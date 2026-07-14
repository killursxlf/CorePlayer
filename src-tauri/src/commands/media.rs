use crate::media::{
    errors::{AppError, MediaError},
    ffmpeg, ffprobe,
    models::{
        AudioWaveformRequest, AudioWaveformResult, MediaProbe, ThumbnailRequest, ThumbnailResult,
        TimelineThumbnail,
    },
};

#[tauri::command]
pub fn probe_media(input_path: String) -> Result<MediaProbe, AppError> {
    ffprobe::probe_media(&input_path).map_err(AppError::from)
}

#[tauri::command]
pub fn create_video_cache_id(input_path: String) -> Result<String, AppError> {
    ffmpeg::create_video_cache_id(&input_path).map_err(AppError::from)
}

#[tauri::command]
pub async fn generate_timeline_thumbnails(
    input_path: String,
    duration: f64,
    max_frames: usize,
) -> Result<Vec<TimelineThumbnail>, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        ffmpeg::generate_timeline_thumbnails(input_path, duration, max_frames)
    })
    .await
    .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn generate_timeline_thumbnail_range(
    request: ThumbnailRequest,
) -> Result<ThumbnailResult, AppError> {
    let cache_root = std::env::temp_dir().join("video-editor-cache");

    tauri::async_runtime::spawn_blocking(move || {
        ffmpeg::generate_timeline_thumbnail_range(request, cache_root)
    })
    .await
    .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
    .map_err(AppError::from)
}

#[tauri::command]
pub async fn generate_audio_waveform(
    request: AudioWaveformRequest,
) -> Result<AudioWaveformResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || ffmpeg::generate_audio_waveform(request))
        .await
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
        .map_err(AppError::from)
}
