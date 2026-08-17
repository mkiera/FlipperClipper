// Public so tests/real_export.rs can drive the real command builder.
pub mod ffmpeg;
mod export;
mod settings;
mod sysutil;
mod updater;

use std::sync::{Arc, Mutex};

pub struct ExportSlot {
    pub child: Option<std::process::Child>,
    // Lives beside the child handle so a user cancel and ffmpeg dying on its own
    // - identical from the watcher thread's side - resolve to one outcome.
    pub cancelled: bool,
}

pub struct AppState {
    // Cached for the life of the process: detection costs one real ffmpeg run
    // per candidate, and a GPU does not appear while the app is open.
    pub encoder: Mutex<Option<String>>,
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
            // Startup is the one moment nothing in that folder is in use.
            updater::clear_updates_dir(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sysutil::ffmpeg_status,
            sysutil::ffmpeg_check_log,
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
            updater::list_releases,
            updater::install_release,
            updater::list_alpha_builds,
            updater::install_alpha_build,
            settings::get_settings,
            settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
