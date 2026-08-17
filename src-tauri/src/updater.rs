//! Self-update against the GitHub Releases API.
//!
//! This is a port of FinFetcher's `UpdateManager` (mkiera/FinFetcher,
//! main.pyw) with the same flow: check the release list, pick the release's
//! `-Setup.exe`, download it into a cache directory that startup clears,
//! verify its length, hand it to Windows and get out of the way. The
//! reasoning that made that version work is repeated on the individual steps
//! below, because most of it is not recoverable from reading the code.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// Matches `UpdateInfo` in src/types.ts, which is why the rename is here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub release_url: String,
    pub download_url: String,
    pub asset_name: String,
    pub size_bytes: u64,
    pub prerelease: bool,
}

const RELEASES_URL: &str = "https://api.github.com/repos/mkiera/QuickClip/releases";

/// The tail of the one asset a release carries that can update an installed
/// copy. FinFetcher matched on "an .exe with 'setup' in the name" because its
/// older releases also shipped a bare stand-alone exe that would merely start
/// an unpacked old version out of the cache directory. QuickClip has shipped
/// the installer and nothing else from its first release, so the name the CI
/// job writes can be matched exactly.
const INSTALLER_SUFFIX: &str = "-setup.exe";

/// Event name from `EVENT.updateProgress` in src/types.ts.
const UPDATE_PROGRESS_EVENT: &str = "update-progress";

/// GitHub answers an unauthenticated request with no `User-Agent` with a 403
/// and no release list at all, so the header is not decoration — see the
/// "User agent required" section of the GitHub REST API docs.
fn user_agent(version: &semver::Version) -> String {
    format!("QuickClip/{version} (+https://github.com/mkiera/QuickClip)")
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// The one directory an update may be downloaded to and run from.
fn updates_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("updates"))
        .map_err(|e| format!("Could not find the app data directory: {e}"))
}

/// Delete the installers earlier update attempts left behind.
///
/// They cannot be cleaned up at the point they are used: `apply_update` hands
/// the file to Windows and the app exits immediately so the installer can
/// replace it, which otherwise leaves one installer per update sitting in
/// AppData forever. Startup is the next moment at which they are provably
/// finished with. Everything in here was put there by this app, so nothing
/// else can be caught by it.
///
/// Best effort throughout: the obvious failure is the installer that just ran
/// us still holding its own exe open, and the next launch clears it.
pub fn clear_updates_dir(app: &tauri::AppHandle) {
    let Ok(dir) = updates_dir(app) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return; // never downloaded anything, or the directory is unreadable
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let _ = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
    }
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    // package_info().version is the version Tauri compiled in from
    // package.json, so the check compares against the same single source the
    // release tag is written from.
    let current = app.package_info().version.clone();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not start the update check: {e}"))?;

    let response = client
        .get(RELEASES_URL)
        .header(reqwest::header::USER_AGENT, user_agent(&current))
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        // GitHub allows 60 unauthenticated requests an hour per address and
        // answers 403 (occasionally 429) once that is spent. It is worth
        // naming separately because it is the one failure that is neither the
        // network nor this app being wrong, and it clears itself.
        return Err(if status.as_u16() == 403 || status.as_u16() == 429 {
            "GitHub is rate limiting update checks right now.".to_string()
        } else {
            format!("GitHub answered the update check with HTTP {status}.")
        });
    }

    let releases: Vec<GhRelease> = response
        .json()
        .await
        .map_err(|e| format!("GitHub's release list could not be read: {e}"))?;

    Ok(pick_update(releases, &current))
}

/// Which release, if any, the running version should be offered.
///
/// Split out from the command so it can be tested: everything that decides
/// whether a person is interrupted lives here, and none of it needs a network
/// or an AppHandle. Getting it wrong is quiet in both directions - offering a
/// downgrade walks somebody backwards, and offering nothing means a fix never
/// reaches them - so it is the part of the updater worth pinning down.
fn pick_update(releases: Vec<GhRelease>, current: &semver::Version) -> Option<UpdateInfo> {
    // FinFetcher had a settings toggle for its beta channel. The same
    // behaviour falls out of the running version here: somebody on
    // 0.2.0-beta.1 asked for pre-releases by installing one, and somebody on
    // a stable build did not, so a pre-release must never pull them off it.
    let running_is_prerelease = !current.pre.is_empty();

    let mut best: Option<(semver::Version, UpdateInfo)> = None;

    for release in releases {
        if release.draft {
            continue;
        }

        // Tags are written `v0.2.0`; anything that is not semver after that
        // is not something this updater can order against the running
        // version, so it is skipped rather than guessed at.
        let Ok(version) = semver::Version::parse(release.tag_name.trim_start_matches('v')) else {
            continue;
        };

        let is_prerelease = release.prerelease || !version.pre.is_empty();
        if is_prerelease && !running_is_prerelease {
            continue;
        }

        // semver's ordering already puts 0.2.0-beta.1 below 0.2.0, so the
        // stable release of a version correctly updates a pre-release of it.
        if version <= *current {
            continue;
        }

        let Some(asset) = release
            .assets
            .iter()
            .find(|asset| asset.name.to_ascii_lowercase().ends_with(INSTALLER_SUFFIX))
        else {
            // A release whose upload has not finished yet has a tag and no
            // asset. Skipping it and offering the newest release that does
            // have one keeps a half-published release from hiding a usable
            // update; the next check picks the newer one up once it lands.
            continue;
        };

        if best.as_ref().is_none_or(|(seen, _)| version > *seen) {
            best = Some((
                version.clone(),
                UpdateInfo {
                    version: version.to_string(),
                    release_url: release.html_url.clone(),
                    download_url: asset.browser_download_url.clone(),
                    asset_name: asset.name.clone(),
                    size_bytes: asset.size,
                    prerelease: is_prerelease,
                },
            ));
        }
    }

    best.map(|(_, info)| info)
}

#[tauri::command]
pub async fn apply_update(app: tauri::AppHandle, info: UpdateInfo) -> Result<(), String> {
    // An update ends in app.exit(0), which tears this process down without ever
    // reaching the ffmpeg handle in AppState. Windows does not reap
    // grandchildren, so an export that is still running would be left detached,
    // writing to a file the user has every reason to think was abandoned, while
    // the installer replaces the app around it — and installer.iss's
    // CloseApplications filter only covers files under {app}, so it does not
    // catch ffmpeg either. Refuse here rather than at the spawn, because there
    // is nothing to be gained from downloading eight megabytes first.
    //
    // A panic in an export thread must not make updating impossible, and the
    // slot behind this lock is a process handle and a bool, neither of which
    // can be observed half-written, so a poisoned lock is read through.
    let export_running = app
        .state::<crate::AppState>()
        .export
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .child
        .is_some();
    if export_running {
        return Err("QuickClip is still exporting a clip. Let it finish, then update.".to_string());
    }

    // Nothing downstream can tell a truncated installer from a complete one
    // without a length to check against, and a truncated installer that still
    // runs is the worst outcome available here, so refuse before downloading.
    if info.size_bytes == 0 {
        return Err(format!(
            "The release does not list a size for {}, so the download cannot be verified.",
            info.asset_name
        ));
    }

    let dir = updates_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create the updates folder: {e}"))?;

    // The asset name comes from the network, so only its last path component
    // is ever used — a name containing separators must not be able to steer
    // the write, or the file that gets executed below, out of this folder.
    let file_name = Path::new(&info.asset_name)
        .file_name()
        .ok_or_else(|| format!("{} is not a usable file name.", info.asset_name))?;
    let dest = dir.join(file_name);

    let client = reqwest::Client::builder()
        // No overall timeout: this body is the whole installer and a slow
        // connection is not an error. The connect timeout still catches the
        // case where the host cannot be reached at all.
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Could not start the download: {e}"))?;

    let response = client
        .get(&info.download_url)
        .header(
            reqwest::header::USER_AGENT,
            user_agent(&app.package_info().version),
        )
        .send()
        .await
        .map_err(|e| format!("Could not reach the download: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "The download answered with HTTP {}.",
            response.status()
        ));
    }

    let mut file =
        fs::File::create(&dest).map_err(|e| format!("Could not write the download: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut written: u64 = 0;
    let mut last_emitted = 0.0_f64;
    let mut last_emitted_at = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => {
                let _ = fs::remove_file(&dest);
                return Err(format!("The download stopped early: {e}"));
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            let _ = fs::remove_file(&dest);
            return Err(format!("Could not write the download: {e}"));
        }
        written += chunk.len() as u64;

        // Every chunk is a few tens of kilobytes, so emitting per chunk would
        // put hundreds of events a second through the IPC bridge to move a
        // progress bar by less than a pixel. One percent or 100 ms, whichever
        // comes first, keeps it smooth on both a fast and a slow connection.
        let fraction = (written as f64 / info.size_bytes as f64).min(1.0);
        if fraction - last_emitted >= 0.01 || last_emitted_at.elapsed() >= Duration::from_millis(100)
        {
            last_emitted = fraction;
            last_emitted_at = Instant::now();
            let _ = app.emit(UPDATE_PROGRESS_EVENT, fraction);
        }
    }

    if let Err(e) = file.flush() {
        let _ = fs::remove_file(&dest);
        return Err(format!("Could not finish writing the download: {e}"));
    }
    drop(file);

    // A stream that ends is indistinguishable from a connection that was cut,
    // and this file is about to be *executed* as an installer. Compare it
    // with the length the release lists and delete anything short, rather
    // than running a half-written setup exe over a working installation.
    if written != info.size_bytes {
        let _ = fs::remove_file(&dest);
        return Err(format!(
            "The download stopped early — got {} bytes of the {} the release lists. \
             The incomplete file has been deleted; please try again.",
            written, info.size_bytes
        ));
    }

    let _ = app.emit(UPDATE_PROGRESS_EVENT, 1.0_f64);

    // Switch semantics are from the Inno Setup help, "Setup Command Line
    // Parameters":
    //   /SILENT  hides the wizard but keeps the progress window, so the user
    //            sees the update happening after this window disappears.
    //            /VERYSILENT would leave a blank screen that reads as a crash.
    //   /CLOSEAPPLICATIONS  we exit immediately below, but losing that race
    //            would otherwise leave the installed exe locked against the
    //            copy that is replacing it.
    //   /NORESTARTAPPLICATIONS  Setup only restarts applications that called
    //            RegisterApplicationRestart, which this app does not, so
    //            saying "no" explicitly keeps the relaunch owned by exactly
    //            one thing — installer.iss's [Run] entry.
    // Deliberately not passed: /DIR and /TASKS, because UsePreviousAppDir and
    // UsePreviousTasks both default to yes and passing them would reset the
    // user's install location and desktop-shortcut choice; and /NORESTART,
    // which would suppress the [Run] entry that is the only thing bringing
    // the app back.
    let mut command = std::process::Command::new(&dest);
    command.args(["/SILENT", "/CLOSEAPPLICATIONS", "/NORESTARTAPPLICATIONS"]);
    // The working directory stays in AppData. A cwd inside the install folder
    // would lock that folder against the very files the installer replaces.
    command.current_dir(&dir);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS and CREATE_NEW_PROCESS_GROUP so the installer
        // outlives the app.exit(0) two lines down — it cannot replace these
        // files until this process is gone. CREATE_NO_WINDOW because every
        // process this app spawns is spawned without a console flashing up.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    // Asked again, because the check at the top of this function only covered
    // the moment the user clicked Update. Downloading the installer takes long
    // enough on a slow connection for them to have opened a clip and started an
    // export in the meantime, and it is the exit below - not the click - that
    // would orphan the ffmpeg writing it.
    let export_started_meanwhile = app
        .state::<crate::AppState>()
        .export
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .child
        .is_some();
    if export_started_meanwhile {
        return Err("QuickClip started exporting a clip while the update was downloading. Let it finish, then update.".to_string());
    }

    // Blocked by antivirus or policy, not an executable at all, gone from
    // under us — whatever it was, this app is still running and the caller
    // needs to be told so it can leave the pill in a failed state instead of
    // waiting forever for an exit that is not coming.
    command
        .spawn()
        .map_err(|e| format!("Could not start the installer: {e}"))?;

    // Nothing to wait for and nothing to relaunch: the installer needs this
    // process gone before it reaches the file copy, and its [Run] entry is
    // what starts the new version.
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(raw: &str) -> semver::Version {
        semver::Version::parse(raw).expect("test version should parse")
    }

    fn releases(json: &str) -> Vec<GhRelease> {
        serde_json::from_str(json).expect("test payload should deserialise")
    }

    /// Trimmed from what api.github.com actually returned for this repo, so the
    /// field names and types are the real ones rather than what we assume they
    /// are. A response GitHub can send and serde cannot read would fail here
    /// rather than silently becoming "no update available" for everybody.
    const REAL_PAYLOAD: &str = r#"[
      {
        "html_url": "https://github.com/mkiera/QuickClip/releases/tag/v0.1.0-beta",
        "tag_name": "v0.1.0-beta",
        "draft": false,
        "prerelease": true,
        "assets": [
          {
            "name": "QuickClip-Setup.exe",
            "size": 3309048,
            "browser_download_url": "https://github.com/mkiera/QuickClip/releases/download/v0.1.0-beta/QuickClip-Setup.exe"
          }
        ]
      }
    ]"#;

    #[test]
    fn the_real_github_payload_deserialises_and_is_offered_to_an_older_prerelease() {
        let picked = pick_update(releases(REAL_PAYLOAD), &version("0.0.9-beta"))
            .expect("an older pre-release build should be offered this one");
        assert_eq!(picked.version, "0.1.0-beta");
        assert_eq!(picked.asset_name, "QuickClip-Setup.exe");
        assert_eq!(picked.size_bytes, 3309048);
        assert!(picked.prerelease);
        assert!(picked.download_url.ends_with("/QuickClip-Setup.exe"));
    }

    #[test]
    fn a_stable_build_is_never_pulled_onto_a_prerelease() {
        // The whole beta channel, with no settings toggle: a person running a
        // stable build never asked to be moved onto a beta, even a newer one.
        assert!(pick_update(releases(REAL_PAYLOAD), &version("0.0.1")).is_none());
    }

    #[test]
    fn the_running_version_is_not_offered_to_itself() {
        // The bug FinFetcher hit: ship a build whose version does not match its
        // tag and it is offered its own release forever.
        assert!(pick_update(releases(REAL_PAYLOAD), &version("0.1.0-beta")).is_none());
        assert!(pick_update(releases(REAL_PAYLOAD), &version("0.2.0-beta")).is_none());
    }

    #[test]
    fn the_stable_release_of_a_version_updates_its_prerelease() {
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.1.0","draft":false,"prerelease":false,
           "assets":[{"name":"QuickClip-Setup.exe","size":10,"browser_download_url":"u"}]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0-beta"))
            .expect("0.1.0 is newer than 0.1.0-beta and stable, so it is offered");
        assert_eq!(picked.version, "0.1.0");
        assert!(!picked.prerelease);
    }

    #[test]
    fn the_newest_release_wins_regardless_of_the_order_github_lists_them() {
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.3.0","draft":false,"prerelease":false,
           "assets":[{"name":"QuickClip-Setup.exe","size":3,"browser_download_url":"u3"}]},
          {"html_url":"h","tag_name":"v0.9.0","draft":false,"prerelease":false,
           "assets":[{"name":"QuickClip-Setup.exe","size":9,"browser_download_url":"u9"}]},
          {"html_url":"h","tag_name":"v0.5.0","draft":false,"prerelease":false,
           "assets":[{"name":"QuickClip-Setup.exe","size":5,"browser_download_url":"u5"}]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0")).expect("something is newer");
        assert_eq!(picked.version, "0.9.0");
    }

    #[test]
    fn drafts_and_unparseable_tags_are_skipped_rather_than_guessed_at() {
        let payload = r#"[
          {"html_url":"h","tag_name":"v9.9.9","draft":true,"prerelease":false,
           "assets":[{"name":"QuickClip-Setup.exe","size":1,"browser_download_url":"u"}]},
          {"html_url":"h","tag_name":"nightly","draft":false,"prerelease":false,
           "assets":[{"name":"QuickClip-Setup.exe","size":1,"browser_download_url":"u"}]},
          {"html_url":"h","tag_name":"v0.2.0","draft":false,"prerelease":false,
           "assets":[{"name":"QuickClip-Setup.exe","size":2,"browser_download_url":"u2"}]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0")).expect("v0.2.0 is usable");
        assert_eq!(picked.version, "0.2.0");
    }

    #[test]
    fn a_release_still_uploading_does_not_hide_an_older_usable_one() {
        // A tag exists the moment the workflow starts; the asset appears
        // minutes later. Treating the newest release as authoritative when it
        // has no installer would mean nobody is offered anything until the
        // upload finishes.
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.4.0","draft":false,"prerelease":false,"assets":[]},
          {"html_url":"h","tag_name":"v0.2.0","draft":false,"prerelease":false,
           "assets":[{"name":"QuickClip-Setup.exe","size":2,"browser_download_url":"u2"}]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0")).expect("v0.2.0 is ready");
        assert_eq!(picked.version, "0.2.0");
    }

    #[test]
    fn only_the_setup_exe_is_ever_offered() {
        // Whatever else a release carries - a portable build, a zip, checksums -
        // the updater must hand the installer to Setup, because that is the
        // thing that understands /SILENT and the [Run] relaunch.
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.2.0","draft":false,"prerelease":false,
           "assets":[
             {"name":"QuickClip-portable.exe","size":1,"browser_download_url":"bad"},
             {"name":"checksums.txt","size":1,"browser_download_url":"bad"},
             {"name":"QuickClip-Setup.exe","size":7,"browser_download_url":"good"}
           ]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0")).expect("the setup exe");
        assert_eq!(picked.download_url, "good");
        assert_eq!(picked.size_bytes, 7);
    }

    #[test]
    fn an_empty_release_list_is_not_an_error() {
        assert!(pick_update(releases("[]"), &version("0.1.0")).is_none());
    }

    /// Hits the real GitHub API. #[ignore] so an offline machine, or one that
    /// has spent its 60 unauthenticated requests for the hour, does not fail
    /// the suite for a reason that has nothing to do with the code:
    ///
    ///     cargo test -- --ignored
    ///
    /// What it covers that the fixtures above cannot: that RELEASES_URL names
    /// the right repository, and that GitHub accepts the User-Agent. GitHub
    /// answers 403 to a request without one, and the app would report that as
    /// "could not check" forever without anybody noticing an update existed.
    #[tokio::test]
    #[ignore]
    async fn the_live_release_feed_is_reachable_and_parses() {
        let current = version("0.0.1-alpha");
        let response = reqwest::Client::new()
            .get(RELEASES_URL)
            .header(reqwest::header::USER_AGENT, user_agent(&current))
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .expect("could not reach GitHub");
        assert!(
            response.status().is_success(),
            "GitHub answered {} - a 403 here means the User-Agent was refused",
            response.status()
        );

        let releases: Vec<GhRelease> = response
            .json()
            .await
            .expect("the live payload did not match GhRelease");

        // Every published release must carry the installer the updater knows
        // how to run, or a client would reach it and find nothing to install.
        for release in &releases {
            if release.draft {
                continue;
            }
            assert!(
                release
                    .assets
                    .iter()
                    .any(|a| a.name.to_ascii_lowercase().ends_with(INSTALLER_SUFFIX)),
                "release {} has no {INSTALLER_SUFFIX} asset",
                release.tag_name
            );
        }

        let picked = pick_update(releases, &current);
        assert!(
            picked.is_some(),
            "a 0.0.1-alpha build should be offered the newest published release"
        );
    }
}
