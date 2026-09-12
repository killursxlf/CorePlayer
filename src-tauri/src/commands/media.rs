use crate::media::http_server::{MediaHttpServer, PlaybackRegistration};
use crate::media::{
    errors::{AppError, MediaError},
    ffmpeg, ffprobe,
    models::{
        AudioWaveformRequest, AudioWaveformResult, MediaProbe, ThumbnailRequest, ThumbnailResult,
    },
};
use tauri::State;

#[tauri::command]
pub async fn detect_accelerators(backend: State<'_, ffmpeg::BackgroundMediaBackend>) -> Result<crate::media::acceleration::Status, AppError> {
    let backend = backend.inner().clone();
    if backend.runtime_config().playback_active {
        return Ok(backend.acceleration.status());
    }
    tauri::async_runtime::spawn_blocking(move || backend.acceleration.discover()).await
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))
}

#[tauri::command]
pub fn set_acceleration_settings(backend: State<'_, ffmpeg::BackgroundMediaBackend>, settings: crate::media::acceleration::Settings) -> Result<(), AppError> {
    backend.acceleration.settings(settings).map_err(|error| AppError::from(MediaError::Io(error)))?;
    backend.cancel_all();
    backend.cancel_proxy();
    Ok(())
}

#[tauri::command]
pub async fn get_frame_step(
    input_path: String,
    time: f64,
    direction: i8,
    index: State<'_, std::sync::Arc<crate::media::frame_index::FrameIndex>>,
) -> Result<crate::media::frame_index::FrameStep, AppError> {
    let index = index.inner().clone();
    let token = index.token();
    tauri::async_runtime::spawn_blocking(move || index.step(&input_path, time, direction, token))
        .await
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
        .map_err(AppError::from)
}

#[tauri::command]
pub fn cancel_frame_steps(index: State<'_, std::sync::Arc<crate::media::frame_index::FrameIndex>>) {
    index.cancel();
}

#[tauri::command]
pub async fn probe_media(input_path: String) -> Result<MediaProbe, AppError> {
    tauri::async_runtime::spawn_blocking(move || ffprobe::probe_media(&input_path))
        .await
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
        .map_err(AppError::from)
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
    server
        .register(&input_path)
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))
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
    cache_only: Option<bool>,
) -> Result<AudioWaveformResult, AppError> {
    let backend = backend.inner().clone();
    let token = backend.waveform_token();
    tauri::async_runtime::spawn_blocking(move || {
        ffmpeg::generate_audio_waveform_cached(
            request,
            &backend,
            token,
            cache_only.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn generate_playback_proxy(
    input_path: String,
    video_id: String,
    force_cpu: Option<bool>,
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
) -> Result<String, AppError> {
    let backend = backend.inner().clone();
    let token = backend.proxy_token();
    tauri::async_runtime::spawn_blocking(move || {
        if force_cpu.unwrap_or(false) {
            ffmpeg::generate_playback_proxy_with_options(&input_path, &video_id, &backend, token, true)
        } else { ffmpeg::generate_playback_proxy(&input_path, &video_id, &backend, token) }
    })
    .await
    .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
    .map_err(AppError::from)
}

#[tauri::command]
pub fn cancel_timeline_thumbnails(backend: State<'_, ffmpeg::BackgroundMediaBackend>) {
    backend.cancel_thumbnails();
}

#[tauri::command]
pub fn cancel_background_media(
    backend: State<'_, ffmpeg::BackgroundMediaBackend>,
    include_proxy: Option<bool>,
) {
    backend.cancel_all();
    if include_proxy.unwrap_or(false) {
        backend.cancel_proxy();
    }
}

#[tauri::command]
pub fn set_media_playback_state(backend: State<'_, ffmpeg::BackgroundMediaBackend>, playing: bool) {
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
    ui_long_task_ratio: Option<f64>,
) -> Result<ffmpeg::RuntimePerformanceConfig, AppError> {
    backend.update_ui_load(ui_long_task_ratio);
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
