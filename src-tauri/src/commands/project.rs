use std::{fs, path::PathBuf};

use crate::media::errors::{AppError, MediaError};

#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, AppError> {
    tauri::async_runtime::spawn_blocking(move || fs::read_to_string(PathBuf::from(path)))
        .await
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
        .map_err(MediaError::from)
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || fs::write(PathBuf::from(path), contents))
        .await
        .map_err(|error| AppError::from(MediaError::Io(error.to_string())))?
        .map_err(MediaError::from)
        .map_err(AppError::from)
}
