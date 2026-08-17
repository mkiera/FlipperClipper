use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::ffmpeg::{self, MediaInfo};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub available: bool,
    pub version: Option<String>,
}

#[tauri::command(async)]
pub fn ffmpeg_status() -> FfmpegStatus {
    let output = ffmpeg::hidden_command("ffmpeg")
        .args(["-hide_banner", "-version"])
        .stdin(Stdio::null())
        .output();

    match output {
        Ok(output) if output.status.success() => FfmpegStatus {
            available: true,
            version: parse_version_line(&String::from_utf8_lossy(&output.stdout)),
        },
        // Anything else - not on PATH, not executable, a stub that exits non-zero
        // - is the same thing as far as the install banner is concerned: this
        // machine cannot export until FFmpeg is dealt with.
        _ => FfmpegStatus {
            available: false,
            version: None,
        },
    }
}

/// "ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024 ..." from
/// the winget build, "ffmpeg version n7.1 Copyright ..." from others. The third
/// whitespace-separated token is the version in every build FFmpeg has shipped.
fn parse_version_line(text: &str) -> Option<String> {
    let mut parts = text.lines().next()?.split_whitespace();
    if parts.next()? != "ffmpeg" || parts.next()? != "version" {
        return None;
    }
    parts.next().map(|version| version.to_string())
}

#[tauri::command(async)]
pub fn install_ffmpeg() -> Result<(), String> {
    let output = ffmpeg::hidden_command("winget")
        .args([
            "install",
            "-e",
            "--id",
            "Gyan.FFmpeg",
            "--source",
            "winget",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
            "--silent",
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| {
            "Windows Package Manager (winget) is not available on this PC, so FFmpeg cannot be \
             installed automatically. Install FFmpeg yourself and restart FlipperClipper."
                .to_string()
        })?;

    if !output.status.success() {
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        // winget exits non-zero when the package is already present. That is not
        // a failure from where the user is standing - they pressed a button
        // because export said FFmpeg was missing, and the honest outcome is that
        // it is installed after all and only the PATH was stale.
        if !text.to_lowercase().contains("already installed") {
            return Err(last_meaningful_line(&text).unwrap_or_else(|| {
                "The FFmpeg install did not finish. Try running it from a terminal to see why: \
                 winget install -e --id Gyan.FFmpeg"
                    .to_string()
            }));
        }
    }

    add_winget_links_to_path();
    Ok(())
}

/// winget drops its shims in %LOCALAPPDATA%\Microsoft\WinGet\Links and adds that
/// folder to the *user's* PATH, but a process only ever sees the copy of the
/// environment it was launched with. Without this the install banner would stay
/// up, and every export would keep failing, until FlipperClipper was restarted -
/// while ffmpeg.exe sat on disk the whole time. Child processes inherit this
/// process's environment, so patching it here is enough to find the new exe.
fn add_winget_links_to_path() {
    let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let links = PathBuf::from(local_app_data)
        .join("Microsoft")
        .join("WinGet")
        .join("Links");
    if !links.is_dir() {
        return;
    }

    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&current).collect();
    if dirs.iter().any(|dir| dir == &links) {
        return;
    }
    dirs.push(links);
    if let Ok(joined) = std::env::join_paths(dirs) {
        std::env::set_var("PATH", joined);
    }
}

fn last_meaningful_line(text: &str) -> Option<String> {
    text.lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .next_back()
        .map(|line| line.to_string())
}

#[tauri::command(async)]
pub fn probe(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    let info = probe_media(&path)?;

    // The <video> element reads the file through Tauri's asset protocol, which
    // serves nothing outside its scope. tauri.conf.json ships that scope empty on
    // purpose - a tool that opens whatever the user drags onto it has no folder
    // it could name up front - so each file earns its entry at the moment it is
    // opened, and nothing else on the disk is reachable from the webview.
    app.asset_protocol_scope().allow_file(&path).map_err(|_| {
        "FlipperClipper could not give itself permission to play that file.".to_string()
    })?;

    Ok(info)
}

/// The probe without the scope side effect, so the export path can ask what is in
/// a file without also handing the webview access to it.
pub fn probe_media(path: &str) -> Result<MediaInfo, String> {
    let size_bytes = std::fs::metadata(path)
        .map_err(|_| "That file could not be opened. It may have been moved or deleted.".to_string())?
        .len();

    let output = ffmpeg::hidden_command("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| {
            "FFmpeg is not installed, so FlipperClipper cannot read that video.".to_string()
        })?;

    if !output.status.success() {
        return Err("That is not a video file FlipperClipper can read.".to_string());
    }

    ffmpeg::parse_probe(&String::from_utf8_lossy(&output.stdout), path, size_bytes)
}

#[tauri::command(async)]
pub fn make_filmstrip(path: String, count: u32, height: u32) -> Result<Vec<String>, String> {
    // The filmstrip is decoration behind the timeline. Clamping here means a
    // frontend bug can waste at most a few hundred milliseconds of decoding
    // rather than asking for ten thousand thumbnails of a two-hour recording.
    let count = count.clamp(1, 64);
    let height = height.clamp(16, 240);

    let info = probe_media(&path)?;
    if info.duration <= 0.0 || !info.duration.is_finite() {
        return Err("That video has no duration to draw a filmstrip from.".to_string());
    }

    let dir = temp_subdir("filmstrip")?;
    let frames = render_filmstrip(&path, &dir, count, height, info.duration);
    let _ = std::fs::remove_dir_all(&dir);
    frames
}

fn render_filmstrip(
    path: &str,
    dir: &Path,
    count: u32,
    height: u32,
    duration: f64,
) -> Result<Vec<String>, String> {
    // One frame every duration/count seconds, from a single decode pass. The
    // obvious alternative - one -ss invocation per thumbnail - costs a process
    // start and a seek each, and that is what makes a filmstrip take long enough
    // for the user to notice it arriving.
    let rate = format!("{:.6}", (count as f64) / duration);
    let filter = format!("fps={rate},scale=-2:{height}");
    let frames = count.to_string();
    let pattern = dir.join("frame%04d.jpg");

    let status = ffmpeg::hidden_command("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i", path])
        .args(["-vf", filter.as_str()])
        .args(["-frames:v", frames.as_str()])
        .args(["-an", "-sn", "-q:v", "6"])
        .arg(&pattern)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| {
            "FFmpeg is not installed, so FlipperClipper cannot draw the filmstrip.".to_string()
        })?;

    if !status.success() {
        return Err("FFmpeg could not read frames from that video.".to_string());
    }

    let entries = std::fs::read_dir(dir)
        .map_err(|_| "The filmstrip frames could not be read back.".to_string())?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|file| file.extension().and_then(|ext| ext.to_str()) == Some("jpg"))
        .collect();
    // read_dir order is whatever NTFS feels like; the zero-padded names sort into
    // playback order, which is the whole point of a filmstrip.
    files.sort();

    let mut strip = Vec::with_capacity(files.len());
    for file in files {
        let bytes = std::fs::read(&file)
            .map_err(|_| "The filmstrip frames could not be read back.".to_string())?;
        strip.push(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)));
    }
    Ok(strip)
}

#[tauri::command(async)]
pub fn make_preview_proxy(app: AppHandle, path: String) -> Result<String, String> {
    if !Path::new(&path).is_file() {
        return Err("That file is no longer there.".to_string());
    }

    // Named after the source path rather than the clock, so opening the same
    // HEVC clip twice in one session overwrites one temp file instead of leaving
    // a new 40 MB proxy behind on every attempt.
    let output = std::env::temp_dir().join(format!("flipperclipper-proxy-{}.mp4", path_key(&path)));

    let status = ffmpeg::hidden_command("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i", path.as_str()])
        // The quotes keep libavfilter from reading the comma in min(960,iw) as
        // the end of the scale filter. Capping instead of forcing 960 avoids
        // upscaling a phone clip that was already smaller than the preview.
        .args(["-vf", "scale=w='min(960,iw)':h=-2"])
        .args(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"])
        .args(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"])
        .args(["-movflags", "+faststart"])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| {
            "FFmpeg is not installed, so FlipperClipper cannot build a preview.".to_string()
        })?;

    if !status.success() {
        return Err("FlipperClipper could not build a playable preview of that video.".to_string());
    }

    let output = output.to_string_lossy().to_string();
    app.asset_protocol_scope()
        .allow_file(&output)
        .map_err(|_| "FlipperClipper could not give itself permission to play the preview.".to_string())?;
    Ok(output)
}

/// A stable name per source path. Case-folded because Windows treats two spellings
/// of the same path as the same file and would otherwise build two proxies for it.
fn path_key(path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_lowercase().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

#[tauri::command(async)]
pub fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    if !Path::new(&path).is_file() {
        return Err("That file is no longer there.".to_string());
    }

    // Set-Clipboard -LiteralPath puts the *file* on the clipboard as a file drop,
    // which is what makes Ctrl+V in Discord attach the clip instead of typing out
    // its path.
    //
    // The path travels in an environment variable rather than inside the command
    // text because PowerShell re-parses everything after -Command as a script:
    // C:\Users\Kiera\My Clips\it's done.mp4 breaks twice over there, once on the
    // space and once on the apostrophe, and those are exactly the paths people
    // have. An $env: lookup is resolved at runtime and never re-parsed.
    let status = ffmpeg::hidden_command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-Command",
            "Set-Clipboard -LiteralPath $env:FLIPPERCLIPPER_CLIPBOARD_PATH",
        ])
        .env("FLIPPERCLIPPER_CLIPBOARD_PATH", &path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| {
            "Windows PowerShell could not be started, so the file was not copied.".to_string()
        })?;

    if !status.success() {
        return Err("Windows would not let FlipperClipper put that file on the clipboard.".to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("That file is no longer there.".to_string());
    }

    // The obvious spelling, explorer.exe /select,"<path>", has to be handed over
    // as one raw command line: Explorer parses the line itself instead of going
    // through CommandLineToArgvW, and the quoting Rust applies around an argument
    // containing a space produces a form Explorer answers by opening Documents.
    // The opener plugin is already a dependency and already carries the shell-API
    // version of this (SHOpenFolderAndSelectItems), which has no command line to
    // get wrong.
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|_| "Windows could not open Explorer for that file.".to_string())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The file a "Open with -> FlipperClipper" or a drag onto the exe was launched for.
///
/// Windows passes it as a plain command-line argument, and the frontend asks for
/// it once on boot, so double-clicking a video lands in the editor with the clip
/// already open instead of on an empty window.
#[tauri::command]
pub fn cli_file_path() -> Option<String> {
    // The path is not at a fixed position: argument 0 is the executable, and a
    // dev launch adds flags of its own ahead of anything the user supplied, so
    // taking the second argument would pick up "--no-default-features" as often
    // as a video. The first argument that names a file already on disk is the
    // only reliable identification. args_os rather than args because args panics
    // on a path Windows stores as bytes that are not valid UTF-8, and that would
    // take the whole app down before the window appeared.
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|arg| arg.is_file())
        .map(|arg| arg.to_string_lossy().into_owned())
}

fn temp_subdir(kind: &str) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "flipperclipper-{kind}-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|_| "Windows would not let FlipperClipper write to the temp folder.".to_string())?;
    Ok(dir)
}

/// Twenty lines against another crate in the tree, in a project whose whole pitch
/// is that it downloads in a few seconds. The filmstrip is the only caller and it
/// needs plain standard base64 for a data: URI, with no line wrapping.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let packed = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | (*chunk.get(2).unwrap_or(&0) as u32);

        encoded.push(ALPHABET[(packed >> 18 & 63) as usize] as char);
        encoded.push(ALPHABET[(packed >> 12 & 63) as usize] as char);
        encoded.push(if chunk.len() > 1 {
            ALPHABET[(packed >> 6 & 63) as usize] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            ALPHABET[(packed & 63) as usize] as char
        } else {
            '='
        });
    }
    encoded
}
