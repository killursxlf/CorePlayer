use tauri::{AppHandle, State};

use crate::media::{
    errors::AppError,
    ffmpeg::FfmpegBackend,
    models::{ExportStarted, ExportTrimRequest},
};

#[tauri::command]
pub fn export_trim(
    app: AppHandle,
    backend: State<'_, FfmpegBackend>,
    request: ExportTrimRequest,
) -> Result<ExportStarted, AppError> {
    backend.export_trim(app, request).map_err(AppError::from)
}

#[tauri::command]
pub fn cancel_export(
    backend: State<'_, FfmpegBackend>,
    operation_id: String,
) -> Result<(), AppError> {
    backend.cancel(operation_id).map_err(AppError::from)
}
