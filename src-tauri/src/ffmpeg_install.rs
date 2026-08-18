//! Fetching a copy of FFmpeg for machines that have none.
//!
//! Only ever reached after the resolver has come back empty: the search in ffmpeg.rs still owns
//! finding a copy the user already has.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::download::{self, UnpackError};

/// Versionless on purpose: gyan.dev answers it with a 303 to the current release build.
const FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

/// Matches `EVENT.ffmpegProgress` in src/types.ts.
const FFMPEG_PROGRESS_EVENT: &str = "ffmpeg-progress";

/// ffplay is in the zip too and is a third of it; nothing here can use it.
const TOOLS: [&str; 2] = ["ffmpeg", "ffprobe"];

const STAGING: &str = "ffmpeg-staging";

/// Marks a binary that was live when a newer one replaced it, for the next launch to sweep.
const ASIDE_PREFIX: &str = ".old-";

static INSTALLING: AtomicBool = AtomicBool::new(false);

const ALREADY_RUNNING: &str = "FFmpeg is already downloading.";
const NO_APP_DIR: &str =
    "FlipperClipper could not find its own data folder, so FFmpeg cannot be installed.";
const NO_POWERSHELL: &str =
    "Windows PowerShell could not be started, so the FFmpeg download could not be unpacked.";
const UNPACK_FAILED: &str = "The FFmpeg download could not be unpacked. It needs about 450 MB of \
                             free space while it installs; free some space and try again.";
const ZIP_INCOMPLETE: &str = "The FFmpeg download did not contain ffmpeg.exe, so nothing was \
                              installed. Try again, or install FFmpeg yourself and restart \
                              FlipperClipper.";
const BINARY_WONT_RUN: &str = "The downloaded FFmpeg would not run on this PC, so it was \
                               discarded. Your antivirus may have quarantined it.";
const NO_CONNECTION: &str = "FFmpeg could not be downloaded: www.gyan.dev could not be reached. \
                             Check your internet connection, then try again.";
const NO_SPACE: &str = "There is not enough free space to install FFmpeg. It needs about 450 MB \
                        free while it installs, and about 200 MB afterwards.";

/// Clears the flag however the install ends, including on an early return.
struct Running;

impl Drop for Running {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn install_ffmpeg(app: AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err(ALREADY_RUNNING.to_string());
    }
    let _running = Running;

    let managed = crate::ffmpeg::managed_dir().ok_or(NO_APP_DIR)?;
    let staging = staging_dir(&app)?;

    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("Could not prepare a folder to download into: {e}"))?;

    let zip = staging.join("ffmpeg.zip");
    let downloaded =
        download::stream_download(&app, FFMPEG_URL, &zip, None, None, FFMPEG_PROGRESS_EVENT)
            .await
            .map_err(download_failed);

    let result = match downloaded {
        Err(e) => Err(e),
        // Expand-Archive plus two -version runs is several seconds of blocking work.
        Ok(()) => {
            let staging = staging.clone();
            tauri::async_runtime::spawn_blocking(move || install_from(&staging, &managed))
                .await
                .map_err(|_| "The FFmpeg install stopped unexpectedly.".to_string())?
        }
    };

    let _ = std::fs::remove_dir_all(&staging);
    // Mandatory on success and harmless otherwise: the resolver's memo predates the new copy.
    crate::ffmpeg::forget_resolved_tools();
    result
}

/// Unpacks, checks and publishes what was downloaded. The managed copy is not touched until
/// every tool has proved it runs.
fn install_from(staging: &Path, managed: &Path) -> Result<(), String> {
    let zip = staging.join("ffmpeg.zip");
    let tree = staging.join("tree");

    download::extract_zip(&zip, &tree).map_err(|e| match e {
        UnpackError::PowerShellMissing => NO_POWERSHELL.to_string(),
        UnpackError::Failed => UNPACK_FAILED.to_string(),
    })?;
    // The unpacked tree is three times the zip, and the zip has done its job by now.
    let _ = std::fs::remove_file(&zip);

    let staged = staged_tools(&tree)?;
    verify_staged(&staged)?;

    std::fs::create_dir_all(managed)
        .map_err(|e| format!("Could not create the folder FFmpeg goes in: {e}"))?;
    swap_into_place(managed, &staged)
}

fn staging_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join(STAGING))
        .map_err(|_| NO_APP_DIR.to_string())
}

/// The zip wraps everything in a folder named after the version, so the tools are searched for
/// rather than read from a fixed path.
fn staged_tools(tree: &Path) -> Result<Vec<(&'static str, PathBuf)>, String> {
    TOOLS
        .iter()
        .map(|tool| {
            let file_name = format!("{tool}{}", std::env::consts::EXE_SUFFIX);
            download::find_file(tree, 3, &|name| name.eq_ignore_ascii_case(&file_name))
                .map(|path| (*tool, path))
                .ok_or_else(|| ZIP_INCOMPLETE.to_string())
        })
        .collect()
}

/// The same acceptance rule the resolver applies, so nothing is published that it would refuse.
fn verify_staged(staged: &[(&'static str, PathBuf)]) -> Result<(), String> {
    for (_, path) in staged {
        if crate::ffmpeg::run_version(path).is_none() {
            return Err(BINARY_WONT_RUN.to_string());
        }
    }
    Ok(())
}

/// Windows refuses to delete or overwrite a running exe but allows renaming one, so any existing
/// copy is moved aside instead of replaced. Per file, never per folder: renaming a folder that
/// holds a running exe is refused as well.
fn swap_into_place(managed: &Path, staged: &[(&'static str, PathBuf)]) -> Result<(), String> {
    for (tool, from) in staged {
        let dest = managed.join(format!("{tool}{}", std::env::consts::EXE_SUFFIX));
        let aside = dest.with_extension(format!("exe{ASIDE_PREFIX}{}", stamp()));
        if dest.exists() {
            rename_when_free(&dest, &aside).map_err(swap_failed)?;
        }
        rename_when_free(from, &dest).map_err(swap_failed)?;
        let _ = std::fs::remove_file(&aside);
    }
    Ok(())
}

/// A binary that was just extracted and just run is not always movable at once: Windows holds
/// the image section briefly after the process exits, and antivirus opens what appeared on disk
/// a moment ago. Both surface as a sharing violation on the rename - measured as os error 32
/// against a freshly unpacked ffmpeg.exe - and both clear on their own within seconds.
fn rename_when_free(from: &Path, to: &Path) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 150;
    let mut last = None;
    for attempt in 0..ATTEMPTS {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        if attempt + 1 < ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    Err(last.expect("at least one attempt"))
}

fn swap_failed(e: std::io::Error) -> String {
    format!(
        "FFmpeg was downloaded but could not be put into place: {e}. \
         Close FlipperClipper and try again."
    )
}

fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// stream_download's messages are already worded for a person; these two read better named.
fn download_failed(detail: String) -> String {
    if detail.starts_with("Could not reach the download") {
        return NO_CONNECTION.to_string();
    }
    // ERROR_DISK_FULL, which arrives as a write failure saying nothing about space.
    if detail.contains("os error 112") {
        return NO_SPACE.to_string();
    }
    detail
}

/// Startup housekeeping: a staging folder from an install that was killed, and any binary left
/// aside because it was still running when it was replaced.
pub fn sweep_leftovers(app: &AppHandle) {
    if let Ok(staging) = staging_dir(app) {
        let _ = std::fs::remove_dir_all(staging);
    }
    let Some(managed) = crate::ffmpeg::managed_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(managed) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_aside = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(ASIDE_PREFIX));
        if is_aside {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flipperclipper-ffmpeg-test-{name}-{}", stamp()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Half a gigabyte of temp files is worth a few retries: the binaries were just run, and
    /// the same hold that delays a rename delays their removal.
    fn sweep(dir: &Path) {
        for _ in 0..30 {
            if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        std::fs::write(path, body).expect("write");
    }

    #[test]
    fn the_source_is_the_versionless_gyan_essentials_zip() {
        // Versioned URLs go stale every release; this one redirects to the current build.
        assert_eq!(
            FFMPEG_URL,
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
        );
    }

    #[test]
    fn the_tools_are_found_under_the_versioned_folder_the_zip_invents() {
        let tree = temp_dir("layout");
        let build = tree.join("ffmpeg-9.0.1-essentials_build").join("bin");
        write(&build.join("ffmpeg.exe"), "f");
        write(&build.join("ffprobe.exe"), "p");
        write(&build.join("ffplay.exe"), "l");

        let staged = staged_tools(&tree).expect("both tools found");
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[0].0, "ffmpeg");
        assert!(staged[0].1.ends_with("ffmpeg.exe"));
        assert!(staged[1].1.ends_with("ffprobe.exe"));

        let _ = std::fs::remove_dir_all(&tree);
    }

    #[test]
    fn a_zip_without_ffmpeg_is_reported_rather_than_half_installed() {
        let tree = temp_dir("incomplete");
        write(
            &tree.join("ffmpeg-9.0.1-essentials_build").join("bin").join("ffprobe.exe"),
            "p",
        );

        assert_eq!(staged_tools(&tree).unwrap_err(), ZIP_INCOMPLETE);

        let _ = std::fs::remove_dir_all(&tree);
    }

    #[test]
    fn a_binary_that_will_not_run_is_rejected() {
        // The guard candidate_exists cannot give: the file is there and still unusable.
        let dir = temp_dir("wont-run");
        let fake = dir.join("ffmpeg.exe");
        write(&fake, "");

        let staged = vec![("ffmpeg", fake)];
        assert_eq!(verify_staged(&staged).unwrap_err(), BINARY_WONT_RUN);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_old_binary_is_moved_aside_rather_than_written_over() {
        let dir = temp_dir("swap");
        let managed = dir.join("managed");
        let staged_dir = dir.join("staged");
        write(&managed.join("ffmpeg.exe"), "old");
        write(&staged_dir.join("ffmpeg.exe"), "new");

        // Held open, the way a running export would hold it.
        let held = std::fs::File::open(managed.join("ffmpeg.exe")).expect("open");

        swap_into_place(&managed, &[("ffmpeg", staged_dir.join("ffmpeg.exe"))]).expect("swap");
        assert_eq!(
            std::fs::read_to_string(managed.join("ffmpeg.exe")).expect("read"),
            "new"
        );

        drop(held);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_binary_still_held_open_is_waited_out_rather_than_failed() {
        // What the live run hit: the file is unrenameable for a moment after being run.
        let dir = temp_dir("held");
        let from = dir.join("ffmpeg.exe");
        let to = dir.join("published.exe");
        write(&from, "new");

        let blocker = dir.join("published.exe");
        write(&blocker, "old");
        let held = std::fs::File::options()
            .read(true)
            .share_mode(0)
            .open(&blocker)
            .expect("exclusive open");
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            drop(held);
        });

        rename_when_free(&from, &to).expect("the rename waits the lock out");
        releaser.join().expect("releaser");
        assert_eq!(std::fs::read_to_string(&to).expect("read"), "new");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreachable_host_reads_as_a_connection_problem() {
        assert_eq!(
            download_failed("Could not reach the download: dns error".to_string()),
            NO_CONNECTION
        );
    }

    #[test]
    fn a_full_disk_reads_as_free_space_rather_than_an_error_number() {
        assert_eq!(
            download_failed("Could not write the download: os error 112".to_string()),
            NO_SPACE
        );
    }

    /// The whole thing, for real: fetch the zip gyan.dev is serving today, run it through the
    /// production unpack/verify/swap, then hard-link the result into the folder the app actually
    /// looks in and prove the resolver picks it over everything already on this machine.
    ///
    /// #[ignore] because it downloads about 106 MB:
    ///     cargo test -- --ignored the_real_download_installs_a_working_ffmpeg --test-threads=1
    #[tokio::test]
    #[ignore]
    async fn the_real_download_installs_a_working_ffmpeg() {
        let staging = temp_dir("live-staging");
        let managed = temp_dir("live-managed");

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("client");
        let body = client
            .get(FFMPEG_URL)
            .send()
            .await
            .expect("gyan.dev could not be reached")
            .error_for_status()
            .expect("the download answered with an error")
            .bytes()
            .await
            .expect("the download stopped early");
        eprintln!("downloaded {} bytes", body.len());
        assert!(body.len() > 50_000_000, "{} bytes is not a build", body.len());
        std::fs::write(staging.join("ffmpeg.zip"), &body).expect("write the zip");

        install_from(&staging, &managed).expect("the install");

        for tool in TOOLS {
            let path = managed.join(format!("{tool}.exe"));
            assert!(path.is_file(), "{tool} was not published");
            let version = crate::ffmpeg::run_version(&path)
                .unwrap_or_else(|| panic!("{tool} would not run from the managed folder"));
            eprintln!("{tool}: {}", version.lines().next().unwrap_or(""));
            assert!(version.starts_with(&format!("{tool} version")));
        }

        // The zip is gone and the tree with it, so only the two tools are left behind.
        assert!(!staging.join("ffmpeg.zip").exists(), "the zip was kept");
        let published: Vec<_> = std::fs::read_dir(&managed)
            .expect("read managed")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(published.len(), 2, "{published:?}");

        // Now the part the offline tests cannot reach: that the app would pick this copy up
        // ahead of the winget install already on this machine. Hard-linked rather than copied,
        // so the proof costs no second 200 MB.
        let real = crate::ffmpeg::managed_dir().expect("a managed dir");
        let preexisting = real.exists();
        std::fs::create_dir_all(&real).expect("create the real managed dir");
        for tool in TOOLS {
            let link = real.join(format!("{tool}.exe"));
            let _ = std::fs::remove_file(&link);
            std::fs::hard_link(managed.join(format!("{tool}.exe")), &link).expect("hard link");
        }
        crate::ffmpeg::forget_resolved_tools();
        let resolved = crate::ffmpeg::resolve_tool("ffmpeg").expect("ffmpeg resolves");
        eprintln!("resolver chose: {}", resolved.display());

        // Undo before asserting, so a failure does not leave the links behind.
        for tool in TOOLS {
            let _ = std::fs::remove_file(real.join(format!("{tool}.exe")));
        }
        if !preexisting {
            let _ = std::fs::remove_dir(&real);
        }
        crate::ffmpeg::forget_resolved_tools();

        sweep(&staging);
        sweep(&managed);

        assert_eq!(
            resolved,
            real.join("ffmpeg.exe"),
            "the app's own copy did not win the search"
        );
    }

    /// The one failure the offline tests cannot see: gyan.dev moving or renaming the versionless
    /// zip, which would turn the banner's button into a dead end. #[ignore] because it needs the
    /// network: `cargo test -- --ignored the_download_is_still_where_it_was`.
    #[tokio::test]
    #[ignore]
    async fn the_download_is_still_where_it_was() {
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("client");
        // A range request, so the check costs two bytes rather than a hundred megabytes.
        let response = client
            .get(FFMPEG_URL)
            .header(reqwest::header::RANGE, "bytes=0-1")
            .send()
            .await
            .expect("gyan.dev could not be reached");

        assert!(
            response.status().is_success(),
            "the download answered {}",
            response.status()
        );
        let total = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit('/').next().map(|s| s.to_string()))
            .and_then(|size| size.parse::<u64>().ok())
            .or_else(|| response.content_length())
            .expect("a length");
        assert!(total > 50_000_000, "{total} bytes is not an ffmpeg build");
    }

    #[test]
    fn a_short_download_keeps_the_byte_counts_it_came_with() {
        let detail = "The download stopped early — got 5 bytes of the 9 it should have.";
        assert_eq!(download_failed(detail.to_string()), detail);
    }
}
