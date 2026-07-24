use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MediaError {
    #[error("Input file does not exist.")]
    InputMissing,
    #[error("Output path is empty.")]
    EmptyOutputPath,
    #[error("Output path must be different from the input file.")]
    SameInputOutput,
    #[error("Start time must be greater than or equal to zero.")]
    InvalidStartTime,
    #[error("End time must be greater than start time.")]
    InvalidEndTime,
    #[error("{binary} is not available. Checked: {checked:?}")]
    FfmpegUnavailable {
        binary: String,
        checked: Vec<String>,
    },
    #[error("Export is already running.")]
    ExportAlreadyRunning,
    #[error("Export operation was not found.")]
    OperationNotFound,
    #[error("I/O error: {0}")]
    Io(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    pub title: &'static str,
    pub message: &'static str,
    pub technical_details: Option<String>,
    pub recoverable: bool,
}

impl From<MediaError> for AppError {
    fn from(error: MediaError) -> Self {
        match error {
            MediaError::InputMissing => AppError {
                code: "INPUT_MISSING",
                title: "Input video was not found",
                message: "Choose an existing local video file and try again.",
                technical_details: None,
                recoverable: true,
            },
            MediaError::EmptyOutputPath => AppError {
                code: "OUTPUT_PATH_EMPTY",
                title: "Output path is missing",
                message: "Choose where the exported video should be saved.",
                technical_details: None,
                recoverable: true,
            },
            MediaError::SameInputOutput => AppError {
                code: "SAME_INPUT_OUTPUT",
                title: "Output would overwrite the original",
                message: "Choose a different output path. The original video is never modified.",
                technical_details: None,
                recoverable: true,
            },
            MediaError::InvalidStartTime => AppError {
                code: "INVALID_START_TIME",
                title: "Invalid trim start",
                message: "The trim start time must be greater than or equal to zero.",
                technical_details: None,
                recoverable: true,
            },
            MediaError::InvalidEndTime => AppError {
                code: "INVALID_END_TIME",
                title: "Invalid trim range",
                message: "The trim end time must be greater than the start time.",
                technical_details: None,
                recoverable: true,
            },
            MediaError::FfmpegUnavailable { binary, checked } => AppError {
                code: "FFMPEG_UNAVAILABLE",
                title: "FFmpeg was not found",
                message: "Install FFmpeg, add it to PATH, or set FFMPEG_PATH to ffmpeg.exe.",
                technical_details: Some(format!(
                    "{binary} was not found. Checked: {}",
                    checked.join("; ")
                )),
                recoverable: true,
            },
            MediaError::ExportAlreadyRunning => AppError {
                code: "EXPORT_ALREADY_RUNNING",
                title: "Export already running",
                message:
                    "Wait for the current export to finish or cancel it before starting another.",
                technical_details: None,
                recoverable: true,
            },
            MediaError::OperationNotFound => AppError {
                code: "OPERATION_NOT_FOUND",
                title: "Export operation was not found",
                message: "The export may have already finished or been cancelled.",
                technical_details: None,
                recoverable: true,
            },
            MediaError::Io(details) => AppError {
                code: "IO_ERROR",
                title: "File operation failed",
                message: "The file operation could not be completed.",
                technical_details: Some(details),
                recoverable: true,
            },
        }
    }
}

impl From<std::io::Error> for MediaError {
    fn from(error: std::io::Error) -> Self {
        MediaError::Io(error.to_string())
    }
}
