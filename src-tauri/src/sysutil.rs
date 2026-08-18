use std::collections::HashSet;
use std::fmt::Write as _;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

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
pub fn ffmpeg_status(app: AppHandle) -> FfmpegStatus {
    // Every call is a real re-check, so a "missing" verdict cannot outlive its conditions.
    ffmpeg::forget_resolved_tools();

    match ffmpeg::resolve_tool_with_version("ffmpeg") {
        Some((_, text)) => FfmpegStatus {
            available: true,
            version: parse_version_line(&text),
        },
        None => {
            write_check_log(&app);
            FfmpegStatus {
                available: false,
                version: None,
            }
        }
    }
}

// --- The "why did it say missing?" log ---

const CHECK_LOG_NAME: &str = "ffmpeg-check.log";

/// The text of the last negative check, for a UI that wants to show it.
#[tauri::command(async)]
pub fn ffmpeg_check_log(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(check_log_path(&app)?).ok()
}

fn check_log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(CHECK_LOG_NAME))
}

/// A snapshot of one failed check, not a history: the file is replaced every time.
fn write_check_log(app: &AppHandle) {
    let Some(path) = check_log_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    let rows = probe_candidates("ffmpeg");
    let text = render_check_log(
        &utc_stamp(SystemTime::now()),
        &std::env::var("PATH").unwrap_or_else(|_| "(unset)".to_string()),
        &rows,
    );
    let _ = std::fs::write(path, text);
}

fn render_check_log(
    stamp: &str,
    path_value: &str,
    rows: &[(&'static str, PathBuf, String)],
) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "FlipperClipper ffmpeg check - {stamp}");
    let _ = writeln!(out, "verdict: ffmpeg could not be run");
    let _ = writeln!(out, "inherited PATH: {path_value}");
    let _ = writeln!(out, "tried, in order:");
    for (tier, candidate, outcome) in rows {
        let _ = writeln!(out, "  [{tier}] {} -> {outcome}", candidate.display());
    }
    out
}

/// A second implementation rather than a hook into the resolver, which reports nothing
/// but its final answer.
fn probe_candidates(name: &str) -> Vec<(&'static str, PathBuf, String)> {
    let file_name = format!("{}{}", name, std::env::consts::EXE_SUFFIX);
    let mut seen: HashSet<String> = HashSet::new();
    let mut rows: Vec<(&'static str, PathBuf, String)> = Vec::new();

    for (tier, dir) in diagnostic_dirs() {
        let key = dir
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase();
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        let candidate = dir.join(&file_name);
        if std::fs::symlink_metadata(&candidate).is_err() {
            rows.push((tier, candidate, "no such file".to_string()));
            continue;
        }
        // Every tier is probed, never stopping at the first that runs: the case this log exists for
        // is the resolver saying missing while a second look says otherwise.
        let (_, outcome) = version_outcome(&candidate);
        rows.push((tier, candidate, outcome));
    }

    let bare = PathBuf::from(&file_name);
    let (_, outcome) = version_outcome(&bare);
    rows.push(("bare", bare, outcome));

    // The resolver's own answer, taken after the walk, so a disagreement is printed as a fact.
    let second = match ffmpeg::resolve_tool_with_version(name) {
        Some((path, _)) => format!("found at {}", path.display()),
        None => "still not found".to_string(),
    };
    rows.push(("resolver", PathBuf::from("(asked again)"), second));
    rows
}

/// Expanded by PowerShell rather than here: the Path of HKCU\Environment is REG_EXPAND_SZ.
fn diagnostic_dirs() -> Vec<(&'static str, PathBuf)> {
    let mut dirs: Vec<(&'static str, PathBuf)> = Vec::new();

    // First here because it is first in the resolver; a log that named a different order would
    // be describing a search the app does not run.
    if let Some(dir) = ffmpeg::managed_dir() {
        dirs.push(("managed", dir));
    }
    if let Some(value) = std::env::var_os("PATH") {
        dirs.extend(
            split_path_list(&value.to_string_lossy())
                .into_iter()
                .map(|dir| ("PATH", dir)),
        );
    }
    for (tier, scope) in [("registry User", "User"), ("registry Machine", "Machine")] {
        if let Some(value) = registry_path_value(scope) {
            dirs.extend(split_path_list(&value).into_iter().map(|dir| (tier, dir)));
        }
    }
    dirs.extend(
        known_install_dirs()
            .into_iter()
            .map(|dir| ("known dir", dir)),
    );
    dirs
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

fn registry_path_value(scope: &str) -> Option<String> {
    let script = format!(
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
         [Environment]::ExpandEnvironmentVariables(\
         [Environment]::GetEnvironmentVariable('Path','{scope}'))"
    );
    let output = ffmpeg::hidden_command("powershell")
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

/// Runs `-version` the way the resolver validates a candidate. The bool is "would have been accepted".
fn version_outcome(path: &Path) -> (bool, String) {
    let result = ffmpeg::hidden_command(path.to_string_lossy().as_ref())
        .arg("-version")
        .stdin(Stdio::null())
        .output();

    match result {
        Ok(output) if output.status.success() => (true, "ran, exit 0".to_string()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = match last_meaningful_line(&stderr) {
                Some(line) => format!("{}, {}", output.status, clip_to(&line, 160)),
                None => output.status.to_string(),
            };
            (false, detail)
        }
        Err(error) => (false, format!("could not start: {error}")),
    }
}

fn clip_to(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => format!("{}...", &text[..cut]),
        None => text.to_string(),
    }
}

/// Hinnant's civil-from-days. Its era starts in March, which is why the month is rotated back.
fn utc_stamp(now: SystemTime) -> String {
    let secs = now
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        tod / 3_600,
        tod / 60 % 60,
        tod % 60
    )
}

/// The third whitespace-separated token is the version in every build FFmpeg has shipped.
fn parse_version_line(text: &str) -> Option<String> {
    let mut parts = text.lines().next()?.split_whitespace();
    if parts.next()? != "ffmpeg" || parts.next()? != "version" {
        return None;
    }
    parts.next().map(|version| version.to_string())
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

    // The asset protocol serves nothing outside its scope, and tauri.conf.json ships that scope
    // empty on purpose, so each file earns its entry at the moment it is opened.
    app.asset_protocol_scope().allow_file(&path).map_err(|_| {
        "FlipperClipper could not give itself permission to play that file.".to_string()
    })?;

    Ok(info)
}

/// The probe without the scope side effect, so the export path can ask what is in a file
/// without handing the webview access to it.
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
    // One decode pass: an -ss invocation per thumbnail costs a process start and a seek each.
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
    // read_dir order is whatever NTFS feels like; the zero-padded names sort into playback order.
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

    // Named after the source path rather than the clock, so reopening the same clip overwrites
    // one temp file instead of leaving a new proxy behind each time.
    let output = std::env::temp_dir().join(format!("flipperclipper-proxy-{}.mp4", path_key(&path)));

    let status = ffmpeg::hidden_command("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-i", path.as_str()])
        // The quotes keep libavfilter from reading the comma in min(960,iw) as the end of the filter.
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

/// Case-folded: Windows treats two spellings of a path as one file and would build two proxies.
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

    // Set-Clipboard -LiteralPath puts the *file* on the clipboard, which is what makes Ctrl+V
    // attach the clip. The path travels in an environment variable because PowerShell re-parses
    // everything after -Command, and a space or an apostrophe in the path breaks that.
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

    // explorer.exe /select,"<path>" has to be handed over as one raw command line - Explorer
    // parses it itself, and Rust's quoting produces a form it answers by opening Documents.
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|_| "Windows could not open Explorer for that file.".to_string())
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn cli_file_path() -> Option<String> {
    // The path is not at a fixed position: a dev launch adds flags ahead of the user's argument,
    // so the first argument naming a file on disk is the only reliable identification. args_os
    // because args panics on a path Windows stores as bytes that are not valid UTF-8.
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

/// Twenty lines against another crate in the tree. The filmstrip is the only caller and needs
/// plain standard base64 for a data: URI, with no line wrapping.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(secs: u64) -> String {
        utc_stamp(UNIX_EPOCH + Duration::from_secs(secs))
    }

    #[test]
    fn the_stamp_is_utc_and_survives_leap_years() {
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        // 2000 is a leap year under the 400 rule the era arithmetic exists to get right.
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn the_log_names_the_tier_and_the_reason_for_every_candidate() {
        let rows = vec![
            (
                "PATH",
                PathBuf::from("C:\\Windows\\System32\\ffmpeg.exe"),
                "no such file".to_string(),
            ),
            (
                "known dir",
                PathBuf::from("C:\\Links\\ffmpeg.exe"),
                "exit code: 3221225781".to_string(),
            ),
        ];
        let text = render_check_log("2026-08-17T09:00:00Z", "C:\\Windows\\System32", &rows);

        assert!(text.starts_with("FlipperClipper ffmpeg check - 2026-08-17T09:00:00Z\n"));
        assert!(text.contains("inherited PATH: C:\\Windows\\System32\n"));
        assert!(text.contains("  [PATH] C:\\Windows\\System32\\ffmpeg.exe -> no such file\n"));
        assert!(text.contains("  [known dir] C:\\Links\\ffmpeg.exe -> exit code: 3221225781\n"));
    }

    #[test]
    fn a_long_stderr_line_is_clipped_rather_than_dumped() {
        assert_eq!(clip_to("short", 160), "short");
        assert_eq!(clip_to("abcdef", 3), "abc...");
    }

    #[test]
    fn the_path_list_splits_the_way_windows_writes_it() {
        assert_eq!(
            split_path_list("C:\\a; \"C:\\b b\" ;;C:\\c"),
            vec![
                PathBuf::from("C:\\a"),
                PathBuf::from("C:\\b b"),
                PathBuf::from("C:\\c"),
            ]
        );
    }

    #[test]
    fn the_winget_links_dir_is_the_first_known_dir_tried() {
        if std::env::var_os("LOCALAPPDATA").is_none() {
            return;
        }
        let first = known_install_dirs()
            .into_iter()
            .next()
            .expect("a known dir");
        assert!(
            first.ends_with("Microsoft\\WinGet\\Links"),
            "{}",
            first.display()
        );
    }
}
