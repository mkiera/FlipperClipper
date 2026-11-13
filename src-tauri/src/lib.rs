// Public so tests/real_export.rs can drive the real command builder.
pub mod ffmpeg;
mod download;
mod debug;
mod export;
mod export_output;
mod ffmpeg_install;
pub mod ramp;
pub mod sequence;
mod settings;
mod sysutil;
mod updater;

use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct ExportSlot {
    pub child: Option<std::process::Child>,
    // Held from the start of start_export until its watcher has cleaned up, so the probe and
    // encoder tests before the spawn count as running too.
    pub job: Option<u64>,
    // Per job id, so a cancel that lands before the child exists still stops that export and a
    // later export does not inherit it. Lives beside the child handle so a user cancel and
    // ffmpeg dying on its own - identical from the watcher thread's side - resolve to one outcome.
    pub cancelled_jobs: std::collections::HashSet<u64>,
    // Set once the window starts closing, so no export can start while it waits to go.
    pub closing: bool,
}

/// Long enough for a killed ffmpeg to exit and its temp file to go, short enough that a stuck
/// one does not hold the window open.
const CLOSE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

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
                job: None,
                cancelled_jobs: Default::default(),
                closing: false,
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
            // Before anything can resolve a tool, so the app's own copy is the first tier.
            if let Ok(dir) = app.path().app_local_data_dir() {
                ffmpeg::set_managed_dir(dir.join("ffmpeg"));
            }
            // Startup is the one moment nothing in these folders is in use.
            ffmpeg_install::sweep_leftovers(app.handle());
            updater::clear_updates_dir(app.handle());
            Ok(())
        })
        // Closing the window ends the process, and a running ffmpeg is a child Windows does
        // not reap - it would keep writing to a file nobody is waiting for. Killing it takes
        // the same path a cancel does, and the window stays until that path has removed the
        // part-written output, because the process exit would otherwise cut it short.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let window = window.clone();
                let slot = Arc::clone(&window.app_handle().state::<AppState>().export);
                std::thread::spawn(move || {
                    export::close_export(&slot, CLOSE_WAIT);
                    let _ = window.destroy();
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            sysutil::ffmpeg_status,
            sysutil::ffmpeg_check_log,
            ffmpeg_install::install_ffmpeg,
            sysutil::probe,
            sysutil::measure_loudness,
            sysutil::make_filmstrip,
            sysutil::make_clips_filmstrip,
            sysutil::make_preview_proxy,
            sysutil::make_audio_previews,
            sysutil::copy_file_to_clipboard,
            sysutil::reveal_in_explorer,
            sysutil::app_version,
            sysutil::set_min_window_size,
            sysutil::grow_window_for_mixer,
            sysutil::shrink_window_after_mixer,
            sysutil::cli_file_path,
            ffmpeg::estimate_export_size,
            export::detect_encoder,
            debug::debug_report,
            debug::run_diagnostic,
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
