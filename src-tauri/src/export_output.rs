use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use same_file::Handle;
use tempfile::TempPath;

use crate::ffmpeg::ExportJob;

pub(crate) fn validate_destination(input: &Path, output: &Path) -> Result<(), String> {
    let source = Handle::from_path(input)
        .map_err(|err| format!("The source video could not be checked: {err}"))?;
    check_destination(&source, output)
}

fn check_destination(source: &Handle, output: &Path) -> Result<(), String> {
    match Handle::from_path(output) {
        Ok(destination) if source == &destination => Err(
            "Pick a different name: this would overwrite the video you are editing.".to_string(),
        ),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "The export destination could not be checked: {err}"
        )),
    }
}

pub(crate) struct PendingOutput {
    source: Handle,
    destination: PathBuf,
    temporary: Option<TempPath>,
}

impl PendingOutput {
    pub(crate) fn new(job: &mut ExportJob) -> Result<Self, String> {
        let input = std::fs::canonicalize(&job.input)
            .map_err(|err| format!("The source video could not be checked: {err}"))?;
        let source = Handle::from_path(&input)
            .map_err(|err| format!("The source video could not be checked: {err}"))?;
        let output = Path::new(&job.output);
        let name = output
            .file_name()
            .ok_or_else(|| "The export path is not a file path.".to_string())?;
        let parent = output
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let directory = std::fs::canonicalize(parent)
            .map_err(|err| format!("The export folder could not be checked: {err}"))?;
        let destination = directory.join(name);
        check_destination(&source, &destination)?;
        // FFmpeg infers the container from the filename, including for stream copies.
        let suffix = output
            .extension()
            .map(|ext| format!(".{}", ext.to_string_lossy()))
            .unwrap_or_default();
        let temporary = tempfile::Builder::new()
            .prefix(".flipperclipper-export-")
            .suffix(&suffix)
            .tempfile_in(directory)
            .map_err(|err| format!("A temporary export file could not be created: {err}"))?
            .into_temp_path();
        job.input = input.to_string_lossy().into_owned();
        job.output = temporary.to_string_lossy().into_owned();
        Ok(Self {
            source,
            destination,
            temporary: Some(temporary),
        })
    }

    pub(crate) fn publish(&mut self) -> Result<(), String> {
        check_destination(&self.source, &self.destination)?;
        let temporary = self
            .temporary
            .take()
            .ok_or_else(|| "The temporary export file is no longer available.".to_string())?;
        match temporary.persist(&self.destination) {
            Ok(()) => Ok(()),
            Err(err) => {
                let message = format!(
                    "The completed export could not replace the destination. The existing file has been kept: {}",
                    err.error,
                );
                self.temporary = Some(err.path);
                Err(message)
            }
        }
    }

    pub(crate) fn discard(mut self) -> bool {
        self.temporary
            .take()
            .is_some_and(|path| path.close().is_ok())
    }
}
