use tauri::{AppHandle, State};

use crate::media::{
    errors::{AppError, MediaError},
    ffmpeg::{BackgroundMediaBackend, FfmpegBackend},
    models::{ExportStarted, ExportTrimRequest},
};

#[tauri::command]
pub async fn export_trim(
    app: AppHandle,
    backend: State<'_, FfmpegBackend>,
    resources: State<'_, BackgroundMediaBackend>,
    request: ExportTrimRequest,
) -> Result<ExportStarted, AppError> {
    let backend = backend.inner().clone();
    let resources = resources.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.export_trim(app, request, resources))
        .await
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
        .map_err(AppError::from)
}

#[tauri::command]
pub fn cancel_export(
    backend: State<'_, FfmpegBackend>,
    operation_id: String,
) -> Result<(), AppError> {
    backend.cancel(operation_id).map_err(AppError::from)
}
