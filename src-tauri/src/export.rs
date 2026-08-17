use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::ffmpeg::{self, ExportJob};
use crate::{AppState, ExportSlot};

const EVENT_PROGRESS: &str = "export-progress";
const EVENT_DONE: &str = "export-done";
const EVENT_ERROR: &str = "export-error";

/// ffmpeg writes a progress block roughly every half second of *encoded* video,
/// which on a hardware encoder chewing through a short clip is several hundred
/// blocks a second. Forwarding all of them would repaint a progress bar far more
/// often than the display can show it and starve the same webview that has to
/// keep the preview responsive, so the stream is thinned to 20 events a second.
const MIN_EMIT_INTERVAL: Duration = Duration::from_millis(50);

/// Enough stderr to hold the real complaint plus the lines around it, but not so
/// much that a file with a thousand "non-monotonous DTS" warnings pushes the
/// useful line out of the buffer before ffmpeg exits.
const STDERR_TAIL_LINES: usize = 40;

/// Tried in this order because that is the order of how much CPU they leave for
/// everything else. A missing GPU shows up as the process failing, not as the
/// encoder being absent from `-encoders`, which is why each one is test-run.
const ENCODER_CANDIDATES: [&str; 3] = ["h264_nvenc", "h264_qsv", "h264_amf"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    percent: f64,
    speed: Option<f64>,
    eta_seconds: Option<f64>,
}

/// A panic in one of the export threads must not wedge every later export. The
/// data behind this lock is a process handle and a bool, neither of which can be
/// left half-written, so taking the value out of a poisoned lock is safe here and
/// strictly better than refusing to export until the app is restarted.
fn lock_slot(slot: &Mutex<ExportSlot>) -> MutexGuard<'_, ExportSlot> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tauri::command(async)]
pub fn detect_encoder(app: AppHandle) -> String {
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

    let picked = ENCODER_CANDIDATES
        .iter()
        .find(|name| test_encode(name))
        .map(|name| name.to_string())
        .unwrap_or_else(|| "libx264".to_string());

    let mut cached = state
        .encoder
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *cached = Some(picked.clone());
    picked
}

/// One frame of nothing through the encoder and straight into the null muxer.
/// This is the only reliable test: h264_nvenc is compiled into every full build
/// of FFmpeg 7.1 whether or not the machine has an NVIDIA card, and asking for
/// the encoder list would report it as available on a laptop that would then
/// fail the real export with "Cannot load nvEncodeAPI64.dll".
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

    // The stream mapping ffmpeg gets depends on whether the source has audio at
    // all, and the job the UI sends does not carry that - it only knows what the
    // user asked for, not what is in the file. A probe here costs about 30 ms and
    // saves the "Stream map '0:a:0' matches no streams" failure that a clip
    // recorded with the mic off would otherwise hit every single time.
    //
    // The same probe answers the other two questions build_args has to settle:
    // the frame size it clamps the crop rectangle against, and the size and rate
    // it measures bits-per-pixel with when a fit-under-10-MB target has to decide
    // whether to downscale. These are display-orientation values, which is the
    // space the crop rectangle already arrives in, so they pass straight through.
    let info = crate::sysutil::probe_media(&job.input)?;
    let encoder = resolve_encoder(&state);
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
            return Err("FFmpeg started but QuickClip could not read from it.".to_string());
        }
    };

    {
        // Checked again now that the child exists, because the probe above takes
        // long enough for a second Export click to have got past the first check.
        // Two ffmpegs writing the same output file produce a corrupt mp4 and no
        // error from either of them, which is the worst way for this to fail.
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
        // Reaped even when cancelled, otherwise the killed ffmpeg lingers as a
        // zombie for as long as QuickClip stays open.
        let status = child.map(|mut child| child.wait());

        if cancelled {
            // A half-written mp4 wearing the final name is worse than no file at
            // all: it sits in the folder looking like a finished export, and the
            // person it gets sent to is the one who finds out it is not.
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
        // Nothing to report on a failed kill: either the process is already gone,
        // which is the outcome we wanted, or it will be reaped by the watcher
        // thread a moment from now anyway.
        let _ = child.kill();
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
    if !job.speed.is_finite() || !(0.25..=4.0).contains(&job.speed) {
        return Err("Speed has to be between 0.25x and 4x.".to_string());
    }
    if !Path::new(&job.input).is_file() {
        return Err("The source video is no longer there. It may have been moved or deleted."
            .to_string());
    }

    // ffmpeg opens the output with -y and truncates it before it reads a single
    // frame, so exporting over the source destroys the source and then fails.
    // Windows paths are case-insensitive, which is why this compares folded.
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
        // Only a rectangle with no area is refused here. A negative origin is the
        // ordinary result of dragging the crop box past the left or top edge of
        // the picture, and build_args already trims the rectangle back inside the
        // frame; rejecting it here turned a routine overshoot into a failed
        // export and made that clamping unreachable from the real command path.
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
    // Some builds report only `out_time`, some report `out_time_us` too. Once a
    // microsecond key has been seen the text timestamp is ignored, so the two
    // never fight over the same value at different precisions.
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
            // FFmpeg writes AV_TIME_BASE units - microseconds - under both of
            // these keys. `out_time_ms` being microseconds rather than
            // milliseconds is a long-standing quirk of the progress writer, and
            // dividing it by a thousand is what makes a progress bar crawl to 0.1%
            // and stop on the builds that emit only that key.
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
            // Every progress block is terminated by this key, which makes it the
            // one place where all the other values are known to belong together.
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

/// "00:01:02.345678" -> 62.345678. Also covers the "N/A" ffmpeg prints before the
/// first frame is written, by failing to parse it.
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
        // The line is stored raw because its leading whitespace is the only thing
        // that tells ffmpeg's indented metadata tags ("  encoder : Lavf60.16.100")
        // apart from a real error message, and explain_failure needs that to keep
        // MP4 box tags out of the toast the user sees. Emptiness is tested on a
        // trimmed copy so a whitespace-only line is still skipped.
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

/// Turns the tail of ffmpeg's stderr into something worth putting in a toast.
///
/// The last line is usually the real complaint, but not always - "Conversion
/// failed!" is the last line of most failures and says nothing - so three lines
/// are kept, and the stream inventory ffmpeg prints on the way in is dropped,
/// because a person reading "Stream #0:1: Audio: aac (LC), 48000 Hz" learns
/// nothing about why their clip did not export.
fn explain_failure(tail: &VecDeque<String>) -> String {
    let inventory = |line: &&String| {
        let line = line.as_str();
        // Everything ffmpeg indents is part of the inventory it prints on the way
        // in: the tag lines between "Input #" and "Stream #" read as
        // "major_brand : isom" and "handler_name : SoundHandler", and matching
        // them by prefix is hopeless because the tag names come from the file. A
        // failure during input parsing or muxer setup leaves those as the last
        // lines on stderr, so without this the toast is three lines of MP4 boxes.
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
        // Trimmed only now that the indentation has done its filtering job, so
        // the toast does not carry ffmpeg's alignment padding into the UI.
        .map(|line| line.trim())
        .collect();
    picked.reverse();

    if picked.is_empty() {
        return "FFmpeg failed without saying why. The source file may be damaged.".to_string();
    }
    picked.join("\n")
}
