use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::ffmpeg::{self, ExportFormat, ExportJob, QualityPreset};
use crate::settings::EncoderPreference;
use crate::{AppState, ExportSlot};

const EVENT_PROGRESS: &str = "export-progress";
const EVENT_DONE: &str = "export-done";
const EVENT_ERROR: &str = "export-error";

/// ffmpeg writes several hundred progress blocks a second on a hardware encoder.
const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(50);

/// Enough for the real complaint; a thousand DTS warnings must not push it out.
const STDERR_TAIL_LINES: usize = 40;

/// Ordered by how much CPU they leave free. A missing GPU fails at run time rather than
/// being absent from `-encoders`, which is why each one is test-run.
const ENCODER_CANDIDATES: [&str; 3] = ["h264_nvenc", "h264_qsv", "h264_amf"];

/// The only thing keeping an arbitrary height out of a job that arrives over IPC.
const OUTPUT_HEIGHTS: [i64; 6] = [2160, 1440, 1080, 720, 480, 360];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    percent: f64,
    speed: Option<f64>,
    eta_seconds: Option<f64>,
}

/// A poisoned lock here holds a process handle and a bool, neither half-writable, so taking
/// the value out beats refusing to export until the app restarts.
fn lock_slot(slot: &Mutex<ExportSlot>) -> MutexGuard<'_, ExportSlot> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command(async)]
pub fn detect_encoder(app: AppHandle) -> String {
    // "Force software" is usually picked because the probes hang or wake a discrete GPU.
    if crate::settings::load(&app).encoder != EncoderPreference::Auto {
        return "libx264".to_string();
    }
    resolve_encoder(&app.state::<AppState>())
}

pub fn resolve_encoder(state: &AppState) -> String {
    {
        let cached = state
            .encoder
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(name) = cached.as_ref() {
            return name.clone();
        }
    }

    // Not cached when nothing validated: FFmpeg may not be reachable yet at startup.
    let Some(picked) = ENCODER_CANDIDATES.iter().find(|name| test_encode(name)) else {
        return "libx264".to_string();
    };
    let picked = picked.to_string();

    let mut cached = state
        .encoder
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cached = Some(picked.clone());
    picked
}

/// h264_nvenc is compiled into every full build whether or not the machine has the card,
/// so `-encoders` would list it and the real export would fail on the missing DLL.
fn test_encode(encoder: &str) -> bool {
    ffmpeg::hidden_command("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "nullsrc=s=256x144",
            "-frames:v",
            "1",
            "-c:v",
            encoder,
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[tauri::command(async)]
pub fn start_export(app: AppHandle, job: ExportJob) -> Result<(), String> {
    validate(&job)?;

    let state = app.state::<AppState>();
    let slot_arc = Arc::clone(&state.export);
    if lock_slot(&slot_arc).child.is_some() {
        return Err("An export is already running. Cancel it first.".to_string());
    }

    // The job carries what the user asked for, not what is in the file. Without this probe a
    // clip recorded with the mic off fails on "Stream map '0:a:0' matches no streams".
    let info = crate::sysutil::probe_media(&job.input)?;
    if is_audio_format(&job.format) && !info.has_audio {
        return Err("This video has no audio track to export.".to_string());
    }
    // Only the h264 containers read the encoder, and resolving it test-runs an ffmpeg per candidate.
    let hardware_allowed = crate::settings::load(&app).encoder == EncoderPreference::Auto;
    let encoder = if hardware_allowed
        && matches!(
            job.format,
            ExportFormat::Mp4 | ExportFormat::Mov | ExportFormat::Mkv
        ) {
        resolve_encoder(&state)
    } else {
        "libx264".to_string()
    };
    let args = ffmpeg::build_args(
        &job,
        &encoder,
        info.has_audio,
        info.width,
        info.height,
        info.fps,
    );

    let mut child = ffmpeg::hidden_command("ffmpeg")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| {
            "FFmpeg could not be started. It may have been uninstalled or removed from PATH."
                .to_string()
        })?;

    let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
        (Some(out), Some(err)) => (out, err),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("FFmpeg started but FlipperClipper could not read from it.".to_string());
        }
    };

    {
        // Checked again now the child exists: two ffmpegs on one output write a corrupt file and
        // neither of them reports an error.
        let mut slot = lock_slot(&slot_arc);
        if slot.child.is_some() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("An export is already running. Cancel it first.".to_string());
        }
        slot.cancelled = false;
        slot.child = Some(child);
    }

    let stderr_reader = std::thread::spawn(move || collect_stderr_tail(stderr));

    let total = ffmpeg::output_duration(&job);
    let output_path = job.output.clone();
    let watcher_app = app.clone();
    let watcher_slot = Arc::clone(&slot_arc);

    std::thread::spawn(move || {
        read_progress(&watcher_app, stdout, total);

        let tail = stderr_reader.join().unwrap_or_default();

        let (child, cancelled) = {
            let mut slot = lock_slot(&watcher_slot);
            (slot.child.take(), slot.cancelled)
        };
        // Reaped even when cancelled, or the killed ffmpeg lingers as a zombie.
        let status = child.map(|mut child| child.wait());

        if cancelled {
            // A half-written file wearing the final name looks like a finished export.
            let _ = std::fs::remove_file(&output_path);
            return;
        }

        match status {
            Some(Ok(status)) if status.success() => {
                let _ = watcher_app.emit(EVENT_DONE, output_path);
            }
            Some(Ok(_)) => {
                let _ = watcher_app.emit(EVENT_ERROR, explain_failure(&tail));
            }
            _ => {
                let _ = watcher_app.emit(
                    EVENT_ERROR,
                    "FFmpeg stopped unexpectedly and the export did not finish.".to_string(),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_export(app: AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = lock_slot(&state.export);
    slot.cancelled = true;
    if let Some(child) = slot.child.as_mut() {
        let _ = child.kill();
    }
}

/// Matched here rather than imported, so a new container fails to compile in this match
/// instead of silently defaulting to video.
fn is_audio_format(format: &ExportFormat) -> bool {
    match format {
        ExportFormat::Mp3
        | ExportFormat::M4a
        | ExportFormat::Wav
        | ExportFormat::Flac
        | ExportFormat::Ogg
        | ExportFormat::Opus => true,
        ExportFormat::Mp4
        | ExportFormat::Mkv
        | ExportFormat::Mov
        | ExportFormat::Webm
        | ExportFormat::Gif => false,
    }
}

fn validate(job: &ExportJob) -> Result<(), String> {
    if !job.in_point.is_finite() || !job.out_point.is_finite() {
        return Err("The trim points are not valid numbers.".to_string());
    }
    if job.in_point < 0.0 {
        return Err("The in point is before the start of the clip.".to_string());
    }
    if job.out_point <= job.in_point {
        return Err("The trim range is empty. Move the out point after the in point.".to_string());
    }
    // Wider than the slider on purpose: the number input goes to 0.05..20.
    if !job.speed.is_finite() || !(0.05..=20.0).contains(&job.speed) {
        return Err("Speed has to be between 0.05x and 20x.".to_string());
    }
    if !job.volume.is_finite() || !(0.0..=2.0).contains(&job.volume) {
        return Err("Volume has to be between 0% and 200%.".to_string());
    }

    if matches!(job.quality, QualityPreset::Fit) {
        // gif's size is a function of its content, and wav/flac encode every sample at full fidelity.
        if matches!(job.format, ExportFormat::Gif) {
            return Err("A GIF cannot be fitted under a size target.".to_string());
        }
        if matches!(job.format, ExportFormat::Wav | ExportFormat::Flac) {
            return Err("WAV and FLAC cannot be fitted under a size target.".to_string());
        }
        match job.target_mb {
            Some(mb) if mb.is_finite() && (0.5..=10_000.0).contains(&mb) => {}
            _ => {
                return Err("The target size has to be between 0.5 and 10000 MB.".to_string());
            }
        }
    }

    if let Some(height) = job.output_height {
        if !OUTPUT_HEIGHTS.contains(&height) {
            return Err(
                "The output size has to be 2160, 1440, 1080, 720, 480 or 360.".to_string(),
            );
        }
    }
    if let Some(kbps) = job.video_kbps {
        if !(50..=200_000).contains(&kbps) {
            return Err("The video bitrate has to be between 50 and 200000 kbps.".to_string());
        }
        if matches!(job.quality, QualityPreset::Fit) {
            return Err(
                "A size target works out its own bitrate, so it cannot be given one as well."
                    .to_string(),
            );
        }
    }

    if job.mute && is_audio_format(&job.format) {
        return Err("A muted audio export would be silence.".to_string());
    }

    // A job arrives over IPC, so the UI greying these combinations out is not a guarantee.
    if job.lossless
        && (job.reverse
            || job.volume != 1.0
            || is_audio_format(&job.format)
            || matches!(job.format, ExportFormat::Gif))
    {
        return Err(
            "A lossless export copies the video as it is, so it cannot reverse, change the volume, or change to an audio or GIF format.".to_string(),
        );
    }
    if !Path::new(&job.input).is_file() {
        return Err("The source video is no longer there. It may have been moved or deleted."
            .to_string());
    }

    // -y truncates the output before the first frame is read, so exporting over the source
    // destroys the source and then fails. Windows paths compare folded.
    if job.input.to_lowercase() == job.output.to_lowercase() {
        return Err(
            "Pick a different name: this would overwrite the video you are editing.".to_string(),
        );
    }

    match Path::new(&job.output).parent() {
        None => return Err("The export path is not a file path.".to_string()),
        Some(dir) if dir.as_os_str().is_empty() => {}
        Some(dir) if !dir.is_dir() => {
            return Err(format!(
                "The folder for the exported file does not exist: {}",
                dir.display()
            ))
        }
        Some(_) => {}
    }

    if let Some(crop) = job.crop {
        // A negative origin is the ordinary result of dragging past an edge, and build_args trims
        // the rectangle back inside the frame.
        if crop.w <= 0 || crop.h <= 0 {
            return Err("The crop rectangle is empty.".to_string());
        }
    }

    Ok(())
}

fn read_progress<R: std::io::Read>(app: &AppHandle, stdout: R, total: f64) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut last_emit: Option<Instant> = None;
    let mut out_seconds = 0.0f64;
    let mut speed: Option<f64> = None;
    // Some builds report only `out_time`; once a microsecond key has been seen the text one is ignored.
    let mut micros_seen = false;

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }

        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };

        match key {
            // Both keys carry microseconds - `out_time_ms` being microseconds is a quirk of the progress writer.
            "out_time_us" | "out_time_ms" => {
                if let Ok(micros) = value.parse::<f64>() {
                    out_seconds = micros / 1_000_000.0;
                    micros_seen = true;
                }
            }
            "out_time" => {
                if !micros_seen {
                    if let Some(seconds) = parse_timestamp(value) {
                        out_seconds = seconds;
                    }
                }
            }
            "speed" => {
                speed = value.trim().trim_end_matches('x').parse::<f64>().ok();
            }
            // Every progress block is terminated by this key, so it is where the values belong together.
            "progress" => {
                let ended = value.trim() == "end";
                if !ended {
                    if let Some(previous) = last_emit {
                        if previous.elapsed() < MIN_EMIT_INTERVAL {
                            continue;
                        }
                    }
                }
                last_emit = Some(Instant::now());

                let percent = if ended {
                    1.0
                } else if total > 0.0 {
                    (out_seconds / total).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let eta_seconds = match speed {
                    _ if ended => Some(0.0),
                    Some(rate) if rate > 0.0 => Some((total - out_seconds).max(0.0) / rate),
                    _ => None,
                };

                let _ = app.emit(
                    EVENT_PROGRESS,
                    ExportProgress {
                        percent,
                        speed,
                        eta_seconds,
                    },
                );
            }
            _ => {}
        }
    }
}

/// "00:01:02.345678" -> 62.345678, and the "N/A" before the first frame by failing to parse.
fn parse_timestamp(value: &str) -> Option<f64> {
    let mut seconds = 0.0f64;
    for part in value.trim().split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(seconds)
}

fn collect_stderr_tail<R: std::io::Read>(stderr: R) -> VecDeque<String> {
    let mut tail: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL_LINES);
    for line in BufReader::new(stderr).lines() {
        let Ok(line) = line else { break };
        // Stored raw: the leading whitespace is what tells ffmpeg's indented metadata dump apart
        // from a real error message.
        if line.trim().is_empty() {
            continue;
        }
        if tail.len() == STDERR_TAIL_LINES {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    tail
}

/// The last line is usually the real complaint, but "Conversion failed!" is the last line of
/// most failures and says nothing, so three are kept.
fn explain_failure(tail: &VecDeque<String>) -> String {
    let inventory = |line: &&String| {
        let line = line.as_str();
        // Everything ffmpeg indents is part of the stream inventory it prints on the way in.
        !(line.starts_with(char::is_whitespace)
            || line.starts_with("ffmpeg version")
            || line.starts_with("built with")
            || line.starts_with("configuration:")
            || line.starts_with("lib")
            || line.starts_with("Input #")
            || line.starts_with("Output #")
            || line.starts_with("Stream #")
            || line.starts_with("Stream mapping:")
            || line.starts_with("Metadata:")
            || line.starts_with("Duration:")
            || line.starts_with("frame=")
            || line.starts_with("Press ["))
    };

    let mut picked: Vec<&str> = tail
        .iter()
        .rev()
        .filter(inventory)
        .take(3)
        .map(|line| line.trim())
        .collect();
    picked.reverse();

    if picked.is_empty() {
        return "FFmpeg failed without saying why. The source file may be damaged.".to_string();
    }
    picked.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> ExportJob {
        ExportJob {
            input: "C:\\clips\\a.mp4".to_string(),
            output: "C:\\clips\\b.mp4".to_string(),
            in_point: 0.0,
            out_point: 10.0,
            speed: 1.0,
            crop: None,
            mute: false,
            reverse: false,
            volume: 1.0,
            format: ExportFormat::Mp4,
            quality: QualityPreset::Balanced,
            target_mb: None,
            lossless: false,
            output_height: None,
            video_kbps: None,
        }
    }

    #[test]
    fn only_the_offered_output_sizes_are_accepted() {
        for height in [2160, 1440, 1080, 720, 480, 360] {
            let mut j = job();
            j.output_height = Some(height);
            assert_ne!(
                validate(&j).unwrap_err(),
                "The output size has to be 2160, 1440, 1080, 720, 480 or 360."
            );
        }
        for height in [1081, 0, -720, 4320] {
            let mut j = job();
            j.output_height = Some(height);
            assert_eq!(
                validate(&j).unwrap_err(),
                "The output size has to be 2160, 1440, 1080, 720, 480 or 360."
            );
        }
    }

    #[test]
    fn the_explicit_bitrate_is_bounded() {
        for kbps in [49, 0, -1, 200_001] {
            let mut j = job();
            j.video_kbps = Some(kbps);
            assert_eq!(
                validate(&j).unwrap_err(),
                "The video bitrate has to be between 50 and 200000 kbps."
            );
        }
        for kbps in [50, 8_000, 200_000] {
            let mut j = job();
            j.video_kbps = Some(kbps);
            assert_ne!(
                validate(&j).unwrap_err(),
                "The video bitrate has to be between 50 and 200000 kbps."
            );
        }
    }

    #[test]
    fn a_size_target_and_an_explicit_bitrate_cannot_both_be_asked_for() {
        let mut j = job();
        j.quality = QualityPreset::Fit;
        j.target_mb = Some(10.0);
        j.video_kbps = Some(4000);
        assert_eq!(
            validate(&j).unwrap_err(),
            "A size target works out its own bitrate, so it cannot be given one as well."
        );

        j.video_kbps = None;
        assert_ne!(
            validate(&j).unwrap_err(),
            "A size target works out its own bitrate, so it cannot be given one as well."
        );
    }
}
