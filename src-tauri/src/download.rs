//! Downloading and unpacking, shared by the updater and the FFmpeg installer.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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

/// How long a download may receive nothing before it counts as stalled.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);

static PART_COUNTER: AtomicU64 = AtomicU64::new(0);

fn download_client(stall: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // No overall timeout: this body is the whole installer and a slow connection is not an error.
        .connect_timeout(Duration::from_secs(15))
        // Without it a connection that goes quiet without a reset waits forever, with no Retry shown.
        .read_timeout(stall)
        .build()
        .map_err(|e| format!("Could not start the download: {e}"))
}

/// A name no other download can be writing, so two downloads to one destination never truncate each other.
fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(format!(
        ".part-{}-{}",
        std::process::id(),
        PART_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    dest.with_file_name(name)
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
    let client = download_client(STALL_TIMEOUT)?;
    download_to(
        &client,
        download_url,
        &user_agent(&app.package_info().version),
        dest,
        size_bytes,
        gone_message,
        |fraction| {
            let _ = app.emit(event, fraction);
        },
    )
    .await
}

async fn download_to(
    client: &reqwest::Client,
    download_url: &str,
    agent: &str,
    dest: &Path,
    size_bytes: Option<u64>,
    gone_message: Option<&str>,
    progress: impl Fn(f64),
) -> Result<(), String> {
    let response = client
        .get(download_url)
        .header(reqwest::header::USER_AGENT, agent)
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

    let part = part_path(dest);
    let mut file =
        fs::File::create(&part).map_err(|e| format!("Could not write the download: {e}"))?;
    let mut stream = response.bytes_stream();
    let mut written: u64 = 0;
    let mut last_emitted = 0.0_f64;
    let mut last_emitted_at = Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&part);
                if e.is_timeout() {
                    return Err(format!(
                        "The download stalled: nothing arrived for {} seconds.                          Check your internet connection, then try again.",
                        STALL_TIMEOUT.as_secs()
                    ));
                }
                return Err(format!("The download stopped early: {e}"));
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = fs::remove_file(&part);
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
            progress(fraction);
        }
    }

    if let Err(e) = file.flush() {
        drop(file);
        let _ = fs::remove_file(&part);
        return Err(format!("Could not finish writing the download: {e}"));
    }
    drop(file);

    // A stream that ends is indistinguishable from a connection that was cut, and this file is
    // about to be executed as an installer.
    if let Some(total) = expected {
        if written != total {
            let _ = fs::remove_file(&part);
            return Err(format!(
                "The download stopped early — got {} bytes of the {} it should have.                  The incomplete file has been deleted; please try again.",
                written, total
            ));
        }
    }

    if let Err(e) = fs::rename(&part, dest) {
        let _ = fs::remove_file(&part);
        return Err(format!("Could not finish writing the download: {e}"));
    }

    progress(1.0);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::mpsc;

    const BODY_LEN: usize = 100;
    const FIRST_PART: usize = 10;

    /// Sends headers and the first bytes of the body, then holds the connection open until `go`
    /// fires, then sends the rest. A dropped `go` closes the connection instead.
    fn stalling_server(go: mpsc::Receiver<()>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}/file", listener.local_addr().expect("addr"));
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                if socket.read(&mut byte).unwrap_or(0) == 0 {
                    return;
                }
                request.push(byte[0]);
            }
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {BODY_LEN}\r\n\r\n");
            let _ = socket.write_all(head.as_bytes());
            let _ = socket.write_all(&[b'n'; FIRST_PART]);
            let _ = socket.flush();
            if go.recv().is_ok() {
                let _ = socket.write_all(&[b'n'; BODY_LEN - FIRST_PART]);
                let _ = socket.flush();
            }
        });
        url
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "flipperclipper-download-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn file_names(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("read dir")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[tokio::test]
    async fn a_stalled_download_fails_instead_of_waiting_forever() {
        let (_go, wait) = mpsc::channel();
        let url = stalling_server(wait);
        let dir = temp_dir("stall");
        let dest = dir.join("FlipperClipper-Setup.exe");
        let client = download_client(Duration::from_millis(300)).expect("client");

        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            download_to(&client, &url, "test", &dest, Some(BODY_LEN as u64), None, |_| {}),
        )
        .await
        .expect("the download hung on a stalled connection");

        let error = outcome.expect_err("a stalled download must fail");
        assert!(error.contains("stalled"), "{error}");
        assert!(file_names(&dir).is_empty(), "left behind {:?}", file_names(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    // Multi-threaded because the test blocks on a channel while the download runs.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_download_in_progress_leaves_the_destination_alone() {
        let (go, wait) = mpsc::channel();
        let url = stalling_server(wait);
        let dir = temp_dir("part");
        let dest = dir.join("FlipperClipper-Setup.exe");
        fs::write(&dest, b"old installer").expect("seed");
        let client = download_client(Duration::from_secs(10)).expect("client");

        let (progressed, progress) = mpsc::channel();
        let task = tokio::spawn({
            let dest = dest.clone();
            async move {
                download_to(&client, &url, "test", &dest, Some(BODY_LEN as u64), None, move |f| {
                    let _ = progressed.send(f);
                })
                .await
            }
        });

        let first = progress
            .recv_timeout(Duration::from_secs(10))
            .expect("no progress");
        assert!(first < 1.0);
        assert_eq!(fs::read(&dest).expect("read"), b"old installer");

        go.send(()).expect("release");
        task.await.expect("task").expect("download");
        assert_eq!(fs::read(&dest).expect("read"), vec![b'n'; BODY_LEN]);
        assert_eq!(file_names(&dir), vec!["FlipperClipper-Setup.exe".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }
}
