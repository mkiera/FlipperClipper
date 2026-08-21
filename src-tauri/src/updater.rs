//! Self-update against the GitHub Releases API, ported from FinFetcher's UpdateManager.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::download::{extract_zip, find_file, stream_download, user_agent, UnpackError};
use crate::settings::{self, UpdateChannel};

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

/// Matches `ReleaseInfo` in src/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub version: String,
    pub tag_name: String,
    pub published_at: Option<String>,
    pub prerelease: bool,
    pub release_url: String,
    pub download_url: String,
    pub asset_name: String,
    pub size_bytes: u64,
}

/// Matches `AlphaBuild` in src/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaBuild {
    pub run_id: u64,
    pub branch: String,
    pub sha: String,
    pub run_number: u64,
    pub created_at: Option<String>,
    pub artifact_name: String,
    pub download_url: String,
    pub is_current: bool,
}

const RELEASES_URL: &str = "https://api.github.com/repos/mkiera/FlipperClipper/releases";

/// Scoped to the one workflow: an unscoped /actions/runs page buries branch builds under
/// thirty release runs.
const ALPHA_RUNS_URL: &str =
    "https://api.github.com/repos/mkiera/FlipperClipper/actions/workflows/build-test.yml/runs";
const ALPHA_RUNS_URL_BASE: &str = "https://api.github.com/repos/mkiera/FlipperClipper/actions/runs";

/// A run reports its workflow's name, and only this one builds an installer from a branch.
const ALPHA_WORKFLOW_NAME: &str = "Build Test";

/// One artifacts call each, against a 60-per-hour anonymous budget.
const ALPHA_MAX_BRANCHES: usize = 8;

/// GitHub's own artifact download needs a token even on a public repository; nightly.link
/// proxies the same zip anonymously.
const NIGHTLY_LINK_URL: &str = "https://nightly.link/mkiera/FlipperClipper/actions/runs";

/// The CI job writes this name exactly, so it can be matched exactly.
const INSTALLER_SUFFIX: &str = "-setup.exe";

/// Event name from `EVENT.updateProgress` in src/types.ts.
const UPDATE_PROGRESS_EVENT: &str = "update-progress";

#[derive(Deserialize, Clone)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

#[derive(Deserialize, Clone)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

fn updates_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("updates"))
        .map_err(|e| format!("Could not find the app data directory: {e}"))
}

/// Startup is the next moment these are provably finished with: apply_update hands the file
/// to Windows and exits, so it cannot delete its own installer. Best effort throughout.
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

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not start the update check: {e}"))
}

/// 60 unauthenticated requests an hour per address, then 403 (occasionally 429). Worth naming
/// separately: it is the one failure that is neither the network nor this app, and it clears itself.
fn github_error(status: reqwest::StatusCode) -> String {
    if status.as_u16() == 403 || status.as_u16() == 429 {
        "GitHub is rate limiting update checks right now.".to_string()
    } else {
        format!("GitHub answered the update check with HTTP {status}.")
    }
}

async fn github_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
    agent: &str,
) -> Result<T, String> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, agent)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;

    if !response.status().is_success() {
        return Err(github_error(response.status()));
    }

    response
        .json()
        .await
        .map_err(|e| format!("GitHub's answer could not be read: {e}"))
}

async fn fetch_releases(current: &semver::Version) -> Result<Vec<GhRelease>, String> {
    github_json(&api_client()?, RELEASES_URL, &user_agent(current)).await
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let settings = settings::load(&app);
    if !settings.auto_check_updates {
        return Ok(None);
    }

    // package_info().version is compiled in from package.json, the same source the tag is written from.
    let current = app.package_info().version.clone();
    let releases = fetch_releases(&current).await?;

    Ok(pick_update(releases, &current, settings.update_channel))
}

/// Every published release on the channel, newest first, downgrades included.
#[tauri::command]
pub async fn list_releases(
    app: tauri::AppHandle,
    channel: String,
) -> Result<Vec<ReleaseInfo>, String> {
    if channel == "alpha" {
        return Err(
            "Alpha builds come from CI runs rather than releases, so ask list_alpha_builds for them."
                .to_string(),
        );
    }
    let channel = UpdateChannel::parse(&channel)
        .ok_or_else(|| format!("{channel} is not an update channel."))?;
    let current = app.package_info().version.clone();
    let releases = fetch_releases(&current).await?;
    Ok(releases_for_channel(releases, channel))
}

fn releases_for_channel(releases: Vec<GhRelease>, channel: UpdateChannel) -> Vec<ReleaseInfo> {
    let mut listed: Vec<(semver::Version, ReleaseInfo)> = Vec::new();

    for release in releases {
        if release.draft {
            continue;
        }
        let Ok(version) = semver::Version::parse(release.tag_name.trim_start_matches('v')) else {
            continue;
        };
        let is_prerelease = release.prerelease || !version.pre.is_empty();
        if is_prerelease && channel == UpdateChannel::Stable {
            continue;
        }
        let Some(asset) = release
            .assets
            .iter()
            .find(|asset| asset.name.to_ascii_lowercase().ends_with(INSTALLER_SUFFIX))
        else {
            continue;
        };

        listed.push((
            version.clone(),
            ReleaseInfo {
                version: version.to_string(),
                tag_name: release.tag_name.clone(),
                published_at: release.published_at.clone(),
                prerelease: is_prerelease,
                release_url: release.html_url.clone(),
                download_url: asset.browser_download_url.clone(),
                asset_name: asset.name.clone(),
                size_bytes: asset.size,
            },
        ));
    }

    listed.sort_by(|(a, _), (b, _)| b.cmp(a));
    listed.into_iter().map(|(_, info)| info).collect()
}

#[derive(Deserialize, Clone)]
struct GhRunList {
    #[serde(default)]
    workflow_runs: Vec<GhRun>,
}

#[derive(Deserialize, Clone)]
struct GhRun {
    id: u64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    head_branch: Option<String>,
    #[serde(default)]
    head_sha: String,
    #[serde(default)]
    run_number: u64,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Deserialize, Clone)]
struct GhArtifactList {
    #[serde(default)]
    artifacts: Vec<GhArtifact>,
}

#[derive(Deserialize, Clone)]
struct GhArtifact {
    name: String,
    #[serde(default)]
    expired: bool,
}

/// Rows are reused until the user presses refresh: one listing costs an API call per run.
static ALPHA_CACHE: std::sync::Mutex<Option<(Vec<AlphaBuild>, Instant)>> =
    std::sync::Mutex::new(None);
const ALPHA_CACHE_TTL: Duration = Duration::from_secs(300);

/// `current_sha` lives in src/generated/build-info.json, which only the frontend can read, so
/// it arrives as a parameter rather than becoming a second source of truth here.
#[tauri::command]
pub async fn list_alpha_builds(
    app: tauri::AppHandle,
    refresh: bool,
    current_sha: Option<String>,
) -> Result<Vec<AlphaBuild>, String> {
    if !refresh {
        if let Some(cached) = cached_alpha_builds() {
            return Ok(mark_current(cached, current_sha.as_deref()));
        }
    }

    let builds = fetch_alpha_builds(&app.package_info().version).await?;
    *alpha_cache() = Some((builds.clone(), Instant::now()));
    Ok(mark_current(builds, current_sha.as_deref()))
}

/// A list and an instant, neither observable half-written, so a poisoned lock is read through.
fn alpha_cache() -> std::sync::MutexGuard<'static, Option<(Vec<AlphaBuild>, Instant)>> {
    ALPHA_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cached_alpha_builds() -> Option<Vec<AlphaBuild>> {
    let cache = alpha_cache();
    let (builds, at) = cache.as_ref()?;
    (at.elapsed() < ALPHA_CACHE_TTL).then(|| builds.clone())
}

async fn fetch_alpha_builds(current: &semver::Version) -> Result<Vec<AlphaBuild>, String> {
    let client = api_client()?;
    let agent = user_agent(current);

    let runs: GhRunList = github_json(
        &client,
        &format!("{ALPHA_RUNS_URL}?status=success&per_page=30"),
        &agent,
    )
    .await?;

    let mut builds = Vec::new();
    // Bounded because each branch costs another of the 60 anonymous requests an hour.
    for run in newest_run_per_branch(runs.workflow_runs)
        .into_iter()
        .take(ALPHA_MAX_BRANCHES)
    {
        // The artifact name is asked for rather than derived from the branch: only the run knows
        // what build-test.yml uploaded.
        let artifacts: Result<GhArtifactList, String> = github_json(
            &client,
            &format!("{ALPHA_RUNS_URL_BASE}/{}/artifacts", run.id),
            &agent,
        )
        .await;

        // One refused call keeps the rows already gathered instead of re-spending the quota.
        let Ok(artifacts) = artifacts else { break };

        if let Some(artifact) = artifacts
            .artifacts
            .into_iter()
            .find(|artifact| !artifact.expired)
        {
            if let Some(build) = alpha_build(&run, artifact.name) {
                builds.push(build);
            }
        }
    }
    Ok(builds)
}

fn newest_run_per_branch(runs: Vec<GhRun>) -> Vec<GhRun> {
    let mut newest: Vec<GhRun> = Vec::new();

    for run in runs {
        if run.name.as_deref() != Some(ALPHA_WORKFLOW_NAME) {
            continue;
        }
        let Some(branch) = run.head_branch.clone().filter(|name| !name.is_empty()) else {
            continue;
        };

        match newest
            .iter()
            .position(|kept| kept.head_branch.as_deref() == Some(branch.as_str()))
        {
            Some(index) => {
                if newest[index].run_number < run.run_number {
                    newest[index] = run;
                }
            }
            None => newest.push(run),
        }
    }

    newest.sort_by(|a, b| b.run_number.cmp(&a.run_number));
    newest
}

fn alpha_build(run: &GhRun, artifact_name: String) -> Option<AlphaBuild> {
    // The name is a path segment of the download URL, so anything that could steer that URL
    // somewhere else is dropped rather than escaped.
    if artifact_name.is_empty()
        || !artifact_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return None;
    }

    Some(AlphaBuild {
        run_id: run.id,
        branch: run.head_branch.clone().unwrap_or_default(),
        sha: short_sha(&run.head_sha),
        run_number: run.run_number,
        created_at: run.created_at.clone(),
        download_url: format!("{NIGHTLY_LINK_URL}/{}/{artifact_name}.zip", run.id),
        artifact_name,
        is_current: false,
    })
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect::<String>().to_ascii_lowercase()
}

fn mark_current(builds: Vec<AlphaBuild>, running_sha: Option<&str>) -> Vec<AlphaBuild> {
    let running = running_sha
        .map(short_sha)
        .filter(|sha| sha.chars().count() == 7);
    builds
        .into_iter()
        .map(|mut build| {
            build.is_current = running.as_deref() == Some(build.sha.as_str());
            build
        })
        .collect()
}

/// Split out from the command so it can be tested: none of it needs a network or an AppHandle.
/// Wrong in either direction is quiet - a downgrade walks somebody backwards, nothing at all
/// means a fix never reaches them.
fn pick_update(
    releases: Vec<GhRelease>,
    current: &semver::Version,
    channel: UpdateChannel,
) -> Option<UpdateInfo> {
    let mut best: Option<(semver::Version, UpdateInfo)> = None;

    for release in releases {
        if release.draft {
            continue;
        }

        // Tags are written `v0.2.0`; anything that is not semver after that cannot be ordered against
        // the running version, so it is skipped rather than guessed at.
        let Ok(version) = semver::Version::parse(release.tag_name.trim_start_matches('v')) else {
            continue;
        };

        let is_prerelease = release.prerelease || !version.pre.is_empty();
        if is_prerelease && channel == UpdateChannel::Stable {
            continue;
        }

        // semver's ordering puts 0.2.0-beta.1 below 0.2.0, so the stable release of a version
        // correctly updates a pre-release of it.
        if version <= *current {
            continue;
        }

        let Some(asset) = release
            .assets
            .iter()
            .find(|asset| asset.name.to_ascii_lowercase().ends_with(INSTALLER_SUFFIX))
        else {
            // A release whose upload has not finished has a tag and no asset. Skipping it keeps a
            // half-published release from hiding a usable update.
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

/// The auto-update entry point.
#[tauri::command]
pub async fn apply_update(app: tauri::AppHandle, info: UpdateInfo) -> Result<(), String> {
    download_and_install(app, &info.asset_name, &info.download_url, info.size_bytes).await
}

/// Installing a chosen release, including one older than the running build.
#[tauri::command]
pub async fn install_release(app: tauri::AppHandle, info: ReleaseInfo) -> Result<(), String> {
    download_and_install(app, &info.asset_name, &info.download_url, info.size_bytes).await
}

/// Installing one branch build. Only ever reached because somebody picked a row.
#[tauri::command]
pub async fn install_alpha_build(app: tauri::AppHandle, build: AlphaBuild) -> Result<(), String> {
    refuse_while_exporting(&app, EXPORT_RUNNING)?;

    let dir = updates_dir(&app)?.join(format!("alpha-{}", build.run_id));
    // Removed first, so a half-extracted earlier attempt cannot be mistaken for this one's output.
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create the updates folder: {e}"))?;

    let result = match unpack_alpha_build(&app, &build, &dir).await {
        Ok(installer) => spawn_installer(&app, &installer, &dir),
        Err(e) => Err(e),
    };
    if result.is_err() {
        let _ = fs::remove_dir_all(&dir);
    }
    result
}

/// The zip nightly.link serves, unpacked down to the one installer inside it.
async fn unpack_alpha_build(
    app: &tauri::AppHandle,
    build: &AlphaBuild,
    dir: &Path,
) -> Result<PathBuf, String> {
    let zip = dir.join("build.zip");
    stream_download(
        app,
        &build.download_url,
        &zip,
        None,
        Some(ARTIFACT_GONE),
        UPDATE_PROGRESS_EVENT,
    )
    .await?;
    extract_zip(&zip, dir).map_err(|e| match e {
        UnpackError::PowerShellMissing =>
            "Windows PowerShell could not be started, so the build could not be unpacked.".to_string(),
        UnpackError::Failed => "That build's download could not be unpacked.".to_string(),
    })?;

    find_file(dir, 3, &|name| name.to_ascii_lowercase().ends_with(INSTALLER_SUFFIX)).ok_or_else(|| {
        format!(
            "{} does not contain an installer, so there is nothing to run.",
            build.artifact_name
        )
    })
}

const EXPORT_RUNNING: &str =
    "FlipperClipper is still exporting a clip. Let it finish, then update.";
const EXPORT_STARTED_MEANWHILE: &str = "FlipperClipper started exporting a clip while the update was downloading. Let it finish, then update.";
const ARTIFACT_GONE: &str = "That build's installer is no longer downloadable: CI artifacts are kept for 30 days, so this run's has expired, or the run predates the artifact.";

/// A process handle and a bool, neither observable half-written, so a poisoned lock is read through.
fn refuse_while_exporting(app: &tauri::AppHandle, message: &str) -> Result<(), String> {
    let export_running = app
        .state::<crate::AppState>()
        .export
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .child
        .is_some();
    if export_running {
        return Err(message.to_string());
    }
    Ok(())
}

async fn download_and_install(
    app: tauri::AppHandle,
    asset_name: &str,
    download_url: &str,
    size_bytes: u64,
) -> Result<(), String> {
    // app.exit(0) never reaches the ffmpeg handle in AppState, Windows does not reap grandchildren,
    // and installer.iss's CloseApplications only covers files under {app} - so a running export
    // would be left detached, writing to a file the user thinks was abandoned. Refused before the
    // download, since there is nothing to gain from fetching eight megabytes first.
    refuse_while_exporting(&app, EXPORT_RUNNING)?;

    // Nothing downstream can tell a truncated installer from a complete one without a length
    // to check against, and a truncated installer that still runs is the worst outcome here.
    if size_bytes == 0 {
        return Err(format!(
            "The release does not list a size for {}, so the download cannot be verified.",
            asset_name
        ));
    }

    let dir = updates_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create the updates folder: {e}"))?;

    // The asset name comes from the network, so only its last path component is ever used.
    let file_name = Path::new(asset_name)
        .file_name()
        .ok_or_else(|| format!("{} is not a usable file name.", asset_name))?;
    let dest = dir.join(file_name);

    stream_download(
        &app,
        download_url,
        &dest,
        Some(size_bytes),
        None,
        UPDATE_PROGRESS_EVENT,
    )
    .await?;
    spawn_installer(&app, &dest, &dir)
}

/// Hands one installer to Windows and gets out of the way. On success this process is exiting.
fn spawn_installer(app: &tauri::AppHandle, installer: &Path, cwd: &Path) -> Result<(), String> {
    // Inno switches: /SILENT keeps the progress window (/VERYSILENT reads as a crash),
    // /CLOSEAPPLICATIONS covers losing the race with the exit below, /NORESTARTAPPLICATIONS keeps
    // the relaunch owned by installer.iss's [Run] entry. Never /DIR or /TASKS - UsePreviousAppDir
    // and UsePreviousTasks would be reset - and never /NORESTART, which suppresses [Run].
    let mut command = std::process::Command::new(installer);
    command.args(["/SILENT", "/CLOSEAPPLICATIONS", "/NORESTARTAPPLICATIONS"]);
    // The cwd stays in AppData: one inside the install folder would lock the files being replaced.
    command.current_dir(cwd);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS and CREATE_NEW_PROCESS_GROUP so the installer outlives the app.exit(0)
        // below; CREATE_NO_WINDOW because no process this app spawns flashes a console.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    // Asked again: the download is long enough for an export to have been started since the click,
    // and it is the exit below, not the click, that would orphan its ffmpeg.
    refuse_while_exporting(app, EXPORT_STARTED_MEANWHILE)?;

    command
        .spawn()
        .map_err(|e| format!("Could not start the installer: {e}"))?;

    // The installer needs this process gone before it reaches the file copy.
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

    const STABLE: UpdateChannel = UpdateChannel::Stable;
    const PRERELEASE: UpdateChannel = UpdateChannel::Prerelease;

    /// Trimmed from what api.github.com actually returned, so the field names and types are the
    /// real ones. A response serde cannot read fails here rather than becoming "no update".
    const REAL_PAYLOAD: &str = r#"[
      {
        "html_url": "https://github.com/mkiera/FlipperClipper/releases/tag/v0.1.0-beta",
        "tag_name": "v0.1.0-beta",
        "draft": false,
        "prerelease": true,
        "published_at": "2026-08-14T19:02:11Z",
        "assets": [
          {
            "name": "FlipperClipper-Setup.exe",
            "size": 3309048,
            "browser_download_url": "https://github.com/mkiera/FlipperClipper/releases/download/v0.1.0-beta/FlipperClipper-Setup.exe"
          }
        ]
      }
    ]"#;

    #[test]
    fn the_real_github_payload_deserialises_and_is_offered_on_the_prerelease_channel() {
        let picked = pick_update(releases(REAL_PAYLOAD), &version("0.0.9-beta"), PRERELEASE)
            .expect("an older build on the pre-release channel should be offered this one");
        assert_eq!(picked.version, "0.1.0-beta");
        assert_eq!(picked.asset_name, "FlipperClipper-Setup.exe");
        assert_eq!(picked.size_bytes, 3309048);
        assert!(picked.prerelease);
        assert!(picked.download_url.ends_with("/FlipperClipper-Setup.exe"));
    }

    #[test]
    fn the_stable_channel_is_never_pulled_onto_a_prerelease() {
        // The channel decides this, not the running version.
        assert!(pick_update(releases(REAL_PAYLOAD), &version("0.0.1"), STABLE).is_none());
        assert!(pick_update(releases(REAL_PAYLOAD), &version("0.0.9-beta"), STABLE).is_none());
    }

    #[test]
    fn the_running_version_is_not_offered_to_itself() {
        // The bug FinFetcher hit: ship a build whose version does not match its tag and it is offered
        // its own release forever.
        assert!(pick_update(releases(REAL_PAYLOAD), &version("0.1.0-beta"), PRERELEASE).is_none());
        assert!(pick_update(releases(REAL_PAYLOAD), &version("0.2.0-beta"), PRERELEASE).is_none());
    }

    #[test]
    fn the_first_stable_release_reaches_the_beta_builds_on_both_channels() {
        // Every tag before 1.0.0 was a pre-release, so nobody left on the default Stable
        // channel has ever been offered anything. 1.0.0 is the first, and it has to reach
        // the pre-release channel as well or those users are stranded on a beta.
        let payload = r#"[
          {"html_url":"h","tag_name":"v1.0.0","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":10,"browser_download_url":"u"}]}
        ]"#;
        for channel in [STABLE, PRERELEASE] {
            let picked = pick_update(releases(payload), &version("0.1.16-beta"), channel)
                .expect("1.0.0 outranks every 0.1.x beta on either channel");
            assert_eq!(picked.version, "1.0.0");
            assert!(!picked.prerelease);
        }
    }

    #[test]
    fn the_stable_release_of_a_version_updates_its_prerelease() {
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.1.0","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":10,"browser_download_url":"u"}]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0-beta"), STABLE)
            .expect("0.1.0 is newer than 0.1.0-beta and stable, so it is offered");
        assert_eq!(picked.version, "0.1.0");
        assert!(!picked.prerelease);
    }

    #[test]
    fn the_newest_release_wins_regardless_of_the_order_github_lists_them() {
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.3.0","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":3,"browser_download_url":"u3"}]},
          {"html_url":"h","tag_name":"v0.9.0","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":9,"browser_download_url":"u9"}]},
          {"html_url":"h","tag_name":"v0.5.0","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":5,"browser_download_url":"u5"}]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0"), STABLE).expect("something is newer");
        assert_eq!(picked.version, "0.9.0");
    }

    #[test]
    fn drafts_and_unparseable_tags_are_skipped_rather_than_guessed_at() {
        let payload = r#"[
          {"html_url":"h","tag_name":"v9.9.9","draft":true,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":1,"browser_download_url":"u"}]},
          {"html_url":"h","tag_name":"nightly","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":1,"browser_download_url":"u"}]},
          {"html_url":"h","tag_name":"v0.2.0","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":2,"browser_download_url":"u2"}]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0"), STABLE).expect("v0.2.0 is usable");
        assert_eq!(picked.version, "0.2.0");
    }

    #[test]
    fn a_release_still_uploading_does_not_hide_an_older_usable_one() {
        // A tag exists the moment the workflow starts; the asset appears minutes later.
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.4.0","draft":false,"prerelease":false,"assets":[]},
          {"html_url":"h","tag_name":"v0.2.0","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":2,"browser_download_url":"u2"}]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0"), STABLE).expect("v0.2.0 is ready");
        assert_eq!(picked.version, "0.2.0");
    }

    #[test]
    fn only_the_setup_exe_is_ever_offered() {
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.2.0","draft":false,"prerelease":false,
           "assets":[
             {"name":"FlipperClipper-portable.exe","size":1,"browser_download_url":"bad"},
             {"name":"checksums.txt","size":1,"browser_download_url":"bad"},
             {"name":"FlipperClipper-Setup.exe","size":7,"browser_download_url":"good"}
           ]}
        ]"#;
        let picked = pick_update(releases(payload), &version("0.1.0"), STABLE).expect("the setup exe");
        assert_eq!(picked.download_url, "good");
        assert_eq!(picked.size_bytes, 7);
    }

    #[test]
    fn an_empty_release_list_is_not_an_error() {
        assert!(pick_update(releases("[]"), &version("0.1.0"), STABLE).is_none());
    }

    const LISTING_PAYLOAD: &str = r#"[
      {"html_url":"h2","tag_name":"v0.2.0","draft":false,"prerelease":false,
       "published_at":"2026-03-02T10:00:00Z",
       "assets":[{"name":"FlipperClipper-Setup.exe","size":2,"browser_download_url":"u2"}]},
      {"html_url":"h4","tag_name":"v0.4.0-beta.1","draft":false,"prerelease":true,
       "published_at":"2026-05-04T10:00:00Z",
       "assets":[{"name":"FlipperClipper-Setup.exe","size":4,"browser_download_url":"u4"}]},
      {"html_url":"h9","tag_name":"v0.9.0","draft":true,"prerelease":false,
       "published_at":null,
       "assets":[{"name":"FlipperClipper-Setup.exe","size":9,"browser_download_url":"u9"}]},
      {"html_url":"h5","tag_name":"v0.5.0","draft":false,"prerelease":false,
       "published_at":null,"assets":[]},
      {"html_url":"h3","tag_name":"v0.3.0","draft":false,"prerelease":false,
       "published_at":"2026-04-03T10:00:00Z",
       "assets":[{"name":"FlipperClipper-Setup.exe","size":3,"browser_download_url":"u3"}]}
    ]"#;

    fn versions(listed: &[ReleaseInfo]) -> Vec<&str> {
        listed.iter().map(|info| info.version.as_str()).collect()
    }

    #[test]
    fn the_stable_listing_is_newest_first_and_drops_drafts_prereleases_and_assetless_releases() {
        let listed = releases_for_channel(releases(LISTING_PAYLOAD), STABLE);
        assert_eq!(versions(&listed), vec!["0.3.0", "0.2.0"]);
    }

    #[test]
    fn the_prerelease_listing_carries_both_kinds() {
        let listed = releases_for_channel(releases(LISTING_PAYLOAD), PRERELEASE);
        assert_eq!(versions(&listed), vec!["0.4.0-beta.1", "0.3.0", "0.2.0"]);
        assert!(listed[0].prerelease);
        assert!(!listed[1].prerelease);
    }

    #[test]
    fn the_listing_keeps_releases_older_than_the_running_build() {
        // The listing is what makes downgrading possible, so unlike pick_update it compares nothing
        // against the running version.
        let listed = releases_for_channel(releases(LISTING_PAYLOAD), STABLE);
        assert!(listed.iter().any(|info| info.version == "0.2.0"));
    }

    #[test]
    fn a_listed_release_carries_everything_the_settings_panel_shows() {
        let listed = releases_for_channel(releases(REAL_PAYLOAD), PRERELEASE);
        let only = listed.first().expect("one release");
        assert_eq!(only.version, "0.1.0-beta");
        assert_eq!(only.tag_name, "v0.1.0-beta");
        assert_eq!(only.published_at.as_deref(), Some("2026-08-14T19:02:11Z"));
        assert_eq!(only.asset_name, "FlipperClipper-Setup.exe");
        assert_eq!(only.size_bytes, 3309048);
        assert!(only.prerelease);
        assert!(only.release_url.ends_with("/tag/v0.1.0-beta"));
    }

    #[test]
    fn a_release_with_no_published_date_still_lists() {
        let payload = r#"[
          {"html_url":"h","tag_name":"v0.2.0","draft":false,"prerelease":false,
           "assets":[{"name":"FlipperClipper-Setup.exe","size":2,"browser_download_url":"u2"}]}
        ]"#;
        let listed = releases_for_channel(releases(payload), STABLE);
        assert_eq!(versions(&listed), vec!["0.2.0"]);
        assert!(listed[0].published_at.is_none());
    }

    #[test]
    fn the_release_info_field_names_are_the_ones_the_frontend_reads() {
        let listed = releases_for_channel(releases(REAL_PAYLOAD), PRERELEASE);
        let json = serde_json::to_value(&listed[0]).expect("serialises");
        let object = json.as_object().expect("an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "assetName",
                "downloadUrl",
                "prerelease",
                "publishedAt",
                "releaseUrl",
                "sizeBytes",
                "tagName",
                "version"
            ]
        );
    }

    fn runs(json: &str) -> Vec<GhRun> {
        let list: GhRunList = serde_json::from_str(json).expect("test payload should deserialise");
        list.workflow_runs
    }

    /// Trimmed from a real /actions/runs page. Two runs of one branch, a run of another workflow,
    /// and a run with no branch, because all three reach this code in practice.
    const RUNS_PAYLOAD: &str = r#"{
      "total_count": 4,
      "workflow_runs": [
        {"id": 501, "name": "Build Test", "head_branch": "feature/crop-handles",
         "head_sha": "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678", "run_number": 12,
         "created_at": "2026-08-16T09:31:02Z", "event": "push", "conclusion": "success"},
        {"id": 499, "name": "Build Test", "head_branch": "feature/crop-handles",
         "head_sha": "999999999999999999999999999999999999aaaa", "run_number": 11,
         "created_at": "2026-08-15T09:31:02Z", "event": "push", "conclusion": "success"},
        {"id": 498, "name": "Build and Release", "head_branch": "main",
         "head_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "run_number": 40,
         "created_at": "2026-08-14T09:31:02Z", "event": "push", "conclusion": "success"},
        {"id": 497, "name": "Build Test", "head_branch": "bugfix/proxy-leak",
         "head_sha": "cccccccccccccccccccccccccccccccccccccccc", "run_number": 10,
         "created_at": "2026-08-13T09:31:02Z", "event": "push", "conclusion": "success"}
      ]
    }"#;

    #[test]
    fn only_build_test_runs_are_alpha_builds_and_only_the_newest_per_branch() {
        let kept = newest_run_per_branch(runs(RUNS_PAYLOAD));
        let ids: Vec<u64> = kept.iter().map(|run| run.id).collect();
        // 499 is an older run of the same branch, 498 is the release workflow.
        assert_eq!(ids, vec![501, 497]);
    }

    #[test]
    fn a_run_with_no_branch_is_skipped_rather_than_listed_blank() {
        let payload = r#"{"workflow_runs":[
          {"id":1,"name":"Build Test","head_branch":null,"head_sha":"dddddddd","run_number":1}
        ]}"#;
        assert!(newest_run_per_branch(runs(payload)).is_empty());
    }

    #[test]
    fn no_build_test_runs_yet_is_an_empty_list_rather_than_an_error() {
        assert!(newest_run_per_branch(runs(r#"{"workflow_runs":[]}"#)).is_empty());
    }

    #[test]
    fn a_row_carries_the_nightly_link_url_for_the_artifact_the_run_actually_uploaded() {
        let run = newest_run_per_branch(runs(RUNS_PAYLOAD)).remove(0);
        // Whatever build-test.yml uploaded is what gets downloaded; the name is never derived here.
        let build = alpha_build(&run, "FlipperClipper-Setup_handles-retry".to_string())
            .expect("a sane artifact name is usable");
        assert_eq!(build.run_id, 501);
        assert_eq!(build.branch, "feature/crop-handles");
        assert_eq!(build.sha, "a1b2c3d");
        assert_eq!(build.run_number, 12);
        assert_eq!(build.created_at.as_deref(), Some("2026-08-16T09:31:02Z"));
        assert_eq!(
            build.download_url,
            "https://nightly.link/mkiera/FlipperClipper/actions/runs/501/FlipperClipper-Setup_handles-retry.zip"
        );
        assert!(!build.is_current);
    }

    #[test]
    fn an_artifact_name_that_could_steer_the_download_url_is_dropped() {
        let run = newest_run_per_branch(runs(RUNS_PAYLOAD)).remove(0);
        assert!(alpha_build(&run, "../../evil".to_string()).is_none());
        assert!(alpha_build(&run, "a/b".to_string()).is_none());
        assert!(alpha_build(&run, String::new()).is_none());
        assert!(alpha_build(&run, "FlipperClipper-Setup_ok.1".to_string()).is_some());
    }

    fn built(sha: &str) -> AlphaBuild {
        AlphaBuild {
            run_id: 1,
            branch: "feature/x".to_string(),
            sha: short_sha(sha),
            run_number: 1,
            created_at: None,
            artifact_name: "FlipperClipper-Setup_x".to_string(),
            download_url: "u".to_string(),
            is_current: false,
        }
    }

    #[test]
    fn the_running_build_is_marked_whether_its_sha_arrives_short_or_full() {
        let rows = vec![built("a1b2c3d4e5f6"), built("ffffffffffff")];
        let full = mark_current(rows.clone(), Some("A1B2C3D4E5F60718293A4B5C6D7E8F9012345678"));
        assert!(full[0].is_current && !full[1].is_current);

        let short = mark_current(rows.clone(), Some("a1b2c3d"));
        assert!(short[0].is_current && !short[1].is_current);
    }

    #[test]
    fn an_unstamped_build_marks_nothing_as_current() {
        // build-info.json is not committed, so a dev run has no sha to send.
        let rows = vec![built("a1b2c3d4e5f6")];
        assert!(!mark_current(rows.clone(), None)[0].is_current);
        assert!(!mark_current(rows.clone(), Some(""))[0].is_current);
        assert!(!mark_current(rows, Some("a1b2"))[0].is_current);
    }

    #[test]
    fn the_alpha_build_field_names_are_the_ones_the_frontend_reads() {
        let json = serde_json::to_value(built("a1b2c3d4e5f6")).expect("serialises");
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "artifactName",
                "branch",
                "createdAt",
                "downloadUrl",
                "isCurrent",
                "runId",
                "runNumber",
                "sha"
            ]
        );
    }

    /// Hits the real GitHub API. #[ignore] so an offline machine, or one that has spent its 60
    /// requests for the hour, does not fail the suite: `cargo test -- --ignored`.
    ///
    /// A 404 is reported rather than failed - that is what an anonymous request to a PRIVATE
    /// repository gets, and while the repo is private neither this test nor the updater can run.
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

        if response.status().as_u16() == 404 {
            println!(
                "SKIPPED: {RELEASES_URL} answered 404 to an anonymous request.\n\
                 That is what a private repository looks like from outside, and it means\n\
                 the in-app updater cannot reach its release feed either. Nothing to fix\n\
                 in this file - the repository has to be public for updates to work."
            );
            return;
        }

        assert!(
            response.status().is_success(),
            "GitHub answered {} - a 403 here means the User-Agent was refused",
            response.status()
        );

        let releases: Vec<GhRelease> = response
            .json()
            .await
            .expect("the live payload did not match GhRelease");

        // Every published release must carry the installer the updater knows how to run.
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

        let picked = pick_update(releases.clone(), &current, PRERELEASE);
        assert!(
            picked.is_some(),
            "a 0.0.1-alpha build should be offered the newest published release"
        );

        // Derived from the feed rather than naming versions, so it keeps testing the real thing.
        let mut published: Vec<semver::Version> = releases
            .iter()
            .filter(|r| !r.draft)
            .filter_map(|r| semver::Version::parse(r.tag_name.trim_start_matches('v')).ok())
            .collect();
        published.sort();
        published.dedup();

        if published.len() >= 2 {
            let newest = published.last().expect("checked len").clone();
            let previous = published[published.len() - 2].clone();
            let offered = pick_update(releases, &previous, PRERELEASE).unwrap_or_else(|| {
                panic!("a {previous} build was offered nothing, with {newest} published")
            });
            assert_eq!(
                offered.version,
                newest.to_string(),
                "a {previous} build should be offered {newest}"
            );
        }
    }

    /// The alpha half of the live test, #[ignore] for the same reasons. An empty result is reported
    /// rather than failed: build-test.yml only runs on feature/** and bugfix/** pushes.
    #[tokio::test]
    #[ignore]
    async fn the_live_run_feed_is_reachable_and_parses() {
        let current = version("0.0.1-alpha");
        let builds = match fetch_alpha_builds(&current).await {
            Ok(builds) => builds,
            Err(e) => panic!("the run feed could not be read: {e}"),
        };

        if builds.is_empty() {
            println!(
                "SKIPPED: no successful \"{ALPHA_WORKFLOW_NAME}\" run has an artifact yet.\n\
                 That is the expected state until a feature/** or bugfix/** branch is pushed."
            );
            return;
        }

        for build in &builds {
            assert_eq!(build.sha.len(), 7, "{} has no short sha", build.run_id);
            assert!(!build.branch.is_empty());
            assert!(build
                .download_url
                .starts_with("https://nightly.link/mkiera/FlipperClipper/actions/runs/"));
        }
    }
}
