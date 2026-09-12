use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTrimRequest {
    #[serde(default)]
    pub timeline: bool,
    #[serde(default)]
    pub operation_id: Option<String>,
    pub input_path: String,
    pub output_path: String,
    pub clips: Vec<ExportClip>,
    #[serde(default)]
    pub annotations: Vec<ExportAnnotation>,
    pub settings: ExportSettings,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    #[serde(default)]
    pub source_start: Option<f64>,
    pub id: String,
    pub label: String,
    pub start_time: f64,
    pub end_time: f64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportAnnotation {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: ExportAnnotationType,
    pub label: String,
    pub color: String,
    pub opacity: f64,
    pub thickness: f64,
    pub font: String,
    pub visible: bool,
    pub start_time: f64,
    pub end_time: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub line_start_x: Option<f64>,
    pub line_start_y: Option<f64>,
    pub line_end_x: Option<f64>,
    pub line_end_y: Option<f64>,
    pub path_points: Option<Vec<ExportPoint>>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ExportAnnotationType {
    Arrow,
    Rectangle,
    Circle,
    Text,
    Blur,
    Highlight,
    Pen,
    Brush,
    Crop,
    Measure,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ExportPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum ExportMode {
    StreamCopy,
    Encode,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub format: ExportFormat,
    pub mode: ExportMode,
    pub video_codec: VideoCodec,
    pub audio_codec: AudioCodec,
    pub video_bitrate_kbps: Option<u32>,
    pub audio_bitrate_kbps: Option<u32>,
    pub fps: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub crf: Option<u8>,
    pub preset: String,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum ExportFormat {
    Mp4,
    Mov,
    Mkv,
    Webm,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VideoCodec {
    Copy,
    H264,
    H265,
    Av1,
    Vp9,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AudioCodec {
    Copy,
    Aac,
    Opus,
    Mp3,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportStarted {
    pub operation_id: String,
    pub output_path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgressEvent {
    pub operation_id: String,
    pub progress: f64,
    pub status: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub duration: f64,
    pub codec: Option<String>,
    pub resolution: Option<String>,
    pub fps: Option<f64>,
    pub time_base: Option<String>,
    pub rotation: Option<i64>,
    pub has_audio: Option<bool>,
    pub has_video: Option<bool>,
    pub variable_fps: Option<bool>,
    pub bitrate: Option<String>,
    pub audio_streams: Option<String>,
    pub subtitles: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioWaveformRequest {
    pub video_id: String,
    pub file_path: String,
    pub start_time: f64,
    pub end_time: f64,
    pub peak_count: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AudioWaveformResult {
    pub video_id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub peaks: Vec<f32>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRequest {
    pub video_id: String,
    pub file_path: String,
    pub start_time: f64,
    pub end_time: f64,
    pub interval_seconds: f64,
    pub thumbnail_width: u32,
    pub thumbnail_height: u32,
    pub generation: u64,
    pub priority: ThumbnailPriority,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ThumbnailPriority {
    Visible,
    Near,
    Prefetch,
}

#[allow(dead_code)]
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "kebab-case")]
pub enum ThumbnailState {
    Queued,
    Loading,
    Ready,
    Error,
    Missing,
    CacheCorrupt,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailItem {
    pub time: f64,
    pub path: String,
    pub state: ThumbnailState,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailResult {
    pub video_id: String,
    pub generation: u64,
    pub interval_seconds: f64,
    pub cache_dir: String,
    pub thumbnails: Vec<ThumbnailItem>,
}
