#![allow(linker_messages)]

mod commands;
mod media;

use media::ffmpeg::FfmpegBackend;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    let settings_path = std::env::var_os("APPDATA").map(std::path::PathBuf::from)
        .map(|root| root.join(&context.config().identifier).join("acceleration.json"));
    let mut resources = media::ffmpeg::BackgroundMediaBackend::default();
    resources.acceleration = media::acceleration::Acceleration::load(settings_path);
    if resources.acceleration.status().playback_cpu {
        for window in &mut context.config_mut().app.windows {
            let args = window.additional_browser_args.get_or_insert_with(|| "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection".into());
            args.push_str(" --disable-accelerated-video-decode");
        }
    }
    let media_server = media::http_server::MediaHttpServer::start()
        .expect("failed to start loopback media server");
    tauri::Builder::default()
        .manage(FfmpegBackend::default())
        .manage(resources)
        .manage(std::sync::Arc::new(
            media::frame_index::FrameIndex::default(),
        ))
        .manage(media_server)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::export::export_trim,
            commands::export::cancel_export,
            commands::media::probe_media,
            commands::media::get_frame_step,
            commands::media::cancel_frame_steps,
            commands::media::create_video_cache_id,
            commands::media::register_playback_media,
            commands::media::unregister_playback_media,
            commands::media::get_playback_registration_count,
            commands::media::generate_timeline_thumbnail_range,
            commands::media::generate_audio_waveform,
            commands::media::cancel_timeline_thumbnails,
            commands::media::generate_playback_proxy,
            commands::media::cancel_background_media,
            commands::media::set_media_playback_state,
            commands::media::get_hardware_profile,
            commands::media::detect_accelerators,
            commands::media::set_acceleration_settings,
            commands::media::get_runtime_performance_config,
            commands::media::set_performance_preset,
            commands::media::update_runtime_metrics,
            commands::media::get_media_task_budget,
            commands::project::read_text_file,
            commands::project::write_text_file,
        ])
        .setup(|app| {
            #[cfg(windows)] {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    media::acceleration::observe_playback(&window, app.state::<media::ffmpeg::BackgroundMediaBackend>().acceleration.clone());
                }
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}
