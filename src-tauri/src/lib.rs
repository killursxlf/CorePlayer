mod commands;
mod media;

use media::ffmpeg::FfmpegBackend;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(FfmpegBackend::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::export::export_trim,
            commands::export::cancel_export,
            commands::media::probe_media,
            commands::media::create_video_cache_id,
            commands::media::generate_timeline_thumbnails,
            commands::media::generate_timeline_thumbnail_range,
            commands::media::generate_audio_waveform,
            commands::project::read_text_file,
            commands::project::write_text_file,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
