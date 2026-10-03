use super::tests::job;
use super::*;

#[test]
fn rejects_source_hard_link() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("source.mp4");
    let output = dir.path().join("alias.mp4");
    std::fs::write(&input, b"irreplaceable source").unwrap();
    std::fs::hard_link(&input, &output).unwrap();
    let mut j = job();
    j.input = input.to_string_lossy().into_owned();
    j.output = output.to_string_lossy().into_owned();
    assert!(validate(&j).is_err(), "source hard link was accepted");
    assert_eq!(std::fs::read(input).unwrap(), b"irreplaceable source");
}

#[test]
fn rejects_source_path_with_parent_component() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    let input = dir.path().join("source.mp4");
    std::fs::write(&input, b"irreplaceable source").unwrap();
    let mut j = job();
    j.input = input.to_string_lossy().into_owned();
    j.output = nested
        .join("..")
        .join("source.mp4")
        .to_string_lossy()
        .into_owned();
    assert!(validate(&j).is_err(), "source path alias was accepted");
}

#[cfg(windows)]
#[test]
fn rejects_source_through_directory_junction() {
    let dir = tempfile::tempdir().unwrap();
    let source_dir = dir.path().join("original");
    let junction = dir.path().join("junction");
    std::fs::create_dir(&source_dir).unwrap();
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command",
            "New-Item -ItemType Junction -Path $env:TEST_JUNCTION -Target $env:TEST_TARGET | Out-Null"])
        .env("TEST_JUNCTION", &junction)
        .env("TEST_TARGET", &source_dir)
        .status().unwrap();
    assert!(status.success());
    let source = source_dir.join("source.mp4");
    std::fs::write(&source, b"irreplaceable source").unwrap();
    let mut j = job();
    j.input = junction.join("source.mp4").to_string_lossy().into_owned();
    j.output = source.to_string_lossy().into_owned();
    let result = validate(&j);
    std::fs::remove_dir(junction).unwrap();
    assert!(result.is_err(), "source through a junction was accepted");
}

fn byte_fixture() -> (tempfile::TempDir, ExportJob) {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("source.mp4");
    let output = dir.path().join("previous.mp4");
    std::fs::write(&input, b"irreplaceable source").unwrap();
    std::fs::write(&output, b"previous successful export").unwrap();
    let mut j = job();
    j.input = input.to_string_lossy().into_owned();
    j.output = output.to_string_lossy().into_owned();
    (dir, j)
}

#[test]
fn failure_preserves_previous_export() {
    let (_dir, mut j) = byte_fixture();
    let (input, output) = (j.input.clone(), j.output.clone());
    let pending = PendingOutput::new(&mut j).unwrap();
    assert!(finish_export(pending, None, false, &VecDeque::new()).is_err());
    assert!(!Path::new(&j.output).exists());
    assert_eq!(
        std::fs::read(output).unwrap(),
        b"previous successful export"
    );
    assert_eq!(std::fs::read(input).unwrap(), b"irreplaceable source");
}

// The GitHub runner has no FFmpeg, matching the skip in tests/real_export.rs.
fn export_fixture() -> Option<(tempfile::TempDir, ExportJob)> {
    if ffmpeg::resolve_tool("ffmpeg").is_none() || ffmpeg::resolve_tool("ffprobe").is_none() {
        return None;
    }
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("source.mkv");
    let output = dir.path().join("previous.mp4");
    let generated = ffmpeg::hidden_command("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x64:rate=10:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&input)
        .output()
        .expect("FFmpeg is required for export lifecycle tests");
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    std::fs::write(&output, b"previous successful export").unwrap();
    let mut j = job();
    j.input = input.to_string_lossy().into_owned();
    j.output = output.to_string_lossy().into_owned();
    j.out_point = 0.5;
    Some((dir, j))
}

fn prepare(j: &mut ExportJob, encoder: &str) -> (Command, PendingOutput) {
    let info = crate::sysutil::probe_media(&j.input).unwrap();
    prepare_export(j, encoder, &info, None).unwrap()
}

fn tail(output: &std::process::Output) -> VecDeque<String> {
    String::from_utf8_lossy(&output.stderr)
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn missing_encoder_preserves_existing_destination() {
    let Some((_dir, mut j)) = export_fixture() else {
        return;
    };
    let destination = j.output.clone();
    let source = std::fs::read(&j.input).unwrap();
    let (mut command, pending) = prepare(&mut j, "no_such_encoder");
    let result = command.output().unwrap();
    assert!(!result.status.success());
    let failure =
        finish_export(pending, Some(Ok(result.status)), false, &tail(&result)).unwrap_err();
    assert!(failure.cleaned_up);
    assert!(failure.detail.contains("no_such_encoder"));
    assert_eq!(
        std::fs::read(destination).unwrap(),
        b"previous successful export"
    );
    assert_eq!(std::fs::read(&j.input).unwrap(), source);
    assert!(!Path::new(&j.output).exists());
}

#[test]
fn partial_write_failure_preserves_existing_destination() {
    let (_dir, mut j) = byte_fixture();
    let destination = j.output.clone();
    let pending = PendingOutput::new(&mut j).unwrap();
    std::fs::write(&j.output, b"incomplete export").unwrap();
    let failure = finish_export(pending, None, false, &VecDeque::new()).unwrap_err();
    assert!(failure.cleaned_up);
    assert_eq!(
        std::fs::read(destination).unwrap(),
        b"previous successful export"
    );
    assert!(!Path::new(&j.output).exists());
}

#[test]
fn spawn_failure_discards_only_the_temporary_file() {
    let (dir, mut j) = byte_fixture();
    let destination = j.output.clone();
    let pending = PendingOutput::new(&mut j).unwrap();
    assert!(
        std::process::Command::new(dir.path().join("missing-ffmpeg.exe"))
            .spawn()
            .is_err()
    );
    drop(pending);
    assert_eq!(
        std::fs::read(destination).unwrap(),
        b"previous successful export"
    );
    assert!(!Path::new(&j.output).exists());
}

#[test]
fn cancel_running_encoder_preserves_existing_destination() {
    let Some((_dir, mut j)) = export_fixture() else {
        return;
    };
    let destination = j.output.clone();
    let (command, pending) = prepare(&mut j, "libx264");
    let mut child = ffmpeg::hidden_command("ffmpeg")
        .arg("-re")
        .args(command.get_args())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let started = loop {
        if std::fs::metadata(&j.output).unwrap().len() > 0 {
            break true;
        }
        if Instant::now() >= deadline || child.try_wait().unwrap().is_some() {
            break false;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let original_while_running = std::fs::read(&destination).unwrap();
    let _ = child.kill();
    let status = child.wait();
    assert!(started, "FFmpeg did not begin writing within the timeout");
    assert!(!finish_export(pending, Some(status), true, &VecDeque::new()).unwrap());
    assert_eq!(original_while_running, b"previous successful export");
    assert_eq!(
        std::fs::read(destination).unwrap(),
        b"previous successful export"
    );
    assert!(!Path::new(&j.output).exists());
}

#[test]
fn success_publishes_each_format_only_after_encoding() {
    let Some((dir, base)) = export_fixture() else {
        return;
    };
    let source = std::fs::read(&base.input).unwrap();
    for (format, extension) in [
        (ExportFormat::Mp4, "mp4"),
        (ExportFormat::Mkv, "mkv"),
        (ExportFormat::Mov, "mov"),
        (ExportFormat::Webm, "webm"),
        (ExportFormat::Gif, "gif"),
        (ExportFormat::Mp3, "mp3"),
        (ExportFormat::M4a, "m4a"),
        (ExportFormat::Wav, "wav"),
        (ExportFormat::Flac, "flac"),
        (ExportFormat::Ogg, "ogg"),
        (ExportFormat::Opus, "opus"),
    ] {
        let mut j = base.clone();
        let destination = dir.path().join(format!("finished.{extension}"));
        std::fs::write(&destination, b"previous successful export").unwrap();
        j.output = destination.to_string_lossy().into_owned();
        j.format = format;
        let (mut command, pending) = prepare(&mut j, "libx264");
        assert_ne!(Path::new(&j.output), destination);
        assert_eq!(Path::new(&j.output).extension().unwrap(), extension);
        let result = command.output().unwrap();
        assert!(
            result.status.success(),
            "{extension}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let completed = std::fs::read(&j.output).unwrap();
        assert!(!completed.is_empty());
        assert_eq!(
            std::fs::read(&destination).unwrap(),
            b"previous successful export"
        );
        assert!(finish_export(pending, Some(Ok(result.status)), false, &tail(&result)).unwrap());
        assert_eq!(std::fs::read(&destination).unwrap(), completed);
        assert_eq!(std::fs::read(&j.input).unwrap(), source);
        assert!(!Path::new(&j.output).exists());
        assert!(ffmpeg::hidden_command("ffprobe")
            .args(["-v", "error"])
            .arg(&destination)
            .status()
            .unwrap()
            .success());
    }
}

#[test]
fn destination_changed_to_source_is_rejected_at_completion() {
    let Some((_dir, mut j)) = export_fixture() else {
        return;
    };
    let source = std::fs::read(&j.input).unwrap();
    let destination = j.output.clone();
    let (mut command, pending) = prepare(&mut j, "libx264");
    let result = command.output().unwrap();
    assert!(result.status.success());
    std::fs::remove_file(&destination).unwrap();
    std::fs::hard_link(&j.input, &destination).unwrap();
    let failure =
        finish_export(pending, Some(Ok(result.status)), false, &VecDeque::new()).unwrap_err();
    assert!(failure.message.contains("overwrite the video"));
    assert_eq!(std::fs::read(destination).unwrap(), source);
    assert_eq!(std::fs::read(&j.input).unwrap(), source);
    assert!(!Path::new(&j.output).exists());
}

#[cfg(windows)]
#[test]
fn locked_destination_survives_publish_failure() {
    use std::os::windows::fs::OpenOptionsExt;
    let Some((_dir, mut j)) = export_fixture() else {
        return;
    };
    let destination = j.output.clone();
    let (mut command, pending) = prepare(&mut j, "libx264");
    let result = command.output().unwrap();
    assert!(result.status.success());
    let _lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&destination)
        .unwrap();
    let failure =
        finish_export(pending, Some(Ok(result.status)), false, &VecDeque::new()).unwrap_err();
    assert!(failure.message.contains("could not replace"));
    assert!(failure.cleaned_up);
    assert_eq!(
        std::fs::read(destination).unwrap(),
        b"previous successful export"
    );
    assert!(!Path::new(&j.output).exists());
}

#[test]
fn lossless_export_to_new_destination_publishes_successfully() {
    let Some((dir, mut j)) = export_fixture() else {
        return;
    };
    let destination = dir.path().join("new.mkv");
    j.output = destination.to_string_lossy().into_owned();
    j.lossless = true;
    j.format = ExportFormat::Mkv;
    let (mut command, pending) = prepare(&mut j, "libx264");
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!destination.exists());
    assert!(finish_export(pending, Some(Ok(result.status)), false, &tail(&result)).unwrap());
    assert!(destination.is_file());
    assert!(!Path::new(&j.output).exists());
}
