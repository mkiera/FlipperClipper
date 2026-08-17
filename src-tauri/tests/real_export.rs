//! Runs the argument vectors `build_args` produces through a real ffmpeg and
//! checks the file that comes out with ffprobe.
//!
//! The unit tests inside `ffmpeg.rs` are pure: they prove which flags are
//! emitted, which is exactly the wrong thing to trust on its own. A vector can
//! be word-for-word what was intended and still produce a clip of the wrong
//! length, because the meaning of `-to` depends on which side of `-i` it sits
//! and the meaning of `crop` depends on whether the decoder rotated the frame
//! first. Only ffmpeg can settle those, so this suite asks it.
//!
//! The fixtures are generated on demand into the OS temp directory rather than
//! committed, so the repository stays free of binaries. Encoding them costs a
//! few seconds once per machine.

use std::path::{Path, PathBuf};
use std::process::Command;

use flipperclipper_lib::ffmpeg::{
    build_args, output_duration, ExportFormat, ExportJob, QualityPreset, Rect,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
fn silent() -> PathBuf {
    ensure_fixture(
        "silent-720p.mp4",
        &[
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12",
            "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        ],
    )
}

/// Stored 1280x720 but flagged to display rotated, so its display size is
/// 720x1280. The case where working in stored rather than display coordinates
/// puts the crop rectangle on its side.
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
    // ffmpeg 7 dropped the old `-metadata:s:v:0 rotate=` form; the display
    // matrix is written by re-muxing with -display_rotation on the input.
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

// ---------------------------------------------------------------------------
// Probing the result
// ---------------------------------------------------------------------------

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

/// Decode the first frame of a finished export into an uncompressed BMP and
/// hand back its bytes. BMP rather than PNG so the comparison is over raw
/// pixels with no encoder freedom in between.
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

/// Build the argv the app would build, run it, and hand back the output path.
fn run_export(job: &ExportJob, width: i64, height: i64, fps: f64, has_source_audio: bool) -> PathBuf {
    // libx264 throughout: a hardware encoder would make these assertions depend
    // on which GPU the test happens to run against.
    let args = build_args(job, "libx264", has_source_audio, width, height, fps);
    let out = Command::new("ffmpeg")
        .args(&args)
        .output()
        .expect("could not run ffmpeg");
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
        crop: None,
        mute: false,
        reverse: false,
        volume: 1.0,
        format: ExportFormat::Mp4,
        quality: QualityPreset::Balanced,
        target_mb: None,
        output_height: None,
        video_kbps: None,
        lossless: false,
    }
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

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
    // The whole point of putting -ss and -t on the input side: three seconds
    // means three seconds, not "three seconds measured from wherever the seek
    // landed" and not the eight the source timeline would give.
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
    // If this drifts, the progress bar drifts with it - percent is out_time
    // measured against exactly this prediction.
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
    // atempo refuses anything below 0.5, so 0.25 only works if the filter was
    // chained. A single atempo=0.25 would have made ffmpeg exit non-zero and
    // run_export would already have failed.
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

    // testsrc2 paints a moving pattern with a burnt-in counter, so the frame
    // at t=0 and the frame at t=2 look nothing alike. If reverse worked, the
    // reversed file opens on what used to be the last frame; comparing the two
    // decoded first frames is a cheap proxy for "the clip plays backwards"
    // that does not need every frame decoded and matched.
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
fn doubled_volume_still_carries_an_audio_stream() {
    if ffmpeg_missing() {
        return;
    }
    let src = landscape();
    let mut j = job(&src, "out-volume.mp4");
    j.out_point = 3.0;
    j.volume = 2.0;

    // The risk is not the maths of the gain, it is the filter string: a typo
    // in "volume=" fails the whole export, and run_export already asserts the
    // exit code. What is left to check is that the stream survived the chain.
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
    // Exactly one stream: the source's audio must not have been mapped, and
    // the palette must have been consumed by paletteuse rather than muxed as a
    // second video stream.
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
    // Small keeps the VP9 encode short; the codec pair is the same at every
    // quality and VP9 is the slowest encoder in the whole matrix.
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
    // (10 - 2) / 2 = 4 s. If atempo were missing from this path the file
    // would come out at 8 s and the progress bar's prediction would be wrong
    // for every sped-up audio export.
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
    // Quarter speed stretches the 20 s source to 80 s of output, which pushes
    // the computed rate (186 kbps) under lame's 320k ceiling; at 1x the budget
    // would ask for 744k and lame would round it down to 320k anyway, making
    // the test pass without exercising the arithmetic.
    j.speed = 0.25;
    j.format = ExportFormat::Mp3;
    j.quality = QualityPreset::Fit;
    j.target_mb = Some(2.0);

    let out = run_export(&j, 1920, 1080, 30.0, true);
    let size = std::fs::metadata(&out).expect("no output file").len();
    assert!(size <= 2_000_000, "{size} bytes exceeds the 2 MB target");
    // lame snaps the requested rate to the nearest valid MPEG-1 rate (192k),
    // so the file should still land close to the budget, not miles under it.
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
    // y = 900 is outside the STORED height of 720 and inside the DISPLAY
    // height of 1280. It only survives if ffmpeg rotated before cropping,
    // which is the assumption the crop overlay is built on.
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
    // Dragged off the left and past the bottom. The visible selection is
    // 0..370 wide, so a clamp that kept the original width would emit 400 and
    // silently include 30 px the user never selected.
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
    // yuv420p subsamples chroma by two, so an odd dimension is rejected
    // outright by the encoder rather than rounded for us.
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

    // The real risk here is an atempo filter or an `-map 0:a:0` built for a
    // track that does not exist, either of which makes ffmpeg exit non-zero.
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
    // The budget deliberately undershoots so the file clears the limit however
    // the receiving service reads "10 MB". Also assert it is not absurdly
    // small, which would mean the bitrate maths collapsed rather than aimed.
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
    // Deliberately no duration assertion. Stream copy can only start on a
    // keyframe, so it snaps backwards - measured at 8.09 s for this 5..8 s
    // request against a fixture whose keyframes are ~8.3 s apart. That is the
    // documented cost of the lossless checkbox, not a bug, and asserting an
    // exact span here would encode a promise the feature does not make.
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

    // -movflags belongs to the mov/mp4 muxer; leaving it on a Matroska output
    // makes ffmpeg abort with "Option movflags not found" after the user has
    // already picked the filename.
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
