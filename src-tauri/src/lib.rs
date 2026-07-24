#![allow(linker_messages)]

mod commands;
mod media;

use media::ffmpeg::FfmpegBackend;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let media_server = media::http_server::MediaHttpServer::start()
        .expect("failed to start loopback media server");
    tauri::Builder::default()
        .manage(FfmpegBackend::default())
        .manage(media::ffmpeg::BackgroundMediaBackend::default())
        .manage(media_server)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::export::export_trim,
            commands::export::cancel_export,
            commands::media::probe_media,
            commands::media::create_video_cache_id,
            commands::media::register_playback_media,
            commands::media::unregister_playback_media,
            commands::media::get_playback_registration_count,
            commands::media::generate_timeline_thumbnail_range,
            commands::media::generate_audio_waveform,
            commands::media::cancel_background_media,
            commands::media::set_media_playback_state,
            commands::media::get_hardware_profile,
            commands::media::get_runtime_performance_config,
            commands::media::set_performance_preset,
            commands::media::update_runtime_metrics,
            commands::media::get_media_task_budget,
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
