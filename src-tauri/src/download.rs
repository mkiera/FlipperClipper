//! Downloading and unpacking, shared by the updater and the FFmpeg installer.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tauri::Emitter;

/// Which half of the unpack failed, so each caller can name the thing it was unpacking.
pub(crate) enum UnpackError {
    PowerShellMissing,
    Failed,
}

/// GitHub answers 403 to an unauthenticated request that carries no `User-Agent`.
pub(crate) fn user_agent(version: &semver::Version) -> String {
    format!("FlipperClipper/{version} (+https://github.com/mkiera/FlipperClipper)")
}

/// Streams one file to disk, emitting progress, and deletes anything short of its promised length.
pub(crate) async fn stream_download(
    app: &tauri::AppHandle,
    download_url: &str,
    dest: &Path,
    size_bytes: Option<u64>,
    gone_message: Option<&str>,
    event: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        // No overall timeout: this body is the whole installer and a slow connection is not an error.
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Could not start the download: {e}"))?;

    let response = client
        .get(download_url)
        .header(
            reqwest::header::USER_AGENT,
            user_agent(&app.package_info().version),
        )
        .send()
        .await
        .map_err(|e| format!("Could not reach the download: {e}"))?;

    if !response.status().is_success() {
        if let (404, Some(gone)) = (response.status().as_u16(), gone_message) {
            return Err(gone.to_string());
        }
        return Err(format!(
            "The download answered with HTTP {}.",
            response.status()
        ));
    }

    // The releases API states a length; nightly.link only sends one back.
    let expected = size_bytes.or_else(|| response.content_length());

    let mut file =
        fs::File::create(dest).map_err(|e| format!("Could not write the download: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut written: u64 = 0;
    let mut last_emitted = 0.0_f64;
    let mut last_emitted_at = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => {
                let _ = fs::remove_file(dest);
                return Err(format!("The download stopped early: {e}"));
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            let _ = fs::remove_file(dest);
            return Err(format!("Could not write the download: {e}"));
        }
        written += chunk.len() as u64;

        // Per chunk would be hundreds of IPC events a second to move the bar by less than a pixel.
        let Some(total) = expected.filter(|total| *total > 0) else {
            continue;
        };
        let fraction = (written as f64 / total as f64).min(1.0);
        if fraction - last_emitted >= 0.01 || last_emitted_at.elapsed() >= Duration::from_millis(100)
        {
            last_emitted = fraction;
            last_emitted_at = Instant::now();
            let _ = app.emit(event, fraction);
        }
    }

    if let Err(e) = file.flush() {
        let _ = fs::remove_file(dest);
        return Err(format!("Could not finish writing the download: {e}"));
    }
    drop(file);

    // A stream that ends is indistinguishable from a connection that was cut, and this file is
    // about to be executed as an installer.
    if let Some(total) = expected {
        if written != total {
            let _ = fs::remove_file(dest);
            return Err(format!(
                "The download stopped early — got {} bytes of the {} it should have. \
                 The incomplete file has been deleted; please try again.",
                written, total
            ));
        }
    }

    let _ = app.emit(event, 1.0_f64);
    Ok(())
}

/// Expand-Archive rather than a zip crate, and the path travels in an environment variable
/// because PowerShell re-parses everything after -Command.
pub(crate) fn extract_zip(zip: &Path, dir: &Path) -> Result<(), UnpackError> {
    let status = crate::ffmpeg::hidden_command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath $env:FLIPPERCLIPPER_ZIP \
             -DestinationPath $env:FLIPPERCLIPPER_ZIP_DEST -Force",
        ])
        .env("FLIPPERCLIPPER_ZIP", zip)
        .env("FLIPPERCLIPPER_ZIP_DEST", dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| UnpackError::PowerShellMissing)?;

    if !status.success() {
        // Expand-Archive reads the central directory at the end, so a truncated download fails here.
        return Err(UnpackError::Failed);
    }
    Ok(())
}

/// The one file wanted out of an extracted tree. A match at the current level beats a deeper one,
/// and depth counts the levels below the starting directory.
pub(crate) fn find_file(dir: &Path, depth: u8, matches: &dyn Fn(&str) -> bool) -> Option<PathBuf> {
    let mut subdirs = Vec::new();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches(name))
        {
            return Some(path);
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs
        .into_iter()
        .find_map(|subdir| find_file(&subdir, depth - 1, matches))
}
