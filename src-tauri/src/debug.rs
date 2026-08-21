//! What the debug panel reports, and the diagnostic it can run.
//!
//! The panel exists to turn "it did not work" into something answerable without the machine in
//! front of you. Everything here is read at the moment it is asked for rather than cached at
//! startup: a report that says FFmpeg is missing when it was installed ten minutes ago sends
//! the reader down the wrong path.
//!
//! The browser side fills in what it can see better than Rust can - the OS build and the
//! WebView2 version both sit in the user agent - so this covers the tools and the paths.

use std::path::Path;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::ffmpeg;
use crate::AppState;

/// Long enough for a cold FFmpeg on a slow disk, short enough that a hung probe still answers.
const DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(60);

/// The test clip, small enough to encode in well under a second on anything.
const TEST_WIDTH: i64 = 320;
const TEST_HEIGHT: i64 = 180;
const TEST_FPS: f64 = 30.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolReport {
    pub found: bool,
    /// Where it actually resolved to, which is the answer when two FFmpegs are installed.
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugReport {
    pub app_version: String,
    pub tauri_version: String,
    pub arch: String,
    pub os_family: String,
    pub ffmpeg: ToolReport,
    pub ffprobe: ToolReport,
    /// What an export would actually encode with, hardware or software.
    pub encoder: String,
    pub config_dir: Option<String>,
    pub temp_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticResult {
    pub success: bool,
    pub message: String,
    /// Whatever FFmpeg said, when it said anything. Empty on success.
    pub detail: String,
    pub millis: u64,
}

#[tauri::command]
pub fn debug_report(app: AppHandle) -> DebugReport {
    // Every call re-resolves, so a verdict cannot outlive the conditions that produced it.
    ffmpeg::forget_resolved_tools();

    DebugReport {
        app_version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        os_family: std::env::consts::OS.to_string(),
        ffmpeg: tool("ffmpeg"),
        ffprobe: tool("ffprobe"),
        encoder: crate::export::resolve_encoder(&app.state::<AppState>()),
        config_dir: app
            .path()
            .app_config_dir()
            .ok()
            .map(|dir| dir.to_string_lossy().into_owned()),
        temp_dir: std::env::temp_dir().to_string_lossy().into_owned(),
    }
}

fn tool(name: &str) -> ToolReport {
    match ffmpeg::resolve_tool_with_version(name) {
        Some((path, text)) => ToolReport {
            found: true,
            path: Some(path.to_string_lossy().into_owned()),
            // The first line carries the version; the rest is the build's configure flags.
            version: text.lines().next().map(|line| line.trim().to_string()),
        },
        None => ToolReport {
            found: false,
            path: None,
            version: None,
        },
    }
}

/// A real export, start to finish, on a clip this makes for itself.
///
/// Checking that FFmpeg answers `-version` proves far less than it looks: the encoder can be
/// missing its DLL, the temp folder can be unwritable, and a filter can be absent from a
/// cut-down build. All three only show up when something is actually encoded.
#[tauri::command]
pub fn run_diagnostic(app: AppHandle) -> DiagnosticResult {
    let started = Instant::now();
    let (tx, rx) = mpsc::channel();
    let encoder = crate::export::resolve_encoder(&app.state::<AppState>());

    std::thread::spawn(move || {
        let _ = tx.send(diagnose(&encoder));
    });

    match rx.recv_timeout(DIAGNOSTIC_TIMEOUT) {
        Ok((success, message, detail)) => DiagnosticResult {
            success,
            message,
            detail,
            millis: started.elapsed().as_millis() as u64,
        },
        Err(_) => DiagnosticResult {
            success: false,
            message: "The test export did not finish.".to_string(),
            detail: format!(
                "FFmpeg was still running after {} seconds. That usually means it is waiting on \
                 a device that is not answering - a hardware encoder on a sleeping GPU is the \
                 common one. Setting the encoder to software in Settings works around it.",
                DIAGNOSTIC_TIMEOUT.as_secs()
            ),
            millis: started.elapsed().as_millis() as u64,
        },
    }
}

/// Returns (success, message, detail). Split out so the timeout above owns the waiting.
fn diagnose(encoder: &str) -> (bool, String, String) {
    let dir = std::env::temp_dir().join(format!("flipperclipper-diagnostic-{}", std::process::id()));
    if std::fs::create_dir_all(&dir).is_err() {
        return (
            false,
            "The temp folder could not be written to.".to_string(),
            format!("Tried to create {}", dir.display()),
        );
    }

    let source = dir.join("source.mp4");
    let output = dir.join("export.mp4");
    let _ = std::fs::remove_file(&output);

    if let Err(detail) = make_source(&source) {
        return (
            false,
            "A test clip could not be made.".to_string(),
            detail,
        );
    }

    // A job that touches the parts an ordinary export touches: a trim, a retime, and a filter.
    let mut job = ffmpeg::ExportJob {
        input: source.to_string_lossy().into_owned(),
        output: output.to_string_lossy().into_owned(),
        in_point: 0.25,
        out_point: 1.75,
        speed: 1.5,
        ramp: Vec::new(),
        crop: None,
        mute: false,
        reverse: false,
        normalize: false,
        volume: 1.0,
        format: ffmpeg::ExportFormat::Mp4,
        quality: ffmpeg::QualityPreset::Balanced,
        target_mb: None,
        lossless: false,
        output_height: None,
        video_kbps: None,
        effects: ffmpeg::Effects::default(),
    };
    job.effects.contrast = Some(1.1);

    let args = ffmpeg::build_args(
        &job,
        encoder,
        true,
        TEST_WIDTH,
        TEST_HEIGHT,
        TEST_FPS,
        None,
    );
    let result = ffmpeg::hidden_command("ffmpeg")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    let outcome = match result {
        Ok(out) if out.status.success() => {
            let size = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
            if size == 0 {
                (
                    false,
                    "FFmpeg reported success but wrote nothing.".to_string(),
                    format!("{} is empty.", output.display()),
                )
            } else {
                (
                    true,
                    format!("Exported {} KB with {}.", size / 1024, encoder),
                    String::new(),
                )
            }
        }
        Ok(out) => (
            false,
            "The test export failed.".to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ),
        Err(e) => (
            false,
            "FFmpeg could not be started.".to_string(),
            e.to_string(),
        ),
    };

    let _ = std::fs::remove_file(&source);
    let _ = std::fs::remove_file(&output);
    outcome
}

/// Two seconds of colour bars and a tone, built by FFmpeg so the test needs no fixture on disk.
fn make_source(path: &Path) -> Result<(), String> {
    let status = ffmpeg::hidden_command("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!(
                "testsrc2=size={}x{}:rate={}:duration=2",
                TEST_WIDTH, TEST_HEIGHT, TEST_FPS
            ),
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    match status {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(e) => Err(e.to_string()),
    }
}
