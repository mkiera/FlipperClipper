//! Pure command-building and probe-parsing logic.
//!
//! Everything in here except `hidden_command` is a pure function of its
//! arguments so the whole export matrix can be unit-tested without ffmpeg
//! installed and without writing a file. A wrong argument here produces a
//! silently truncated or unwatchable export rather than an error, so the tests
//! at the bottom of this file are the only thing that catches it.

use serde::{Deserialize, Serialize};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QualityPreset {
    High,
    Balanced,
    Small,
    Fit10,
    Fit25,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJob {
    pub input: String,
    pub output: String,
    pub in_point: f64,
    pub out_point: f64,
    pub speed: f64,
    pub crop: Option<Rect>,
    pub mute: bool,
    pub quality: QualityPreset,
    pub lossless: bool,
}

/// Below this many bits per pixel per second H.264 stops being able to hold
/// detail and a "fit under 10 MB" export turns into a block of mush. The value
/// is the low end of the usual 0.04-0.10 working range for the veryfast preset;
/// anything under it is better spent on fewer, sharper pixels.
const BPP_FLOOR: f64 = 0.04;

/// The rungs the auto-downscale ladder is allowed to land on. They are the
/// standard 720p/480p/360p widths for 16:9 and all three are even, so `-2` on
/// the other axis always yields an even height too.
const SCALE_LADDER: [i64; 3] = [1280, 854, 640];

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/// Formats a float for an ffmpeg filter expression: enough precision to survive
/// a 1/3 speed, but with the trailing zeros of `{:.6}` trimmed so the argument
/// vector that shows up in a bug report is readable. One digit is always kept
/// after the point because `atempo=2` and `atempo=2.0` are the same to ffmpeg
/// but only one of them looks like a rate.
fn fmt_num(v: f64) -> String {
    let mut s = format!("{:.6}", v);
    while s.ends_with('0') && !s.ends_with(".0") {
        s.pop();
    }
    s
}

/// Seek and duration values go out at millisecond precision. ffmpeg parses
/// plain seconds happily and three decimals is finer than any frame we will
/// ever cut on, while a full `{}` of an f64 can print `1.7999999999999998`.
fn fmt_time(v: f64) -> String {
    format!("{:.3}", v.max(0.0))
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

/// The wall-clock length of the exported file, which the speed change alters.
/// The progress reader divides ffmpeg's `out_time` by this, so a zero here
/// would produce NaN percentages in the UI.
pub fn output_duration(job: &ExportJob) -> f64 {
    if job.speed <= 0.0 {
        return 0.0;
    }
    ((job.out_point - job.in_point) / job.speed).max(0.0)
}

/// The window of *source* material we read, which the speed change does not
/// alter. Keeping this separate from `output_duration` is the whole reason the
/// trim survives a speed change.
fn source_duration(job: &ExportJob) -> f64 {
    (job.out_point - job.in_point).max(0.0)
}

/// Builds the `atempo` chain for any speed the UI can produce.
///
/// atempo refuses factors outside 0.5-2.0 and errors out rather than clamping,
/// so the 0.25x and 4x presets have to be expressed as two stages. Returns an
/// empty vector at 1x because emitting `atempo=1.0` would force a needless
/// resample of the audio.
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

/// Snaps a crop rectangle to something yuv420p can actually encode.
///
/// Chroma is subsampled 2x2, so an odd width, height or offset makes libx264
/// either refuse the filter or shift the colour planes half a pixel against the
/// luma. The rectangle also arrives from a mouse drag on an overlay, so it can
/// be a pixel or two outside the frame after the display-to-source scaling;
/// ffmpeg treats an out-of-frame crop as a hard error and the export dies after
/// the user has already picked a filename. Nothing upstream rejects an
/// out-of-frame rectangle, so this clamp is the whole definition of what such a
/// rectangle means. Returns None when nothing usable is left, which the caller
/// reads as "do not crop".
///
/// The extent is derived from the rectangle's original *edges* rather than from
/// its width and height. Pulling the width across from the unclamped rect would
/// mean an origin of x=-30 with w=400 - a visible selection of 0..370 - emitted
/// a 400-wide crop covering 0..400, so the user got 30px more than they dragged
/// and every pixel inside the region shifted.
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

    // Rounding the origin *down* can only ever give the rectangle more room on
    // that side, so it happens after the extent has been measured and cannot
    // push the far edge back out of the frame.
    let x = left - left % 2;
    let y = top - top % 2;
    w -= w % 2;
    h -= h % 2;

    if w < 2 || h < 2 {
        return None;
    }
    Some(Rect { x, y, w, h })
}

/// Picks a downscale width for the size-target presets, or None to keep the
/// source resolution.
///
/// See BPP_FLOOR: past a point, spending the budget on 1080p pixels means every
/// one of them is wrong. Steps down the ladder until the budget is comfortable
/// again or 640 is reached, whichever comes first.
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

// ---------------------------------------------------------------------------
// Encoder families
// ---------------------------------------------------------------------------

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

/// CRF for libx264. 18 is visually transparent for most material, 23 is the
/// encoder's own default, 28 is where a clip meant for a chat window stops
/// being worth shrinking further.
fn crf_for(quality: QualityPreset) -> i32 {
    match quality {
        QualityPreset::High => 18,
        QualityPreset::Small => 28,
        _ => 23,
    }
}

/// The hardware equivalents sit one step higher than the x264 numbers because
/// the vendor quantiser scales are not the same curve: matching CRF exactly
/// produces visibly larger files for no visible gain.
fn cq_for(quality: QualityPreset) -> i32 {
    match quality {
        QualityPreset::High => 19,
        QualityPreset::Small => 29,
        _ => 24,
    }
}

fn audio_kbps_for(quality: QualityPreset) -> i32 {
    match quality {
        QualityPreset::High => 160,
        QualityPreset::Small => 96,
        // The size-target presets subtract the audio allowance from the video
        // budget, so this number has to match the one the arithmetic uses.
        _ => 128,
    }
}

/// Whether the output path names a container the mov/mp4 muxer will handle.
///
/// -movflags is a private option of that muxer, so ffmpeg aborts with "Option
/// movflags not found" on a .mkv or .webm output - and it does so after the user
/// has already been through the save dialog. The extension is all we have to go
/// on because the muxer is chosen from it too.
fn is_mp4_family(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.ends_with(".mp4") || lower.ends_with(".m4v") || lower.ends_with(".mov")
}

/// Byte budget for the size-target presets.
///
/// Discord's attachment limit is 10 MiB (10485760 bytes), but plenty of other
/// places mean 10 x 10^6 when they write "10 MB". Targeting the decimal value
/// undershoots both readings, which is the only number that is safe wherever
/// the clip ends up.
fn target_bytes_for(quality: QualityPreset) -> Option<u64> {
    match quality {
        QualityPreset::Fit10 => Some(10_000_000),
        QualityPreset::Fit25 => Some(25_000_000),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// The command matrix
// ---------------------------------------------------------------------------

/// Builds the full ffmpeg argument vector for one export.
///
/// `width`, `height` and `fps` are the *display-orientation* source dimensions
/// from `probe`; they are needed because the crop clamp and the size-target
/// auto-downscale both depend on them, and neither belongs in ExportJob (they
/// describe the file, not the edit).
pub fn build_args(
    job: &ExportJob,
    encoder: &str,
    has_audio: bool,
    width: i64,
    height: i64,
    fps: f64,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let keep_audio = has_audio && !job.mute;

    push_all(&mut args, &["-y"]);
    // Progress goes to stdout as key=value lines that the export task parses;
    // -nostats suppresses the carriage-return status line on stderr that would
    // otherwise interleave with real error text and make the failure message we
    // show the user unreadable.
    push_all(&mut args, &["-progress", "pipe:1", "-nostats"]);

    // -ss in front of -i is the fast path: ffmpeg seeks to the nearest keyframe
    // and then decodes forward, discarding frames before the target, so it is
    // both quick on a long file and still frame-accurate when re-encoding.
    //
    // The companion flag is -t and deliberately not -to. ffmpeg accepts -to as
    // both an input and an output option and the two mean different things: as
    // an output option it is measured on the *output* timeline, which setpts
    // has already stretched or compressed, so a 2x export of [10s, 20s] with
    // "-to 20" keeps writing until it has produced 20 seconds of a 5 second
    // clip. Input-side -t is measured on the source's own timestamps before any
    // filter runs, so (out - in) is exactly the window we decode regardless of
    // speed. Getting this backwards truncates or over-runs every export while
    // still exiting zero.
    args.push("-ss".to_string());
    args.push(fmt_time(job.in_point));
    args.push("-t".to_string());
    args.push(fmt_time(source_duration(job)));
    args.push("-i".to_string());
    args.push(job.input.clone());

    // Explicit maps rather than ffmpeg's default stream selection. A phone or
    // GoPro file often carries a timecode data stream or a subtitle track that
    // MP4 cannot hold in its source format, and the mux fails at the very end
    // of an otherwise finished encode. The `?` makes the audio map optional so
    // the same vector works on a file that turns out to have no audio.
    push_all(&mut args, &["-map", "0:v:0"]);
    if keep_audio {
        push_all(&mut args, &["-map", "0:a:0?"]);
    }

    if job.lossless {
        // Only reachable when trim is the sole edit, so there is nothing to
        // filter and no quality to choose. make_zero rebases the timestamps
        // after the keyframe seek; without it the first packet carries a
        // negative PTS and some players show a frozen frame at the start.
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

    if job.mute {
        push_all(&mut args, &["-an"]);
    }

    let crop = job
        .crop
        .as_ref()
        .and_then(|r| normalize_crop(r, width, height));
    let (effective_width, effective_height) = match crop {
        Some(r) => (r.w, r.h),
        None => (width, height),
    };

    // The bitrate has to be settled before the filter chain because the
    // auto-downscale decision is a function of it.
    let audio_kbps = audio_kbps_for(job.quality);
    let mut video_kbps: Option<i64> = None;
    if let Some(target_bytes) = target_bytes_for(job.quality) {
        let duration = output_duration(job);
        let audio_bits = if keep_audio {
            audio_kbps as f64 * 1000.0 * duration
        } else {
            0.0
        };
        // The 0.93 is container overhead headroom: MP4 boxes, per-packet
        // headers and the encoder overshooting its own target all come out of
        // the same budget, and landing at 10.2 MB fails just as hard as landing
        // at 20 MB would.
        let kbps = if duration > 0.0 {
            (target_bytes as f64 * 8.0 * 0.93 - audio_bits) / duration / 1000.0
        } else {
            0.0
        };
        video_kbps = Some(kbps.max(100.0).round() as i64);
    }

    let scale_width =
        video_kbps.and_then(|kbps| downscale_width(kbps, effective_width, effective_height, fps));

    let mut vfilters: Vec<String> = Vec::new();
    if let Some(r) = crop {
        // Crop first so setpts and scale only ever see the pixels that survive,
        // and so the crop coordinates stay in the source pixel space the UI
        // overlay measured them in.
        vfilters.push(format!("crop={}:{}:{}:{}", r.w, r.h, r.x, r.y));
    }
    if (job.speed - 1.0).abs() > 1e-9 {
        vfilters.push(format!("setpts=PTS/{}", fmt_num(job.speed)));
    }
    if let Some(sw) = scale_width {
        // -2 keeps the aspect ratio and rounds the other axis to a multiple of
        // two, which yuv420p requires.
        vfilters.push(format!("scale={}:-2", sw));
    }
    if !vfilters.is_empty() {
        args.push("-vf".to_string());
        args.push(vfilters.join(","));
    }

    if keep_audio {
        let afilters = atempo_chain(job.speed);
        if !afilters.is_empty() {
            args.push("-af".to_string());
            args.push(afilters.join(","));
        }
    }

    args.push("-c:v".to_string());
    args.push(encoder.to_string());

    let family = encoder_family(encoder);
    match video_kbps {
        Some(kbps) => {
            // One-pass constrained VBR. maxrate pins the peak so a busy scene
            // late in the clip cannot blow the budget, and the usual 2x bufsize
            // gives the rate controller a second of slack to spend on a cut.
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
            // The three hardware encoders each spell "constant quality"
            // differently because each wraps a different vendor SDK rather than
            // a shared ffmpeg abstraction. NVENC exposes NVIDIA's CQ level and
            // needs -b:v 0 beside it, or its VBR rate controller quietly caps
            // the stream at the 2 Mbit default and the quality setting does
            // nothing. QSV routes through Intel's ICQ mode, which ffmpeg
            // surfaces via the generic AVCodecContext global_quality field. AMF
            // has no constant-quality concept at all, only the per-frame-type
            // quantisers of its CQP rate controller. There is no single flag
            // that reaches all three.
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

    if keep_audio {
        push_all(&mut args, &["-c:a", "aac"]);
        args.push("-b:a".to_string());
        args.push(format!("{}k", audio_kbps));
    }

    // yuv420p because WebView2, Discord's inline player and every phone decoder
    // reject 4:2:2 or 10-bit H.264, and a screen recording or a phone HDR clip
    // will hand us exactly that. +faststart moves the moov atom to the front so
    // the embed starts playing before the whole file has downloaded, which is
    // the normal case: the save dialog offers .mp4 first.
    push_all(&mut args, &["-pix_fmt", "yuv420p"]);
    if is_mp4_family(&job.output) {
        push_all(&mut args, &["-movflags", "+faststart"]);
    }

    args.push(job.output.clone());
    args
}

// ---------------------------------------------------------------------------
// ffprobe JSON
// ---------------------------------------------------------------------------

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

/// Parses "30000/1001" style rationals. Defaults to 30 rather than failing
/// because fps is only used for the progress estimate and the bits-per-pixel
/// test, and a still image or a broken container reports "0/0" here.
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

/// Reads the rotation a player would apply, from either place ffprobe puts it.
///
/// Modern files carry it in the video stream's Display Matrix side data;
/// older MOV files only have the `rotate` stream tag. The two use opposite
/// signs for the same physical rotation (an upright iPhone clip reports
/// side-data -90 and tag 90), which does not matter here because the only
/// consumer is the 90/270 dimension swap and both normalise into that set.
fn read_rotation(stream: &Value) -> i64 {
    let raw = stream
        .get("side_data_list")
        .and_then(|v| v.as_array())
        .and_then(|list| list.iter().find_map(|entry| as_f64(entry.get("rotation"))))
        .or_else(|| as_f64(stream.get("tags").and_then(|t| t.get("rotate"))))
        .unwrap_or(0.0);

    let degrees = raw.round() as i64;
    let normalised = ((degrees % 360) + 360) % 360;
    // Snap anything that is not a right angle (some cameras write 89 or 271)
    // onto the nearest quarter turn, because a swap decision has no third
    // answer.
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

    // An MP3 with cover art has a video stream that is a single still JPEG.
    // Picking it would report a 600x600 "video" and produce an export that is
    // one frame long, so attached pictures are skipped explicitly.
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

    // The format-level duration is the one the container advertises and the one
    // a player's seek bar uses. A stream-level duration only exists on some
    // containers, so it is the fallback rather than the first choice.
    // Each candidate is checked for usability before the next one is consulted,
    // because a remuxed MKV/TS or a screen recorder will happily advertise
    // "duration": "0.000000" at the format level while the video stream carries
    // the real length. Filtering only the final answer would accept that zero,
    // never reach the stream, and leave the whole UI with a zero-length clip.
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
    // Report display dimensions, not stored ones. Both WebView2 and ffmpeg
    // apply the rotation on decode, so the crop overlay and the crop filter
    // both work in this orientation; reporting the stored size would put the
    // crop rectangle on its side and the user would get a wrong region with no
    // error anywhere.
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

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

/// Builds a Command that will not flash a console window.
///
/// The app is a windows_subsystem="windows" binary, so any child console
/// process allocates its own window: without CREATE_NO_WINDOW a black box pops
/// up and steals focus for every filmstrip thumbnail and every probe, which on
/// opening a file is a dozen flashes in a row.
pub fn hidden_command(program: &str) -> std::process::Command {
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

// ---------------------------------------------------------------------------

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
            crop: None,
            mute: false,
            quality,
            lossless: false,
        }
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

    // -- trim ---------------------------------------------------------------

    #[test]
    fn lossless_trim_is_a_stream_copy_with_no_filters() {
        let mut j = job(QualityPreset::Balanced);
        j.lossless = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);

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
        let args = build_args(&j, "libx264", false, 1920, 1080, 30.0);
        assert!(!has_pair(&args, "-map", "0:a:0?"));
        assert!(has_pair(&args, "-map", "0:v:0"));
        assert!(has_pair(&args, "-c", "copy"));
    }

    #[test]
    fn trim_uses_input_side_duration_not_output_side_to() {
        let mut j = job(QualityPreset::Balanced);
        j.in_point = 4.0;
        j.out_point = 9.0;
        j.speed = 2.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);

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
    fn atempo_stages_multiply_back_to_the_requested_speed() {
        for speed in [0.25f64, 0.3, 0.5, 0.75, 1.5, 2.0, 3.0, 4.0] {
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
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        assert_eq!(value_after(&args, "-vf"), Some("setpts=PTS/0.25"));
        assert_eq!(value_after(&args, "-af"), Some("atempo=0.5,atempo=0.5"));

        j.speed = 4.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        assert_eq!(value_after(&args, "-vf"), Some("setpts=PTS/4.0"));
        assert_eq!(value_after(&args, "-af"), Some("atempo=2.0,atempo=2.0"));

        j.speed = 2.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
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
            &build_args(&j, "libx264", true, 1920, 1080, 30.0),
            "-af"
        ));

        j.mute = false;
        assert!(!has(
            &build_args(&j, "libx264", false, 1920, 1080, 30.0),
            "-af"
        ));
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
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        assert_eq!(value_after(&args, "-vf"), Some("crop=640:360:100:50"));
    }

    #[test]
    fn crop_is_clamped_inside_the_frame() {
        let mut j = job(QualityPreset::Balanced);
        // A drag that ran off the right and bottom edges of the overlay. The
        // width and height are deliberately smaller than the frame so that an
        // implementation carrying the original w/h across the clamp cannot pass
        // by landing on the frame size anyway.
        j.crop = Some(Rect {
            x: 1800,
            y: 1000,
            w: 400,
            h: 400,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        assert_eq!(value_after(&args, "-vf"), Some("crop=120:80:1800:1000"));
    }

    #[test]
    fn a_negative_crop_origin_keeps_the_region_the_user_dragged() {
        let mut j = job(QualityPreset::Balanced);
        // The overlay produces this when the pointer leaves the window mid-drag.
        // The visible selection is 0..370 across and 0..390 down, so those are
        // the extents that have to survive; taking the width from the rect
        // instead of from its right edge would emit 400x400 and shift the whole
        // region 30px left and 10px up.
        j.crop = Some(Rect {
            x: -30,
            y: -10,
            w: 400,
            h: 400,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        assert_eq!(value_after(&args, "-vf"), Some("crop=370:390:0:0"));

        // Overhanging both ends at once still yields the whole frame.
        j.crop = Some(Rect {
            x: -30,
            y: -10,
            w: 4000,
            h: 4000,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
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
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        assert!(!has(&args, "-vf"));

        j.crop = Some(Rect {
            x: 1920,
            y: 1080,
            w: 100,
            h: 100,
        });
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
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
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
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
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
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
            let args = build_args(&job(quality), "libx264", true, 1920, 1080, 30.0);
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
            let args = build_args(&job(quality), "h264_nvenc", true, 1920, 1080, 30.0);
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
            let args = build_args(&job(quality), "h264_qsv", true, 1920, 1080, 30.0);
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
            let args = build_args(&job(quality), "h264_amf", true, 1920, 1080, 30.0);
            assert!(has_pair(&args, "-c:v", "h264_amf"));
            assert!(has_pair(&args, "-rc", "cqp"));
            assert_eq!(value_after(&args, "-qp_i"), Some(qp));
            assert_eq!(value_after(&args, "-qp_p"), Some(qp));
            assert_eq!(value_after(&args, "-qp_b"), Some(qp));
            assert!(!has(&args, "-crf"));
            assert!(!has(&args, "-global_quality"));
        }
    }

    // -- size targets -------------------------------------------------------

    #[test]
    fn fit10_bitrate_arithmetic_muted() {
        let mut j = job(QualityPreset::Fit10);
        j.in_point = 0.0;
        j.out_point = 30.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);

        // (10_000_000 * 8 * 0.93 - 0) / 30 / 1000 = 2480
        assert_eq!(value_after(&args, "-b:v"), Some("2480k"));
        assert_eq!(value_after(&args, "-maxrate"), Some("2480k"));
        assert_eq!(value_after(&args, "-bufsize"), Some("4960k"));
        assert!(!has(&args, "-crf"));
    }

    #[test]
    fn fit10_bitrate_arithmetic_subtracts_the_audio_allowance() {
        let mut j = job(QualityPreset::Fit10);
        j.in_point = 0.0;
        j.out_point = 20.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);

        // (10_000_000 * 8 * 0.93 - 128_000 * 20) / 20 / 1000 = 3592
        assert_eq!(value_after(&args, "-b:v"), Some("3592k"));
        assert_eq!(value_after(&args, "-bufsize"), Some("7184k"));
        assert_eq!(value_after(&args, "-b:a"), Some("128k"));
    }

    #[test]
    fn fit25_bitrate_arithmetic_accounts_for_speed() {
        let mut j = job(QualityPreset::Fit25);
        j.in_point = 0.0;
        j.out_point = 120.0;
        j.speed = 2.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);

        // Output is 60s long, not 120s:
        // (25_000_000 * 8 * 0.93 - 128_000 * 60) / 60 / 1000 = 2972
        assert_eq!(value_after(&args, "-b:v"), Some("2972k"));
        assert_eq!(value_after(&args, "-maxrate"), Some("2972k"));
    }

    #[test]
    fn a_size_target_on_a_hardware_encoder_still_uses_bitrate_not_cq() {
        let mut j = job(QualityPreset::Fit10);
        j.in_point = 0.0;
        j.out_point = 20.0;
        let args = build_args(&j, "h264_nvenc", true, 1920, 1080, 30.0);
        assert_eq!(value_after(&args, "-b:v"), Some("3592k"));
        assert!(!has(&args, "-cq"));
        assert!(!has(&args, "-preset"));
    }

    // -- auto-downscale -----------------------------------------------------

    #[test]
    fn auto_downscale_does_not_fire_when_the_budget_is_comfortable() {
        let mut j = job(QualityPreset::Fit10);
        j.in_point = 0.0;
        j.out_point = 10.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        // 7440 kbps over 1920x1080x30 is 0.12 bpp, well clear of the floor.
        assert_eq!(value_after(&args, "-b:v"), Some("7440k"));
        assert!(!has(&args, "-vf"));
    }

    #[test]
    fn auto_downscale_steps_to_720p() {
        let mut j = job(QualityPreset::Fit10);
        j.in_point = 0.0;
        j.out_point = 60.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        // 1240 kbps is 0.020 bpp at 1080p and 0.045 bpp at 720p.
        assert_eq!(value_after(&args, "-b:v"), Some("1240k"));
        assert_eq!(value_after(&args, "-vf"), Some("scale=1280:-2"));
    }

    #[test]
    fn auto_downscale_keeps_stepping_when_720p_is_still_too_thin() {
        let mut j = job(QualityPreset::Fit10);
        j.in_point = 0.0;
        j.out_point = 120.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        // 620 kbps is 0.022 bpp at 720p and 0.050 bpp at 854x480.
        assert_eq!(value_after(&args, "-b:v"), Some("620k"));
        assert_eq!(value_after(&args, "-vf"), Some("scale=854:-2"));
    }

    #[test]
    fn auto_downscale_stops_at_the_bottom_rung() {
        let mut j = job(QualityPreset::Fit10);
        j.in_point = 0.0;
        j.out_point = 900.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        assert_eq!(value_after(&args, "-vf"), Some("scale=640:-2"));
    }

    #[test]
    fn auto_downscale_never_upscales_a_small_source() {
        let mut j = job(QualityPreset::Fit10);
        j.in_point = 0.0;
        j.out_point = 900.0;
        j.mute = true;
        let args = build_args(&j, "libx264", true, 640, 360, 30.0);
        assert!(!has(&args, "-vf"));
    }

    #[test]
    fn auto_downscale_measures_the_cropped_size_not_the_source_size() {
        let mut j = job(QualityPreset::Fit10);
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
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
        assert_eq!(value_after(&args, "-vf"), Some("crop=1280:720:0:0"));
    }

    #[test]
    fn auto_downscale_is_only_a_size_target_behaviour() {
        let mut j = job(QualityPreset::Small);
        j.in_point = 0.0;
        j.out_point = 900.0;
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
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
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);

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
        for name in ["out.mkv", "out.webm", "out"] {
            let mut j = job(QualityPreset::Balanced);
            j.output = format!("C:\\clips\\{}", name);
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
            assert!(!has(&args, "-movflags"), "{}", name);
            assert!(has_pair(&args, "-pix_fmt", "yuv420p"), "{}", name);

            j.lossless = true;
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
            assert!(!has(&args, "-movflags"), "lossless {}", name);
            assert_eq!(args.last().unwrap(), &format!("C:\\clips\\{}", name));
        }

        // The rest of the mp4 family keeps it, in both modes.
        for name in ["out.MP4", "out.m4v", "out.mov"] {
            let mut j = job(QualityPreset::Balanced);
            j.output = format!("C:\\clips\\{}", name);
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
            assert!(has_pair(&args, "-movflags", "+faststart"), "{}", name);

            j.lossless = true;
            let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);
            assert!(
                has_pair(&args, "-movflags", "+faststart"),
                "lossless {}",
                name
            );
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
        let args = build_args(&j, "libx264", true, 1920, 1080, 30.0);

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
        // Remuxed MKV/TS files and several screen recorders write a literal
        // zero at the format level rather than omitting the key, so a fallback
        // that only triggers on a missing key never runs on the files that need
        // it most.
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
}
