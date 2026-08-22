//! Pure command-building and probe-parsing, so the whole export matrix is unit-testable
//! without ffmpeg installed. A wrong argument here produces a silently truncated or
//! unwatchable export rather than an error, which is what the tests below are for.
//!
//! Validation lives in export.rs: build_args builds exactly what the job says, including
//! combinations export.rs would refuse, so the tests can reach it with edge-case inputs.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::ramp::{self, SpeedPoint};
use serde_json::Value;

/// A rectangle in *source* pixels, in display orientation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub duration: f64,
    pub width: i64,
    pub height: i64,
    pub fps: f64,
    pub rotation: i64,
    pub has_audio: bool,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub size_bytes: u64,
}

/// The lowercase serde names are the exact strings the frontend's ExportFormat union uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Mp4,
    Mkv,
    Mov,
    Webm,
    Gif,
    Mp3,
    M4a,
    Wav,
    Flac,
    Ogg,
    Opus,
}

impl ExportFormat {
    /// The whole audio-only branch keys off this, so a format missed here would go down the
    /// video path and hand libx264 an .mp3 output.
    pub fn is_audio(self) -> bool {
        matches!(
            self,
            ExportFormat::Mp3
                | ExportFormat::M4a
                | ExportFormat::Wav
                | ExportFormat::Flac
                | ExportFormat::Ogg
                | ExportFormat::Opus
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QualityPreset {
    High,
    Balanced,
    Small,
    /// Size-targeted: the byte budget comes from ExportJob::target_mb rather
    /// than from the preset, which is why this variant carries no number.
    Fit,
}

/// The nine places a text overlay can sit. A grid rather than free coordinates: it is one
/// click, and it stays where it was put whatever the frame's shape turns out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAnchorX {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAnchorY {
    Top,
    Middle,
    Bottom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextOverlay {
    /// Taken exactly as typed. It never enters the filtergraph - see drawtext_filter.
    pub text: String,
    /// Fraction of the frame height, so one setting reads the same at 1080p and 480p.
    pub size: f64,
    /// '#rrggbb'.
    pub color: String,
    /// 0 - 1.
    pub opacity: f64,
    pub anchor_x: TextAnchorX,
    pub anchor_y: TextAnchorY,
    pub boxed: bool,
}

/// The quick-effects tab, resolved: None is off. Container-level `default` so a job built
/// before this existed - or by anything that leaves the block out - deserialises to no effects
/// rather than failing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Effects {
    /// Gaussian sigma, in source pixels.
    pub blur: Option<f64>,
    /// Linear multipliers; 1 is unchanged.
    pub brightness: Option<f64>,
    pub contrast: Option<f64>,
    pub saturation: Option<f64>,
    /// Degrees.
    pub hue: Option<f64>,
    /// 0 - 1, scaled onto the lens angle vignette actually takes.
    pub vignette: Option<f64>,
    /// Seconds, on the exported timeline - after the trim and the speed change.
    pub fade_in: Option<f64>,
    pub fade_out: Option<f64>,
    pub text: Option<TextOverlay>,
}

impl Effects {
    /// Whether anything at all is switched on. A stream copy cannot apply any of it.
    pub fn any(&self) -> bool {
        self.blur.is_some()
            || self.brightness.is_some()
            || self.contrast.is_some()
            || self.saturation.is_some()
            || self.hue.is_some()
            || self.vignette.is_some()
            || self.fade_in.is_some()
            || self.fade_out.is_some()
            || self.text.is_some()
    }
}

/// How the frame is turned before anything else happens to it.
///
/// At the HEAD of the chain, ahead of crop, so every coordinate downstream - the crop
/// rectangle, the text anchors, the vignette - is in the frame as the user sees it. The
/// alternative, turning last, would mean the crop rectangle arriving in one orientation and
/// being applied in another.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Orientation {
    /// Quarter turns clockwise: 0, 90, 180 or 270. Anything else is treated as 0.
    pub rotate: i64,
    /// Mirrored left to right, applied after the turn.
    pub flip_h: bool,
    pub flip_v: bool,
}

impl Orientation {
    pub fn any(&self) -> bool {
        self.turns() != 0 || self.flip_h || self.flip_v
    }

    /// Quarter turns, normalised to 0..3. A negative or out-of-range value from a hand-built
    /// job becomes 0 rather than an invalid filter.
    fn turns(&self) -> i64 {
        match self.rotate {
            90 => 1,
            180 => 2,
            270 => 3,
            _ => 0,
        }
    }

    /// Whether width and height swap. Every size calculation downstream keys on this.
    pub fn swaps_axes(&self) -> bool {
        self.turns() % 2 == 1
    }

    /// transpose=1 is 90 clockwise and transpose=2 is 90 anticlockwise. 180 is two of the
    /// same, which is cheaper than the hflip,vflip pair and keeps one filter's rounding.
    fn filters(&self) -> Vec<String> {
        let mut parts: Vec<String> = Vec::new();
        match self.turns() {
            1 => parts.push("transpose=1".to_string()),
            2 => {
                parts.push("transpose=1".to_string());
                parts.push("transpose=1".to_string());
            }
            3 => parts.push("transpose=2".to_string()),
            _ => {}
        }
        // After the turn, so they mirror what the user is looking at rather than the source.
        if self.flip_h {
            parts.push("hflip".to_string());
        }
        if self.flip_v {
            parts.push("vflip".to_string());
        }
        parts
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub input: String,
    pub output: String,
    pub in_point: f64,
    pub out_point: f64,
    pub speed: f64,
    /// The speed curve on top of `speed`, on the source timeline. Empty is a flat 1.
    #[serde(default)]
    pub ramp: Vec<SpeedPoint>,
    /// Applied at the head of the chain, so `crop` is in the turned frame.
    #[serde(default)]
    pub orientation: Orientation,
    pub crop: Option<Rect>,
    pub mute: bool,
    pub reverse: bool,
    /// EBU R128 loudness normalisation. Emitted before `volume`, which trims from there.
    pub normalize: bool,
    /// Linear gain, 1.0 = unchanged. export.rs bounds it to [0.0, 10.0].
    pub volume: f64,
    pub format: ExportFormat,
    pub quality: QualityPreset,
    /// Only read when quality is Fit. Decimal megabytes, not MiB - see
    /// target_bytes_for.
    pub target_mb: Option<f64>,
    pub lossless: bool,
    /// None follows the source. Otherwise the finished clip's *smaller*
    /// dimension, the way "1080p" names it whichever way up the frame is.
    pub output_height: Option<i64>,
    /// None lets the quality preset's CRF/CQ decide the rate.
    pub video_kbps: Option<i64>,
    #[serde(default)]
    pub effects: Effects,
}

/// Below this, H.264 stops holding detail and a fit-under-10-MB export turns into mush.
/// The low end of the usual 0.04-0.10 range for veryfast.
const BPP_FLOOR: f64 = 0.04;

/// The standard 16:9 widths, all even, so `-2` on the other axis yields an even height.
const SCALE_LADDER: [i64; 3] = [1280, 854, 640];

// --- Small formatting helpers ---

/// One digit is always kept after the point: `atempo=2` and `atempo=2.0` are the same to
/// ffmpeg, but only one of them looks like a rate.
fn fmt_num(v: f64) -> String {
    let mut s = format!("{:.6}", v);
    while s.ends_with('0') && !s.ends_with(".0") {
        s.pop();
    }
    s
}

/// Millisecond precision. A full `{}` of an f64 can print `1.7999999999999998`.
fn fmt_time(v: f64) -> String {
    format!("{:.3}", v.max(0.0))
}

// --- Pure math ---

/// The progress reader divides ffmpeg's `out_time` by this, so a zero would produce NaN.
pub fn output_duration(job: &ExportJob) -> f64 {
    if job.speed <= 0.0 {
        return 0.0;
    }
    if !ramp::has_ramp(&job.ramp) {
        return ((job.out_point - job.in_point) / job.speed).max(0.0);
    }
    ramp::ramped_duration(&job.ramp, job.speed, job.in_point, job.out_point)
}

/// The curve cut into pieces across this job's trim. Every ramp-aware caller starts here.
fn ramp_segments(job: &ExportJob) -> Vec<ramp::Segment> {
    ramp::segments(&job.ramp, job.speed, job.in_point, job.out_point)
}

/// The retiming filters: one division at a single speed, a nested expression under a curve,
/// and nothing at all when neither changes the timing.
///
/// A curve also needs its frame rate settling. A single speed leaves a clip that is evenly
/// spaced, just at a different rate, and the muxer writes that as it stands. A curve leaves
/// frames bunched where it ran fast and spread where it ran slow, and ffmpeg's own conversion
/// to a constant rate overshoots: measured on a five-part ramp, 5.967s of picture against a
/// predicted 5.914s. The audio is padded to the prediction, so that gap is the two of them
/// coming apart. An explicit fps brings it inside half a frame.
fn retime_filters(job: &ExportJob, fps: f64) -> Vec<String> {
    if ramp::has_ramp(&job.ramp) {
        if let Some(expr) = ramp::setpts_expression(&ramp_segments(job)) {
            // Quoted inside the graph: the expression is full of commas, which separate
            // filters, and ffmpeg reads everything after the first one as the next filter.
            let mut parts = vec![format!("setpts='({})/TB'", expr)];
            if fps > 0.0 {
                parts.push(format!("fps={}", fmt_num(fps)));
            }
            return parts;
        }
    }
    if (job.speed - 1.0).abs() > 1e-9 {
        return vec![format!("setpts=PTS/{}", fmt_num(job.speed))];
    }
    Vec::new()
}

/// The source window, which the speed change does not alter. Keeping it separate from
/// output_duration is the whole reason the trim survives a speed change.
fn source_duration(job: &ExportJob) -> f64 {
    (job.out_point - job.in_point).max(0.0)
}

/// atempo refuses factors below 0.5 and errors rather than clamping, so the slow end is a
/// chain of 0.5 stages. The fast end chains 2.0 stages too, though ffmpeg 7 accepts up to 100
/// in one: a big stage widens the WSOLA window in proportion and smears transients. Empty at
/// 1x, because `atempo=1.0` would force a needless resample.
pub fn atempo_chain(speed: f64) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    if !speed.is_finite() || speed <= 0.0 {
        return parts;
    }
    let mut remaining = speed;
    while remaining > 2.0 + 1e-9 {
        parts.push("atempo=2.0".to_string());
        remaining /= 2.0;
    }
    while remaining < 0.5 - 1e-9 {
        parts.push("atempo=0.5".to_string());
        remaining *= 2.0;
    }
    if (remaining - 1.0).abs() > 1e-9 {
        parts.push(format!("atempo={}", fmt_num(remaining)));
    }
    parts
}

/// One pass of EBU R128, at the target streaming services and chat clients settle around.
/// TP=-1.5 is a true-peak ceiling, so the gain it works out cannot clip however quiet the
/// source was. That holds only as far as the filter: `volume` rides after it, and 1.5 dB of
/// headroom is spent at a trim of about 119%.
pub(crate) const LOUDNORM: &str = "loudnorm=I=-16:TP=-1.5:LRA=11";

/// The level LOUDNORM aims at, in LUFS. The preview turns the gap between this and a file's
/// measured loudness into one fixed gain.
pub(crate) const LOUDNORM_TARGET_LUFS: f64 = -16.0;

/// areverse has to buffer the entire stream before it can emit a sample, so it sits last,
/// where a sped-up export hands it the shortened stream. volume is omitted at 1.0 for the
/// same reason atempo is: a no-op filter still costs a resample pass.
fn audio_filters(job: &ExportJob) -> Vec<String> {
    let ramped = ramp::has_ramp(&job.ramp);
    // A curve too wide for atempo to follow falls back to the single speed. export.rs refuses
    // that job before it gets here, so this only decides what a hand-built one does: run the
    // audio at the base speed rather than emit a graph ffmpeg would reject.
    let mut parts = if ramped {
        ramp::audio_stages(&ramp_segments(job), ramp::AUDIO_STEP_SECONDS)
            .unwrap_or_else(|| atempo_chain(job.speed))
    } else {
        atempo_chain(job.speed)
    };
    if job.normalize {
        parts.push(LOUDNORM.to_string());
    }
    if (job.volume - 1.0).abs() > 1e-9 {
        parts.push(format!("volume={}", fmt_num(job.volume)));
    }
    if job.reverse {
        parts.push("areverse".to_string());
    }
    // After areverse, where "the start" finally means the start of what will be heard.
    parts.extend(fade_filters(&job.effects, output_duration(job), false));
    if ramped {
        // atempo loses a fraction of a millisecond at every tempo change, so the audio comes
        // out a little short of the length the video's own expression works out to. Padded and
        // cut to that length, the two end together; asetpts then rebuilds the timestamps from
        // the sample count, which atrim on its own would leave with a hole where it cut.
        let duration = output_duration(job);
        if duration > 0.0 {
            parts.push("apad".to_string());
            parts.push(format!("atrim=end={}", fmt_time(duration)));
            parts.push("asetpts=N/SR/TB".to_string());
        }
    }
    parts
}

// --- Quick effects ---

/// The strongest vignette the slider can ask for. `vignette` clips its angle at PI/2, which is
/// a black frame with a bright dot in it; PI/2.5 is heavy but still a picture.
const VIGNETTE_MAX_ANGLE: f64 = std::f64::consts::PI / 2.5;
const _: () = assert!(VIGNETTE_MAX_ANGLE < std::f64::consts::FRAC_PI_2);

/// The gap drawtext leaves at an edge, as a fraction of frame height - height on both axes, so
/// the margin looks square rather than stretching with a wide frame. overlay.ts places the
/// preview with the same fraction.
const TEXT_MARGIN: &str = "h*0.04";

/// The plate's border around the text, same units.
const TEXT_PLATE_BORDER: &str = "h*0.012";

const TEXT_PLATE_COLOR: &str = "black@0.45";

/// The file drawtext reads the overlay text from, named relative to ffmpeg's working
/// directory. **export.rs writes this file and sets the child's cwd to the folder holding it,
/// and the two have to stay in step**: a path in a filtergraph has to be quoted, and a quoted
/// path cannot express an apostrophe - which a Windows user name is allowed to contain. A bare
/// filename resolved from the cwd sidesteps the escaping rules entirely.
pub const OVERLAY_TEXT_FILE: &str = "flipperclipper-overlay.txt";

/// Everything that repaints the pixels, in the order the preview's CSS filter applies the same
/// list. drawtext is not here: it goes in after the scale, so the text is rasterised at the
/// size it will be read at instead of being downsampled with the frame.
fn effect_filters(fx: &Effects) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();

    // A multiply across RGB, which is what CSS brightness() does, so the preview and the file
    // agree. `eq`'s own brightness is an addition and would not. The cost is that ffmpeg
    // inserts a conversion either side of it - paid only when the dial is switched on.
    if let Some(k) = fx.brightness {
        parts.push(format!(
            "colorchannelmixer=rr={0}:gg={0}:bb={0}",
            fmt_num(k)
        ));
    }

    // Two dials, one filter, one pass.
    let mut eq: Vec<String> = Vec::new();
    if let Some(c) = fx.contrast {
        eq.push(format!("contrast={}", fmt_num(c)));
    }
    if let Some(sat) = fx.saturation {
        eq.push(format!("saturation={}", fmt_num(sat)));
    }
    if !eq.is_empty() {
        parts.push(format!("eq={}", eq.join(":")));
    }

    if let Some(degrees) = fx.hue {
        parts.push(format!("hue=h={}", fmt_num(degrees)));
    }
    if let Some(sigma) = fx.blur {
        parts.push(format!("gblur=sigma={}", fmt_num(sigma)));
    }
    if let Some(strength) = fx.vignette {
        parts.push(format!(
            "vignette=angle={}",
            fmt_num(strength * VIGNETTE_MAX_ANGLE)
        ));
    }
    parts
}

/// Fades are timed on the finished clip, so they are emitted after reverse - the last filter
/// that changes what "the start" means. Empty on a clip with no duration to fade across.
fn fade_filters(fx: &Effects, total: f64, video: bool) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    if !total.is_finite() || total <= 0.0 {
        return parts;
    }
    let name = if video { "fade" } else { "afade" };

    if let Some(seconds) = fx.fade_in.filter(|s| *s > 0.0) {
        parts.push(format!(
            "{}=t=in:st=0:d={}",
            name,
            fmt_time(seconds.min(total))
        ));
    }
    if let Some(seconds) = fx.fade_out.filter(|s| *s > 0.0) {
        let duration = seconds.min(total);
        parts.push(format!(
            "{}=t=out:st={}:d={}",
            name,
            fmt_time((total - duration).max(0.0)),
            fmt_time(duration)
        ));
    }
    parts
}

/// The text overlay. `font` is an absolute path and does go into the graph, quoted with its
/// drive colon escaped - the Windows font directory is a system path, so it carries none of
/// the characters that form cannot express. The text itself never appears here at all: it is
/// read from OVERLAY_TEXT_FILE, and `expansion=none` stops ffmpeg reading `%{...}` or
/// backslashes inside it, so a colon, a quote or a percent sign in the user's words is drawn
/// rather than parsed.
fn drawtext_filter(overlay: &TextOverlay, font: &Path) -> String {
    let x = match overlay.anchor_x {
        TextAnchorX::Left => format!("x={}", TEXT_MARGIN),
        TextAnchorX::Center => "x=(w-text_w)/2".to_string(),
        TextAnchorX::Right => format!("x=w-text_w-{}", TEXT_MARGIN),
    };
    let y = match overlay.anchor_y {
        TextAnchorY::Top => format!("y={}", TEXT_MARGIN),
        TextAnchorY::Middle => "y=(h-text_h)/2".to_string(),
        TextAnchorY::Bottom => format!("y=h-text_h-{}", TEXT_MARGIN),
    };

    let mut parts = vec![
        format!("fontfile={}", graph_path(font)),
        format!("textfile={}", OVERLAY_TEXT_FILE),
        "expansion=none".to_string(),
        // Both are expressions against the frame, so neither needs the output size worked out.
        format!("fontsize=h*{}", fmt_num(overlay.size)),
        format!(
            "fontcolor={}@{}",
            ffmpeg_color(&overlay.color),
            fmt_num(overlay.opacity)
        ),
        x,
        y,
    ];
    if overlay.boxed {
        parts.push("box=1".to_string());
        parts.push(format!("boxcolor={}", TEXT_PLATE_COLOR));
        parts.push(format!("boxborderw={}", TEXT_PLATE_BORDER));
    }
    format!("drawtext={}", parts.join(":"))
}

/// A path for a filtergraph: quoted, forward slashes, drive colon escaped. Measured against
/// ffmpeg 9 - unquoted, a backslash does not escape the colon and the parser reads everything
/// after the drive letter as the next option.
fn graph_path(path: &Path) -> String {
    format!(
        "'{}'",
        path.to_string_lossy().replace('\\', "/").replace(':', "\\:")
    )
}

/// ffmpeg wants 0xRRGGBB; the colour input hands over '#rrggbb'. Anything unreadable becomes
/// white, which is what the overlay would have defaulted to anyway.
fn ffmpeg_color(hex: &str) -> String {
    let body = hex.strip_prefix('#').unwrap_or(hex);
    if body.len() == 6 && body.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0x{}", body.to_ascii_lowercase())
    } else {
        "0xffffff".to_string()
    }
}

/// Chroma is subsampled 2x2, so an odd width, height or offset makes libx264 refuse the
/// filter or shift the colour planes half a pixel. The rectangle arrives from a mouse drag
/// and can land outside the frame, which ffmpeg treats as a hard error, so this clamp is the
/// whole definition of what an out-of-frame rectangle means. The extent comes from the
/// original *edges*: pulling the width across from the unclamped rect would turn x=-30 w=400
/// into a 400-wide crop of 0..400, 30px more than was dragged and every pixel shifted.
fn normalize_crop(rect: &Rect, width: i64, height: i64) -> Option<Rect> {
    if width < 2 || height < 2 {
        return None;
    }
    let left = rect.x.clamp(0, width);
    let top = rect.y.clamp(0, height);
    let right = (rect.x + rect.w.max(0)).clamp(0, width);
    let bottom = (rect.y + rect.h.max(0)).clamp(0, height);
    let mut w = (right - left).max(0);
    let mut h = (bottom - top).max(0);

    // Rounding the origin down only ever gives the rectangle more room, so it happens after the
    // extent is measured and cannot push the far edge back out of the frame.
    let x = left - left % 2;
    let y = top - top % 2;
    w -= w % 2;
    h -= h % 2;

    if w < 2 || h < 2 {
        return None;
    }
    Some(Rect { x, y, w, h })
}

/// See BPP_FLOOR: past a point, spending the budget on 1080p pixels means every one is wrong.
/// Steps down the ladder until the budget is comfortable or 640 is reached.
fn downscale_width(video_kbps: i64, width: i64, height: i64, fps: f64) -> Option<i64> {
    if width < 2 || height < 2 {
        return None;
    }
    let fps = if fps.is_finite() && fps > 0.0 {
        fps
    } else {
        30.0
    };
    let bpp = |w: i64, h: i64| -> f64 {
        let pixels_per_second = (w as f64) * (h as f64) * fps;
        if pixels_per_second <= 0.0 {
            return f64::INFINITY;
        }
        (video_kbps as f64 * 1000.0) / pixels_per_second
    };

    if bpp(width, height) >= BPP_FLOOR {
        return None;
    }

    let mut chosen = None;
    for candidate in SCALE_LADDER {
        if candidate >= width {
            continue;
        }
        // ffmpeg will compute the real height from `-2`; this is only the
        // estimate the bits-per-pixel test needs.
        let scaled_height = ((height as f64) * (candidate as f64) / (width as f64)).round() as i64;
        let scaled_height = (scaled_height.max(2) / 2) * 2;
        chosen = Some(candidate);
        if bpp(candidate, scaled_height) >= BPP_FLOOR {
            break;
        }
    }
    chosen
}

/// Rounds a computed dimension the way ffmpeg's `-2` does, so the estimator
/// measures the frame the encoder will actually be handed.
fn even_down(value: i64) -> i64 {
    (value.max(2) / 2) * 2
}

/// The requested number names the smaller dimension, so it lands on the height of a landscape
/// frame and the width of a portrait one; `-2` keeps the aspect and forces an even result.
/// None means no filter at all, which is both the never-upscale rule and the degenerate case.
fn explicit_scale(target: i64, width: i64, height: i64) -> Option<(String, i64, i64)> {
    if target < 2 || width < 2 || height < 2 {
        return None;
    }
    if width >= height {
        if target >= height {
            return None;
        }
        let scaled = even_down(((width as f64) * (target as f64) / (height as f64)).round() as i64);
        Some((format!("scale=-2:{}", target), scaled, target))
    } else {
        if target >= width {
            return None;
        }
        let scaled = even_down(((height as f64) * (target as f64) / (width as f64)).round() as i64);
        Some((format!("scale={}:-2", target), target, scaled))
    }
}

/// An explicit output height owns this step outright: the fit ladder does not add a second
/// scale on top of it, or override a request that was a no-op because it would have upscaled.
fn scale_step(
    job: &ExportJob,
    width: i64,
    height: i64,
    fps: f64,
    fit_kbps: Option<i64>,
) -> (Option<String>, i64, i64) {
    if let Some(target) = job.output_height {
        return match explicit_scale(target, width, height) {
            Some((filter, w, h)) => (Some(filter), w, h),
            None => (None, width, height),
        };
    }
    match fit_kbps.and_then(|kbps| downscale_width(kbps, width, height, fps)) {
        Some(scaled) => {
            let h = even_down(((height as f64) * (scaled as f64) / (width as f64)).round() as i64);
            (Some(format!("scale={}:-2", scaled)), scaled, h)
        }
        None => (None, width, height),
    }
}

/// The frame rate and width caps the gif chain applies per quality.
fn gif_caps(quality: QualityPreset) -> (i64, i64) {
    match quality {
        QualityPreset::High => (20, 640),
        QualityPreset::Small => (10, 360),
        // export.rs refuses a size target for gif before build_args runs; a total function here
        // beats a panic if that guard ever slips.
        _ => (15, 480),
    }
}

/// The frame after crop, which is what both the scale step and the estimator
/// measure against.
/// The source size as the frame is shown after the turn. The crop rectangle, the scale
/// ladder and the size estimate all work in this space, because the user drew the crop on a
/// turned picture and `transpose` runs before any of them.
pub fn turned_size(job: &ExportJob, width: i64, height: i64) -> (i64, i64) {
    if job.orientation.swaps_axes() {
        (height, width)
    } else {
        (width, height)
    }
}

fn cropped_size(job: &ExportJob, width: i64, height: i64) -> (i64, i64) {
    match job
        .crop
        .as_ref()
        .and_then(|r| normalize_crop(r, width, height))
    {
        Some(r) => (r.w, r.h),
        None => (width, height),
    }
}

// --- Encoder families ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EncoderFamily {
    X264,
    Nvenc,
    Qsv,
    Amf,
}

/// Appends a run of literal flags. Exists only so the assembly below reads as
/// the flag matrix it is instead of a wall of `.to_string()`.
fn push_all(args: &mut Vec<String>, items: &[&str]) {
    for item in items {
        args.push((*item).to_string());
    }
}

fn encoder_family(encoder: &str) -> EncoderFamily {
    if encoder.contains("nvenc") {
        EncoderFamily::Nvenc
    } else if encoder.contains("qsv") {
        EncoderFamily::Qsv
    } else if encoder.contains("amf") {
        EncoderFamily::Amf
    } else {
        EncoderFamily::X264
    }
}

/// 18 is visually transparent for most material, 23 is the encoder's default, 28 is where a
/// clip meant for a chat window stops being worth shrinking.
fn crf_for(quality: QualityPreset) -> i32 {
    match quality {
        QualityPreset::High => 18,
        QualityPreset::Small => 28,
        _ => 23,
    }
}

/// One step higher than the x264 numbers: the vendor quantiser scales are a different curve,
/// and matching CRF exactly produces larger files for no visible gain.
fn cq_for(quality: QualityPreset) -> i32 {
    match quality {
        QualityPreset::High => 19,
        QualityPreset::Small => 29,
        _ => 24,
    }
}

/// VP9's CRF scale runs 4-5 points looser than x264's for the same visual result.
fn vp9_crf_for(quality: QualityPreset) -> i32 {
    match quality {
        QualityPreset::High => 30,
        QualityPreset::Small => 38,
        _ => 34,
    }
}

fn audio_kbps_for(quality: QualityPreset) -> i32 {
    match quality {
        QualityPreset::High => 160,
        QualityPreset::Small => 96,
        // The size-target preset subtracts this audio allowance from the video budget.
        _ => 128,
    }
}

/// -movflags is private to that muxer, so ffmpeg aborts with "Option movflags not found" on a
/// .mkv or .webm - after the user has been through the save dialog. .m4a is in the family.
fn is_mp4_family(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.ends_with(".mp4")
        || lower.ends_with(".m4v")
        || lower.ends_with(".mov")
        || lower.ends_with(".m4a")
}

/// Discord's limit is 10 MiB, but plenty of places mean 10 x 10^6 by "10 MB". Targeting the
/// decimal value undershoots both readings.
fn target_bytes_for(job: &ExportJob) -> Option<u64> {
    if job.quality != QualityPreset::Fit {
        return None;
    }
    let mb = job.target_mb?;
    if !mb.is_finite() || mb <= 0.0 {
        return None;
    }
    Some((mb * 1_000_000.0).round() as u64)
}

/// Fit hands the entire budget to the audio - there is no video to share it with. The 32k
/// floor is libmp3lame's lowest MPEG-1 Layer III rate; it rejects anything under it.
fn fit_audio_kbps(job: &ExportJob) -> Option<i64> {
    let bytes = target_bytes_for(job)?;
    let duration = output_duration(job);
    if duration <= 0.0 {
        return None;
    }
    Some(((bytes as f64 * 8.0 * 0.93) / duration / 1000.0).max(32.0).round() as i64)
}

/// Stepped per codec rather than sharing one table: 96k opus is comparable to 128k mp3, so
/// shared numbers would make "small" mean different things. wav and flac are told nothing.
fn audio_only_kbps(job: &ExportJob) -> i64 {
    let fit = fit_audio_kbps(job);
    let by_quality = |high: i64, balanced: i64, small: i64| -> i64 {
        fit.unwrap_or(match job.quality {
            QualityPreset::High => high,
            QualityPreset::Small => small,
            _ => balanced,
        })
    };
    match job.format {
        ExportFormat::Mp3 => by_quality(256, 192, 128),
        ExportFormat::M4a => by_quality(256, 160, 96),
        ExportFormat::Opus => by_quality(192, 128, 96),
        ExportFormat::Ogg => by_quality(224, 160, 112),
        ExportFormat::Wav => 1536,
        ExportFormat::Flac => 900,
        _ => 0,
    }
}

/// webm carries opus at a flat 128k - transparent at any preset - while aac keeps its dial.
fn video_path_audio_kbps(job: &ExportJob) -> i64 {
    if job.format == ExportFormat::Webm {
        128
    } else {
        audio_kbps_for(job.quality) as i64
    }
}

/// The 0.93 is container-overhead headroom: MP4 boxes, packet headers and the encoder
/// overshooting its own target come out of the same budget, and 10.2 MB fails as hard as 20.
fn fit_video_kbps(job: &ExportJob, keep_audio: bool) -> Option<i64> {
    let target_bytes = target_bytes_for(job)?;
    let duration = output_duration(job);
    let audio_bits = if keep_audio {
        video_path_audio_kbps(job) as f64 * 1000.0 * duration
    } else {
        0.0
    };
    let kbps = if duration > 0.0 {
        (target_bytes as f64 * 8.0 * 0.93 - audio_bits) / duration / 1000.0
    } else {
        0.0
    };
    Some(kbps.max(100.0).round() as i64)
}

fn push_audio_codec(args: &mut Vec<String>, job: &ExportJob) {
    let kbps = audio_only_kbps(job);

    match job.format {
        ExportFormat::Mp3 => {
            push_all(args, &["-c:a", "libmp3lame"]);
            args.push("-b:a".to_string());
            args.push(format!("{}k", kbps));
        }
        ExportFormat::M4a => {
            push_all(args, &["-c:a", "aac"]);
            args.push("-b:a".to_string());
            args.push(format!("{}k", kbps));
        }
        ExportFormat::Opus => {
            push_all(args, &["-c:a", "libopus"]);
            args.push("-b:a".to_string());
            args.push(format!("{}k", kbps));
        }
        ExportFormat::Ogg => {
            push_all(args, &["-c:a", "libvorbis"]);
            match fit_audio_kbps(job) {
                // Vorbis is natively VBR, but a size target needs a rate the arithmetic can hold it to.
                Some(_) => {
                    args.push("-b:a".to_string());
                    args.push(format!("{}k", kbps));
                }
                None => {
                    args.push("-q:a".to_string());
                    args.push(
                        match job.quality {
                            QualityPreset::High => "7",
                            QualityPreset::Small => "3",
                            _ => "5",
                        }
                        .to_string(),
                    );
                }
            }
        }
        // No rate for these two: pcm_s16le's is a fixed function of the sample rate and flac is
        // lossless, so the quality dial is ignored rather than mapped onto inaudible levels.
        ExportFormat::Wav => push_all(args, &["-c:a", "pcm_s16le"]),
        ExportFormat::Flac => push_all(args, &["-c:a", "flac"]),
        // The caller branched on is_audio() before getting here.
        _ => unreachable!("push_audio_codec called with a video format"),
    }
}

// --- The command matrix ---

/// `width`, `height` and `fps` are the display-orientation source dimensions from `probe`.
/// The crop clamp and the auto-downscale both depend on them, and neither belongs in
/// ExportJob - they describe the file, not the edit. `font` is the same kind of fact: which
/// font file this machine has. Without one the text overlay is left out rather than guessed
/// at; export.rs refuses the job before it gets here.
pub fn build_args(
    job: &ExportJob,
    encoder: &str,
    has_audio: bool,
    width: i64,
    height: i64,
    fps: f64,
    font: Option<&Path>,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let keep_audio = has_audio && !job.mute;
    // Everything below reasons about the frame the user was looking at, which is the turned
    // one. transpose runs at the head of the chain, so crop and scale see these dimensions.
    let (width, height) = turned_size(job, width, height);

    push_all(&mut args, &["-y"]);
    // -nostats suppresses the carriage-return status line that would otherwise interleave with
    // real error text and make the failure message unreadable.
    push_all(&mut args, &["-progress", "pipe:1", "-nostats"]);

    // -ss in front of -i seeks to the nearest keyframe and decodes forward: quick on a long file
    // and still frame-accurate. Its companion is -t and deliberately not -to - an output-side -to
    // is measured on the setpts-scaled timeline, so a 2x export of [10s, 20s] with "-to 20" keeps
    // writing until it has produced 20 seconds. Getting this backwards still exits zero.
    args.push("-ss".to_string());
    args.push(fmt_time(job.in_point));
    args.push("-t".to_string());
    args.push(fmt_time(source_duration(job)));
    args.push("-i".to_string());
    args.push(job.input.clone());

    if job.lossless {
        // Only reachable when trim is the sole edit. mkv is the cross-container lossless target -
        // stream copy cannot change codecs, but Matroska holds anything. make_zero rebases the
        // timestamps after the keyframe seek, or the first packet carries a negative PTS.
        push_all(&mut args, &["-map", "0:v:0"]);
        if keep_audio {
            push_all(&mut args, &["-map", "0:a:0?"]);
        }
        push_all(
            &mut args,
            &["-c", "copy", "-avoid_negative_ts", "make_zero"],
        );
        if is_mp4_family(&job.output) {
            push_all(&mut args, &["-movflags", "+faststart"]);
        }
        args.push(job.output.clone());
        return args;
    }

    if job.format.is_audio() {
        // -vn beside an audio-only -map is what keeps an embedded cover art stream (an attached_pic
        // is a video stream) out of the container. job.mute is ignored here: -an beside -vn would ask
        // ffmpeg for a file with no streams at all.
        push_all(&mut args, &["-vn", "-map", "0:a:0"]);

        let afilters = audio_filters(job);
        if !afilters.is_empty() {
            args.push("-af".to_string());
            args.push(afilters.join(","));
        }

        push_audio_codec(&mut args, job);

        if is_mp4_family(&job.output) {
            push_all(&mut args, &["-movflags", "+faststart"]);
        }
        args.push(job.output.clone());
        return args;
    }

    if job.format == ExportFormat::Gif {
        // palettegen/paletteuse is a two-branch graph, which -vf cannot express, so the whole gif
        // pipeline lives in one -filter_complex with crop, setpts and reverse prepended into it.
        // stats_mode=diff weights the palette toward the pixels that change. 'min(iw,N)' caps the
        // width without upscaling; the fps cap matters more, since gif has no interframe compression.
        // No -map, -an or -pix_fmt: with a filter_complex the graph's output is the only mapped
        // stream, and paletteuse emits pal8 that forcing yuv420p would break.
        let crop = job
            .crop
            .as_ref()
            .and_then(|r| normalize_crop(r, width, height));
        // The gif chain owns its own frame rate and width caps, so neither an
        // explicit output height nor an explicit bitrate applies here.
        let (fps_cap, width_cap) = gif_caps(job.quality);

        let mut chain: Vec<String> = Vec::new();
        chain.extend(job.orientation.filters());
        if let Some(r) = crop {
            chain.push(format!("crop={}:{}:{}:{}", r.w, r.h, r.x, r.y));
        }
        chain.extend(retime_filters(job, fps));
        // The gif branch owns its own scale, so the effects and the text both go in ahead of
        // it - the same relative order as the video branch, minus the split.
        chain.extend(effect_filters(&job.effects));
        if let (Some(overlay), Some(font)) = (job.effects.text.as_ref(), font) {
            chain.push(drawtext_filter(overlay, font));
        }
        if job.reverse {
            chain.push("reverse".to_string());
        }
        chain.extend(fade_filters(&job.effects, output_duration(job), true));
        chain.push(format!(
            "fps={},scale='min(iw,{})':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
            fps_cap, width_cap
        ));

        args.push("-filter_complex".to_string());
        args.push(chain.join(","));
        // Loop forever. It is the muxer's default today, but a default is a muxer detail and "a gif
        // that plays once and freezes" takes a day to trace back to a dropped flag.
        push_all(&mut args, &["-loop", "0"]);
        args.push(job.output.clone());
        return args;
    }

    // ---- the video containers: mp4 / mov / mkv / webm ----------------------

    // Explicit maps rather than default stream selection: a phone or GoPro file often carries a
    // timecode or subtitle stream MP4 cannot hold, and the mux fails at the end of a finished
    // encode. The `?` makes the audio map optional, for a file that turns out to have none.
    push_all(&mut args, &["-map", "0:v:0"]);
    if keep_audio {
        push_all(&mut args, &["-map", "0:a:0?"]);
    }

    if job.mute {
        push_all(&mut args, &["-an"]);
    }

    let crop = job
        .crop
        .as_ref()
        .and_then(|r| normalize_crop(r, width, height));
    let (effective_width, effective_height) = cropped_size(job, width, height);

    let is_webm = job.format == ExportFormat::Webm;
    let audio_kbps = video_path_audio_kbps(job);

    // Settled before the filter chain, because the auto-downscale decision is a function of it.
    let fit_kbps = fit_video_kbps(job, keep_audio);
    let video_kbps = fit_kbps.or_else(|| job.video_kbps.filter(|kbps| *kbps > 0));

    let (scale_filter, _, _) = scale_step(job, effective_width, effective_height, fps, fit_kbps);

    let mut vfilters: Vec<String> = Vec::new();
    // Ahead of the crop, so the rectangle the UI produced lands on the frame it was drawn on.
    vfilters.extend(job.orientation.filters());
    if let Some(r) = crop {
        // Crop first, so setpts and scale only see the surviving pixels and the coordinates stay in
        // the source pixel space the overlay measured them in.
        vfilters.push(format!("crop={}:{}:{}:{}", r.w, r.h, r.x, r.y));
    }
    vfilters.extend(retime_filters(job, fps));
    // Ahead of the scale, so a sigma given in source pixels means the same thing whatever
    // size the clip is exported at - which is what the preview shows.
    vfilters.extend(effect_filters(&job.effects));
    if let Some(filter) = scale_filter {
        vfilters.push(filter);
    }
    // After the scale, so the letters are rasterised at the size they will be read at rather
    // than drawn large and then thrown away.
    if let (Some(overlay), Some(font)) = (job.effects.text.as_ref(), font) {
        vfilters.push(drawtext_filter(overlay, font));
    }
    if job.reverse {
        // Last of the frame-shaping filters on purpose: reverse holds every frame it will emit
        // in memory before producing the first, so it should be handed cropped and downscaled
        // frames.
        vfilters.push("reverse".to_string());
    }
    // After reverse, because a fade in belongs at the start of what will be watched.
    vfilters.extend(fade_filters(&job.effects, output_duration(job), true));
    if !vfilters.is_empty() {
        args.push("-vf".to_string());
        args.push(vfilters.join(","));
    }

    if keep_audio {
        let afilters = audio_filters(job);
        if !afilters.is_empty() {
            args.push("-af".to_string());
            args.push(afilters.join(","));
        }
    }

    if is_webm {
        // Always software VP9: none of the detected h264_* hardware encoders can produce it. Measured
        // ~19x slower than x264 veryfast; -row-mt 1 and -cpu-used 4 pull that back to usable for less
        // than one CRF step of quality.
        push_all(&mut args, &["-c:v", "libvpx-vp9"]);
        match video_kbps {
            Some(kbps) => {
                args.push("-b:v".to_string());
                args.push(format!("{}k", kbps));
                args.push("-maxrate".to_string());
                args.push(format!("{}k", kbps));
                args.push("-bufsize".to_string());
                args.push(format!("{}k", kbps * 2));
            }
            None => {
                // -b:v 0 is load-bearing: with a -crf alone libvpx runs constrained-quality and caps the
                // stream at its default bitrate, quietly ignoring the quality the user picked.
                push_all(&mut args, &["-b:v", "0"]);
                args.push("-crf".to_string());
                args.push(vp9_crf_for(job.quality).to_string());
            }
        }
        push_all(&mut args, &["-row-mt", "1", "-cpu-used", "4"]);
    } else {
        args.push("-c:v".to_string());
        args.push(encoder.to_string());

        let family = encoder_family(encoder);
        match video_kbps {
            Some(kbps) => {
                // One-pass constrained VBR: maxrate pins the peak so a busy scene cannot blow the budget,
                // and the usual 2x bufsize gives the rate controller a second of slack.
                args.push("-b:v".to_string());
                args.push(format!("{}k", kbps));
                args.push("-maxrate".to_string());
                args.push(format!("{}k", kbps));
                args.push("-bufsize".to_string());
                args.push(format!("{}k", kbps * 2));
                if family == EncoderFamily::X264 {
                    push_all(&mut args, &["-preset", "veryfast"]);
                }
            }
            None => {
                // Each hardware encoder wraps a different vendor SDK, so "constant quality" is spelled three
                // ways: NVENC's CQ level needs -b:v 0 beside it or its VBR controller caps the stream at the
                // 2 Mbit default; QSV routes through Intel's ICQ via global_quality; AMF has no constant
                // quality at all, only the per-frame-type quantisers of its CQP controller.
                match family {
                    EncoderFamily::X264 => {
                        push_all(&mut args, &["-preset", "veryfast"]);
                        args.push("-crf".to_string());
                        args.push(crf_for(job.quality).to_string());
                    }
                    EncoderFamily::Nvenc => {
                        push_all(&mut args, &["-rc", "vbr"]);
                        args.push("-cq".to_string());
                        args.push(cq_for(job.quality).to_string());
                        push_all(&mut args, &["-b:v", "0"]);
                    }
                    EncoderFamily::Qsv => {
                        args.push("-global_quality".to_string());
                        args.push(cq_for(job.quality).to_string());
                    }
                    EncoderFamily::Amf => {
                        push_all(&mut args, &["-rc", "cqp"]);
                        let qp = cq_for(job.quality).to_string();
                        args.push("-qp_i".to_string());
                        args.push(qp.clone());
                        args.push("-qp_p".to_string());
                        args.push(qp.clone());
                        args.push("-qp_b".to_string());
                        args.push(qp);
                    }
                }
            }
        }
    }

    if keep_audio {
        if is_webm {
            push_all(&mut args, &["-c:a", "libopus"]);
        } else {
            push_all(&mut args, &["-c:a", "aac"]);
        }
        args.push("-b:a".to_string());
        args.push(format!("{}k", audio_kbps));
    }

    // yuv420p because WebView2, Discord's inline player and every phone decoder reject 4:2:2 or
    // 10-bit H.264, which a screen recording or an HDR phone clip will hand us. +faststart moves
    // the moov atom to the front so an embed plays before the whole file has downloaded.
    push_all(&mut args, &["-pix_fmt", "yuv420p"]);
    if is_mp4_family(&job.output) {
        push_all(&mut args, &["-movflags", "+faststart"]);
    }

    args.push(job.output.clone());
    args
}

// --- Size estimation ---

/// The only term in the estimate that is a guess rather than arithmetic. Measured on the
/// integration suite's own 1080p30 fixture: x264 veryfast lands at 0.115 / 0.079 / 0.036 bpp
/// for crf 18 / 23 / 28, VP9 at 0.117 / 0.092 / 0.067 for crf 30 / 34 / 38. These sit a little
/// under the x264 measurements because testsrc2 carries more fine detail than real footage,
/// and VP9 gets its own row because it measured no cheaper at all.
fn bpp_for(format: ExportFormat, quality: QualityPreset) -> f64 {
    if format == ExportFormat::Webm {
        return match quality {
            QualityPreset::High => 0.100,
            QualityPreset::Small => 0.050,
            _ => 0.070,
        };
    }
    match quality {
        QualityPreset::High => 0.100,
        QualityPreset::Small => 0.035,
        _ => 0.065,
    }
}

/// Gif has no interframe compression worth the name, so its size is content-bound to a degree
/// no constant can follow: the same 480x270 chain measured 0.10 mostly-static and 1.01 when
/// every pixel changes every frame.
const GIF_BYTES_PER_PIXEL: f64 = 0.35;

fn bytes_from_kbps(kbps: i64, seconds: f64) -> f64 {
    kbps as f64 * 1000.0 * seconds / 8.0
}

/// Where the job names a rate - an explicit bitrate, or a size target - the answer is
/// arithmetic and close to exact. The constant-quality presets can only be estimated, so treat
/// the result as the order of magnitude it is.
pub fn estimate_output_bytes(
    job: &ExportJob,
    width: i64,
    height: i64,
    fps: f64,
    has_audio: bool,
) -> u64 {
    let duration = output_duration(job);
    let fps = if fps.is_finite() && fps > 0.0 {
        fps
    } else {
        30.0
    };
    let keep_audio = has_audio && !job.mute;
    if duration <= 0.0 || width < 2 || height < 2 {
        return 0;
    }

    if job.lossless {
        // A stream copy keeps the source's own rate, which is not one of the arguments here, so the
        // high-quality figure is the closest guess.
        let seconds = (job.out_point - job.in_point).max(0.0);
        let video = bpp_for(job.format, QualityPreset::High) * width as f64 * height as f64 * fps;
        let audio = if keep_audio { 128_000.0 } else { 0.0 };
        return (((video + audio) * seconds) / 8.0).round() as u64;
    }

    if job.format.is_audio() {
        if !has_audio {
            return 0;
        }
        return bytes_from_kbps(audio_only_kbps(job), duration).round() as u64;
    }

    let (width, height) = turned_size(job, width, height);
    let (cropped_width, cropped_height) = cropped_size(job, width, height);
    // setpts moves the timestamps and keeps every frame, so the rate is the frame count over
    // the finished length. Under a curve that is an average, which is all an estimate needs.
    let output_fps = if duration > 0.0 {
        fps * source_duration(job) / duration
    } else {
        0.0
    };

    if job.format == ExportFormat::Gif {
        let (fps_cap, width_cap) = gif_caps(job.quality);
        let w = cropped_width.min(width_cap);
        let h = even_down(
            ((cropped_height as f64) * (w as f64) / (cropped_width as f64)).round() as i64,
        );
        let frames = output_fps.min(fps_cap as f64) * duration;
        return (w as f64 * h as f64 * GIF_BYTES_PER_PIXEL * frames).round() as u64;
    }

    let fit_kbps = fit_video_kbps(job, keep_audio);
    let (_, frame_width, frame_height) =
        scale_step(job, cropped_width, cropped_height, fps, fit_kbps);

    let video_bits = match fit_kbps.or_else(|| job.video_kbps.filter(|kbps| *kbps > 0)) {
        Some(kbps) => kbps as f64 * 1000.0 * duration,
        None => {
            bpp_for(job.format, job.quality)
                * frame_width as f64
                * frame_height as f64
                * output_fps
                * duration
        }
    };
    let audio_bits = if keep_audio {
        video_path_audio_kbps(job) as f64 * 1000.0 * duration
    } else {
        0.0
    };

    ((video_bits + audio_bits) / 8.0).round() as u64
}

/// The estimator over IPC. The frame size and rate come from the MediaInfo the
/// frontend already holds, so a slider drag costs no probe.
#[tauri::command]
pub fn estimate_export_size(
    job: ExportJob,
    width: i64,
    height: i64,
    fps: f64,
    has_audio: bool,
) -> u64 {
    estimate_output_bytes(&job, width, height, fps, has_audio)
}

// --- ffprobe JSON ---

/// ffprobe writes most numbers as JSON strings but not all of them, and which
/// is which changes between fields and between builds.
fn as_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn as_i64(value: Option<&Value>) -> Option<i64> {
    as_f64(value).map(|v| v.round() as i64)
}

/// Defaults to 30 rather than failing: fps only feeds the progress estimate and the
/// bits-per-pixel test, and a still image or a broken container reports "0/0" here.
fn parse_rational(text: Option<&Value>) -> Option<f64> {
    let s = text?.as_str()?;
    let (num, den) = s.split_once('/')?;
    let num: f64 = num.trim().parse().ok()?;
    let den: f64 = den.trim().parse().ok()?;
    if den == 0.0 || num <= 0.0 {
        return None;
    }
    let fps = num / den;
    if fps.is_finite() && fps > 0.0 {
        Some(fps)
    } else {
        None
    }
}

/// Modern files carry it in the video stream's Display Matrix side data, older MOV files only
/// in the `rotate` tag. The two use opposite signs for the same physical rotation, which does
/// not matter here: the only consumer is the 90/270 dimension swap.
fn read_rotation(stream: &Value) -> i64 {
    let raw = stream
        .get("side_data_list")
        .and_then(|v| v.as_array())
        .and_then(|list| list.iter().find_map(|entry| as_f64(entry.get("rotation"))))
        .or_else(|| as_f64(stream.get("tags").and_then(|t| t.get("rotate"))))
        .unwrap_or(0.0);

    let degrees = raw.round() as i64;
    let normalised = ((degrees % 360) + 360) % 360;
    // Some cameras write 89 or 271, and a swap decision has no third answer.
    match (normalised + 45) / 90 % 4 {
        1 => 90,
        2 => 180,
        3 => 270,
        _ => 0,
    }
}

pub fn parse_probe(json: &str, path: &str, size_bytes: u64) -> Result<MediaInfo, String> {
    let root: Value = serde_json::from_str(json)
        .map_err(|e| format!("ffprobe did not return readable JSON: {}", e))?;

    let streams = root
        .get("streams")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "ffprobe reported no streams for this file".to_string())?;

    // An MP3 with cover art has a video stream that is a single still JPEG, which would report a
    // 600x600 "video" and export one frame.
    let video = streams
        .iter()
        .find(|s| {
            s.get("codec_type").and_then(|v| v.as_str()) == Some("video")
                && s.get("disposition")
                    .and_then(|d| d.get("attached_pic"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    == 0
        })
        .ok_or_else(|| "this file has no video track".to_string())?;

    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"));

    // The format-level duration is the one a player's seek bar uses; a stream-level one only
    // exists on some containers. Each candidate is checked for usability before the next is
    // consulted, because a remuxed MKV/TS or a screen recorder will advertise "0.000000" at the
    // format level while the video stream carries the real length.
    let usable = |d: f64| d.is_finite() && d > 0.0;
    let duration = as_f64(root.get("format").and_then(|f| f.get("duration")))
        .filter(|d| usable(*d))
        .or_else(|| as_f64(video.get("duration")).filter(|d| usable(*d)))
        .unwrap_or(0.0);

    let fps = parse_rational(video.get("r_frame_rate"))
        .or_else(|| parse_rational(video.get("avg_frame_rate")))
        .unwrap_or(30.0);

    let rotation = read_rotation(video);
    let stored_width = as_i64(video.get("width")).unwrap_or(0);
    let stored_height = as_i64(video.get("height")).unwrap_or(0);
    // Display dimensions, not stored ones: both WebView2 and ffmpeg apply the rotation on decode,
    // so the overlay and the crop filter agree. Stored size would put the rectangle on its side.
    let (width, height) = if rotation == 90 || rotation == 270 {
        (stored_height, stored_width)
    } else {
        (stored_width, stored_height)
    };

    Ok(MediaInfo {
        path: path.to_string(),
        duration,
        width,
        height,
        fps,
        rotation,
        has_audio: audio.is_some(),
        video_codec: video
            .get("codec_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        audio_codec: audio
            .and_then(|s| s.get("codec_name"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        size_bytes,
    })
}

// --- Process spawning ---

/// The app is a windows_subsystem="windows" binary, so any child console process allocates its
/// own window: without CREATE_NO_WINDOW a black box steals focus for every thumbnail and every
/// probe. "ffmpeg" and "ffprobe" are spawned from the absolute path `resolve_tool` found.
pub fn hidden_command(program: &str) -> std::process::Command {
    match program {
        "ffmpeg" | "ffprobe" => match resolve_tool(program) {
            Some(path) => hidden_command_at(path.as_os_str()),
            None => hidden_command_at(program.as_ref()),
        },
        _ => hidden_command_at(program.as_ref()),
    }
}

fn hidden_command_at(program: &std::ffi::OsStr) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

// --- Tool resolution ---

/// The Path values these two scopes hold are the current, authoritative ones
/// even when the environment block this process inherited is stale.
const REGISTRY_PATH_SCOPES: [&str; 2] = ["User", "Machine"];

/// The identifier from tauri.conf.json, used only by the fallback in managed_dir.
const APP_IDENTIFIER: &str = "com.mkiera.flipperclipper";

static MANAGED_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Set once from lib.rs's setup hook, before anything can resolve a tool.
pub fn set_managed_dir(dir: PathBuf) {
    let _ = MANAGED_DIR.set(dir);
}

/// Where the app keeps the copy of FFmpeg it downloaded itself, whether or not one is there yet.
/// The fallback is what Tauri's app_local_data_dir expands to, so a caller running before the
/// setup hook - and every test - agrees with it.
pub fn managed_dir() -> Option<PathBuf> {
    MANAGED_DIR.get().cloned().or_else(|| {
        std::env::var_os("LOCALAPPDATA")
            .map(|root| PathBuf::from(root).join(APP_IDENTIFIER).join("ffmpeg"))
    })
}

fn resolved_tools() -> &'static Mutex<HashMap<String, PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drops the memoised paths so the next `resolve_tool` searches again.
static FILTERS: OnceLock<HashSet<String>> = OnceLock::new();

/// Whether this build has a given filter. drawtext needs libfreetype, and a cut-down ffmpeg on
/// someone's PATH may not have been built with it - without this check the failure is an
/// "Unknown filter" line at the end of a job the user has already waited through.
///
/// An unreadable listing answers yes: a probe that failed is not evidence the filter is
/// missing, and ffmpeg's own error is a better report than a refusal built on a guess.
pub fn has_filter(name: &str) -> bool {
    let filters = FILTERS.get_or_init(|| {
        let Ok(output) = hidden_command("ffmpeg")
            .args(["-hide_banner", "-filters"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        else {
            return HashSet::new();
        };
        // " T. drawtext          V->V       Draw text on top of video frames..." - the flags
        // come first, so the name is the second field.
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_whitespace().nth(1).map(str::to_string))
            .collect()
    });
    filters.is_empty() || filters.contains(name)
}

pub fn forget_resolved_tools() {
    if let Ok(mut cache) = resolved_tools().lock() {
        cache.clear();
    }
}

/// A launch from the installer and a launch from the shell do not see the same environment, so
/// the search runs the inherited PATH, then the registry's Path values, then the usual install
/// folders. Only a candidate that actually runs is accepted. Misses are not cached.
pub fn resolve_tool(name: &str) -> Option<PathBuf> {
    match cached_tool(name) {
        Some(hit) => Some(hit),
        None => search_for_tool(name).map(|(path, _)| path),
    }
}

/// `resolve_tool` plus the `-version` stdout its validation run already
/// captured. Only the path is memoised, so a cache hit still costs one run.
pub fn resolve_tool_with_version(name: &str) -> Option<(PathBuf, String)> {
    match cached_tool(name) {
        Some(hit) => run_version(&hit).map(|text| (hit, text)),
        None => search_for_tool(name),
    }
}

fn cached_tool(name: &str) -> Option<PathBuf> {
    resolved_tools().lock().ok()?.get(name).cloned()
}

fn search_for_tool(name: &str) -> Option<(PathBuf, String)> {
    let file_name = format!("{}{}", name, std::env::consts::EXE_SUFFIX);
    // Last resort: the bare name, so CreateProcess still gets to apply its own
    // search (the app's own folder, the system dirs) as it did before.
    let bare = std::iter::once(PathBuf::from(&file_name));
    let (path, version) = candidate_dirs()
        .map(move |dir| dir.join(&file_name))
        .filter(|candidate| candidate_exists(candidate))
        .chain(bare)
        .flat_map(|candidate| {
            let target = link_target(&candidate);
            std::iter::once(candidate).chain(target)
        })
        .find_map(|candidate| run_version(&candidate).map(|text| (candidate, text)))?;

    if let Ok(mut cache) = resolved_tools().lock() {
        cache.insert(name.to_string(), path.clone());
    }
    Some((path, version))
}

/// symlink_metadata rather than is_file: the winget shims are reparse points,
/// and following one can fail even though CreateProcess would launch it.
fn candidate_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// The winget shims are symlinks, and a process the installer launched is refused permission
/// to traverse one - os error 448, "the path cannot be traversed because it contains an
/// untrusted mount point". read_link answers where a spawn could not go.
fn link_target(path: &Path) -> Option<PathBuf> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_symlink() {
        return None;
    }
    let target = std::fs::read_link(path).ok()?;
    let target = if target.is_absolute() {
        target
    } else {
        path.parent()?.join(target)
    };
    candidate_exists(&target).then_some(target)
}

/// The stdout of a `-version` that exited zero, or None - which is what keeps a
/// zero-byte WinGet alias from winning the search.
pub(crate) fn run_version(path: &Path) -> Option<String> {
    let output = hidden_command_at(path.as_os_str())
        .arg("-version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Inherited PATH, then the registry, then the usual install folders - as a
/// lazy stream, so a hit in the first tier costs no PowerShell spawn at all.
fn candidate_dirs() -> impl Iterator<Item = PathBuf> {
    let inherited = std::env::var_os("PATH")
        .map(|path| split_path_list(&path.to_string_lossy()))
        .unwrap_or_default();

    let registry = REGISTRY_PATH_SCOPES.into_iter().flat_map(|scope| {
        registry_path_value(scope)
            .map(|value| {
                split_path_list(&expand_env_vars(&value, |name| std::env::var(name).ok()))
            })
            .unwrap_or_default()
    });

    // The app's own copy first: it is the one binary this app verified itself, it costs no
    // PowerShell spawn to find, and it is never a reparse point.
    dedupe_dirs(
        managed_dir()
            .into_iter()
            .chain(inherited)
            .chain(registry)
            .chain(std::iter::once_with(known_install_dirs).flatten()),
    )
}

fn known_install_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |var: &str, tail: &[&str]| {
        if let Some(root) = std::env::var_os(var) {
            let mut dir = PathBuf::from(root);
            for part in tail {
                dir.push(part);
            }
            dirs.push(dir);
        }
    };
    push("LOCALAPPDATA", &["Microsoft", "WinGet", "Links"]);
    push("ProgramFiles", &["ffmpeg", "bin"]);
    push("ProgramData", &["chocolatey", "bin"]);
    push("LOCALAPPDATA", &["Programs", "ffmpeg", "bin"]);
    dirs
}

/// Not reg.exe: it writes stdout in the console's OEM codepage, which turns any non-ASCII
/// directory into replacement characters.
fn registry_path_value(scope: &str) -> Option<String> {
    let script = format!(
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
         [Environment]::GetEnvironmentVariable('Path','{scope}')"
    );
    let output = hidden_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script.as_str()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn split_path_list(value: &str) -> Vec<PathBuf> {
    value
        .split(';')
        .map(|part| part.trim().trim_matches('"'))
        .filter(|part| !part.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Expands %VAR% references. The registry holds the Path of HKCU\Environment as
/// REG_EXPAND_SZ, so it can contain them unexpanded.
fn expand_env_vars<F>(text: &str, lookup: F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match lookup(name) {
                    Some(value) if !name.is_empty() => out.push_str(&value),
                    _ => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Keeps the first spelling of each directory, so search priority survives.
/// Filters the stream rather than a finished list, so a later tier is still
/// only read if the search gets that far.
fn dedupe_dirs(dirs: impl Iterator<Item = PathBuf>) -> impl Iterator<Item = PathBuf> {
    let mut seen: HashSet<String> = HashSet::new();
    dirs.filter(move |dir| {
        let key = dir
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase();
        !key.is_empty() && seen.insert(key)
    })
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;

    fn job(quality: QualityPreset) -> ExportJob {
        ExportJob {
            input: "C:\\clips\\my video.mp4".to_string(),
            output: "C:\\clips\\my video_clip.mp4".to_string(),
            in_point: 1.5,
            out_point: 11.5,
            speed: 1.0,
            ramp: Vec::new(),
            orientation: Orientation::default(),
            crop: None,
            mute: false,
            reverse: false,
            normalize: false,
            volume: 1.0,
            format: ExportFormat::Mp4,
            quality,
            target_mb: None,
            lossless: false,
            output_height: None,
            video_kbps: None,
            effects: Effects::default(),
        }
    }

    /// A size-target job. The preset carries no number of its own any more, so
    /// the two always travel together.
    fn fit_job(target_mb: f64) -> ExportJob {
        let mut j = job(QualityPreset::Fit);
        j.target_mb = Some(target_mb);
        j
    }

    fn index_of(args: &[String], needle: &str) -> Option<usize> {
        args.iter().position(|a| a == needle)
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        index_of(args, flag)
            .and_then(|i| args.get(i + 1))
            .map(|s| s.as_str())
    }

    fn has(args: &[String], flag: &str) -> bool {
        index_of(args, flag).is_some()
    }

    /// Asserts `pair` appears as two consecutive arguments.
    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|w| w[0] == flag && w[1] == value)
    }

    /// The font is a fact about the machine, so the tests name one rather than looking for it.
    fn font() -> PathBuf {
        PathBuf::from("C:\\Windows\\Fonts\\arial.ttf")
    }

    fn overlay(text: &str) -> TextOverlay {
        TextOverlay {
            text: text.to_string(),
            size: 0.07,
            color: "#ffcc00".to_string(),
            opacity: 0.9,
            anchor_x: TextAnchorX::Center,
            anchor_y: TextAnchorY::Bottom,
            boxed: false,
        }
    }

    /// The -vf chain as one string, which is where every ordering assertion below looks.
    fn vf(args: &[String]) -> String {
        value_after(args, "-vf")
            .or_else(|| value_after(args, "-filter_complex"))
            .unwrap_or("")
            .to_string()
    }

    // -- quick effects -------------------------------------------------------

    #[test]
    fn no_effects_switched_on_emit_no_filters_at_all() {
        // The whole point of Option-per-dial: an untouched effects tab costs nothing.
        let args = build_args(&job(QualityPreset::Balanced), "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-vf"), "{args:?}");
    }

    #[test]
    fn brightness_multiplies_rather_than_adding_so_the_preview_agrees() {
        // eq's own brightness is additive; CSS brightness() multiplies. The preview can only
        // do the second, so the export has to as well.
        let mut j = job(QualityPreset::Balanced);
        j.effects.brightness = Some(1.25);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(vf(&args), "colorchannelmixer=rr=1.25:gg=1.25:bb=1.25");
    }

    #[test]
    fn contrast_and_saturation_share_one_eq() {
        let mut j = job(QualityPreset::Balanced);
        j.effects.contrast = Some(1.3);
        j.effects.saturation = Some(0.7);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(vf(&args), "eq=contrast=1.3:saturation=0.7");
    }

    #[test]
    fn each_colour_dial_can_stand_alone_in_the_eq() {
        let mut j = job(QualityPreset::Balanced);
        j.effects.saturation = Some(0.0);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(vf(&args), "eq=saturation=0.0");
    }

    #[test]
    fn the_vignette_slider_maps_onto_the_lens_angle() {
        let mut j = job(QualityPreset::Balanced);
        j.effects.vignette = Some(1.0);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        // Full strength stops short of PI/2, which vignette clips at and which is a black
        // frame with a dot in the middle rather than a picture.
        assert_eq!(vf(&args), format!("vignette=angle={}", fmt_num(VIGNETTE_MAX_ANGLE)));
    }

    #[test]
    fn blur_goes_in_before_the_scale_and_text_after_it() {
        // A sigma is in source pixels. Blurring first keeps it proportional at any export
        // size; drawing the text last keeps the letters crisp at the size they end up.
        let mut j = job(QualityPreset::Balanced);
        j.effects.blur = Some(6.0);
        j.effects.text = Some(overlay("hello"));
        j.output_height = Some(720);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, Some(&font()));
        let chain = vf(&args);

        let blur = chain.find("gblur").expect("no blur in the chain");
        let scale = chain.find("scale=").expect("no scale in the chain");
        let text = chain.find("drawtext").expect("no text in the chain");
        assert!(blur < scale && scale < text, "{chain}");
    }

    #[test]
    fn the_overlay_text_never_enters_the_filtergraph() {
        // A colon separates filter options, a quote opens a quoted section and a percent sign
        // starts an expansion. All three are ordinary things to type into a caption, so the
        // words travel in a file and expansion is switched off rather than escaped.
        let mut j = job(QualityPreset::Balanced);
        j.effects.text = Some(overlay("50%: it's \\fine\\"));
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, Some(&font()));
        let chain = vf(&args);

        assert!(!chain.contains("it's"), "{chain}");
        assert!(!chain.contains("50%"), "{chain}");
        assert!(chain.contains(&format!("textfile={OVERLAY_TEXT_FILE}")), "{chain}");
        assert!(chain.contains("expansion=none"), "{chain}");
    }

    #[test]
    fn the_text_file_is_named_relative_to_ffmpegs_working_directory() {
        // Not a style choice: a filtergraph path must be quoted, and a quoted one cannot carry
        // an apostrophe - which the temp path under a user called O'Brien would. export.rs
        // sets the child's cwd to match, and the two only work together.
        let mut j = job(QualityPreset::Balanced);
        j.effects.text = Some(overlay("hi"));
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, Some(&font()));
        let chain = vf(&args);
        assert!(chain.contains(&format!("textfile={OVERLAY_TEXT_FILE}:")), "{chain}");
        assert!(!chain.contains("textfile='"), "{chain}");
    }

    #[test]
    fn the_font_path_is_quoted_with_its_drive_colon_escaped() {
        let mut j = job(QualityPreset::Balanced);
        j.effects.text = Some(overlay("hi"));
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, Some(&font()));
        assert!(
            vf(&args).contains("fontfile='C\\:/Windows/Fonts/arial.ttf'"),
            "{}",
            vf(&args)
        );
    }

    #[test]
    fn the_colour_input_hex_becomes_an_ffmpeg_colour() {
        assert_eq!(ffmpeg_color("#FFcc00"), "0xffcc00");
        assert_eq!(ffmpeg_color("112233"), "0x112233");
        // Anything unreadable falls back rather than emitting a filter ffmpeg will reject.
        assert_eq!(ffmpeg_color("rebeccapurple"), "0xffffff");
        assert_eq!(ffmpeg_color("#12345"), "0xffffff");
    }

    #[test]
    fn every_text_anchor_maps_onto_a_pair_of_drawtext_expressions() {
        let cases = [
            (TextAnchorX::Left, TextAnchorY::Top, "x=h*0.04", "y=h*0.04"),
            (
                TextAnchorX::Center,
                TextAnchorY::Middle,
                "x=(w-text_w)/2",
                "y=(h-text_h)/2",
            ),
            (
                TextAnchorX::Right,
                TextAnchorY::Bottom,
                "x=w-text_w-h*0.04",
                "y=h-text_h-h*0.04",
            ),
        ];
        for (anchor_x, anchor_y, x, y) in cases {
            let mut j = job(QualityPreset::Balanced);
            let mut o = overlay("hi");
            o.anchor_x = anchor_x;
            o.anchor_y = anchor_y;
            j.effects.text = Some(o);
            let chain = vf(&build_args(&j, "libx264", true, 1920, 1080, 30.0, Some(&font())));
            assert!(chain.contains(&format!(":{x}:")), "{chain}");
            assert!(chain.contains(&format!(":{y}")), "{chain}");
        }
    }

    #[test]
    fn the_text_is_dropped_rather_than_half_emitted_when_no_font_was_found() {
        // build_args is handed None when the machine has no usable font. Emitting drawtext
        // without a fontfile would fail the whole export over one optional overlay.
        let mut j = job(QualityPreset::Balanced);
        j.effects.text = Some(overlay("hi"));
        j.effects.blur = Some(4.0);
        let chain = vf(&build_args(&j, "libx264", true, 1920, 1080, 30.0, None));
        assert!(!chain.contains("drawtext"), "{chain}");
        assert!(chain.contains("gblur"), "{chain}");
    }

    #[test]
    fn fades_are_measured_on_the_output_timeline_not_the_source_one() {
        // A 10 s trim at 2x is a 5 s clip, so a fade out one second long starts at 4.
        let mut j = job(QualityPreset::Balanced);
        j.speed = 2.0;
        j.effects.fade_out = Some(1.0);
        let chain = vf(&build_args(&j, "libx264", true, 1920, 1080, 30.0, None));
        assert!(chain.contains("fade=t=out:st=4.000:d=1.000"), "{chain}");
    }

    #[test]
    fn a_fade_longer_than_the_clip_is_trimmed_to_the_clip() {
        let mut j = job(QualityPreset::Balanced);
        j.out_point = j.in_point + 2.0;
        j.effects.fade_in = Some(30.0);
        j.effects.fade_out = Some(30.0);
        let chain = vf(&build_args(&j, "libx264", true, 1920, 1080, 30.0, None));
        assert!(chain.contains("fade=t=in:st=0:d=2.000"), "{chain}");
        assert!(chain.contains("fade=t=out:st=0.000:d=2.000"), "{chain}");
    }

    #[test]
    fn fades_sit_after_reverse_in_both_chains() {
        // reverse is the last filter that changes which end is the start, so a fade in put
        // ahead of it would be seen as a fade out.
        let mut j = job(QualityPreset::Balanced);
        j.reverse = true;
        j.effects.fade_in = Some(0.5);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);

        let chain = vf(&args);
        assert!(
            chain.find("reverse").unwrap() < chain.find("fade=t=in").unwrap(),
            "{chain}"
        );

        let audio = value_after(&args, "-af").unwrap_or("");
        assert!(
            audio.find("areverse").unwrap() < audio.find("afade=t=in").unwrap(),
            "{audio}"
        );
    }

    #[test]
    fn the_audio_fades_with_the_picture() {
        let mut j = job(QualityPreset::Balanced);
        j.effects.fade_in = Some(0.5);
        j.effects.fade_out = Some(1.5);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-af"),
            Some("afade=t=in:st=0:d=0.500,afade=t=out:st=8.500:d=1.500")
        );
    }

    #[test]
    fn an_audio_only_export_fades_but_takes_no_picture_effects() {
        let mut j = job(QualityPreset::Balanced);
        j.format = ExportFormat::Mp3;
        j.output = "C:\\clips\\out.mp3".to_string();
        j.effects.fade_in = Some(0.5);
        j.effects.blur = Some(9.0);
        j.effects.text = Some(overlay("hi"));
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, Some(&font()));

        assert!(value_after(&args, "-af").unwrap().contains("afade=t=in"), "{args:?}");
        assert!(!has(&args, "-vf"), "{args:?}");
        assert!(!args.iter().any(|a| a.contains("gblur") || a.contains("drawtext")), "{args:?}");
    }

    #[test]
    fn a_silent_source_gets_no_afade_either() {
        let mut j = job(QualityPreset::Balanced);
        j.effects.fade_in = Some(0.5);
        let args = build_args(&j, "libx264", false, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-af"), "{args:?}");
        assert!(vf(&args).contains("fade=t=in"), "{args:?}");
    }

    #[test]
    fn the_gif_chain_carries_the_effects_into_its_filter_complex() {
        let mut j = job(QualityPreset::Balanced);
        j.format = ExportFormat::Gif;
        j.output = "C:\\clips\\out.gif".to_string();
        j.effects.blur = Some(3.0);
        j.effects.text = Some(overlay("hi"));
        j.effects.fade_in = Some(0.5);
        let chain = value_after(&build_args(&j, "libx264", true, 1920, 1080, 30.0, Some(&font())), "-filter_complex")
            .unwrap()
            .to_string();

        // Everything still has to land ahead of the palette pass, which is the only branch.
        let palette = chain.find("palettegen").expect("no palette pass");
        for needle in ["gblur", "drawtext", "fade=t=in"] {
            let at = chain.find(needle).unwrap_or_else(|| panic!("no {needle} in {chain}"));
            assert!(at < palette, "{needle} landed after the palette: {chain}");
        }
    }

    #[test]
    fn a_lossless_job_emits_no_effect_filters() {
        // export.rs refuses this combination; build_args is reached anyway by the tests, and
        // the stream-copy branch returns before any filter is considered.
        let mut j = job(QualityPreset::Balanced);
        j.lossless = true;
        j.effects.blur = Some(4.0);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-vf"), "{args:?}");
        assert!(has_pair(&args, "-c", "copy"), "{args:?}");
    }

    // -- the IPC shape -------------------------------------------------------

    #[test]
    fn export_job_deserialises_the_camel_case_ipc_shape() {
        // This JSON is what the frontend's invoke() actually sends: a drifted serde rename fails
        // every export at the boundary, and this test is what names the field.
        let json = r#"{
            "input": "a.mp4", "output": "b.m4a",
            "inPoint": 0.0, "outPoint": 2.0,
            "speed": 1.0, "crop": null, "mute": false,
            "reverse": true, "normalize": true, "volume": 1.5,
            "format": "m4a", "quality": "fit",
            "targetMb": 2.5, "lossless": false,
            "outputHeight": 720, "videoKbps": null
        }"#;
        let j: ExportJob = serde_json::from_str(json).unwrap();
        assert!(j.reverse);
        assert!(j.normalize);
        assert_eq!(j.volume, 1.5);
        assert_eq!(j.format, ExportFormat::M4a);
        assert_eq!(j.quality, QualityPreset::Fit);
        assert_eq!(j.target_mb, Some(2.5));
        assert_eq!(j.output_height, Some(720));
        assert_eq!(j.video_kbps, None);
    }

    // -- trim ---------------------------------------------------------------

    #[test]
    fn lossless_trim_is_a_stream_copy_with_no_filters() {
        let mut j = job(QualityPreset::Balanced);
        j.lossless = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);

        assert_eq!(
            args,
            vec![
                "-y",
                "-progress",
                "pipe:1",
                "-nostats",
                "-ss",
                "1.500",
                "-t",
                "10.000",
                "-i",
                "C:\\clips\\my video.mp4",
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "+faststart",
                "C:\\clips\\my video_clip.mp4",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<String>>()
        );
    }

    #[test]
    fn lossless_on_a_silent_file_omits_the_audio_map() {
        let mut j = job(QualityPreset::Balanced);
        j.lossless = true;
        let args = build_args(&j, "libx264", false, 1920, 1080, 30.0, None);
        assert!(!has_pair(&args, "-map", "0:a:0?"));
        assert!(has_pair(&args, "-map", "0:v:0"));
        assert!(has_pair(&args, "-c", "copy"));
    }

    #[test]
    fn lossless_into_mkv_is_a_stream_copy_without_movflags() {
        // The mkv escape hatch of losslessEligible: any codec fits in
        // Matroska, but the Matroska muxer does not own -movflags.
        let mut j = job(QualityPreset::Balanced);
        j.lossless = true;
        j.format = ExportFormat::Mkv;
        j.output = "C:\\clips\\my video_clip.mkv".to_string();
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(has_pair(&args, "-c", "copy"));
        assert!(!has(&args, "-movflags"));
        assert_eq!(args.last().unwrap(), "C:\\clips\\my video_clip.mkv");
    }

    #[test]
    fn trim_uses_input_side_duration_not_output_side_to() {
        let mut j = job(QualityPreset::Balanced);
        j.in_point = 4.0;
        j.out_point = 9.0;
        j.speed = 2.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);

        // -t is the source window (5s), unaffected by the 2x speed, and both
        // seek flags sit in front of -i.
        assert_eq!(value_after(&args, "-ss"), Some("4.000"));
        assert_eq!(value_after(&args, "-t"), Some("5.000"));
        assert!(!has(&args, "-to"));
        assert!(index_of(&args, "-ss").unwrap() < index_of(&args, "-i").unwrap());
        assert!(index_of(&args, "-t").unwrap() < index_of(&args, "-i").unwrap());
    }

    #[test]
    fn output_duration_divides_the_trim_by_speed() {
        let mut j = job(QualityPreset::Balanced);
        j.in_point = 2.0;
        j.out_point = 12.0;
        j.speed = 2.0;
        assert!((output_duration(&j) - 5.0).abs() < 1e-9);
        j.speed = 0.25;
        assert!((output_duration(&j) - 40.0).abs() < 1e-9);
        j.speed = 0.0;
        assert_eq!(output_duration(&j), 0.0);
        j.speed = 1.0;
        j.out_point = 1.0;
        assert_eq!(output_duration(&j), 0.0);
    }

    // -- speed --------------------------------------------------------------

    #[test]
    fn a_curve_settles_the_frame_rate_where_a_single_speed_does_not_need_to() {
        // One speed leaves the clip evenly spaced, just at another rate, and the muxer writes
        // that as it stands. A curve leaves frames bunched where it ran fast, and ffmpeg's own
        // conversion to a constant rate overshoots the length the audio is padded to.
        let mut j = job(QualityPreset::High);
        j.speed = 2.0;
        let graph = build_args(&j, "libx264", true, 1920, 1080, 30.0, None).join(" ");
        assert!(graph.contains("setpts=PTS/2.0"), "{graph}");
        assert!(!graph.contains("fps=30"), "{graph}");

        j.speed = 1.0;
        j.ramp = vec![
            SpeedPoint { t: 0.0, speed: 1.0 },
            SpeedPoint { t: 2.0, speed: 4.0 },
        ];
        let graph = build_args(&j, "libx264", true, 1920, 1080, 30.0, None).join(" ");
        assert!(graph.contains("setpts='("), "{graph}");
        assert!(graph.contains("fps=30"), "{graph}");
        // The expression itself, not a division: a curve has no single speed to divide by.
        assert!(!graph.contains("setpts=PTS/"), "{graph}");
    }


    #[test]
    fn atempo_chains_outside_its_supported_range() {
        assert_eq!(atempo_chain(1.0), Vec::<String>::new());
        assert_eq!(atempo_chain(0.5), vec!["atempo=0.5"]);
        assert_eq!(atempo_chain(2.0), vec!["atempo=2.0"]);
        assert_eq!(atempo_chain(0.25), vec!["atempo=0.5", "atempo=0.5"]);
        assert_eq!(atempo_chain(4.0), vec!["atempo=2.0", "atempo=2.0"]);
        assert_eq!(atempo_chain(1.5), vec!["atempo=1.5"]);
        assert_eq!(atempo_chain(0.75), vec!["atempo=0.75"]);
        assert_eq!(atempo_chain(3.0), vec!["atempo=2.0", "atempo=1.5"]);
        assert_eq!(atempo_chain(0.3), vec!["atempo=0.5", "atempo=0.6"]);
    }

    #[test]
    fn atempo_chains_the_full_widened_range() {
        // 0.05 and 20 are the extremes the number input allows: four halving stages bring 0.05 up to
        // 0.8, four doubling stages bring 20 down to 1.25, every one inside atempo's 0.5..2.0 window.
        assert_eq!(
            atempo_chain(0.05),
            vec![
                "atempo=0.5",
                "atempo=0.5",
                "atempo=0.5",
                "atempo=0.5",
                "atempo=0.8"
            ]
        );
        assert_eq!(
            atempo_chain(20.0),
            vec![
                "atempo=2.0",
                "atempo=2.0",
                "atempo=2.0",
                "atempo=2.0",
                "atempo=1.25"
            ]
        );
    }

    #[test]
    fn atempo_stages_multiply_back_to_the_requested_speed() {
        for speed in [0.05f64, 0.1, 0.25, 0.3, 0.5, 0.75, 1.5, 2.0, 3.0, 4.0, 8.0, 20.0] {
            let product: f64 = atempo_chain(speed)
                .iter()
                .map(|part| part.trim_start_matches("atempo=").parse::<f64>().unwrap())
                .product();
            assert!(
                (product - speed).abs() < 1e-6,
                "chain for {} multiplied to {}",
                speed,
                product
            );
        }
    }

    #[test]
    fn speed_sets_both_setpts_and_atempo() {
        let mut j = job(QualityPreset::Balanced);
        j.speed = 0.25;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("setpts=PTS/0.25"));
        assert_eq!(value_after(&args, "-af"), Some("atempo=0.5,atempo=0.5"));

        j.speed = 4.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("setpts=PTS/4.0"));
        assert_eq!(value_after(&args, "-af"), Some("atempo=2.0,atempo=2.0"));

        j.speed = 2.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-af"), Some("atempo=2.0"));
    }

    #[test]
    fn speed_of_one_emits_no_filters_at_all() {
        let args = build_args(
            &job(QualityPreset::Balanced),
            "libx264",
            true,
            1920,
            1080,
            30.0,
            None,
        );
        assert!(!has(&args, "-vf"));
        assert!(!has(&args, "-af"));
    }

    #[test]
    fn muted_and_silent_sources_get_no_atempo() {
        let mut j = job(QualityPreset::Balanced);
        j.speed = 2.0;
        j.mute = true;
        assert!(!has(
            &build_args(&j, "libx264", true, 1920, 1080, 30.0, None),
            "-af"
        ));

        j.mute = false;
        assert!(!has(
            &build_args(&j, "libx264", false, 1920, 1080, 30.0, None),
            "-af"
        ));
    }

    // -- volume -------------------------------------------------------------

    #[test]
    fn volume_sits_after_atempo_and_unity_volume_is_omitted() {
        let mut j = job(QualityPreset::Balanced);
        j.speed = 2.0;
        j.volume = 1.5;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-af"), Some("atempo=2.0,volume=1.5"));

        // 1.0 is "unchanged": the filter must vanish, not read volume=1.0.
        j.volume = 1.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-af"), Some("atempo=2.0"));

        // A very quiet source needs far more than the slider's 200%, and the filter takes it.
        j.volume = 9.5;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-af"), Some("atempo=2.0,volume=9.5"));

        // Volume alone still produces an -af.
        j.speed = 1.0;
        j.volume = 0.5;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-af"), Some("volume=0.5"));
    }

    #[test]
    fn normalising_replaces_the_manual_gain_and_sits_after_the_tempo_change() {
        let mut j = job(QualityPreset::Balanced);
        j.normalize = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-af"),
            Some("loudnorm=I=-16:TP=-1.5:LRA=11")
        );

        // atempo first, so loudnorm measures the audio at the speed it will be heard at.
        j.speed = 2.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-af"),
            Some("atempo=2.0,loudnorm=I=-16:TP=-1.5:LRA=11")
        );

        // The pair the UI actually produces: normalise to a known level, then trim from it.
        j.speed = 1.0;
        j.volume = 0.5;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-af"),
            Some("loudnorm=I=-16:TP=-1.5:LRA=11,volume=0.5")
        );
    }

    #[test]
    fn normalising_a_muted_export_emits_nothing() {
        let mut j = job(QualityPreset::Balanced);
        j.normalize = true;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-af"), "{args:?}");
    }

    #[test]
    fn volume_on_a_muted_export_emits_nothing() {
        let mut j = job(QualityPreset::Balanced);
        j.volume = 2.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-af"));
    }

    // -- reverse ------------------------------------------------------------

    #[test]
    fn reverse_is_appended_last_in_both_filter_chains() {
        let mut j = job(QualityPreset::Balanced);
        j.speed = 2.0;
        j.volume = 1.5;
        j.reverse = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("setpts=PTS/2.0,reverse"));
        assert_eq!(
            value_after(&args, "-af"),
            Some("atempo=2.0,volume=1.5,areverse")
        );
    }

    #[test]
    fn reverse_comes_after_the_fit_downscale() {
        // reverse buffers every frame it is handed, so it has to sit behind
        // the scale filter where the frames are already small.
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 60.0;
        j.mute = true;
        j.reverse = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("scale=1280:-2,reverse"));
    }

    #[test]
    fn reverse_alone_still_reverses_both_streams() {
        let mut j = job(QualityPreset::Balanced);
        j.reverse = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("reverse"));
        assert_eq!(value_after(&args, "-af"), Some("areverse"));
    }

    // -- crop ---------------------------------------------------------------

    #[test]
    fn crop_rounds_every_value_down_to_even() {
        let mut j = job(QualityPreset::Balanced);
        j.crop = Some(Rect {
            x: 101,
            y: 51,
            w: 641,
            h: 361,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("crop=640:360:100:50"));
    }

    #[test]
    fn crop_is_clamped_inside_the_frame() {
        let mut j = job(QualityPreset::Balanced);
        // A drag that ran off the right and bottom edges. The width and height are deliberately
        // smaller than the frame, so an implementation carrying the original w/h across the clamp
        // cannot pass by landing on the frame size anyway.
        j.crop = Some(Rect {
            x: 1800,
            y: 1000,
            w: 400,
            h: 400,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("crop=120:80:1800:1000"));
    }

    #[test]
    fn a_negative_crop_origin_keeps_the_region_the_user_dragged() {
        let mut j = job(QualityPreset::Balanced);
        // The pointer left the window mid-drag. The visible selection is 0..370 across and 0..390
        // down, so taking the width from the rect instead of its right edge would emit 400x400 and
        // shift the whole region.
        j.crop = Some(Rect {
            x: -30,
            y: -10,
            w: 400,
            h: 400,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("crop=370:390:0:0"));

        // Overhanging both ends at once still yields the whole frame.
        j.crop = Some(Rect {
            x: -30,
            y: -10,
            w: 4000,
            h: 4000,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("crop=1920:1080:0:0"));
    }

    #[test]
    fn a_degenerate_crop_is_dropped_rather_than_failing_the_export() {
        let mut j = job(QualityPreset::Balanced);
        j.crop = Some(Rect {
            x: 0,
            y: 0,
            w: 1,
            h: 1,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-vf"));

        j.crop = Some(Rect {
            x: 1920,
            y: 1080,
            w: 100,
            h: 100,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-vf"));
    }

    #[test]
    fn crop_comes_before_setpts_and_scale_in_the_chain() {
        let mut j = job(QualityPreset::Balanced);
        j.crop = Some(Rect {
            x: 10,
            y: 20,
            w: 1280,
            h: 720,
        });
        j.speed = 2.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-vf"),
            Some("crop=1280:720:10:20,setpts=PTS/2.0")
        );
    }

    // -- mute ---------------------------------------------------------------

    #[test]
    fn mute_drops_the_audio_map_and_adds_an() {
        let mut j = job(QualityPreset::Balanced);
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(has(&args, "-an"));
        assert!(has_pair(&args, "-map", "0:v:0"));
        assert!(!has_pair(&args, "-map", "0:a:0?"));
        assert!(!has(&args, "-c:a"));
        assert!(!has(&args, "-b:a"));
    }

    #[test]
    fn a_silent_source_gets_no_audio_flags_but_no_an_either() {
        let args = build_args(
            &job(QualityPreset::Balanced),
            "libx264",
            false,
            1920,
            1080,
            30.0,
            None,
        );
        assert!(!has_pair(&args, "-map", "0:a:0?"));
        assert!(!has(&args, "-c:a"));
        // The explicit video-only map already excludes audio, so -an would be
        // noise; asserting it stays out keeps the vector honest.
        assert!(!has(&args, "-an"));
    }

    // -- quality ------------------------------------------------------------

    #[test]
    fn libx264_uses_crf_and_the_veryfast_preset() {
        for (quality, crf, abr) in [
            (QualityPreset::High, "18", "160k"),
            (QualityPreset::Balanced, "23", "128k"),
            (QualityPreset::Small, "28", "96k"),
        ] {
            let args = build_args(&job(quality), "libx264", true, 1920, 1080, 30.0, None);
            assert!(has_pair(&args, "-c:v", "libx264"));
            assert!(has_pair(&args, "-preset", "veryfast"), "{:?}", quality);
            assert_eq!(value_after(&args, "-crf"), Some(crf), "{:?}", quality);
            assert_eq!(value_after(&args, "-b:a"), Some(abr), "{:?}", quality);
            assert!(has_pair(&args, "-c:a", "aac"));
            assert!(!has(&args, "-cq"));
            assert!(!has(&args, "-global_quality"));
        }
    }

    #[test]
    fn nvenc_uses_cq_with_an_explicit_zero_bitrate() {
        for (quality, cq) in [
            (QualityPreset::High, "19"),
            (QualityPreset::Balanced, "24"),
            (QualityPreset::Small, "29"),
        ] {
            let args = build_args(&job(quality), "h264_nvenc", true, 1920, 1080, 30.0, None);
            assert!(has_pair(&args, "-c:v", "h264_nvenc"));
            assert!(has_pair(&args, "-rc", "vbr"));
            assert_eq!(value_after(&args, "-cq"), Some(cq));
            // Without this the VBR controller ignores -cq and caps the stream.
            assert!(has_pair(&args, "-b:v", "0"));
            assert!(!has(&args, "-crf"));
            assert!(!has(&args, "-preset"));
        }
    }

    #[test]
    fn qsv_uses_global_quality() {
        for (quality, gq) in [
            (QualityPreset::High, "19"),
            (QualityPreset::Balanced, "24"),
            (QualityPreset::Small, "29"),
        ] {
            let args = build_args(&job(quality), "h264_qsv", true, 1920, 1080, 30.0, None);
            assert!(has_pair(&args, "-c:v", "h264_qsv"));
            assert_eq!(value_after(&args, "-global_quality"), Some(gq));
            assert!(!has(&args, "-crf"));
            assert!(!has(&args, "-cq"));
        }
    }

    #[test]
    fn amf_uses_cqp_quantisers() {
        for (quality, qp) in [
            (QualityPreset::High, "19"),
            (QualityPreset::Balanced, "24"),
            (QualityPreset::Small, "29"),
        ] {
            let args = build_args(&job(quality), "h264_amf", true, 1920, 1080, 30.0, None);
            assert!(has_pair(&args, "-c:v", "h264_amf"));
            assert!(has_pair(&args, "-rc", "cqp"));
            assert_eq!(value_after(&args, "-qp_i"), Some(qp));
            assert_eq!(value_after(&args, "-qp_p"), Some(qp));
            assert_eq!(value_after(&args, "-qp_b"), Some(qp));
            assert!(!has(&args, "-crf"));
            assert!(!has(&args, "-global_quality"));
        }
    }

    // -- webm ---------------------------------------------------------------

    #[test]
    fn webm_uses_vp9_and_opus_with_the_speed_flags() {
        for (quality, crf) in [
            (QualityPreset::High, "30"),
            (QualityPreset::Balanced, "34"),
            (QualityPreset::Small, "38"),
        ] {
            let mut j = job(quality);
            j.format = ExportFormat::Webm;
            j.output = "C:\\clips\\out.webm".to_string();
            // The encoder argument is the detected h264 hardware encoder; a
            // webm job must ignore it entirely.
            let args = build_args(&j, "h264_nvenc", true, 1920, 1080, 30.0, None);
            assert!(has_pair(&args, "-c:v", "libvpx-vp9"), "{:?}", quality);
            assert!(!has_pair(&args, "-c:v", "h264_nvenc"));
            assert!(has_pair(&args, "-b:v", "0"));
            assert_eq!(value_after(&args, "-crf"), Some(crf), "{:?}", quality);
            assert!(has_pair(&args, "-row-mt", "1"));
            assert!(has_pair(&args, "-cpu-used", "4"));
            assert!(has_pair(&args, "-c:a", "libopus"));
            assert_eq!(value_after(&args, "-b:a"), Some("128k"));
            assert!(has_pair(&args, "-pix_fmt", "yuv420p"));
            assert!(!has(&args, "-movflags"));
            assert!(!has(&args, "-preset"));
            assert!(!has(&args, "-cq"));
        }
    }

    #[test]
    fn webm_fit_computes_a_constrained_vp9_bitrate() {
        let mut j = fit_job(10.0);
        j.format = ExportFormat::Webm;
        j.output = "C:\\clips\\out.webm".to_string();
        j.in_point = 0.0;
        j.out_point = 20.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        // (10_000_000 * 8 * 0.93 - 0) / 20 / 1000 = 3720
        assert!(has_pair(&args, "-c:v", "libvpx-vp9"));
        assert_eq!(value_after(&args, "-b:v"), Some("3720k"));
        assert_eq!(value_after(&args, "-maxrate"), Some("3720k"));
        assert_eq!(value_after(&args, "-bufsize"), Some("7440k"));
        assert!(has_pair(&args, "-row-mt", "1"));
        assert!(!has(&args, "-crf"));

        // With audio, the 128k opus allowance comes off the video budget:
        // (10_000_000 * 8 * 0.93 - 128_000 * 20) / 20 / 1000 = 3592
        j.mute = false;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-b:v"), Some("3592k"));
        assert!(has_pair(&args, "-c:a", "libopus"));
        assert_eq!(value_after(&args, "-b:a"), Some("128k"));
    }

    // -- gif ----------------------------------------------------------------

    #[test]
    fn gif_builds_the_palette_chain_for_each_quality() {
        for (quality, expected) in [
            (
                QualityPreset::High,
                "fps=20,scale='min(iw,640)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
            ),
            (
                QualityPreset::Balanced,
                "fps=15,scale='min(iw,480)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
            ),
            (
                QualityPreset::Small,
                "fps=10,scale='min(iw,360)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
            ),
        ] {
            let mut j = job(quality);
            j.format = ExportFormat::Gif;
            j.output = "C:\\clips\\out.gif".to_string();
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
            assert_eq!(
                value_after(&args, "-filter_complex"),
                Some(expected),
                "{:?}",
                quality
            );
            assert!(has_pair(&args, "-loop", "0"), "{:?}", quality);
            // The graph output is the only mapped stream, so none of the
            // stream-selection or video-codec flags may appear.
            assert!(!has(&args, "-map"));
            assert!(!has(&args, "-an"));
            assert!(!has(&args, "-vf"));
            assert!(!has(&args, "-c:v"));
            assert!(!has(&args, "-c:a"));
            assert!(!has(&args, "-pix_fmt"));
            assert!(!has(&args, "-movflags"));
            assert_eq!(args.last().unwrap(), "C:\\clips\\out.gif");
        }
    }

    #[test]
    fn gif_prepends_crop_setpts_and_reverse_into_the_complex_chain() {
        let mut j = job(QualityPreset::Balanced);
        j.format = ExportFormat::Gif;
        j.output = "C:\\clips\\out.gif".to_string();
        j.crop = Some(Rect {
            x: 10,
            y: 20,
            w: 1280,
            h: 720,
        });
        j.speed = 2.0;
        j.reverse = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-filter_complex"),
            Some(
                "crop=1280:720:10:20,setpts=PTS/2.0,reverse,fps=15,scale='min(iw,480)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5"
            )
        );
    }

    // -- audio-only formats --------------------------------------------------

    #[test]
    fn audio_formats_pick_the_right_codec_and_bitrate_per_quality() {
        for (format, ext, codec, rates) in [
            (ExportFormat::Mp3, "mp3", "libmp3lame", ["256k", "192k", "128k"]),
            (ExportFormat::M4a, "m4a", "aac", ["256k", "160k", "96k"]),
            (ExportFormat::Opus, "opus", "libopus", ["192k", "128k", "96k"]),
        ] {
            for (quality, rate) in [
                (QualityPreset::High, rates[0]),
                (QualityPreset::Balanced, rates[1]),
                (QualityPreset::Small, rates[2]),
            ] {
                let mut j = job(quality);
                j.format = format;
                j.output = format!("C:\\clips\\out.{}", ext);
                let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
                assert!(has(&args, "-vn"), "{:?} {:?}", format, quality);
                assert!(has_pair(&args, "-map", "0:a:0"), "{:?}", format);
                assert!(has_pair(&args, "-c:a", codec), "{:?} {:?}", format, quality);
                assert_eq!(
                    value_after(&args, "-b:a"),
                    Some(rate),
                    "{:?} {:?}",
                    format,
                    quality
                );
                // Nothing video-shaped may leak into an audio export.
                assert!(!has(&args, "-c:v"), "{:?}", format);
                assert!(!has(&args, "-pix_fmt"), "{:?}", format);
                assert!(!has(&args, "-vf"), "{:?}", format);
            }
        }
    }

    #[test]
    fn wav_and_flac_ignore_the_quality_dial() {
        for (format, ext, codec) in [
            (ExportFormat::Wav, "wav", "pcm_s16le"),
            (ExportFormat::Flac, "flac", "flac"),
        ] {
            for quality in [QualityPreset::High, QualityPreset::Small] {
                let mut j = job(quality);
                j.format = format;
                j.output = format!("C:\\clips\\out.{}", ext);
                let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
                assert!(has_pair(&args, "-c:a", codec), "{:?}", format);
                assert!(!has(&args, "-b:a"), "{:?} {:?}", format, quality);
                assert!(!has(&args, "-q:a"), "{:?} {:?}", format, quality);
            }
        }
    }

    #[test]
    fn ogg_uses_the_vorbis_quality_scale() {
        for (quality, q) in [
            (QualityPreset::High, "7"),
            (QualityPreset::Balanced, "5"),
            (QualityPreset::Small, "3"),
        ] {
            let mut j = job(quality);
            j.format = ExportFormat::Ogg;
            j.output = "C:\\clips\\out.ogg".to_string();
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
            assert!(has_pair(&args, "-c:a", "libvorbis"));
            assert_eq!(value_after(&args, "-q:a"), Some(q), "{:?}", quality);
            assert!(!has(&args, "-b:a"), "{:?}", quality);
        }
    }

    #[test]
    fn audio_exports_apply_speed_volume_and_reverse() {
        let mut j = job(QualityPreset::Balanced);
        j.format = ExportFormat::Mp3;
        j.output = "C:\\clips\\out.mp3".to_string();
        j.speed = 2.0;
        j.volume = 0.5;
        j.reverse = true;
        // Crop is irrelevant on this path - the video it would apply to is
        // dropped by -vn - and must not sneak in as a -vf.
        j.crop = Some(Rect {
            x: 0,
            y: 0,
            w: 640,
            h: 360,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-af"),
            Some("atempo=2.0,volume=0.5,areverse")
        );
        assert!(!has(&args, "-vf"));
    }

    #[test]
    fn audio_fit_gives_the_whole_budget_to_the_bitrate() {
        let mut j = fit_job(2.0);
        j.format = ExportFormat::Mp3;
        j.output = "C:\\clips\\out.mp3".to_string();
        j.in_point = 0.0;
        j.out_point = 60.0;
        // (2_000_000 * 8 * 0.93) / 60 / 1000 = 248 - no audio allowance to
        // subtract because the audio IS the budget.
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(has_pair(&args, "-c:a", "libmp3lame"));
        assert_eq!(value_after(&args, "-b:a"), Some("248k"));
        assert!(!has(&args, "-b:v"));
        assert!(!has(&args, "-maxrate"));

        // A pathological budget clamps to the 32k floor instead of asking lame
        // for a rate it refuses.
        let mut j = fit_job(0.5);
        j.format = ExportFormat::Mp3;
        j.output = "C:\\clips\\out.mp3".to_string();
        j.in_point = 0.0;
        j.out_point = 200.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-b:a"), Some("32k"));
    }

    #[test]
    fn ogg_fit_switches_from_quality_scale_to_bitrate() {
        let mut j = fit_job(2.0);
        j.format = ExportFormat::Ogg;
        j.output = "C:\\clips\\out.ogg".to_string();
        j.in_point = 0.0;
        j.out_point = 60.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(has_pair(&args, "-c:a", "libvorbis"));
        assert_eq!(value_after(&args, "-b:a"), Some("248k"));
        assert!(!has(&args, "-q:a"));
    }

    // -- size targets -------------------------------------------------------

    #[test]
    fn fit_bitrate_arithmetic_muted() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 30.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);

        // (10_000_000 * 8 * 0.93 - 0) / 30 / 1000 = 2480
        assert_eq!(value_after(&args, "-b:v"), Some("2480k"));
        assert_eq!(value_after(&args, "-maxrate"), Some("2480k"));
        assert_eq!(value_after(&args, "-bufsize"), Some("4960k"));
        assert!(!has(&args, "-crf"));
    }

    #[test]
    fn fit_bitrate_arithmetic_subtracts_the_audio_allowance() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 20.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);

        // (10_000_000 * 8 * 0.93 - 128_000 * 20) / 20 / 1000 = 3592
        assert_eq!(value_after(&args, "-b:v"), Some("3592k"));
        assert_eq!(value_after(&args, "-bufsize"), Some("7184k"));
        assert_eq!(value_after(&args, "-b:a"), Some("128k"));
    }

    #[test]
    fn fit_bitrate_arithmetic_accounts_for_speed() {
        let mut j = fit_job(25.0);
        j.in_point = 0.0;
        j.out_point = 120.0;
        j.speed = 2.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);

        // Output is 60s long, not 120s:
        // (25_000_000 * 8 * 0.93 - 128_000 * 60) / 60 / 1000 = 2972
        assert_eq!(value_after(&args, "-b:v"), Some("2972k"));
        assert_eq!(value_after(&args, "-maxrate"), Some("2972k"));
    }

    #[test]
    fn a_fit_without_a_target_falls_back_to_constant_quality() {
        // export.rs validates target_mb whenever quality is Fit, so this pair should never arrive -
        // but a balanced CRF beats a panic or a 100 kbps slideshow.
        let mut j = job(QualityPreset::Fit);
        j.target_mb = None;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-b:v"));
        assert_eq!(value_after(&args, "-crf"), Some("23"));
    }

    #[test]
    fn a_size_target_on_a_hardware_encoder_still_uses_bitrate_not_cq() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 20.0;
        let args = build_args(&j, "h264_nvenc", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-b:v"), Some("3592k"));
        assert!(!has(&args, "-cq"));
        assert!(!has(&args, "-preset"));
    }

    // -- auto-downscale -----------------------------------------------------

    #[test]
    fn auto_downscale_does_not_fire_when_the_budget_is_comfortable() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 10.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        // 7440 kbps over 1920x1080x30 is 0.12 bpp, well clear of the floor.
        assert_eq!(value_after(&args, "-b:v"), Some("7440k"));
        assert!(!has(&args, "-vf"));
    }

    #[test]
    fn auto_downscale_steps_to_720p() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 60.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        // 1240 kbps is 0.020 bpp at 1080p and 0.045 bpp at 720p.
        assert_eq!(value_after(&args, "-b:v"), Some("1240k"));
        assert_eq!(value_after(&args, "-vf"), Some("scale=1280:-2"));
    }

    #[test]
    fn auto_downscale_keeps_stepping_when_720p_is_still_too_thin() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 120.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        // 620 kbps is 0.022 bpp at 720p and 0.050 bpp at 854x480.
        assert_eq!(value_after(&args, "-b:v"), Some("620k"));
        assert_eq!(value_after(&args, "-vf"), Some("scale=854:-2"));
    }

    #[test]
    fn auto_downscale_stops_at_the_bottom_rung() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 900.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("scale=640:-2"));
    }

    #[test]
    fn auto_downscale_never_upscales_a_small_source() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 900.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 640, 360, 30.0, None);
        assert!(!has(&args, "-vf"));
    }

    #[test]
    fn auto_downscale_measures_the_cropped_size_not_the_source_size() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 60.0;
        j.mute = true;
        // Cropping 1080p down to 720p already fixes the bits-per-pixel, so no
        // scale filter should be appended even though the source is 1080p.
        j.crop = Some(Rect {
            x: 0,
            y: 0,
            w: 1280,
            h: 720,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("crop=1280:720:0:0"));
    }

    #[test]
    fn auto_downscale_is_only_a_size_target_behaviour() {
        let mut j = job(QualityPreset::Small);
        j.in_point = 0.0;
        j.out_point = 900.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-vf"));
        assert!(!has(&args, "-b:v"));
    }

    // -- always-on flags ----------------------------------------------------

    #[test]
    fn every_reencode_carries_the_compatibility_and_progress_flags() {
        let mut j = job(QualityPreset::High);
        j.speed = 1.5;
        j.crop = Some(Rect {
            x: 4,
            y: 4,
            w: 800,
            h: 600,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);

        assert_eq!(args[0], "-y");
        assert!(has_pair(&args, "-pix_fmt", "yuv420p"));
        assert!(has_pair(&args, "-movflags", "+faststart"));
        assert!(has_pair(&args, "-progress", "pipe:1"));
        assert!(has(&args, "-nostats"));
        assert_eq!(args.last().unwrap(), "C:\\clips\\my video_clip.mp4");
    }

    #[test]
    fn a_non_mp4_output_does_not_get_movflags() {
        // The mov/mp4 muxer owns -movflags, so passing it to the Matroska or
        // WebM muxer aborts the run outright.
        for (name, format) in [
            ("out.mkv", ExportFormat::Mkv),
            ("out.webm", ExportFormat::Webm),
            ("out", ExportFormat::Mkv),
        ] {
            let mut j = job(QualityPreset::Balanced);
            j.format = format;
            j.output = format!("C:\\clips\\{}", name);
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
            assert!(!has(&args, "-movflags"), "{}", name);
            assert!(has_pair(&args, "-pix_fmt", "yuv420p"), "{}", name);

            j.lossless = true;
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
            assert!(!has(&args, "-movflags"), "lossless {}", name);
            assert_eq!(args.last().unwrap(), &format!("C:\\clips\\{}", name));
        }

        // The rest of the mp4 family keeps it, in both modes.
        for name in ["out.MP4", "out.m4v", "out.mov"] {
            let mut j = job(QualityPreset::Balanced);
            j.output = format!("C:\\clips\\{}", name);
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
            assert!(has_pair(&args, "-movflags", "+faststart"), "{}", name);

            j.lossless = true;
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
            assert!(
                has_pair(&args, "-movflags", "+faststart"),
                "lossless {}",
                name
            );
        }
    }

    #[test]
    fn faststart_covers_m4a_but_no_other_audio_container() {
        // .m4a is the mov/mp4 muxer wearing another extension, so it wants +faststart; every other
        // audio container's muxer would abort on the unknown option.
        let mut j = job(QualityPreset::Balanced);
        j.format = ExportFormat::M4a;
        j.output = "C:\\clips\\out.m4a".to_string();
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(has_pair(&args, "-movflags", "+faststart"));

        for (format, ext) in [
            (ExportFormat::Mp3, "mp3"),
            (ExportFormat::Wav, "wav"),
            (ExportFormat::Flac, "flac"),
            (ExportFormat::Ogg, "ogg"),
            (ExportFormat::Opus, "opus"),
        ] {
            let mut j = job(QualityPreset::Balanced);
            j.format = format;
            j.output = format!("C:\\clips\\out.{}", ext);
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
            assert!(!has(&args, "-movflags"), "{:?}", format);
        }
    }

    #[test]
    fn the_full_combination_produces_the_exact_expected_vector() {
        let mut j = job(QualityPreset::Balanced);
        j.in_point = 2.0;
        j.out_point = 12.0;
        j.speed = 2.0;
        j.crop = Some(Rect {
            x: 11,
            y: 21,
            w: 1281,
            h: 721,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);

        assert_eq!(
            args,
            vec![
                "-y",
                "-progress",
                "pipe:1",
                "-nostats",
                "-ss",
                "2.000",
                "-t",
                "10.000",
                "-i",
                "C:\\clips\\my video.mp4",
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-vf",
                "crop=1280:720:10:20,setpts=PTS/2.0",
                "-af",
                "atempo=2.0",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "C:\\clips\\my video_clip.mp4",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<String>>()
        );
    }

    // -- explicit output size ------------------------------------------------

    #[test]
    fn an_explicit_height_scales_the_short_edge_of_a_landscape_frame() {
        let mut j = job(QualityPreset::Balanced);
        j.output_height = Some(720);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        // "720p" names the height here, and -2 works out the width.
        assert_eq!(value_after(&args, "-vf"), Some("scale=-2:720"));
    }

    #[test]
    fn an_explicit_height_scales_the_width_of_a_portrait_frame() {
        let mut j = job(QualityPreset::Balanced);
        j.output_height = Some(720);
        let args = build_args(&j, "libx264", true, 1080, 1920, 30.0, None);
        // A phone clip's short edge is its width, so the same "720p" request
        // has to land on the other axis or the frame comes out 405 wide.
        assert_eq!(value_after(&args, "-vf"), Some("scale=720:-2"));
    }

    #[test]
    fn an_explicit_height_never_upscales() {
        for (source_w, source_h) in [(1280i64, 720i64), (720, 1280)] {
            for requested in [720, 1080, 2160] {
                let mut j = job(QualityPreset::Balanced);
                j.output_height = Some(requested);
                let args = build_args(&j, "libx264", true, source_w, source_h, 30.0, None);
                assert!(
                    !has(&args, "-vf"),
                    "{requested} on {source_w}x{source_h} emitted a scale filter"
                );
            }
        }
    }

    #[test]
    fn an_explicit_height_measures_the_crop_not_the_source() {
        let mut j = job(QualityPreset::Balanced);
        // A portrait region cut out of a landscape source: the crop decides
        // which axis is the short one, so this has to flip to a width scale.
        j.crop = Some(Rect {
            x: 0,
            y: 0,
            w: 608,
            h: 1080,
        });
        j.output_height = Some(480);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-vf"),
            Some("crop=608:1080:0:0,scale=480:-2")
        );

        // And a crop that is already smaller than the request is left alone.
        j.output_height = Some(720);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("crop=608:1080:0:0"));
    }

    #[test]
    fn the_scale_sits_between_setpts_and_reverse() {
        let mut j = job(QualityPreset::Balanced);
        j.crop = Some(Rect {
            x: 0,
            y: 0,
            w: 1920,
            h: 1080,
        });
        j.speed = 2.0;
        j.reverse = true;
        j.output_height = Some(480);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(
            value_after(&args, "-vf"),
            Some("crop=1920:1080:0:0,setpts=PTS/2.0,scale=-2:480,reverse")
        );
    }

    #[test]
    fn an_explicit_height_wins_over_the_fit_ladder() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 900.0;
        j.mute = true;
        // Left alone this budget walks the ladder all the way to 640 wide.
        j.output_height = Some(1080);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-vf"), "the ladder overrode the explicit height");

        j.output_height = Some(480);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-vf"), Some("scale=-2:480"));
    }

    #[test]
    fn gif_and_audio_formats_ignore_the_explicit_size_and_rate() {
        let mut j = job(QualityPreset::Balanced);
        j.output_height = Some(360);
        j.video_kbps = Some(4000);

        j.format = ExportFormat::Gif;
        j.output = "C:\\clips\\out.gif".to_string();
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        // The gif chain owns its own width and frame rate caps.
        assert_eq!(
            value_after(&args, "-filter_complex"),
            Some("fps=15,scale='min(iw,480)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5")
        );
        assert!(!has(&args, "-b:v"));

        j.format = ExportFormat::Mp3;
        j.output = "C:\\clips\\out.mp3".to_string();
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(!has(&args, "-vf"));
        assert!(!has(&args, "-b:v"));
        assert_eq!(value_after(&args, "-b:a"), Some("192k"));
    }

    // -- explicit bitrate ----------------------------------------------------

    #[test]
    fn an_explicit_bitrate_replaces_the_constant_quality_flags() {
        for encoder in ["libx264", "h264_nvenc", "h264_qsv", "h264_amf"] {
            let mut j = job(QualityPreset::High);
            j.video_kbps = Some(2500);
            let args = build_args(&j, encoder, true, 1920, 1080, 30.0, None);

            assert_eq!(value_after(&args, "-b:v"), Some("2500k"), "{encoder}");
            assert_eq!(value_after(&args, "-maxrate"), Some("2500k"), "{encoder}");
            assert_eq!(value_after(&args, "-bufsize"), Some("5000k"), "{encoder}");
            assert!(!has(&args, "-crf"), "{encoder}");
            assert!(!has(&args, "-cq"), "{encoder}");
            assert!(!has(&args, "-global_quality"), "{encoder}");
            assert!(!has(&args, "-qp_i"), "{encoder}");
            // The audio rate still comes from the quality preset.
            assert_eq!(value_after(&args, "-b:a"), Some("160k"), "{encoder}");
        }
    }

    #[test]
    fn an_explicit_bitrate_drives_vp9_too() {
        let mut j = job(QualityPreset::Balanced);
        j.format = ExportFormat::Webm;
        j.output = "C:\\clips\\out.webm".to_string();
        j.video_kbps = Some(1500);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert!(has_pair(&args, "-c:v", "libvpx-vp9"));
        assert_eq!(value_after(&args, "-b:v"), Some("1500k"));
        assert_eq!(value_after(&args, "-bufsize"), Some("3000k"));
        // -b:v 0 is the constant-quality spelling; with a real rate it must go.
        assert!(!has_pair(&args, "-b:v", "0"));
        assert!(!has(&args, "-crf"));
        assert!(has_pair(&args, "-row-mt", "1"));
    }

    #[test]
    fn a_size_target_overrides_an_explicit_bitrate() {
        // export.rs refuses this pair, so this only pins what a job that
        // skipped validation does: the target owns the rate.
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 30.0;
        j.mute = true;
        j.video_kbps = Some(9999);
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
        assert_eq!(value_after(&args, "-b:v"), Some("2480k"));
    }

    // -- size estimation -----------------------------------------------------

    #[test]
    fn the_estimate_of_an_explicit_bitrate_is_arithmetic() {
        let mut j = job(QualityPreset::Balanced);
        j.video_kbps = Some(2000);
        j.mute = true;
        // 2000 kbps across the 10 s trim.
        assert_eq!(
            estimate_output_bytes(&j, 1920, 1080, 30.0, true),
            2_500_000
        );

        // Unmuted adds the preset's 128k aac.
        j.mute = false;
        assert_eq!(
            estimate_output_bytes(&j, 1920, 1080, 30.0, true),
            2_660_000
        );
        // A source with no audio track pays nothing for one.
        assert_eq!(
            estimate_output_bytes(&j, 1920, 1080, 30.0, false),
            2_500_000
        );
    }

    #[test]
    fn the_estimate_of_a_size_target_is_the_budget_it_aimed_at() {
        let mut j = fit_job(10.0);
        j.in_point = 0.0;
        j.out_point = 20.0;
        j.mute = true;
        // The 0.93 overhead margin is deliberate undershoot, so the estimate
        // has to report 9.3 MB rather than the 10 MB the user typed.
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 9_300_000);

        // With audio the two streams still add back up to the same budget.
        j.mute = false;
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 9_300_000);
    }

    #[test]
    fn the_constant_quality_estimate_uses_bits_per_pixel() {
        let j = job(QualityPreset::Balanced);
        // 0.065 * 1920 * 1080 * 30 fps * 10 s, plus 128k of aac, in bytes.
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 5_214_400);

        let mut j = job(QualityPreset::Small);
        j.mute = true;
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 2_721_600);
    }

    #[test]
    fn the_estimate_counts_frames_rather_than_seconds_through_a_speed_change() {
        let mut j = job(QualityPreset::Balanced);
        j.speed = 2.0;
        // Half the output length at twice the frame rate: the same frames, so
        // only the audio allowance halves.
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 5_134_400);
    }

    #[test]
    fn the_estimate_measures_the_frame_after_crop_and_scale() {
        let mut j = job(QualityPreset::Balanced);
        j.output_height = Some(720);
        // 0.065 * 1280 * 720 * 30 * 10, plus the audio.
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 2_406_400);

        // A request the never-upscale rule drops must not shrink the estimate.
        j.output_height = Some(2160);
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 5_214_400);

        // Cropping counts even without a scale.
        j.output_height = None;
        j.crop = Some(Rect {
            x: 0,
            y: 0,
            w: 1280,
            h: 720,
        });
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 2_406_400);
    }

    #[test]
    fn the_estimate_of_an_audio_export_is_its_bitrate() {
        let mut j = job(QualityPreset::Balanced);
        j.format = ExportFormat::Mp3;
        j.output = "C:\\clips\\out.mp3".to_string();
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 240_000);
        // No audio track means no file worth predicting.
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, false), 0);

        let mut j = fit_job(2.0);
        j.format = ExportFormat::Mp3;
        j.in_point = 0.0;
        j.out_point = 60.0;
        // The 248k the fit arithmetic asks lame for, over 60 s.
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 1_860_000);
    }

    #[test]
    fn the_estimate_of_a_gif_counts_quantised_frames() {
        let mut j = job(QualityPreset::Balanced);
        j.format = ExportFormat::Gif;
        j.output = "C:\\clips\\out.gif".to_string();
        // 480x270 at the balanced 15 fps cap for 10 s.
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 6_804_000);
    }

    #[test]
    fn an_empty_or_unmeasurable_job_estimates_nothing() {
        let mut j = job(QualityPreset::Balanced);
        j.out_point = j.in_point;
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 0);

        let j = job(QualityPreset::Balanced);
        assert_eq!(estimate_output_bytes(&j, 0, 0, 30.0, true), 0);
    }

    #[test]
    fn a_lossless_trim_is_estimated_from_the_source_frame() {
        let mut j = job(QualityPreset::Balanced);
        j.lossless = true;
        // A stream copy ignores crop, so the crop must not shrink the answer.
        j.crop = Some(Rect {
            x: 0,
            y: 0,
            w: 640,
            h: 360,
        });
        // 0.10 * 1920 * 1080 * 30 * 10, plus 128k of audio, in bytes.
        assert_eq!(estimate_output_bytes(&j, 1920, 1080, 30.0, true), 7_936_000);
    }

    /// The estimate against a real encode, which is the only thing that can tell a wrong constant
    /// from a plausible one. #[ignore]: `cargo test -- --ignored estimate_lands`.
    #[test]
    #[ignore]
    fn the_estimate_lands_within_a_factor_of_two_of_a_real_export() {
        let ffmpeg_missing = std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|out| !out.status.success())
            .unwrap_or(true);
        if ffmpeg_missing {
            return;
        }

        let dir = std::env::temp_dir().join("flipperclipper-test-clips");
        std::fs::create_dir_all(&dir).expect("could not create the fixture directory");
        let src = dir.join("estimate-source.mp4");
        if !src.exists() {
            let status = std::process::Command::new("ffmpeg")
                .args([
                    "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=10",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
                    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "128k", "-shortest",
                ])
                .arg(&src)
                .status()
                .expect("could not run ffmpeg");
            assert!(status.success(), "could not build the fixture");
        }

        let check = |name: &str, tune: &dyn Fn(&mut ExportJob)| {
            let mut j = job(QualityPreset::Balanced);
            j.input = src.to_string_lossy().into_owned();
            j.output = dir.join(name).to_string_lossy().into_owned();
            j.in_point = 0.0;
            j.out_point = 5.0;
            tune(&mut j);

            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0, None);
            let out = std::process::Command::new("ffmpeg")
                .args(&args)
                .output()
                .expect("could not run ffmpeg");
            assert!(
                out.status.success(),
                "ffmpeg refused the arguments: {}",
                String::from_utf8_lossy(&out.stderr)
            );

            let actual = std::fs::metadata(&j.output).expect("no output file").len() as f64;
            let estimate = estimate_output_bytes(&j, 1920, 1080, 30.0, true) as f64;
            let ratio = estimate / actual;
            assert!(
                (0.5..=2.0).contains(&ratio),
                "{name}: estimated {estimate} bytes against an actual {actual}"
            );
        };

        check("estimate-balanced.mp4", &|_| {});
        check("estimate-bitrate.mp4", &|j| j.video_kbps = Some(2000));
    }

    // -- parse_probe --------------------------------------------------------

    const LANDSCAPE_JSON: &str = r#"{
      "streams": [
        {
          "index": 0, "codec_name": "h264", "codec_type": "video",
          "width": 1920, "height": 1080,
          "r_frame_rate": "30000/1001", "avg_frame_rate": "30000/1001",
          "duration": "20.020000",
          "disposition": { "default": 1, "attached_pic": 0 }
        },
        {
          "index": 1, "codec_name": "aac", "codec_type": "audio",
          "sample_rate": "48000", "channels": 2, "duration": "20.011000",
          "disposition": { "default": 1, "attached_pic": 0 }
        }
      ],
      "format": {
        "filename": "C:\\clips\\a.mp4", "nb_streams": 2,
        "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
        "duration": "20.021000", "size": "5242880", "bit_rate": "2094000"
      }
    }"#;

    #[test]
    fn parse_probe_reads_a_plain_landscape_clip() {
        let info = parse_probe(LANDSCAPE_JSON, "C:\\clips\\a.mp4", 5_242_880).unwrap();
        assert_eq!(info.path, "C:\\clips\\a.mp4");
        assert_eq!(info.width, 1920);
        assert_eq!(info.height, 1080);
        assert_eq!(info.rotation, 0);
        assert!((info.duration - 20.021).abs() < 1e-6);
        assert!((info.fps - 29.970_029_97).abs() < 1e-6);
        assert!(info.has_audio);
        assert_eq!(info.video_codec, "h264");
        assert_eq!(info.audio_codec.as_deref(), Some("aac"));
        assert_eq!(info.size_bytes, 5_242_880);
    }

    #[test]
    fn parse_probe_swaps_the_dimensions_of_a_rotated_portrait_clip() {
        let json = r#"{
          "streams": [
            {
              "index": 0, "codec_name": "hevc", "codec_type": "video",
              "width": 1920, "height": 1080, "r_frame_rate": "30/1",
              "side_data_list": [
                { "side_data_type": "Display Matrix",
                  "displaymatrix": "00000000: 0 65536 0", "rotation": -90 }
              ],
              "tags": { "rotate": "90" }
            },
            { "index": 1, "codec_name": "aac", "codec_type": "audio" }
          ],
          "format": { "duration": "12.500000" }
        }"#;
        let info = parse_probe(json, "C:\\clips\\phone.mov", 1_000).unwrap();
        // Stored 1920x1080, displayed 1080x1920. The crop overlay measures the
        // displayed frame, so this is the pair everything downstream uses.
        assert_eq!(info.width, 1080);
        assert_eq!(info.height, 1920);
        assert_eq!(info.rotation, 270);
        assert_eq!(info.video_codec, "hevc");
    }

    #[test]
    fn parse_probe_falls_back_to_the_legacy_rotate_tag() {
        let json = r#"{
          "streams": [
            { "codec_name": "h264", "codec_type": "video",
              "width": 1280, "height": 720, "r_frame_rate": "25/1",
              "tags": { "rotate": "270" } }
          ],
          "format": { "duration": "5.0" }
        }"#;
        let info = parse_probe(json, "x.mov", 0).unwrap();
        assert_eq!(info.rotation, 270);
        assert_eq!(info.width, 720);
        assert_eq!(info.height, 1280);
    }

    #[test]
    fn parse_probe_does_not_swap_at_180_degrees() {
        let json = r#"{
          "streams": [
            { "codec_name": "h264", "codec_type": "video",
              "width": 1280, "height": 720, "r_frame_rate": "25/1",
              "tags": { "rotate": "180" } }
          ],
          "format": { "duration": "5.0" }
        }"#;
        let info = parse_probe(json, "x.mov", 0).unwrap();
        assert_eq!(info.rotation, 180);
        assert_eq!(info.width, 1280);
        assert_eq!(info.height, 720);
    }

    #[test]
    fn parse_probe_reports_a_file_with_no_audio() {
        let json = r#"{
          "streams": [
            { "codec_name": "h264", "codec_type": "video",
              "width": 854, "height": 480, "r_frame_rate": "60/1" }
          ],
          "format": { "duration": "3.25" }
        }"#;
        let info = parse_probe(json, "silent.mp4", 42).unwrap();
        assert!(!info.has_audio);
        assert_eq!(info.audio_codec, None);
        assert!((info.fps - 60.0).abs() < 1e-9);
        assert!((info.duration - 3.25).abs() < 1e-9);
    }

    #[test]
    fn parse_probe_ignores_cover_art_when_looking_for_the_video_track() {
        let json = r#"{
          "streams": [
            { "codec_name": "mjpeg", "codec_type": "video",
              "width": 600, "height": 600, "r_frame_rate": "90000/1",
              "disposition": { "attached_pic": 1 } },
            { "codec_name": "h264", "codec_type": "video",
              "width": 1920, "height": 1080, "r_frame_rate": "24/1",
              "disposition": { "attached_pic": 0 } }
          ],
          "format": { "duration": "8.0" }
        }"#;
        let info = parse_probe(json, "art.mp4", 0).unwrap();
        assert_eq!(info.width, 1920);
        assert_eq!(info.video_codec, "h264");
    }

    #[test]
    fn parse_probe_defaults_a_broken_frame_rate_to_thirty() {
        let json = r#"{
          "streams": [
            { "codec_name": "h264", "codec_type": "video",
              "width": 640, "height": 360,
              "r_frame_rate": "0/0", "avg_frame_rate": "0/0" }
          ],
          "format": { "duration": "1.0" }
        }"#;
        let info = parse_probe(json, "vfr.mkv", 0).unwrap();
        assert!((info.fps - 30.0).abs() < 1e-9);
    }

    #[test]
    fn parse_probe_falls_back_to_the_stream_duration() {
        let json = r#"{
          "streams": [
            { "codec_name": "h264", "codec_type": "video",
              "width": 640, "height": 360, "r_frame_rate": "30/1",
              "duration": "7.5" }
          ],
          "format": { "size": "1000" }
        }"#;
        let info = parse_probe(json, "nodur.mkv", 0).unwrap();
        assert!((info.duration - 7.5).abs() < 1e-9);
    }

    #[test]
    fn parse_probe_falls_back_when_the_container_advertises_a_zero_duration() {
        // Remuxed MKV/TS files and several screen recorders write a literal zero at the format level
        // rather than omitting the key, so a fallback that only triggers on a missing key never runs
        // on the files that need it most.
        let json = r#"{
          "streams": [
            { "codec_name": "h264", "codec_type": "video",
              "width": 1920, "height": 1080, "r_frame_rate": "30/1",
              "duration": "63.400000" }
          ],
          "format": { "duration": "0.000000", "size": "1000" }
        }"#;
        let info = parse_probe(json, "remux.mkv", 0).unwrap();
        assert!((info.duration - 63.4).abs() < 1e-9);
    }

    #[test]
    fn parse_probe_rejects_files_it_cannot_edit() {
        assert!(parse_probe("not json", "x", 0).is_err());
        assert!(parse_probe(r#"{"format":{}}"#, "x", 0).is_err());
        let audio_only = r#"{
          "streams": [ { "codec_name": "mp3", "codec_type": "audio" } ],
          "format": { "duration": "60.0" }
        }"#;
        assert!(parse_probe(audio_only, "song.mp3", 0).is_err());
    }

    // -- tool resolution ----------------------------------------------------

    #[test]
    fn the_app_own_copy_is_the_first_directory_tried() {
        // Ahead of PATH on purpose: it is the one binary this app verified itself.
        let Some(managed) = managed_dir() else {
            return;
        };
        assert_eq!(candidate_dirs().next(), Some(managed));
    }

    #[test]
    fn the_managed_dir_sits_under_the_app_identifier() {
        if std::env::var_os("LOCALAPPDATA").is_none() {
            return;
        }
        let dir = managed_dir().expect("a managed dir where LOCALAPPDATA exists");
        assert!(
            dir.ends_with(PathBuf::from(APP_IDENTIFIER).join("ffmpeg")),
            "{dir:?}"
        );
    }

    #[test]
    fn a_path_string_splits_on_semicolons() {
        let dirs = split_path_list(
            "C:\\Windows;;  C:\\Program Files\\ffmpeg\\bin  ;\"C:\\quoted dir\";",
        );
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("C:\\Windows"),
                PathBuf::from("C:\\Program Files\\ffmpeg\\bin"),
                PathBuf::from("C:\\quoted dir"),
            ]
        );
        assert!(split_path_list("").is_empty());
        assert!(split_path_list(" ; ; ").is_empty());
    }

    #[test]
    fn env_expansion_substitutes_known_names_and_keeps_the_rest_literal() {
        let lookup = |name: &str| match name {
            "LOCALAPPDATA" => Some("C:\\Users\\Kiera\\AppData\\Local".to_string()),
            "SystemRoot" => Some("C:\\Windows".to_string()),
            _ => None,
        };
        assert_eq!(
            expand_env_vars("%LOCALAPPDATA%\\Microsoft\\WinGet\\Links", lookup),
            "C:\\Users\\Kiera\\AppData\\Local\\Microsoft\\WinGet\\Links"
        );
        assert_eq!(
            expand_env_vars("%SystemRoot%\\system32;%NOPE%\\bin", lookup),
            "C:\\Windows\\system32;%NOPE%\\bin"
        );
        // An unpaired % is data, not the start of a reference.
        assert_eq!(expand_env_vars("C:\\100% done", lookup), "C:\\100% done");
        assert_eq!(expand_env_vars("plain", lookup), "plain");
    }

    #[test]
    fn candidate_directories_dedupe_without_losing_priority_order() {
        let dirs: Vec<PathBuf> = dedupe_dirs(
            vec![
                PathBuf::from("C:\\Windows"),
                PathBuf::from("C:\\ffmpeg\\bin"),
                // Same folder, three spellings Windows treats as one.
                PathBuf::from("c:\\windows"),
                PathBuf::from("C:\\Windows\\"),
                PathBuf::from("C:\\choco\\bin"),
            ]
            .into_iter(),
        )
        .collect();
        assert_eq!(
            dirs,
            vec![
                PathBuf::from("C:\\Windows"),
                PathBuf::from("C:\\ffmpeg\\bin"),
                PathBuf::from("C:\\choco\\bin"),
            ]
        );
    }

    /// The bug this whole resolver exists for: the app the installer launched inherited an
    /// environment that could not find ffmpeg, and a restart fixed it. Strip PATH to where the
    /// inherited tier cannot answer and assert the later tiers still do. #[ignore] because it
    /// mutates process-wide environment: `cargo test -- --ignored --test-threads=1`.
    #[test]
    #[ignore]
    fn ffmpeg_is_found_with_the_inherited_path_stripped() {
        let real_path = std::env::var_os("PATH");

        forget_resolved_tools();
        assert!(
            resolve_tool("ffmpeg").is_some(),
            "ffmpeg is not installed on this machine, so this test proves nothing"
        );

        // Only System32 - enough for PowerShell to exist, not enough to find
        // ffmpeg, which is what a stale inherited environment looks like.
        let system32 = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        std::env::set_var("PATH", format!("{system32}\\System32"));
        forget_resolved_tools();

        let found = resolve_tool("ffmpeg");

        match real_path {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
        forget_resolved_tools();

        let found = found.expect("no tier after the inherited PATH could find ffmpeg");
        assert!(
            found.is_absolute(),
            "resolution must yield an absolute path, got {found:?}"
        );
        assert!(
            run_version(&found).is_some(),
            "the winner must actually run: a zero-byte WinGet alias must never be accepted"
        );
    }
}
