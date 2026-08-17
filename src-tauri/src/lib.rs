// Public so tests/real_export.rs can drive the real command builder. The unit
// tests in here only prove what argv comes out; that suite proves ffmpeg
// actually accepts it and produces the clip the arguments describe.
pub mod ffmpeg;
mod export;
mod sysutil;
mod updater;

use std::sync::{Arc, Mutex};

/// The one export QuickClip runs at a time, plus how it ended.
///
/// `cancelled` has to sit next to the child handle instead of living in the
/// reader thread, because from the thread's side a user cancel and ffmpeg dying
/// on its own look identical: both arrive as a killed process with a non-zero
/// exit code. Reading the flag under the same lock that hands the child over
/// means the two possible orderings - cancel lands first, or the process exits
/// first - still produce exactly one outcome instead of a done event and an
/// error event racing each other to the UI.
pub struct ExportSlot {
    pub child: Option<std::process::Child>,
    pub cancelled: bool,
}

pub struct AppState {
    /// Detecting the encoder costs one real ffmpeg process per candidate, since
    /// "compiled in" says nothing about whether the GPU is actually there. That
    /// is far too slow to redo per export, and a graphics card does not appear
    /// or vanish while the app is open, so the first answer is kept for the life
    /// of the process.
    pub encoder: Mutex<Option<String>>,
    /// Held behind an Arc as well as the Mutex so the thread that watches ffmpeg
    /// can keep its own handle on the slot without borrowing from an AppHandle.
    pub export: Arc<Mutex<ExportSlot>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            encoder: Mutex::new(None),
            export: Arc::new(Mutex::new(ExportSlot {
                child: None,
                cancelled: false,
            })),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .setup(|app| {
            // The updater hands its downloaded installer to Windows and then
            // forgets about it, so every update QuickClip has ever applied leaves
            // an installer sitting in %APPDATA%\com.mkiera.quickclip\updates for
            // good. Startup is the safe moment to sweep them: no download of this
            // session has happened yet, so nothing in that folder is in use.
            updater::clear_updates_dir(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sysutil::ffmpeg_status,
            sysutil::install_ffmpeg,
            sysutil::probe,
            sysutil::make_filmstrip,
            sysutil::make_preview_proxy,
            sysutil::copy_file_to_clipboard,
            sysutil::reveal_in_explorer,
            sysutil::app_version,
            sysutil::cli_file_path,
            export::detect_encoder,
            export::start_export,
            export::cancel_export,
            updater::check_for_update,
            updater::apply_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
