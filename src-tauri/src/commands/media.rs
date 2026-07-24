use crate::media::{
    errors::{AppError, MediaError},
    ffmpeg, ffprobe,
    models::{
        AudioWaveformRequest, AudioWaveformResult, MediaProbe, ThumbnailRequest, ThumbnailResult,
    },
};
use tauri::State;
use crate::media::http_server::{MediaHttpServer, PlaybackRegistration};

#[tauri::command]
pub fn probe_media(input_path: String) -> Result<MediaProbe, AppError> {
    ffprobe::probe_media(&input_path).map_err(AppError::from)
}

#[tauri::command]
pub fn create_video_cache_id(input_path: String) -> Result<String, AppError> {
    ffmpeg::create_video_cache_id(&input_path).map_err(AppError::from)
}

#[tauri::command]
pub fn register_playback_media(
    server: State<'_, MediaHttpServer>,
    input_path: String,
) -> Result<PlaybackRegistration, AppError> {
    server.register(&input_path).map_err(|error| AppError::from(MediaError::Io(error.to_string())))
}

#[tauri::command]
pub fn unregister_playback_media(server: State<'_, MediaHttpServer>, playback_url: String) {
    server.unregister_url(&playback_url);
}

#[tauri::command]
pub fn get_playback_registration_count(server: State<'_, MediaHttpServer>) -> usize {
    server.registration_count()
}

#[tauri::command]
pub async fn generate_timeline_thumbnail_range(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
    request: ThumbnailRequest,
) -> Result<ThumbnailResult, AppError> {
    let cache_root = std::env::temp_dir().join("video-editor-cache");
    let backend = backend.inner().clone();
    let token = backend.token();

    tauri::async_runtime::spawn_blocking(move || {
        ffmpeg::generate_timeline_thumbnail_range(request, cache_root, &backend, token)
    })
    .await
    .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn generate_audio_waveform(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
    request: AudioWaveformRequest,
) -> Result<AudioWaveformResult, AppError> {
    let backend = backend.inner().clone();
    let token = backend.token();
    tauri::async_runtime::spawn_blocking(move || ffmpeg::generate_audio_waveform(request, &backend, token))
        .await
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
        .map_err(AppError::from)
}

#[tauri::command]
pub fn cancel_background_media(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
) {
    backend.cancel_all();
}

#[tauri::command]
pub fn set_media_playback_state(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
    playing: bool,
) {
    backend.set_playing(playing);
}

#[tauri::command]
pub fn get_hardware_profile(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
) -> ffmpeg::HardwareProfile {
    backend.hardware_profile()
}

#[tauri::command]
pub fn get_runtime_performance_config(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
) -> ffmpeg::RuntimePerformanceConfig {
    backend.runtime_config()
}

#[tauri::command]
pub fn set_performance_preset(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
    preset: ffmpeg::PerformancePreset,
) -> Result<(), AppError> {
    backend.set_preset(preset).map_err(AppError::from)
}

#[tauri::command]
pub fn update_runtime_metrics(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
    metrics: ffmpeg::RuntimeMetrics,
) -> Result<ffmpeg::RuntimePerformanceConfig, AppError> {
    backend.update_metrics(metrics).map_err(AppError::from)?;
    Ok(backend.runtime_config())
}

#[tauri::command]
pub fn get_media_task_budget(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
    kind: ffmpeg::MediaTaskKind,
) -> ffmpeg::TaskBudget {
    backend.budget(kind)
}
