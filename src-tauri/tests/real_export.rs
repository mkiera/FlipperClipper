//! Runs the argument vectors `build_args` produces through a real ffmpeg and checks the file
//! that comes out with ffprobe. The unit tests in ffmpeg.rs are pure - a vector can be
//! word-for-word what was intended and still produce a clip of the wrong length, because the
//! meaning of `-to` depends on which side of `-i` it sits. Fixtures are generated on demand
//! into the OS temp directory rather than committed.

use std::path::{Path, PathBuf};
use std::process::Command;

use flipperclipper_lib::ffmpeg::{
    build_args, output_duration, Effects, ExportFormat, ExportJob, QualityPreset, Rect, TextAnchorX,
    TextAnchorY, TextOverlay, OVERLAY_TEXT_FILE,
};
use flipperclipper_lib::ramp::SpeedPoint;

// --- Fixtures ---

fn fixture_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("flipperclipper-test-clips");
    std::fs::create_dir_all(&dir).expect("could not create the fixture directory");
    dir
}

fn ffmpeg_missing() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| !o.status.success())
        .unwrap_or(true)
}

/// Encode one fixture unless it is already there.
fn ensure_fixture(name: &str, args: &[&str]) -> PathBuf {
    let path = fixture_dir().join(name);
    if path.exists() {
        return path;
    }
    let mut command = Command::new("ffmpeg");
    command.args(["-hide_banner", "-loglevel", "error", "-y"]);
    command.args(args);
    command.arg(&path);
    let status = command.status().expect("could not run ffmpeg");
    assert!(status.success(), "could not build the fixture {name}");
    path
}

/// 1920x1080, 30 fps, 20 s, with a stereo tone. The everyday case.
fn landscape() -> PathBuf {
    ensure_fixture(
        "landscape-1080p.mp4",
        &[
            "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=20",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-shortest",
        ],
    )
}

/// No audio stream at all, so every audio flag has to sit out.
/// The same picture as landscape(), with audio at a twentieth of full scale - the shape of a
/// clip recorded with the mic gain far too low, which is what normalising is for.
fn quiet() -> PathBuf {
    ensure_fixture(
        "quiet-1080p.mp4",
        &[
            "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=10",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
            "-af", "volume=0.05",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-shortest",
        ],
    )
}

fn silent() -> PathBuf {
    ensure_fixture(
        "silent-720p.mp4",
        &[
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        ],
    )
}

/// Stored 1280x720 but flagged to display rotated, so its display size is 720x1280: the case
/// where working in stored rather than display coordinates puts the crop rectangle on its side.
fn rotated() -> PathBuf {
    let path = fixture_dir().join("rotated-90.mp4");
    if path.exists() {
        return path;
    }
    let flat = ensure_fixture(
        "rotated-source.mp4",
        &[
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=10",
            "-f", "lavfi", "-i", "sine=frequency=660:duration=10",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-shortest",
        ],
    );
    // ffmpeg 7 dropped the old `-metadata:s:v:0 rotate=` form; the display matrix is written by
    // re-muxing with -display_rotation on the input.
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i"])
        .arg(&flat)
        .args(["-c", "copy"])
        .arg(&path)
        .status()
        .expect("could not run ffmpeg");
    assert!(status.success(), "could not build the rotated fixture");
    path
}

// --- Probing the result ---

fn ffprobe(args: &[&str], path: &Path) -> String {
    let out = Command::new("ffprobe")
        .args(["-v", "quiet"])
        .args(args)
        .arg(path)
        .output()
        .expect("could not run ffprobe");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn duration_of(path: &Path) -> f64 {
    ffprobe(
        &["-show_entries", "format=duration", "-of", "csv=p=0"],
        path,
    )
    .parse()
    .unwrap_or(0.0)
}

/// One stream's own length rather than the container's, which reports the longer of the two.
/// Read from the packets: a stream-level `duration` tag is optional and mp4 often omits it.
fn stream_duration(path: &Path, kind: &str) -> f64 {
    ffprobe(
        &[
            "-select_streams",
            kind,
            "-show_entries",
            "stream=duration",
            "-of",
            "csv=p=0",
        ],
        path,
    )
    .lines()
    .next()
    .and_then(|line| line.trim().trim_end_matches(',').parse().ok())
    .unwrap_or(0.0)
}

fn dimensions_of(path: &Path) -> (i64, i64) {
    let raw = ffprobe(
        &["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"],
        path,
    );
    let mut parts = raw.split(',').filter(|s| !s.is_empty());
    (
        parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
        parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
    )
}

/// Mean level in dBFS, straight from ffmpeg's volumedetect. Negative; closer to zero is louder.
fn mean_volume(path: &Path) -> f64 {
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(path)
        .args(["-af", "volumedetect", "-f", "null", "-"])
        .output()
        .expect("could not run ffmpeg");
    // volumedetect reports on stderr, as everything that is not the file itself does.
    let text = String::from_utf8_lossy(&out.stderr).into_owned();
    text.lines()
        .find_map(|line| {
            let (_, rest) = line.split_once("mean_volume:")?;
            rest.trim().trim_end_matches(" dB").trim().parse::<f64>().ok()
        })
        .unwrap_or_else(|| panic!("volumedetect printed no mean_volume:
{text}"))
}

fn has_audio(path: &Path) -> bool {
    !ffprobe(
        &["-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0"],
        path,
    )
    .is_empty()
}

fn has_video(path: &Path) -> bool {
    !ffprobe(
        &["-select_streams", "v", "-show_entries", "stream=codec_type", "-of", "csv=p=0"],
        path,
    )
    .is_empty()
}

fn video_codec_of(path: &Path) -> String {
    ffprobe(
        &["-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"],
        path,
    )
}

fn audio_codec_of(path: &Path) -> String {
    ffprobe(
        &["-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0"],
        path,
    )
}

fn stream_count_of(path: &Path) -> i64 {
    ffprobe(
        &["-show_entries", "format=nb_streams", "-of", "csv=p=0"],
        path,
    )
    .parse()
    .unwrap_or(-1)
}

/// BMP rather than PNG, so the comparison is over raw pixels with no encoder freedom between.
fn first_frame_bytes(path: &Path, frame_name: &str) -> Vec<u8> {
    let frame = fixture_dir().join(frame_name);
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(path)
        .args(["-frames:v", "1"])
        .arg(&frame)
        .status()
        .expect("could not run ffmpeg");
    assert!(status.success(), "could not extract a frame into {frame_name}");
    std::fs::read(&frame).expect("the extracted frame file is missing")
}

/// The font export.rs would resolve, or None on a machine without it.
fn overlay_font() -> Option<PathBuf> {
    let root = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
    let font = Path::new(&root).join("Fonts").join("arial.ttf");
    font.is_file().then_some(font)
}

/// Build the argv the app would build, run it, and hand back the output path.
fn run_export(job: &ExportJob, width: i64, height: i64, fps: f64, has_source_audio: bool) -> PathBuf {
    let font = overlay_font();
    // libx264 throughout: a hardware encoder would tie these assertions to whichever GPU ran them.
    let args = build_args(job, "libx264", has_source_audio, width, height, fps, font.as_deref());

    let mut command = Command::new("ffmpeg");
    command.args(&args);
    // The same two-part arrangement export.rs makes: the text in a file named relative to the
    // working directory, because a filtergraph path cannot carry an apostrophe. If this test
    // ever passes with the cwd left alone, build_args has started spelling the path out.
    if let Some(overlay) = job.effects.text.as_ref() {
        let dir = fixture_dir();
        std::fs::write(dir.join(OVERLAY_TEXT_FILE), overlay.text.as_bytes())
            .expect("could not write the overlay text");
        command.current_dir(dir);
    }

    let out = command.output().expect("could not run ffmpeg");
    assert!(
        out.status.success(),
        "ffmpeg refused the arguments the app built.\nargs: {args:?}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    PathBuf::from(&job.output)
}

fn job(input: &Path, name: &str) -> ExportJob {
    ExportJob {
        input: input.to_string_lossy().into_owned(),
        output: fixture_dir().join(name).to_string_lossy().into_owned(),
        in_point: 0.0,
        out_point: 5.0,
        speed: 1.0,
        ramp: Vec::new(),
        crop: None,
        mute: false,
        reverse: false,
        normalize: false,
        volume: 1.0,
        format: ExportFormat::Mp4,
        quality: QualityPreset::Balanced,
        target_mb: None,
        output_height: None,
        video_kbps: None,
        effects: Effects::default(),
        lossless: false,
    }
}

// --- The tests ---

#[test]
fn a_plain_trim_produces_exactly_the_requested_span() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-trim.mp4");
    j.in_point = 5.0;
    j.out_point = 8.0;

    let out = run_export(&j, 1920, 1080, 30.0, true);
    let actual = duration_of(&out);
    // The whole point of putting -ss and -t on the input side: three seconds means three seconds,
    // not three measured from wherever the seek landed.
    assert!(
        (actual - 3.0).abs() < 0.2,
        "expected ~3.0 s, got {actual} s"
    );
    assert!(has_audio(&out));
}

#[test]
fn speed_shortens_the_clip_and_the_prediction_matches() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-speed.mp4");
    j.in_point = 2.0;
    j.out_point = 10.0;
    j.speed = 2.0;

    let predicted = output_duration(&j);
    let out = run_export(&j, 1920, 1080, 30.0, true);
    let actual = duration_of(&out);

    assert!((predicted - 4.0).abs() < 1e-9, "predicted {predicted}");
    // If this drifts the progress bar drifts with it: percent is out_time against this prediction.
    assert!(
        (actual - predicted).abs() < 0.2,
        "predicted {predicted} s, ffmpeg produced {actual} s"
    );
}

#[test]
fn quarter_speed_chains_atempo_without_losing_the_audio() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-slow.mp4");
    j.in_point = 0.0;
    j.out_point = 2.0;
    j.speed = 0.25;

    let out = run_export(&j, 1920, 1080, 30.0, true);
    let actual = duration_of(&out);
    // atempo refuses anything below 0.5, so 0.25 only works if the filter was chained.
    assert!((actual - 8.0).abs() < 0.3, "expected ~8.0 s, got {actual} s");
    assert!(has_audio(&out), "the audio track was dropped");
}

#[test]
fn reverse_actually_reverses_the_video() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut forward = job(&src, "out-rev-forward.mp4");
    forward.out_point = 2.0;
    let mut backward = job(&src, "out-rev-backward.mp4");
    backward.out_point = 2.0;
    backward.reverse = true;

    let a = run_export(&forward, 1920, 1080, 30.0, true);
    let b = run_export(&backward, 1920, 1080, 30.0, true);

    // testsrc2 paints a moving pattern with a burnt-in counter, so t=0 and t=2 look nothing alike.
    // Comparing the two decoded first frames is a cheap proxy for "the clip plays backwards".
    assert_ne!(
        first_frame_bytes(&a, "rev-forward.bmp"),
        first_frame_bytes(&b, "rev-backward.bmp"),
        "the reversed export starts on the same frame as the forward one"
    );
    // Reversal must rearrange time, not consume it.
    assert!((duration_of(&b) - 2.0).abs() < 0.3);
    assert!(has_audio(&b), "areverse dropped the audio track");
}

#[test]
fn normalising_lifts_a_quiet_clip_toward_the_target() {
    if ffmpeg_missing() {
        return;
    }
    let src = quiet();
    let before = mean_volume(&src);

    let mut j = job(&src, "out-normalized.mp4");
    j.out_point = 5.0;
    j.normalize = true;
    let out = run_export(&j, 1920, 1080, 30.0, true);

    let after = mean_volume(&out);
    assert!(has_audio(&out), "normalising lost the audio stream");
    assert!(
        after > before + 15.0,
        "a clip at {before:.1} dBFS came out at {after:.1}, which is not normalised"
    );
    // loudnorm targets -16 LUFS with a true-peak ceiling, so the mean lands well under 0 and
    // nothing is driven into the clip a plain multiplier would have caused.
    assert!(after < -6.0, "{after:.1} dBFS is hotter than the target allows");
}

#[test]
fn the_volume_trim_applies_on_top_of_the_normalised_level() {
    if ffmpeg_missing() {
        return;
    }
    let src = quiet();

    let mut j = job(&src, "out-norm-only.mp4");
    j.out_point = 5.0;
    j.normalize = true;
    let normalised = mean_volume(&run_export(&j, 1920, 1080, 30.0, true));

    let mut j = job(&src, "out-norm-trimmed.mp4");
    j.out_point = 5.0;
    j.normalize = true;
    j.volume = 0.5;
    let trimmed = mean_volume(&run_export(&j, 1920, 1080, 30.0, true));

    // Half the amplitude is 6 dB down from wherever normalising landed, which is what "set the
    // level, then trim to taste" has to mean.
    let drop = normalised - trimmed;
    assert!(
        (drop - 6.0).abs() < 1.5,
        "normalised {normalised:.1} dBFS, trimmed {trimmed:.1} dBFS - a {drop:.1} dB drop is not the half the slider asked for"
    );
}

#[test]
fn doubled_volume_still_carries_an_audio_stream() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-volume.mp4");
    j.out_point = 3.0;
    j.volume = 2.0;

    // The risk is the filter string, not the maths of the gain: what is left to check is that the
    // stream survived the chain.
    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert!(has_audio(&out), "the volume filter lost the audio stream");
    assert!((duration_of(&out) - 3.0).abs() < 0.2);
}

#[test]
fn gif_export_is_one_animated_video_stream_and_nothing_else() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-anim.gif");
    j.out_point = 2.0;
    j.format = ExportFormat::Gif;

    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert_eq!(video_codec_of(&out), "gif");
    // Exactly one stream: the source's audio must not have been mapped, and the palette must have
    // been consumed by paletteuse rather than muxed as a second video stream.
    assert_eq!(stream_count_of(&out), 1);
    assert!(!has_audio(&out));
    // Balanced caps the width at 480.
    let (w, _) = dimensions_of(&out);
    assert_eq!(w, 480);
}

#[test]
fn webm_export_is_vp9_with_opus() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-container.webm");
    j.out_point = 2.0;
    j.format = ExportFormat::Webm;
    // Small keeps the VP9 encode short; the codec pair is the same at every quality.
    j.quality = QualityPreset::Small;

    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert_eq!(video_codec_of(&out), "vp9");
    assert_eq!(audio_codec_of(&out), "opus");
}

#[test]
fn mp3_export_drops_the_video_and_tracks_the_speed_maths() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-audio.mp3");
    j.in_point = 2.0;
    j.out_point = 10.0;
    j.speed = 2.0;
    j.format = ExportFormat::Mp3;

    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert!(has_audio(&out));
    assert!(!has_video(&out), "the mp3 export still carries a video stream");
    // (10 - 2) / 2 = 4 s. Without atempo on this path the file would come out at 8 s and the
    // progress bar would be wrong for every sped-up audio export.
    let actual = duration_of(&out);
    assert!((actual - 4.0).abs() < 0.3, "expected ~4.0 s, got {actual} s");
}

#[test]
fn a_custom_two_megabyte_audio_fit_lands_under_two_megabytes() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-fit-audio.mp3");
    j.in_point = 0.0;
    j.out_point = 20.0;
    // Quarter speed stretches the 20 s source to 80 s of output, pushing the computed rate
    // (186 kbps) under lame's 320k ceiling; at 1x the budget would ask for 744k and lame would
    // round it down anyway, passing the test without exercising the arithmetic.
    j.speed = 0.25;
    j.format = ExportFormat::Mp3;
    j.quality = QualityPreset::Fit;
    j.target_mb = Some(2.0);

    let out = run_export(&j, 1920, 1080, 30.0, true);
    let size = std::fs::metadata(&out).expect("no output file").len();
    assert!(size <= 2_000_000, "{size} bytes exceeds the 2 MB target");
    // lame snaps the requested rate to the nearest valid MPEG-1 rate (192k), so the file should
    // still land close to the budget rather than miles under it.
    assert!(size > 1_000_000, "{size} bytes is suspiciously far under target");
}

#[test]
fn crop_is_applied_in_display_orientation_on_a_rotated_clip() {
    if ffmpeg_missing() {
        return;
    }
    let src = rotated();
    let mut j = job(&src, "out-crop-rotated.mp4");
    j.out_point = 3.0;
    // y = 900 is outside the STORED height of 720 and inside the DISPLAY height of 1280. It only
    // survives if ffmpeg rotated before cropping, which is the assumption the overlay is built on.
    j.crop = Some(Rect { x: 100, y: 900, w: 400, h: 300 });

    let out = run_export(&j, 720, 1280, 30.0, true);
    assert_eq!(dimensions_of(&out), (400, 300));
}

#[test]
fn an_out_of_frame_crop_is_trimmed_rather_than_shifted() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-crop-clamped.mp4");
    j.out_point = 2.0;
    // Dragged off the left and past the bottom. The visible selection is 0..370 wide, so a clamp
    // that kept the original width would emit 400 and include 30 px the user never selected.
    j.crop = Some(Rect { x: -30, y: 900, w: 400, h: 400 });

    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert_eq!(dimensions_of(&out), (370, 180));
}

#[test]
fn crop_dimensions_always_come_out_even() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-crop-odd.mp4");
    j.out_point = 2.0;
    j.crop = Some(Rect { x: 101, y: 51, w: 401, h: 301 });

    let out = run_export(&j, 1920, 1080, 30.0, true);
    let (w, h) = dimensions_of(&out);
    // yuv420p subsamples chroma by two, so an odd dimension is rejected rather than rounded for us.
    assert_eq!((w % 2, h % 2), (0, 0), "got {w}x{h}");
}

#[test]
fn muting_removes_the_audio_stream() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-mute.mp4");
    j.out_point = 3.0;
    j.mute = true;

    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert!(!has_audio(&out), "the muted export still carries audio");
}

#[test]
fn a_source_without_audio_exports_cleanly() {
    if ffmpeg_missing() {
        return;
    }
    let src = silent();
    let mut j = job(&src, "out-silent.mp4");
    j.out_point = 3.0;
    j.speed = 2.0;

    // The real risk here is an atempo filter or an `-map 0:a:0` built for a track that is absent.
    let out = run_export(&j, 1280, 720, 30.0, false);
    assert!(!has_audio(&out));
    assert!((duration_of(&out) - 1.5).abs() < 0.2);
}

#[test]
fn the_ten_megabyte_target_is_actually_met() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-fit10.mp4");
    j.in_point = 0.0;
    j.out_point = 20.0;
    j.quality = QualityPreset::Fit;
    j.target_mb = Some(10.0);

    let out = run_export(&j, 1920, 1080, 30.0, true);
    let size = std::fs::metadata(&out).expect("no output file").len();
    // The budget deliberately undershoots, so the file clears the limit however the receiving
    // service reads "10 MB". Also not absurdly small, which would mean the maths collapsed.
    assert!(size <= 10_000_000, "{size} bytes exceeds the 10 MB target");
    assert!(size > 2_000_000, "{size} bytes is suspiciously far under target");
}

#[test]
fn a_lossless_trim_copies_the_stream_instead_of_re_encoding() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-lossless.mp4");
    j.in_point = 5.0;
    j.out_point = 8.0;
    j.lossless = true;

    let before = video_codec_of(&src);
    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert_eq!(video_codec_of(&out), before, "the stream was re-encoded");
    // Deliberately no duration assertion: stream copy can only start on a keyframe, so it snaps
    // backwards - 8.09 s for this 5..8 s request. That is the cost of the lossless checkbox, and
    // asserting an exact span would encode a promise the feature does not make.
    assert!(duration_of(&out) > 0.0);
}

#[test]
fn a_non_mp4_container_does_not_get_mp4_only_flags() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-container.mkv");
    j.out_point = 2.0;
    j.format = ExportFormat::Mkv;

    // -movflags belongs to the mov/mp4 muxer; on a Matroska output ffmpeg aborts with "Option
    // movflags not found" after the user has already picked the filename.
    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert!(out.exists());
}

#[test]
fn everything_at_once_still_produces_a_sane_clip() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-combined.mp4");
    j.in_point = 4.0;
    j.out_point = 12.0;
    j.speed = 2.0;
    j.crop = Some(Rect { x: 200, y: 100, w: 1280, h: 720 });
    j.mute = true;
    j.quality = QualityPreset::Small;

    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert_eq!(dimensions_of(&out), (1280, 720));
    assert!(!has_audio(&out));
    assert!((duration_of(&out) - 4.0).abs() < 0.2);
}

// --- Quick effects ---

/// The mean pixel value of a BMP's data, 0 (black) to 255. The 54-byte header is skipped;
/// every fixture here is written by the same encoder, so the header is a fixed size.
fn mean_pixel(bytes: &[u8]) -> f64 {
    let pixels = &bytes[54..];
    pixels.iter().map(|b| *b as f64).sum::<f64>() / pixels.len() as f64
}

fn overlay(text: &str) -> TextOverlay {
    TextOverlay {
        text: text.to_string(),
        size: 0.12,
        color: "#ffcc00".to_string(),
        opacity: 1.0,
        anchor_x: TextAnchorX::Center,
        anchor_y: TextAnchorY::Bottom,
        boxed: true,
    }
}

#[test]
fn a_text_overlay_survives_the_trip_through_a_real_filtergraph() {
    if ffmpeg_missing() {
        return;
    }
    // The characters that would each break a naively escaped filtergraph: a colon separates
    // options, an apostrophe opens a quoted section, a percent starts an expansion and a
    // backslash escapes whatever follows.
    let src = landscape();
    let mut j = job(&src, "out-text.mp4");
    j.out_point = 2.0;
    j.effects.text = Some(overlay("50%: it's \\here\\"));

    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert!(out.is_file(), "the export produced no file");

    // Drawn, not merely accepted: the frame has to differ from the same export without it.
    let with_text = first_frame_bytes(&out, "frame-text.bmp");
    let mut plain = job(&src, "out-text-plain.mp4");
    plain.out_point = 2.0;
    let without = first_frame_bytes(&run_export(&plain, 1920, 1080, 30.0, true), "frame-plain.bmp");
    assert_ne!(with_text, without, "the overlay changed nothing in the frame");
}

#[test]
fn the_picture_effects_reach_the_pixels() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut plain = job(&src, "out-fx-plain.mp4");
    plain.out_point = 1.0;
    let before = first_frame_bytes(&run_export(&plain, 1920, 1080, 30.0, true), "frame-fx-plain.bmp");

    let mut graded = job(&src, "out-fx-graded.mp4");
    graded.out_point = 1.0;
    graded.effects.blur = Some(12.0);
    graded.effects.saturation = Some(0.0);
    graded.effects.contrast = Some(1.4);
    graded.effects.brightness = Some(0.8);
    graded.effects.hue = Some(45.0);
    graded.effects.vignette = Some(0.6);
    let after = first_frame_bytes(&run_export(&graded, 1920, 1080, 30.0, true), "frame-fx-graded.bmp");

    assert_ne!(before, after, "a full grade left the frame untouched");
    // Darker: a vignette, a brightness under 1 and colour bars pulled to grey all take light out.
    assert!(
        mean_pixel(&after) < mean_pixel(&before),
        "graded {} was not darker than plain {}",
        mean_pixel(&after),
        mean_pixel(&before)
    );
}

#[test]
fn a_fade_in_starts_black_and_the_clip_recovers() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-fade.mp4");
    j.out_point = 4.0;
    j.effects.fade_in = Some(1.0);

    let out = run_export(&j, 1920, 1080, 30.0, true);
    let first = mean_pixel(&first_frame_bytes(&out, "frame-fade-first.bmp"));
    assert!(first < 4.0, "the first frame of a fade in was not black: {first}");

    // Two seconds in is past the fade, so the picture is back.
    let later = fixture_dir().join("frame-fade-later.bmp");
    let status = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", "2", "-i"])
        .arg(&out)
        .args(["-frames:v", "1"])
        .arg(&later)
        .status()
        .expect("could not run ffmpeg");
    assert!(status.success(), "could not extract the later frame");
    let recovered = mean_pixel(&std::fs::read(&later).expect("the later frame is missing"));
    assert!(
        recovered > 40.0,
        "the clip never came back from the fade: {recovered}"
    );
}

#[test]
fn a_fade_applies_to_the_audio_as_well() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-fade-audio.mp4");
    j.out_point = 4.0;
    j.effects.fade_in = Some(1.0);
    j.effects.fade_out = Some(1.0);

    let out = run_export(&j, 1920, 1080, 30.0, true);
    // Half of a four second tone is fading, so the mean level has to sit under the tone's own.
    let mut plain = job(&src, "out-fade-audio-plain.mp4");
    plain.out_point = 4.0;
    let reference = run_export(&plain, 1920, 1080, 30.0, true);

    assert!(
        mean_volume(&out) < mean_volume(&reference) - 1.0,
        "faded {} was not quieter than plain {}",
        mean_volume(&out),
        mean_volume(&reference)
    );
}

// --- Speed ramping ---

fn ramp(pairs: &[(f64, f64)]) -> Vec<SpeedPoint> {
    pairs.iter().map(|(t, speed)| SpeedPoint { t: *t, speed: *speed }).collect()
}

/// The whole point of the closed form: a ramp is not the average of its ends. This curve
/// averages to 2.5x over its slope, which would predict a shorter clip than the integral of
/// 1/speed gives, and it is the integral that ffmpeg's own setpts expression produces.
#[test]
fn a_speed_ramp_lands_on_the_length_the_integral_predicts() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-ramp.mp4");
    j.out_point = 10.0;
    // 1x held, up to 4x, held, back to 1x - the shape a speed ramp actually gets used in.
    j.ramp = ramp(&[(0.0, 1.0), (3.0, 1.0), (5.0, 4.0), (8.0, 4.0), (10.0, 1.0)]);

    let predicted = output_duration(&j);
    let out = run_export(&j, 1920, 1080, 30.0, true);
    let actual = duration_of(&out);

    // One frame at 30 fps, which is the quantisation of the last timestamp.
    assert!(
        (actual - predicted).abs() < 0.05,
        "ramped clip ran {actual}s against a predicted {predicted}s"
    );
    // The averaged-ends answer would be about 5.1s. The integral says about 5.6s, and a
    // regression to the wrong maths lands well outside the frame tolerance above.
    assert!((predicted - 5.598).abs() < 0.01, "predicted {predicted}");
}

/// The audio has to end with the picture. atempo loses a sliver at every tempo change, so
/// the chain pads and cuts to the length the video works out to.
#[test]
fn a_ramped_clip_keeps_its_audio_the_same_length_as_its_picture() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-ramp-av.mp4");
    j.out_point = 12.0;
    j.ramp = ramp(&[(0.0, 1.0), (4.0, 3.0), (8.0, 3.0), (12.0, 0.5)]);

    let out = run_export(&j, 1920, 1080, 30.0, true);
    assert!(has_audio(&out), "the ramped export dropped its audio");

    let video = stream_duration(&out, "v");
    let audio = stream_duration(&out, "a");
    assert!(
        (video - audio).abs() < 0.1,
        "picture ran {video}s and audio ran {audio}s"
    );
}

/// A curve of all 1s has to leave the argument vector exactly as the speed slider alone would,
/// or every existing export quietly starts going through the ramp path.
#[test]
fn a_flat_curve_produces_the_same_arguments_as_no_curve_at_all() {
    let src = fixture_dir().join("landscape-1080p.mp4");
    let mut plain = job(&src, "out-flat-plain.mp4");
    plain.speed = 2.0;
    let mut flat = plain.clone();
    flat.ramp = ramp(&[(0.0, 1.0), (5.0, 1.0)]);

    let a = build_args(&plain, "libx264", true, 1920, 1080, 30.0, None);
    let b = build_args(&flat, "libx264", true, 1920, 1080, 30.0, None);
    assert_eq!(a, b);
}

/// A ramp under reverse still has to produce a playable clip of the right length: the curve
/// is applied on the source timeline and areverse runs after it, on the retimed stream.
#[test]
fn a_ramp_survives_being_reversed() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-ramp-reverse.mp4");
    j.out_point = 8.0;
    j.reverse = true;
    j.ramp = ramp(&[(0.0, 1.0), (4.0, 2.0), (8.0, 2.0)]);

    let predicted = output_duration(&j);
    let out = run_export(&j, 1920, 1080, 30.0, true);
    let actual = duration_of(&out);
    assert!(
        (actual - predicted).abs() < 0.2,
        "reversed ramp ran {actual}s against a predicted {predicted}s"
    );
}

