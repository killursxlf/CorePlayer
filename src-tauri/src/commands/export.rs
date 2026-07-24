use tauri::{AppHandle, State};

use crate::media::{
    errors::AppError,
    ffmpeg::{BackgroundMediaBackend, FfmpegBackend},
    models::{ExportStarted, ExportTrimRequest},
};

#[tauri::command]
pub fn export_trim(
    app: AppHandle,
    backend: State<'_, FfmpegBackend>,
    resources: State<'_, BackgroundMediaBackend>,
    request: ExportTrimRequest,
) -> Result<ExportStarted, AppError> {
    resources.set_exporting(true);
    backend
        .export_trim(app, request, resources.inner().clone())
        .inspect_err(|_| resources.set_exporting(false))
        .map_err(AppError::from)
}

#[tauri::command]
pub fn cancel_export(
    backend: State<'_, FfmpegBackend>,
    operation_id: String,
) -> Result<(), AppError> {
    backend.cancel(operation_id).map_err(AppError::from)
}
