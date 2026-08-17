use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::ffmpeg::QualityPreset;

pub const MIN_TARGET_MB: f64 = 0.5;
pub const MAX_TARGET_MB: f64 = 10_000.0;
const DEFAULT_TARGET_MB: f64 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Prerelease,
}

impl UpdateChannel {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "stable" => Some(Self::Stable),
            "prerelease" => Some(Self::Prerelease),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncoderPreference {
    Auto,
    Software,
}

/// `ExportFormat` plus "keep whatever the source file is".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultFormat {
    Source,
    Mp4,
    Mkv,
    Mov,
    Webm,
    Gif,
    Mp3,
    M4a,
    Wav,
    Flac,
    Ogg,
    Opus,
}

/// Matches `AppSettings` in src/types.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub update_channel: UpdateChannel,
    pub auto_check_updates: bool,
    pub default_format: DefaultFormat,
    pub default_quality: QualityPreset,
    pub default_target_mb: f64,
    pub show_filmstrip: bool,
    pub encoder: EncoderPreference,
    pub auto_preview_proxy: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            update_channel: UpdateChannel::Stable,
            auto_check_updates: true,
            default_format: DefaultFormat::Source,
            default_quality: QualityPreset::Balanced,
            default_target_mb: DEFAULT_TARGET_MB,
            show_filmstrip: true,
            encoder: EncoderPreference::Auto,
            auto_preview_proxy: true,
        }
    }
}

fn sanitise(mut settings: AppSettings) -> AppSettings {
    settings.default_target_mb = if settings.default_target_mb.is_finite() {
        settings.default_target_mb.clamp(MIN_TARGET_MB, MAX_TARGET_MB)
    } else {
        DEFAULT_TARGET_MB
    };
    settings
}

fn field<T: serde::de::DeserializeOwned>(
    fields: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    slot: &mut T,
) {
    if let Some(value) = fields.get(key) {
        if let Ok(parsed) = serde_json::from_value(value.clone()) {
            *slot = parsed;
        }
    }
}

/// Anything unreadable settles as defaults here. Folded field by field on purpose: an older
/// build reading a newer build's file must lose only the fields it cannot parse.
fn from_json_str(text: &str) -> AppSettings {
    let mut settings = AppSettings::default();
    if let Ok(serde_json::Value::Object(fields)) = serde_json::from_str(text) {
        field(&fields, "updateChannel", &mut settings.update_channel);
        field(&fields, "autoCheckUpdates", &mut settings.auto_check_updates);
        field(&fields, "defaultFormat", &mut settings.default_format);
        field(&fields, "defaultQuality", &mut settings.default_quality);
        field(&fields, "defaultTargetMb", &mut settings.default_target_mb);
        field(&fields, "showFilmstrip", &mut settings.show_filmstrip);
        field(&fields, "encoder", &mut settings.encoder);
        field(&fields, "autoPreviewProxy", &mut settings.auto_preview_proxy);
    }
    sanitise(settings)
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

pub fn load(app: &tauri::AppHandle) -> AppSettings {
    let Some(path) = settings_path(app) else {
        return AppSettings::default();
    };
    match fs::read_to_string(&path) {
        Ok(text) => from_json_str(&text),
        Err(_) => AppSettings::default(),
    }
}

#[tauri::command(async)]
pub fn get_settings(app: tauri::AppHandle) -> AppSettings {
    load(&app)
}

#[tauri::command(async)]
pub fn save_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<(), String> {
    let path = settings_path(&app)
        .ok_or_else(|| "Could not find the app data directory.".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create the settings folder: {e}"))?;
    }
    let text = serde_json::to_string_pretty(&sanitise(settings))
        .map_err(|e| format!("Could not write the settings: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("Could not save the settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_are_the_ones_the_contract_names() {
        let json = serde_json::to_value(AppSettings::default()).expect("serialises");
        assert_eq!(
            json,
            serde_json::json!({
                "updateChannel": "stable",
                "autoCheckUpdates": true,
                "defaultFormat": "source",
                "defaultQuality": "balanced",
                "defaultTargetMb": 10.0,
                "showFilmstrip": true,
                "encoder": "auto",
                "autoPreviewProxy": true
            })
        );
    }

    #[test]
    fn a_full_file_round_trips() {
        let settings = AppSettings {
            update_channel: UpdateChannel::Prerelease,
            auto_check_updates: false,
            default_format: DefaultFormat::Webm,
            default_quality: QualityPreset::Fit,
            default_target_mb: 25.5,
            show_filmstrip: false,
            encoder: EncoderPreference::Software,
            auto_preview_proxy: false,
        };
        let text = serde_json::to_string(&settings).expect("serialises");
        assert_eq!(from_json_str(&text), settings);
    }

    #[test]
    fn a_missing_field_falls_back_to_its_default_and_keeps_the_rest() {
        let loaded = from_json_str(r#"{"showFilmstrip": false, "defaultTargetMb": 3}"#);
        assert!(!loaded.show_filmstrip);
        assert_eq!(loaded.default_target_mb, 3.0);
        assert_eq!(loaded.update_channel, UpdateChannel::Stable);
        assert_eq!(loaded.default_format, DefaultFormat::Source);
    }

    #[test]
    fn an_unreadable_or_invalid_file_is_defaults_rather_than_an_error() {
        assert_eq!(from_json_str(""), AppSettings::default());
        assert_eq!(from_json_str("not json at all"), AppSettings::default());
        assert_eq!(from_json_str("[]"), AppSettings::default());
    }

    #[test]
    fn an_unrecognised_value_only_costs_its_own_field() {
        let loaded = from_json_str(
            r#"{"encoder": "quantum", "updateChannel": "prerelease", "showFilmstrip": false, "defaultTargetMb": 3}"#,
        );
        assert_eq!(loaded.encoder, EncoderPreference::Auto);
        assert_eq!(loaded.update_channel, UpdateChannel::Prerelease);
        assert!(!loaded.show_filmstrip);
        assert_eq!(loaded.default_target_mb, 3.0);
    }

    #[test]
    fn every_export_format_is_also_a_default_format() {
        use crate::ffmpeg::ExportFormat;

        // Listing a new ExportFormat variant here is forced by the match below,
        // and DefaultFormat learning it is forced by the parse.
        let all = [
            ExportFormat::Mp4,
            ExportFormat::Mkv,
            ExportFormat::Mov,
            ExportFormat::Webm,
            ExportFormat::Gif,
            ExportFormat::Mp3,
            ExportFormat::M4a,
            ExportFormat::Wav,
            ExportFormat::Flac,
            ExportFormat::Ogg,
            ExportFormat::Opus,
        ];
        fn position(format: ExportFormat) -> usize {
            match format {
                ExportFormat::Mp4 => 0,
                ExportFormat::Mkv => 1,
                ExportFormat::Mov => 2,
                ExportFormat::Webm => 3,
                ExportFormat::Gif => 4,
                ExportFormat::Mp3 => 5,
                ExportFormat::M4a => 6,
                ExportFormat::Wav => 7,
                ExportFormat::Flac => 8,
                ExportFormat::Ogg => 9,
                ExportFormat::Opus => 10,
            }
        }
        assert!(all.iter().copied().map(position).eq(0..all.len()));

        for format in all {
            let name = serde_json::to_value(format).expect("serialises");
            let parsed = serde_json::from_value::<DefaultFormat>(name.clone());
            assert!(parsed.is_ok(), "DefaultFormat has no variant for {name}");
            assert_eq!(serde_json::to_value(parsed.unwrap()).unwrap(), name);
        }
    }

    #[test]
    fn the_target_size_is_clamped_on_the_way_in() {
        assert_eq!(
            from_json_str(r#"{"defaultTargetMb": 0.001}"#).default_target_mb,
            MIN_TARGET_MB
        );
        assert_eq!(
            from_json_str(r#"{"defaultTargetMb": 1e9}"#).default_target_mb,
            MAX_TARGET_MB
        );
        assert_eq!(
            from_json_str(r#"{"defaultTargetMb": -4}"#).default_target_mb,
            MIN_TARGET_MB
        );
    }

    #[test]
    fn the_target_size_is_clamped_on_the_way_out_too() {
        let settings = AppSettings {
            default_target_mb: 99_999.0,
            ..AppSettings::default()
        };
        assert_eq!(sanitise(settings).default_target_mb, MAX_TARGET_MB);
    }

    #[test]
    fn the_channel_strings_are_the_ones_the_frontend_sends() {
        assert_eq!(UpdateChannel::parse("stable"), Some(UpdateChannel::Stable));
        assert_eq!(
            UpdateChannel::parse("prerelease"),
            Some(UpdateChannel::Prerelease)
        );
        assert_eq!(UpdateChannel::parse("Stable"), None);
        assert_eq!(UpdateChannel::parse("alpha"), None);
    }
}
