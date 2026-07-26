use std::{
    collections::{HashMap, HashSet},
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter};
use serde::{Deserialize, Serialize};

use crate::media::{
    binaries::{ffmpeg_path, media_command},
    errors::MediaError,
    models::{
        AudioCodec, AudioWaveformRequest, AudioWaveformResult, ExportAnnotation,
        ExportAnnotationType, ExportClip, ExportFormat, ExportMode, ExportPoint,
        ExportProgressEvent, ExportSettings, ExportStarted, ExportTrimRequest, ThumbnailItem,
        ThumbnailPriority, ThumbnailRequest, ThumbnailResult, ThumbnailState, VideoCodec,
    },
};

const ASS_PLAY_RES_X: f64 = 1920.0;
const ASS_PLAY_RES_Y: f64 = 1080.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PerformancePreset {
    Auto,
    PowerSaver,
    Balanced,
    Performance,
    Custom,
}

impl Default for PerformancePreset {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PressureLevel {
    Normal,
    Elevated,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaTaskKind {
    VisibleThumbnail,
    NearThumbnail,
    ThumbnailPrefetch,
    VisibleWaveform,
    FullWaveform,
    Proxy,
    Export,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub logical_cpus: usize,
    pub power_class: String,
    pub operating_system: String,
    pub storage_class: String,
    pub total_ram_bytes: Option<u64>,
    pub available_ram_bytes: Option<u64>,
    pub on_battery: Option<bool>,
    pub hardware_decode_available: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBudget {
    pub allowed: bool,
    pub cpu_threads: usize,
    pub filter_threads: usize,
    pub max_parallel_jobs: usize,
    pub batch_size: usize,
    pub max_chunk_seconds: f64,
    pub prefetch_allowed: bool,
    pub delay_ms: u64,
    pub ram_cache_bytes: usize,
    pub decode_concurrency: usize,
    pub cancel_low_priority: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePerformanceConfig {
    pub hardware: HardwareProfile,
    pub preset: PerformancePreset,
    pub pressure: PressureLevel,
    pub playback_active: bool,
    pub export_active: bool,
    pub dropped_frame_ratio: f64,
    pub cpu_load: Option<f64>,
    pub active_background_tasks: usize,
    pub thumbnail_budget: TaskBudget,
    pub waveform_budget: TaskBudget,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetrics {
    pub dropped_frame_ratio: f64,
    pub user_active: bool,
    pub window_visible: bool,
    #[serde(default)]
    pub hardware_decode_available: Option<bool>,
}

#[derive(Debug)]
struct PressureState {
    level: PressureLevel,
    stable_samples: u8,
    dropped_frame_ratio: f64,
}

impl Default for PressureState {
    fn default() -> Self {
        Self {
            level: PressureLevel::Normal,
            stable_samples: 0,
            dropped_frame_ratio: 0.0,
        }
    }
}

#[derive(Clone, Default)]
pub struct BackgroundMediaBackend {
    epoch: Arc<AtomicU64>,
    decoder_lock: Arc<Mutex<()>>,
    playing: Arc<AtomicBool>,
    exporting: Arc<AtomicBool>,
    active_tasks: Arc<AtomicU64>,
    preset: Arc<Mutex<PerformancePreset>>,
    pressure: Arc<Mutex<PressureState>>,
    cpu_sample: Arc<Mutex<Option<(u64, u64, u64)>>>,
    cpu_load: Arc<Mutex<Option<f64>>>,
    hardware_decode_available: Arc<Mutex<Option<bool>>>,
}

impl BackgroundMediaBackend {
    pub fn token(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
    }

    pub fn cancel_all(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub fn set_playing(&self, playing: bool) {
        self.playing.store(playing, Ordering::SeqCst);
        if playing {
            self.cancel_all();
        }
    }

    pub fn set_exporting(&self, exporting: bool) {
        self.exporting.store(exporting, Ordering::SeqCst);
        if exporting {
            self.cancel_all();
        }
    }

    pub fn set_preset(&self, preset: PerformancePreset) -> Result<(), MediaError> {
        *self
            .preset
            .lock()
            .map_err(|_| MediaError::Io("Performance preset lock is poisoned.".to_string()))? = preset;
        Ok(())
    }

    pub fn update_metrics(&self, metrics: RuntimeMetrics) -> Result<(), MediaError> {
        if let Some(available) = metrics.hardware_decode_available {
            if let Ok(mut stored) = self.hardware_decode_available.lock() {
                *stored = Some(available);
            }
        }
        let cpu_load = sample_cpu_load(&self.cpu_sample);
        if let Ok(mut stored) = self.cpu_load.lock() {
            *stored = cpu_load;
        }
        let available_ram = memory_status().map(|(_, available)| available);
        let mut state = self
            .pressure
            .lock()
            .map_err(|_| MediaError::Io("Pressure state lock is poisoned.".to_string()))?;
        let ratio = metrics.dropped_frame_ratio.clamp(0.0, 1.0);
        state.dropped_frame_ratio = ratio;
        let playback = self.playing.load(Ordering::Relaxed);
        let target = if playback && ratio >= 0.08
            || cpu_load.is_some_and(|load| load >= 0.95)
            || available_ram.is_some_and(|bytes| bytes < 512 * 1024 * 1024)
        {
            PressureLevel::Critical
        } else if playback && ratio >= 0.03
            || cpu_load.is_some_and(|load| load >= 0.80)
            || available_ram.is_some_and(|bytes| bytes < 1024 * 1024 * 1024)
        {
            PressureLevel::High
        } else if ratio >= 0.01 || metrics.user_active {
            PressureLevel::Elevated
        } else {
            PressureLevel::Normal
        };
        if pressure_rank(target) > pressure_rank(state.level) {
            state.level = target;
            state.stable_samples = 0;
            if matches!(target, PressureLevel::High | PressureLevel::Critical) {
                self.cancel_all();
            }
        } else if pressure_rank(target) < pressure_rank(state.level) {
            state.stable_samples = state.stable_samples.saturating_add(1);
            if state.stable_samples >= 5 {
                state.level = pressure_step_down(state.level);
                state.stable_samples = 0;
            }
        } else {
            state.stable_samples = 0;
        }
        let _ = metrics.window_visible;
        Ok(())
    }

    pub fn hardware_profile(&self) -> HardwareProfile {
        let logical_cpus = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1);
        let memory = memory_status();
        HardwareProfile {
            logical_cpus,
            power_class: if logical_cpus <= 4 {
                "low".to_string()
            } else if logical_cpus <= 12 {
                "medium".to_string()
            } else {
                "high".to_string()
            },
            operating_system: std::env::consts::OS.to_string(),
            storage_class: "conservative-unknown".to_string(),
            total_ram_bytes: memory.map(|(total, _)| total),
            available_ram_bytes: memory.map(|(_, available)| available),
            on_battery: None,
            hardware_decode_available: self
                .hardware_decode_available
                .lock()
                .ok()
                .and_then(|available| *available),
        }
    }

    pub fn budget(&self, kind: MediaTaskKind) -> TaskBudget {
        let playback = self.playing.load(Ordering::Relaxed);
        let exporting = self.exporting.load(Ordering::Relaxed);
        let preset = self.preset.lock().map(|value| *value).unwrap_or_default();
        let pressure = self
            .pressure
            .lock()
            .map(|value| value.level)
            .unwrap_or(PressureLevel::High);
        let hardware = self.hardware_profile();
        let mut budget =
            calculate_budget(kind, preset, pressure, playback, exporting, hardware.logical_cpus);
        if let Some(available) = hardware.available_ram_bytes {
            if available < 1024 * 1024 * 1024 {
                budget.ram_cache_bytes = 32 * 1024 * 1024;
                budget.decode_concurrency = 1;
            } else if available < 3 * 1024 * 1024 * 1024 {
                budget.ram_cache_bytes = budget.ram_cache_bytes.min(64 * 1024 * 1024);
                budget.decode_concurrency = budget.decode_concurrency.min(1);
            }
        }
        budget
    }

    pub fn runtime_config(&self) -> RuntimePerformanceConfig {
        // Release the pressure lock before budget() reacquires it.
        let (pressure, dropped_frame_ratio) = self
            .pressure
            .lock()
            .map(|value| (value.level, value.dropped_frame_ratio))
            .unwrap_or((PressureLevel::High, 0.0));
        RuntimePerformanceConfig {
            hardware: self.hardware_profile(),
            preset: self.preset.lock().map(|value| *value).unwrap_or_default(),
            pressure,
            playback_active: self.playing.load(Ordering::Relaxed),
            export_active: self.exporting.load(Ordering::Relaxed),
            dropped_frame_ratio,
            cpu_load: self.cpu_load.lock().ok().and_then(|value| *value),
            active_background_tasks: self.active_tasks.load(Ordering::Relaxed) as usize,
            thumbnail_budget: self.budget(MediaTaskKind::VisibleThumbnail),
            waveform_budget: self.budget(MediaTaskKind::VisibleWaveform),
        }
    }

    fn is_current(&self, token: u64) -> bool {
        self.epoch.load(Ordering::Relaxed) == token
    }

    fn thumbnail_threads(&self) -> usize {
        self.budget(MediaTaskKind::VisibleThumbnail).cpu_threads
    }
}

fn pressure_rank(level: PressureLevel) -> u8 {
    match level {
        PressureLevel::Normal => 0,
        PressureLevel::Elevated => 1,
        PressureLevel::High => 2,
        PressureLevel::Critical => 3,
    }
}

fn pressure_step_down(level: PressureLevel) -> PressureLevel {
    match level {
        PressureLevel::Critical => PressureLevel::High,
        PressureLevel::High => PressureLevel::Elevated,
        PressureLevel::Elevated | PressureLevel::Normal => PressureLevel::Normal,
    }
}

#[cfg(windows)]
fn memory_status() -> Option<(u64, u64)> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // Windows fills the fixed-layout structure and does not retain its pointer.
    let succeeded = unsafe { GlobalMemoryStatusEx(&mut status) } != 0;
    succeeded.then_some((status.total_phys, status.avail_phys))
}

#[cfg(not(windows))]
fn memory_status() -> Option<(u64, u64)> {
    None
}

#[cfg(windows)]
fn sample_cpu_load(sample: &Mutex<Option<(u64, u64, u64)>>) -> Option<f64> {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    }
    fn value(time: &FileTime) -> u64 {
        ((time.high as u64) << 32) | time.low as u64
    }
    let mut idle = FileTime { low: 0, high: 0 };
    let mut kernel = FileTime { low: 0, high: 0 };
    let mut user = FileTime { low: 0, high: 0 };
    // GetSystemTimes writes three FILETIME values synchronously.
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return None;
    }
    let current = (value(&idle), value(&kernel), value(&user));
    let mut previous = sample.lock().ok()?;
    let result = previous.and_then(|last| {
        let idle_delta = current.0.saturating_sub(last.0);
        let total_delta = current.1.saturating_sub(last.1) + current.2.saturating_sub(last.2);
        (total_delta > 0).then_some(
            (1.0 - idle_delta as f64 / total_delta as f64).clamp(0.0, 1.0),
        )
    });
    *previous = Some(current);
    result
}

#[cfg(not(windows))]
fn sample_cpu_load(_sample: &Mutex<Option<(u64, u64, u64)>>) -> Option<f64> {
    None
}

fn calculate_budget(
    kind: MediaTaskKind,
    preset: PerformancePreset,
    pressure: PressureLevel,
    playback: bool,
    exporting: bool,
    logical_cpus: usize,
) -> TaskBudget {
    let system_class_threads = if logical_cpus <= 4 { 1 } else if logical_cpus <= 12 { 2 } else { 3 };
    let preset_threads = match preset {
        PerformancePreset::PowerSaver => 1,
        PerformancePreset::Performance => 3,
        PerformancePreset::Auto | PerformancePreset::Balanced | PerformancePreset::Custom => 2,
    };
    let mut cpu_threads = system_class_threads.min(preset_threads).clamp(1, 3);
    let mut batch_size = match preset {
        PerformancePreset::PowerSaver => 2,
        PerformancePreset::Performance => 8,
        _ => 6,
    };
    let mut decode_concurrency = match preset {
        PerformancePreset::PowerSaver => 1,
        PerformancePreset::Performance => 3,
        _ => 2,
    };
    let mut ram_cache_bytes = match preset {
        PerformancePreset::PowerSaver => 48 * 1024 * 1024,
        PerformancePreset::Performance => 192 * 1024 * 1024,
        _ => 128 * 1024 * 1024,
    };
    if matches!(kind, MediaTaskKind::Export) {
        let export_cap = match preset {
            PerformancePreset::PowerSaver => 2,
            PerformancePreset::Performance => 8,
            _ => 6,
        };
        cpu_threads = logical_cpus.saturating_sub(2).clamp(1, export_cap);
        if playback {
            cpu_threads = cpu_threads.min(2);
        }
    }
    let low_priority = matches!(
        kind,
        MediaTaskKind::NearThumbnail
            | MediaTaskKind::ThumbnailPrefetch
            | MediaTaskKind::FullWaveform
            | MediaTaskKind::Proxy
    );
    let mut allowed = true;
    let mut reason = "granted".to_string();
    if exporting && !matches!(kind, MediaTaskKind::Export | MediaTaskKind::VisibleThumbnail) {
        allowed = false;
        reason = "export-active".to_string();
    }
    if playback {
        cpu_threads = 1;
        batch_size = batch_size.min(3);
        decode_concurrency = 1;
        if low_priority || matches!(kind, MediaTaskKind::VisibleWaveform) {
            allowed = false;
            reason = "playback-priority".to_string();
        }
    }
    if matches!(pressure, PressureLevel::High | PressureLevel::Critical) {
        cpu_threads = 1;
        batch_size = 1;
        decode_concurrency = 1;
        ram_cache_bytes = ram_cache_bytes.min(48 * 1024 * 1024);
        if low_priority || matches!(kind, MediaTaskKind::VisibleWaveform) {
            allowed = false;
            reason = "runtime-pressure".to_string();
        }
    } else if pressure == PressureLevel::Elevated {
        cpu_threads = cpu_threads.min(1);
        batch_size = batch_size.min(3);
        decode_concurrency = decode_concurrency.min(1);
    }
    TaskBudget {
        allowed,
        cpu_threads,
        filter_threads: 1,
        max_parallel_jobs: 1,
        batch_size,
        max_chunk_seconds: if matches!(
            kind,
            MediaTaskKind::VisibleWaveform | MediaTaskKind::FullWaveform
        ) {
            if playback { 0.0 } else { 300.0 }
        } else if playback {
            4.0
        } else {
            12.0
        },
        prefetch_allowed: !playback
            && !exporting
            && pressure == PressureLevel::Normal
            && preset != PerformancePreset::PowerSaver,
        delay_ms: if playback { 120 } else if pressure == PressureLevel::Elevated { 80 } else { 20 },
        ram_cache_bytes,
        decode_concurrency,
        cancel_low_priority: matches!(pressure, PressureLevel::High | PressureLevel::Critical),
        reason,
    }
}

struct ActiveTaskGuard(Arc<AtomicU64>);

impl ActiveTaskGuard {
    fn new(counter: Arc<AtomicU64>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for ActiveTaskGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Default)]
pub struct FfmpegBackend {
    operations: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

impl FfmpegBackend {
    pub fn export_trim(
        &self,
        app: AppHandle,
        request: ExportTrimRequest,
        resources: BackgroundMediaBackend,
    ) -> Result<ExportStarted, MediaError> {
        validate_request(&request)?;

        let mut operations = self
            .operations
            .lock()
            .map_err(|_| MediaError::Io("Export state lock is poisoned.".to_string()))?;

        if !operations.is_empty() {
            return Err(MediaError::ExportAlreadyRunning);
        }

        let operation_id = create_operation_id();
        let output_path = request.output_path.clone();
        let outputs = output_paths_for_clips(
            &request.output_path,
            &request.clips,
            request.settings.format,
        );
        let total_duration = request
            .clips
            .iter()
            .map(|clip| clip.end_time - clip.start_time)
            .sum::<f64>()
            .max(0.001);

        let first_clip = request.clips[0].clone();
        let first_output = outputs[0].clone();
        let ffmpeg = ffmpeg_path()?;
        let export_threads = resources.budget(MediaTaskKind::Export).cpu_threads.max(1);
        let mut command = build_export_command(
            &ffmpeg,
            &request.input_path,
            &first_output,
            &first_clip,
            &request.settings,
            &request.annotations,
            export_threads,
        );

        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                MediaError::FfmpegUnavailable {
                    binary: "ffmpeg".to_string(),
                    checked: vec![ffmpeg.to_string_lossy().to_string()],
                }
            } else {
                MediaError::Io(error.to_string())
            }
        })?;

        let stderr = child.stderr.take().ok_or_else(|| {
            MediaError::Io("Could not capture FFmpeg progress output.".to_string())
        })?;

        let child_ref = Arc::new(Mutex::new(child));
        operations.insert(operation_id.clone(), child_ref.clone());
        drop(operations);

        let operations_ref = self.operations.clone();
        let cancelled_ref = self.cancelled.clone();
        let thread_operation_id = operation_id.clone();
        let input_path = request.input_path.clone();
        let clips = request.clips.clone();
        let settings = request.settings.clone();
        let annotations = request.annotations.clone();

        thread::spawn(move || {
            let mut last_details = String::new();
            let mut completed_duration = 0.0;
            let mut status = run_export_child(
                &app,
                &thread_operation_id,
                stderr,
                child_ref.clone(),
                first_clip.end_time - first_clip.start_time,
                completed_duration,
                total_duration,
                &first_clip.label,
                &mut last_details,
            );
            completed_duration += first_clip.end_time - first_clip.start_time;

            if status
                .as_ref()
                .map(|status| status.success())
                .unwrap_or(false)
            {
                for (clip, output) in clips.iter().zip(outputs.iter()).skip(1) {
                    let was_cancelled = cancelled_ref
                        .lock()
                        .map(|cancelled| cancelled.contains(&thread_operation_id))
                        .unwrap_or(false);
                    if was_cancelled {
                        break;
                    }

                    match spawn_export_child(
                        &ffmpeg,
                        &input_path,
                        output,
                        clip,
                        &settings,
                        &annotations,
                        export_threads,
                    ) {
                        Ok((next_child, next_stderr)) => {
                            if let Ok(mut guard) = child_ref.lock() {
                                *guard = next_child;
                            }
                            status = run_export_child(
                                &app,
                                &thread_operation_id,
                                next_stderr,
                                child_ref.clone(),
                                clip.end_time - clip.start_time,
                                completed_duration,
                                total_duration,
                                &clip.label,
                                &mut last_details,
                            );
                            completed_duration += clip.end_time - clip.start_time;

                            if !status
                                .as_ref()
                                .map(|status| status.success())
                                .unwrap_or(false)
                            {
                                break;
                            }
                        }
                        Err(error) => {
                            last_details = error.to_string();
                            status = None;
                            break;
                        }
                    }
                }
            }

            let was_cancelled = cancelled_ref
                .lock()
                .map(|mut cancelled| cancelled.remove(&thread_operation_id))
                .unwrap_or(false);

            let mut final_progress = if was_cancelled { 0.0 } else { 1.0 };
            let mut status_label = if was_cancelled {
                "cancelled".to_string()
            } else {
                "completed".to_string()
            };
            let mut message = if was_cancelled {
                "Cancelled".to_string()
            } else {
                "Completed".to_string()
            };

            if let Some(status) = status {
                if !status.success() && !was_cancelled {
                    final_progress = 0.0;
                    status_label = "failed".to_string();
                    message = if last_details.is_empty() {
                        "Export failed".to_string()
                    } else {
                        format!("Export failed: {last_details}")
                    };
                }
            } else {
                final_progress = 0.0;
                message = "Export failed".to_string();
            }

            let _ = app.emit(
                "export-progress",
                ExportProgressEvent {
                    operation_id: thread_operation_id.clone(),
                    progress: final_progress,
                    status: Some(status_label),
                    message: Some(message),
                },
            );

            if let Ok(mut operations) = operations_ref.lock() {
                operations.remove(&thread_operation_id);
            }
            resources.set_exporting(false);
        });

        Ok(ExportStarted {
            operation_id,
            output_path,
        })
    }

    pub fn cancel(&self, operation_id: String) -> Result<(), MediaError> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| MediaError::Io("Export state lock is poisoned.".to_string()))?;

        let child = operations
            .get(&operation_id)
            .ok_or(MediaError::OperationNotFound)?
            .clone();
        drop(operations);

        self.cancelled
            .lock()
            .map_err(|_| MediaError::Io("Export cancellation lock is poisoned.".to_string()))?
            .insert(operation_id);

        let result = child
            .lock()
            .map_err(|_| MediaError::Io("Export process lock is poisoned.".to_string()))?
            .kill()
            .map_err(MediaError::from);

        result
    }
}

pub fn generate_audio_waveform(
    request: AudioWaveformRequest,
    backend: &BackgroundMediaBackend,
    token: u64,
) -> Result<AudioWaveformResult, MediaError> {
    let budget = backend.budget(MediaTaskKind::VisibleWaveform);
    if !budget.allowed {
        return Err(MediaError::Io(format!("Waveform deferred: {}", budget.reason)));
    }
    let input_path = Path::new(&request.file_path);
    if !input_path.is_file() {
        return Err(MediaError::InputMissing);
    }

    let start_time = request.start_time.max(0.0);
    let duration = request.end_time - start_time;
    if duration <= 0.0 || !duration.is_finite() {
        return Ok(AudioWaveformResult {
            video_id: request.video_id,
            start_time,
            end_time: request.end_time,
            peaks: Vec::new(),
        });
    }

    let peak_count = request.peak_count.clamp(1, 20_000);
    // The UI stores one envelope value per 25 seconds. 100 Hz still gives
    // 2,500 source samples for each value without pushing high-rate PCM
    // through the resampler and pipe.
    let sample_rate = 100;
    let cache_path =
        audio_waveform_cache_path(&request.video_id, start_time, request.end_time, peak_count, sample_rate);
    if let Some(peaks) = read_cached_audio_peaks(&cache_path) {
        return Ok(AudioWaveformResult {
            video_id: request.video_id,
            start_time,
            end_time: request.end_time,
            peaks,
        });
    }
    let _decode_guard = backend
        .decoder_lock
        .lock()
        .map_err(|_| MediaError::Io("Background decoder lock is poisoned.".to_string()))?;
    let _active_task = ActiveTaskGuard::new(backend.active_tasks.clone());
    if !backend.is_current(token) {
        return Err(MediaError::Io("Background media task cancelled.".to_string()));
    }

    let ffmpeg = ffmpeg_path()?;
    let mut command = media_command(ffmpeg);
    command.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-v")
        .arg("error")
        .arg("-threads")
        .arg("1")
        .arg("-filter_threads")
        .arg("1")
        .arg("-ss")
        .arg(format_seconds(start_time))
        .arg("-i")
        .arg(&request.file_path)
        .arg("-map")
        .arg("0:a:0")
        .arg("-t")
        .arg(format_seconds(duration))
        .arg("-vn")
        .arg("-sn")
        .arg("-dn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg(sample_rate.to_string())
        .arg("-f")
        .arg("s16le")
        .arg("pipe:1");
    let (status, stderr, peaks) =
        run_waveform_stream(&mut command, backend, token, sample_rate, duration, peak_count)?;

    if !status.success() {
        let details = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(MediaError::Io(if details.is_empty() {
            "FFmpeg could not decode audio waveform.".to_string()
        } else {
            details
        }));
    }

    write_cached_audio_peaks(&cache_path, &peaks);

    Ok(AudioWaveformResult {
        video_id: request.video_id,
        start_time,
        end_time: request.end_time,
        peaks,
    })
}

fn run_waveform_stream(
    command: &mut Command,
    backend: &BackgroundMediaBackend,
    token: u64,
    sample_rate: u32,
    duration: f64,
    peak_count: usize,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<f32>), MediaError> {
    configure_background_priority(command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(MediaError::from)?;
    let mut stdout = child.stdout.take().ok_or_else(|| MediaError::Io("Missing FFmpeg stdout.".to_string()))?;
    let mut stderr = child.stderr.take().ok_or_else(|| MediaError::Io("Missing FFmpeg stderr.".to_string()))?;
    let samples_per_peak = ((sample_rate as f64
        * duration
        * ((peak_count.max(1) as f64).recip()))
        .max(1.0)) as usize;
    let stdout_reader = thread::spawn(move || {
        let mut peaks = Vec::with_capacity(peak_count);
        let mut buffer = [0_u8; 65_536];
        let mut leftover = None;
        let mut bucket_samples = 0_usize;
        let mut bucket_energy = 0_f64;
        loop {
            let read = match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let mut offset = 0;
            if let Some(low) = leftover.take() {
                let sample = i16::from_le_bytes([low, buffer[0]]) as i32;
                bucket_energy += (sample as f64) * (sample as f64);
                bucket_samples += 1;
                offset = 1;
            }
            while offset + 1 < read {
                let sample = i16::from_le_bytes([buffer[offset], buffer[offset + 1]]) as i32;
                bucket_energy += (sample as f64) * (sample as f64);
                bucket_samples += 1;
                offset += 2;
                if bucket_samples >= samples_per_peak {
                    let rms = (bucket_energy / bucket_samples as f64).sqrt() / 32_768.0;
                    peaks.push((rms as f32 * 3.0).clamp(0.0, 1.0));
                    bucket_samples = 0;
                    bucket_energy = 0.0;
                }
            }
            if offset < read {
                leftover = Some(buffer[offset]);
            }
        }
        if bucket_samples > 0 {
            let rms = (bucket_energy / bucket_samples as f64).sqrt() / 32_768.0;
            peaks.push((rms as f32 * 3.0).clamp(0.0, 1.0));
        }
        peaks.truncate(peak_count);
        peaks
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let status = loop {
        if !backend.is_current(token) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(MediaError::Io("Background media task cancelled.".to_string()));
        }
        if let Some(status) = child.try_wait().map_err(MediaError::from)? {
            break status;
        }
        thread::sleep(Duration::from_millis(25));
    };
    Ok((
        status,
        stderr_reader.join().unwrap_or_default(),
        stdout_reader.join().unwrap_or_default(),
    ))
}

pub fn generate_timeline_thumbnail_range(
    request: ThumbnailRequest,
    cache_root: PathBuf,
    backend: &BackgroundMediaBackend,
    token: u64,
) -> Result<ThumbnailResult, MediaError> {
    let task_kind = match request.priority {
        ThumbnailPriority::Visible => MediaTaskKind::VisibleThumbnail,
        ThumbnailPriority::Near => MediaTaskKind::NearThumbnail,
        ThumbnailPriority::Prefetch => MediaTaskKind::ThumbnailPrefetch,
    };
    let budget = backend.budget(task_kind);
    if !budget.allowed {
        return Err(MediaError::Io(format!("Thumbnail generation deferred: {}", budget.reason)));
    }
    let input_path = Path::new(&request.file_path);
    if !input_path.is_file() {
        return Err(MediaError::InputMissing);
    }

    if request.end_time <= request.start_time
        || request.interval_seconds <= 0.0
        || !request.interval_seconds.is_finite()
    {
        return Ok(ThumbnailResult {
            video_id: request.video_id,
            generation: request.generation,
            interval_seconds: request.interval_seconds,
            cache_dir: cache_root.to_string_lossy().to_string(),
            thumbnails: Vec::new(),
        });
    }
    let _decode_guard = backend
        .decoder_lock
        .lock()
        .map_err(|_| MediaError::Io("Background decoder lock is poisoned.".to_string()))?;
    let _active_task = ActiveTaskGuard::new(backend.active_tasks.clone());
    if !backend.is_current(token) {
        return Err(MediaError::Io("Background media task cancelled.".to_string()));
    }

    let interval = request.interval_seconds.max(0.001);
    let width = request.thumbnail_width.clamp(64, 320);
    let height = request.thumbnail_height.clamp(24, 180);
    let safe_video_id = sanitize_path_segment(&request.video_id);
    let cache_base = cache_root
        .join("thumbnail-cache")
        .join(safe_video_id)
        .join("v5");
    let cache_base = cache_base.join(format!("{width}x{height}"));
    fs::create_dir_all(&cache_base)?;

    let start = align_time(request.start_time, interval);
    let mut times = Vec::new();
    let mut time = start;
    let hard_limit = 1200usize;
    while time <= request.end_time + interval * 0.5 && times.len() < hard_limit {
        if time >= 0.0 {
            times.push(round_time(time));
        }
        time += interval;
    }

    let mut chunks: HashMap<u64, Vec<f64>> = HashMap::new();
    for time in &times {
        let chunk_id = (*time / 25.0).floor().max(0.0) as u64;
        chunks.entry(chunk_id).or_default().push(*time);
    }

    let mut items = Vec::new();
    for (chunk_id, chunk_times) in chunks {
        if !backend.is_current(token) {
            return Err(MediaError::Io("Background media task cancelled.".to_string()));
        }
        let chunk_dir = cache_base.join(format!("chunk-{chunk_id:08}"));
        fs::create_dir_all(&chunk_dir)?;

        let missing = chunk_times
            .iter()
            .filter(|time| !thumbnail_path(&chunk_dir, **time).is_file())
            .copied()
            .collect::<Vec<_>>();

        if !missing.is_empty() {
            if interval >= 2.0 {
                for time in missing {
                    if !backend.is_current(token) {
                        return Err(MediaError::Io("Background media task cancelled.".to_string()));
                    }
                    let _ = generate_single_thumbnail(
                        &request.file_path,
                        &chunk_dir,
                        time,
                        width,
                        height,
                        backend,
                        token,
                    );
                }
            } else {
                let chunk_start = chunk_times
                    .iter()
                    .copied()
                    .fold(f64::INFINITY, f64::min)
                    .max(0.0);
                let chunk_end = chunk_times.iter().copied().fold(0.0, f64::max) + interval;
                let _ = generate_thumbnail_chunk(
                    &request.file_path,
                    &chunk_dir,
                    chunk_start,
                    chunk_end,
                    interval,
                    width,
                    height,
                    backend,
                    token,
                );
            }
        }

        for time in chunk_times {
            let path = thumbnail_path(&chunk_dir, time);
            if path.is_file() {
                items.push(ThumbnailItem {
                    time,
                    path: path.to_string_lossy().to_string(),
                    state: ThumbnailState::Ready,
                    error: None,
                });
            } else {
                items.push(ThumbnailItem {
                    time,
                    path: path.to_string_lossy().to_string(),
                    state: ThumbnailState::Missing,
                    error: Some("Thumbnail is not available yet.".to_string()),
                });
            }
        }
    }

    items.sort_by(|a, b| a.time.total_cmp(&b.time));

    Ok(ThumbnailResult {
        video_id: request.video_id,
        generation: request.generation,
        interval_seconds: request.interval_seconds,
        cache_dir: cache_root
            .join("thumbnail-cache")
            .to_string_lossy()
            .to_string(),
        thumbnails: items,
    })
}

pub fn create_video_cache_id(input_path: &str) -> Result<String, MediaError> {
    let path = Path::new(input_path);
    let metadata = fs::metadata(path)?;
    let canonical_path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis())
        .unwrap_or(0);

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canonical_path.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

pub fn generate_playback_proxy(input_path: &str, video_id: &str) -> Result<String, MediaError> {
    let input = Path::new(input_path);
    if !input.is_file() {
        return Err(MediaError::InputMissing);
    }
    let proxy_dir = std::env::temp_dir()
        .join("video-editor-cache")
        .join("playback-proxy");
    fs::create_dir_all(&proxy_dir)?;
    let output = proxy_dir.join(format!("{}.mp4", sanitize_path_segment(video_id)));
    if output.metadata().is_ok_and(|metadata| metadata.len() > 1024) {
        return Ok(output.to_string_lossy().to_string());
    }

    let temporary = proxy_dir.join(format!(".{}.tmp.mp4", sanitize_path_segment(video_id)));
    let _ = fs::remove_file(&temporary);
    let ffmpeg = ffmpeg_path()?;
    let mut command = media_command(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-y")
        .arg("-i")
        .arg(input)
        .arg("-map")
        .arg("0:v:0")
        .arg("-map")
        .arg("0:a:0?")
        .arg("-vf")
        .arg("scale=w='trunc(min(1280,iw)/2)*2':h=-2:flags=fast_bilinear")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("veryfast")
        .arg("-crf")
        .arg("24")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-g")
        .arg("60")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("128k")
        .arg("-movflags")
        .arg("+faststart")
        .arg("-threads")
        .arg("2")
        .arg(&temporary)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    configure_background_priority(&mut command);
    let result = command.output().map_err(MediaError::from)?;
    if !result.status.success() || !temporary.is_file() {
        let _ = fs::remove_file(&temporary);
        let details = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(MediaError::Io(if details.is_empty() {
            "FFmpeg could not generate the playback proxy.".to_string()
        } else {
            format!("FFmpeg could not generate the playback proxy: {details}")
        }));
    }
    fs::rename(&temporary, &output)
        .or_else(|_| fs::copy(&temporary, &output).map(|_| ()))
        .map_err(MediaError::from)?;
    let _ = fs::remove_file(&temporary);
    Ok(output.to_string_lossy().to_string())
}

fn generate_single_thumbnail(
    input_path: &str,
    chunk_dir: &Path,
    time: f64,
    width: u32,
    height: u32,
    backend: &BackgroundMediaBackend,
    token: u64,
) -> Result<(), MediaError> {
    let target = thumbnail_path(chunk_dir, time);
    if target.is_file() {
        return Ok(());
    }
    let temp = chunk_dir.join(format!(
        ".tmp-{:012}.jpg",
        (time.max(0.0) * 1000.0).round() as u64
    ));
    let ffmpeg = ffmpeg_path()?;
    let threads = backend.thumbnail_threads();
    let mut command = media_command(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-nostdin")
        .arg("-y")
        .arg("-threads")
        .arg(threads.to_string())
        .arg("-filter_threads")
        .arg("1")
        .arg("-ss")
        .arg(format_seconds(time.max(0.0)))
        .arg("-i")
        .arg(input_path)
        .arg("-an")
        .arg("-sn")
        .arg("-dn")
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg(format!("scale={width}:{height}:flags=fast_bilinear"))
        .arg("-q:v")
        .arg("5")
        .arg(&temp)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let status = run_background_status(&mut command, backend, token).map_err(MediaError::from)?;
    if !status.success() || !temp.is_file() {
        let _ = fs::remove_file(&temp);
        return Err(MediaError::Io("FFmpeg could not generate a timeline thumbnail.".to_string()));
    }
    fs::rename(&temp, &target)
        .or_else(|_| fs::copy(&temp, &target).map(|_| ()))
        .map_err(MediaError::from)?;
    let _ = fs::remove_file(&temp);
    Ok(())
}

fn generate_thumbnail_chunk(
    input_path: &str,
    chunk_dir: &Path,
    start_time: f64,
    end_time: f64,
    interval: f64,
    width: u32,
    height: u32,
    backend: &BackgroundMediaBackend,
    token: u64,
) -> Result<(), MediaError> {
    let temp_dir = chunk_dir.join(".tmp");
    if temp_dir.exists() {
        let _ = fs::remove_dir_all(&temp_dir);
    }
    fs::create_dir_all(&temp_dir)?;

    let pattern = temp_dir.join("frame_%05d.jpg");
    let fps = (1.0 / interval).min(60.0);
    let filter = format!("fps={fps:.6},scale={width}:{height}:flags=fast_bilinear");
    let duration = (end_time - start_time).max(interval);

    let ffmpeg = ffmpeg_path()?;
    let threads = backend.thumbnail_threads();
    let mut command = media_command(&ffmpeg);
    command.arg("-hide_banner")
        .arg("-nostdin")
        .arg("-y")
        .arg("-threads")
        .arg(threads.to_string())
        .arg("-filter_threads")
        .arg("1")
        .arg("-ss")
        .arg(format_seconds(start_time))
        .arg("-t")
        .arg(format_seconds(duration))
        .arg("-i")
        .arg(input_path)
        .arg("-an")
        .arg("-sn")
        .arg("-dn")
        .arg("-vf")
        .arg(filter)
        .arg("-q:v")
        .arg("5")
        .arg(pattern)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let status = run_background_status(&mut command, backend, token);

    match status {
        Ok(status) if status.success() => {
            let mut files = fs::read_dir(&temp_dir)?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .map(|extension| extension.eq_ignore_ascii_case("jpg"))
                        .unwrap_or(false)
                })
                .collect::<Vec<_>>();
            files.sort();

            for (index, source) in files.into_iter().enumerate() {
                let time = round_time(start_time + index as f64 * interval);
                let target = thumbnail_path(chunk_dir, time);
                if !target.exists() {
                    let _ = fs::rename(&source, &target)
                        .or_else(|_| fs::copy(&source, &target).map(|_| ()));
                }
            }
            let _ = fs::remove_dir_all(&temp_dir);
            Ok(())
        }
        Ok(_) => {
            let _ = fs::remove_dir_all(&temp_dir);
            Err(MediaError::FfmpegUnavailable {
                binary: "ffmpeg".to_string(),
                checked: vec![ffmpeg.to_string_lossy().to_string()],
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let _ = fs::remove_dir_all(&temp_dir);
            Err(MediaError::FfmpegUnavailable {
                binary: "ffmpeg".to_string(),
                checked: vec![ffmpeg.to_string_lossy().to_string()],
            })
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&temp_dir);
            Err(MediaError::Io(error.to_string()))
        }
    }
}

fn run_background_status(
    command: &mut Command,
    backend: &BackgroundMediaBackend,
    token: u64,
) -> Result<std::process::ExitStatus, std::io::Error> {
    configure_background_priority(command);
    let mut child = command.spawn()?;
    let started_at = Instant::now();
    loop {
        if !backend.is_current(token) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Background media task cancelled.",
            ));
        }
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if started_at.elapsed() >= Duration::from_secs(20) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Background FFmpeg task timed out.",
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(windows)]
fn configure_background_priority(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_background_priority(_command: &mut Command) {}

fn audio_waveform_cache_path(
    video_id: &str,
    start_time: f64,
    end_time: f64,
    peak_count: usize,
    sample_rate: u32,
) -> PathBuf {
    let start_ms = (start_time.max(0.0) * 1000.0).round() as u64;
    let end_ms = (end_time.max(start_time) * 1000.0).round() as u64;
    std::env::temp_dir()
        .join("video-editor-cache")
        .join("waveform-cache")
        .join(sanitize_path_segment(video_id))
        .join(format!(
            "v4-rms-s{start_ms}-e{end_ms}-p{peak_count}-r{sample_rate}.f32"
        ))
}

fn read_cached_audio_peaks(path: &Path) -> Option<Vec<f32>> {
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }

    Some(
        bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .filter(|peak| peak.is_finite())
            .map(|peak| peak.clamp(0.0, 1.0))
            .collect(),
    )
}

fn write_cached_audio_peaks(path: &Path, peaks: &[f32]) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }

    let mut bytes = Vec::with_capacity(peaks.len() * 4);
    for peak in peaks {
        bytes.extend_from_slice(&peak.clamp(0.0, 1.0).to_le_bytes());
    }
    let _ = fs::write(path, bytes);
}

fn thumbnail_path(chunk_dir: &Path, time: f64) -> PathBuf {
    chunk_dir.join(format!("t-{:012}.jpg", (time * 1000.0).round() as u64))
}

fn align_time(time: f64, interval: f64) -> f64 {
    (time / interval).floor() * interval
}

fn round_time(time: f64) -> f64 {
    (time * 1000.0).round() / 1000.0
}

fn sanitize_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect()
}

fn validate_request(request: &ExportTrimRequest) -> Result<(), MediaError> {
    let input_path = Path::new(&request.input_path);
    if !input_path.is_file() {
        return Err(MediaError::InputMissing);
    }

    if request.output_path.trim().is_empty() {
        return Err(MediaError::EmptyOutputPath);
    }

    if request.clips.is_empty() {
        return Err(MediaError::InvalidEndTime);
    }

    for clip in &request.clips {
        if clip.start_time < 0.0 {
            return Err(MediaError::InvalidStartTime);
        }

        if clip.end_time <= clip.start_time {
            return Err(MediaError::InvalidEndTime);
        }
    }

    let input_canonical = input_path.canonicalize()?;
    let output_path = PathBuf::from(&request.output_path);
    let output_parent = output_path.parent().ok_or(MediaError::EmptyOutputPath)?;

    if !output_parent.exists() {
        return Err(MediaError::Io(
            "Output directory does not exist.".to_string(),
        ));
    }

    if output_path.exists() && output_path.canonicalize()? == input_canonical {
        return Err(MediaError::SameInputOutput);
    }

    if !output_path.exists() && normalize_path(&output_path) == input_canonical {
        return Err(MediaError::SameInputOutput);
    }

    Ok(())
}

fn spawn_export_child(
    ffmpeg: &Path,
    input_path: &str,
    output_path: &str,
    clip: &ExportClip,
    settings: &ExportSettings,
    annotations: &[ExportAnnotation],
    threads: usize,
) -> Result<(Child, std::process::ChildStderr), MediaError> {
    let mut command =
        build_export_command(ffmpeg, input_path, output_path, clip, settings, annotations, threads);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            MediaError::FfmpegUnavailable {
                binary: "ffmpeg".to_string(),
                checked: vec![ffmpeg.to_string_lossy().to_string()],
            }
        } else {
            MediaError::Io(error.to_string())
        }
    })?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| MediaError::Io("Could not capture FFmpeg progress output.".to_string()))?;
    Ok((child, stderr))
}

fn build_export_command(
    ffmpeg: &Path,
    input_path: &str,
    output_path: &str,
    clip: &ExportClip,
    settings: &ExportSettings,
    annotations: &[ExportAnnotation],
    threads: usize,
) -> Command {
    let mut command = media_command(ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-nostdin")
        .arg("-y")
        .arg("-ss")
        .arg(format_seconds(clip.start_time))
        .arg("-to")
        .arg(format_seconds(clip.end_time))
        .arg("-i")
        .arg(input_path);

    let overlay_path = write_clip_ass_overlay(clip, annotations).ok().flatten();
    apply_export_settings(&mut command, settings, overlay_path.as_deref());

    command
        .arg("-threads")
        .arg(threads.clamp(1, 8).to_string())
        .arg("-avoid_negative_ts")
        .arg("make_zero")
        .arg("-progress")
        .arg("pipe:2")
        .arg(output_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}

fn apply_export_settings(
    command: &mut Command,
    settings: &ExportSettings,
    overlay_path: Option<&Path>,
) {
    let has_overlay = overlay_path.is_some();

    if matches!(settings.mode, ExportMode::StreamCopy) && !has_overlay {
        command.arg("-c").arg("copy");
        return;
    }

    if matches!(settings.mode, ExportMode::StreamCopy) && has_overlay {
        apply_default_overlay_video_encoder(command, settings.format);
    } else {
        match settings.video_codec {
            VideoCodec::Copy if has_overlay => {
                apply_default_overlay_video_encoder(command, settings.format);
            }
            VideoCodec::Copy => {
                command.arg("-c:v").arg("copy");
            }
            VideoCodec::H264 => {
                command.arg("-c:v").arg("libx264");
                apply_preset(command, &settings.preset);
                apply_crf(command, settings.crf.unwrap_or(20));
            }
            VideoCodec::H265 => {
                command.arg("-c:v").arg("libx265");
                apply_preset(command, &settings.preset);
                apply_crf(command, settings.crf.unwrap_or(24));
            }
            VideoCodec::Av1 => {
                command.arg("-c:v").arg("libaom-av1");
                apply_crf(command, settings.crf.unwrap_or(30));
            }
            VideoCodec::Vp9 => {
                command.arg("-c:v").arg("libvpx-vp9");
                apply_crf(command, settings.crf.unwrap_or(32));
            }
        }
    }

    if let Some(kbps) = settings.video_bitrate_kbps.filter(|value| *value > 0) {
        command.arg("-b:v").arg(format!("{kbps}k"));
    }

    match settings.audio_codec {
        AudioCodec::Copy => {
            command.arg("-c:a").arg("copy");
        }
        AudioCodec::Aac => {
            command.arg("-c:a").arg("aac");
        }
        AudioCodec::Opus => {
            command.arg("-c:a").arg("libopus");
        }
        AudioCodec::Mp3 => {
            command.arg("-c:a").arg("libmp3lame");
        }
    }

    if let Some(kbps) = settings.audio_bitrate_kbps.filter(|value| *value > 0) {
        command.arg("-b:a").arg(format!("{kbps}k"));
    }

    let mut filters = Vec::new();
    if let Some(fps) = settings
        .fps
        .filter(|value| value.is_finite() && *value > 0.0)
    {
        filters.push(format!("fps={fps:.3}"));
    }
    match (settings.width, settings.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => {
            filters.push(format!("scale={width}:{height}"));
        }
        (Some(width), _) if width > 0 => {
            filters.push(format!("scale={width}:-2"));
        }
        (_, Some(height)) if height > 0 => {
            filters.push(format!("scale=-2:{height}"));
        }
        _ => {}
    }
    if !filters.is_empty() && settings.video_codec != VideoCodec::Copy {
        if let Some(path) = overlay_path {
            filters.push(format!("ass='{}'", escape_filter_path(path)));
        }
        command.arg("-vf").arg(filters.join(","));
    } else if let Some(path) = overlay_path {
        command
            .arg("-vf")
            .arg(format!("ass='{}'", escape_filter_path(path)));
    }
}

fn apply_default_overlay_video_encoder(command: &mut Command, format: ExportFormat) {
    match format {
        ExportFormat::Webm => {
            command
                .arg("-c:v")
                .arg("libvpx-vp9")
                .arg("-crf")
                .arg("32")
                .arg("-b:v")
                .arg("0");
        }
        ExportFormat::Mp4 | ExportFormat::Mov | ExportFormat::Mkv => {
            command
                .arg("-c:v")
                .arg("libx264")
                .arg("-preset")
                .arg("medium")
                .arg("-crf")
                .arg("20");
        }
    }
}

fn write_clip_ass_overlay(
    clip: &ExportClip,
    annotations: &[ExportAnnotation],
) -> Result<Option<PathBuf>, MediaError> {
    let events = annotations
        .iter()
        .filter(|annotation| annotation.visible)
        .filter_map(|annotation| ass_event_for_annotation(clip, annotation))
        .collect::<Vec<_>>();

    if events.is_empty() {
        return Ok(None);
    }

    let path = std::env::temp_dir()
        .join("video-editor-overlays")
        .join(format!(
            "{}_{}.ass",
            sanitize_path_segment(&clip.id),
            create_operation_id()
        ));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut ass = String::new();
    ass.push_str("[Script Info]\n");
    ass.push_str("ScriptType: v4.00+\n");
    ass.push_str(&format!("PlayResX: {}\n", ASS_PLAY_RES_X as u32));
    ass.push_str(&format!("PlayResY: {}\n", ASS_PLAY_RES_Y as u32));
    ass.push_str("ScaledBorderAndShadow: yes\n\n");
    ass.push_str("[V4+ Styles]\n");
    ass.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    ass.push_str("Style: Default,Arial,32,&H00FFFFFF,&H00FFFFFF,&HAA000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1\n\n");
    ass.push_str("[Events]\n");
    ass.push_str(
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
    );
    ass.push_str(&events.join("\n"));
    ass.push('\n');

    fs::write(&path, ass)?;
    Ok(Some(path))
}

fn ass_event_for_annotation(clip: &ExportClip, annotation: &ExportAnnotation) -> Option<String> {
    let start = annotation.start_time.max(clip.start_time) - clip.start_time;
    let end = annotation.end_time.min(clip.end_time) - clip.start_time;
    if end <= start || !start.is_finite() || !end.is_finite() {
        return None;
    }

    let start = format_ass_time(start);
    let end = format_ass_time(end);
    let text = ass_text_for_annotation(annotation)?;
    Some(format!(
        "Dialogue: 0,{start},{end},Default,{},0,0,0,,{text}",
        sanitize_ass_name(&annotation.id)
    ))
}

fn ass_text_for_annotation(annotation: &ExportAnnotation) -> Option<String> {
    let x = clamp01(annotation.x) * ASS_PLAY_RES_X;
    let y = clamp01(annotation.y) * ASS_PLAY_RES_Y;
    let width = clamp01(annotation.width).max(0.001) * ASS_PLAY_RES_X;
    let height = clamp01(annotation.height).max(0.001) * ASS_PLAY_RES_Y;
    let color = ass_color(&annotation.color);
    let alpha = ass_alpha(annotation.opacity);
    let line = annotation.thickness.clamp(1.0, 80.0);

    match annotation.annotation_type {
        ExportAnnotationType::Text => {
            let cx = x + width / 2.0;
            let cy = y + height / 2.0;
            let font_size = (annotation.thickness + 6.0).clamp(10.0, 96.0);
            Some(format!(
        "{{\\an5\\pos({cx:.0},{cy:.0})\\fn{}\\fs{font_size:.0}\\1c&H{color}&\\1a&H{alpha}&\\bord2\\3c&H000000&}}{}",
        escape_ass_text(&annotation.font),
        escape_ass_text(&annotation.label)
      ))
        }
        ExportAnnotationType::Rectangle | ExportAnnotationType::Crop => {
            let draw_alpha = ass_alpha(
                if annotation.annotation_type == ExportAnnotationType::Crop {
                    annotation.opacity
                } else {
                    100.0
                },
            );
            Some(ass_group(
                &[
                    rect_draw(x, y, width, line),
                    rect_draw(x, y + height - line, width, line),
                    rect_draw(x, y, line, height),
                    rect_draw(x + width - line, y, line, height),
                ],
                &color,
                &draw_alpha,
            ))
        }
        ExportAnnotationType::Highlight | ExportAnnotationType::Blur => {
            let fill_alpha = if annotation.annotation_type == ExportAnnotationType::Blur {
                ass_alpha((annotation.opacity / 2.5).clamp(8.0, 45.0))
            } else {
                alpha
            };
            Some(ass_draw(
                &rect_path(x, y, width, height),
                &color,
                &fill_alpha,
            ))
        }
        ExportAnnotationType::Circle => Some(ass_draw(
            &ellipse_ring_path(x, y, width, height, line),
            &color,
            &alpha,
        )),
        ExportAnnotationType::Arrow | ExportAnnotationType::Measure => {
            let (x1, y1, x2, y2) = annotation_line(annotation, x, y, width, height);
            let mut parts = vec![line_polygon(x1, y1, x2, y2, line)];
            if annotation.annotation_type == ExportAnnotationType::Arrow {
                parts.push(arrow_head_polygon(x1, y1, x2, y2, line));
            }
            let mut text = ass_group(&parts, &color, &alpha);
            if annotation.annotation_type == ExportAnnotationType::Measure
                && !annotation.label.trim().is_empty()
            {
                let cx = (x1 + x2) / 2.0;
                let cy = (y1 + y2) / 2.0 - 14.0;
                text.push_str(&format!(
          "\\N{{\\an5\\pos({cx:.0},{cy:.0})\\fs22\\1c&H{color}&\\1a&H{alpha}&\\bord2\\3c&H000000&}}{}",
          escape_ass_text(&annotation.label)
        ));
            }
            Some(text)
        }
        ExportAnnotationType::Pen | ExportAnnotationType::Brush => {
            let points = annotation.path_points.as_deref()?;
            if points.len() < 2 {
                return None;
            }
            let draw_alpha = if annotation.annotation_type == ExportAnnotationType::Brush {
                ass_alpha(annotation.opacity.min(88.0))
            } else {
                alpha
            };
            Some(ass_group(
                &path_segments(points, x, y, width, height, line),
                &color,
                &draw_alpha,
            ))
        }
    }
}

fn format_ass_time(seconds: f64) -> String {
    let centiseconds = (seconds.max(0.0) * 100.0).round() as u64;
    let cs = centiseconds % 100;
    let total_seconds = centiseconds / 100;
    let s = total_seconds % 60;
    let total_minutes = total_seconds / 60;
    let m = total_minutes % 60;
    let h = total_minutes / 60;
    format!("{h}:{m:02}:{s:02}.{cs:02}")
}

fn ass_color(hex: &str) -> String {
    let clean = hex.trim().trim_start_matches('#');
    if clean.len() != 6 {
        return "FFFFFF".to_string();
    }
    let r = &clean[0..2];
    let g = &clean[2..4];
    let b = &clean[4..6];
    format!("{b}{g}{r}").to_uppercase()
}

fn ass_alpha(opacity: f64) -> String {
    let alpha = (255.0 * (1.0 - opacity.clamp(0.0, 100.0) / 100.0)).round() as u8;
    format!("{alpha:02X}")
}

fn ass_draw(path: &str, color: &str, alpha: &str) -> String {
    format!("{{\\p1\\bord0\\shad0\\1c&H{color}&\\1a&H{alpha}&}}{path}{{\\p0}}")
}

fn ass_group(paths: &[String], color: &str, alpha: &str) -> String {
    paths
        .iter()
        .map(|path| ass_draw(path, color, alpha))
        .collect::<Vec<_>>()
        .join("\\N")
}

fn rect_draw(x: f64, y: f64, width: f64, height: f64) -> String {
    rect_path(x, y, width.max(1.0), height.max(1.0))
}

fn rect_path(x: f64, y: f64, width: f64, height: f64) -> String {
    let x2 = x + width;
    let y2 = y + height;
    format!("m {x:.0} {y:.0} l {x2:.0} {y:.0} {x2:.0} {y2:.0} {x:.0} {y2:.0}")
}

fn ellipse_ring_path(x: f64, y: f64, width: f64, height: f64, thickness: f64) -> String {
    let outer = ellipse_path(
        x + width / 2.0,
        y + height / 2.0,
        width / 2.0,
        height / 2.0,
        false,
    );
    let inner = ellipse_path(
        x + width / 2.0,
        y + height / 2.0,
        (width / 2.0 - thickness).max(1.0),
        (height / 2.0 - thickness).max(1.0),
        true,
    );
    format!("{outer} {inner}")
}

fn ellipse_path(cx: f64, cy: f64, rx: f64, ry: f64, reverse: bool) -> String {
    let steps = 56;
    let mut points = Vec::with_capacity(steps + 1);
    for index in 0..steps {
        let t = if reverse {
            std::f64::consts::TAU - std::f64::consts::TAU * index as f64 / steps as f64
        } else {
            std::f64::consts::TAU * index as f64 / steps as f64
        };
        points.push((cx + rx * t.cos(), cy + ry * t.sin()));
    }
    polygon_path(&points)
}

fn annotation_line(
    annotation: &ExportAnnotation,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> (f64, f64, f64, f64) {
    (
        x + annotation.line_start_x.unwrap_or(0.06).clamp(0.0, 1.0) * width,
        y + annotation.line_start_y.unwrap_or(0.9).clamp(0.0, 1.0) * height,
        x + annotation.line_end_x.unwrap_or(0.94).clamp(0.0, 1.0) * width,
        y + annotation.line_end_y.unwrap_or(0.1).clamp(0.0, 1.0) * height,
    )
}

fn line_polygon(x1: f64, y1: f64, x2: f64, y2: f64, thickness: f64) -> String {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let length = (dx * dx + dy * dy).sqrt().max(0.001);
    let px = -dy / length * thickness / 2.0;
    let py = dx / length * thickness / 2.0;
    polygon_path(&[
        (x1 + px, y1 + py),
        (x2 + px, y2 + py),
        (x2 - px, y2 - py),
        (x1 - px, y1 - py),
    ])
}

fn arrow_head_polygon(x1: f64, y1: f64, x2: f64, y2: f64, thickness: f64) -> String {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let length = (dx * dx + dy * dy).sqrt().max(0.001);
    let ux = dx / length;
    let uy = dy / length;
    let size = (thickness * 5.0).clamp(12.0, 48.0);
    let px = -uy;
    let py = ux;
    polygon_path(&[
        (x2, y2),
        (
            x2 - ux * size + px * size * 0.45,
            y2 - uy * size + py * size * 0.45,
        ),
        (
            x2 - ux * size - px * size * 0.45,
            y2 - uy * size - py * size * 0.45,
        ),
    ])
}

fn path_segments(
    points: &[ExportPoint],
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    thickness: f64,
) -> Vec<String> {
    points
        .windows(2)
        .filter_map(|pair| {
            let a = pair[0];
            let b = pair[1];
            let x1 = x + clamp01(a.x) * width;
            let y1 = y + clamp01(a.y) * height;
            let x2 = x + clamp01(b.x) * width;
            let y2 = y + clamp01(b.y) * height;
            if (x2 - x1).abs() < 0.1 && (y2 - y1).abs() < 0.1 {
                None
            } else {
                Some(line_polygon(x1, y1, x2, y2, thickness))
            }
        })
        .collect()
}

fn polygon_path(points: &[(f64, f64)]) -> String {
    let Some((first, rest)) = points.split_first() else {
        return String::new();
    };
    let mut path = format!("m {:.0} {:.0}", first.0, first.1);
    for (x, y) in rest {
        path.push_str(&format!(" l {x:.0} {y:.0}"));
    }
    path
}

fn escape_ass_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('{', "\\{")
        .replace('}', "\\}")
        .replace('\n', "\\N")
}

fn sanitize_ass_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>()
}

fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

fn clamp01(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn apply_preset(command: &mut Command, preset: &str) {
    if !preset.trim().is_empty() {
        command.arg("-preset").arg(preset);
    }
}

fn apply_crf(command: &mut Command, crf: u8) {
    command.arg("-crf").arg(crf.clamp(0, 51).to_string());
}

fn run_export_child(
    app: &AppHandle,
    operation_id: &str,
    stderr: std::process::ChildStderr,
    child_ref: Arc<Mutex<Child>>,
    clip_duration: f64,
    completed_duration: f64,
    total_duration: f64,
    clip_label: &str,
    last_details: &mut String,
) -> Option<std::process::ExitStatus> {
    let reader = BufReader::new(stderr);
    for line in reader.lines().map_while(Result::ok) {
        if let Some(clip_progress) = parse_progress_line(&line, clip_duration) {
            let progress = ((completed_duration + clip_progress * clip_duration) / total_duration)
                .clamp(0.0, 0.99);
            let _ = app.emit(
                "export-progress",
                ExportProgressEvent {
                    operation_id: operation_id.to_string(),
                    progress,
                    status: Some("exporting".to_string()),
                    message: Some(format!("Exporting {clip_label}")),
                },
            );
        } else if !line.trim().is_empty() {
            *last_details = line;
        }
    }

    child_ref
        .lock()
        .ok()
        .and_then(|mut child| child.wait().ok())
}

fn output_paths_for_clips(
    output_path: &str,
    clips: &[ExportClip],
    format: ExportFormat,
) -> Vec<String> {
    if clips.len() <= 1 {
        return vec![with_format_extension(Path::new(output_path), format)];
    }

    let path = Path::new(output_path);
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    clips
        .iter()
        .enumerate()
        .map(|(index, clip)| {
            let label = sanitize_path_segment(&clip.label)
                .trim_matches('-')
                .to_string();
            let id = sanitize_path_segment(&clip.id)
                .trim_matches('-')
                .to_string();
            let suffix = if label.is_empty() {
                format!("clip-{:02}", index + 1)
            } else if id.is_empty() {
                label
            } else {
                format!("{:02}-{label}-{id}", index + 1)
            };
            parent
                .join(format!("{stem}-{suffix}.{}", format_extension(format)))
                .to_string_lossy()
                .to_string()
        })
        .collect()
}

fn with_format_extension(path: &Path, format: ExportFormat) -> String {
    path.with_extension(format_extension(format))
        .to_string_lossy()
        .to_string()
}

fn format_extension(format: ExportFormat) -> &'static str {
    match format {
        ExportFormat::Mp4 => "mp4",
        ExportFormat::Mov => "mov",
        ExportFormat::Mkv => "mkv",
        ExportFormat::Webm => "webm",
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(file_name)) => parent
            .canonicalize()
            .map(|canonical| canonical.join(file_name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

fn parse_progress_line(line: &str, duration: f64) -> Option<f64> {
    let value = line
        .strip_prefix("out_time_ms=")
        .or_else(|| line.strip_prefix("out_time_us="))?;
    let parsed = value.parse::<f64>().ok()?;
    if duration <= 0.0 {
        return Some(0.0);
    }

    Some((parsed / 1_000_000.0 / duration).clamp(0.0, 0.99))
}

fn format_seconds(seconds: f64) -> String {
    format!("{seconds:.3}")
}

fn create_operation_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("export-{millis}")
}

#[cfg(test)]
mod resource_manager_tests {
    use super::*;

    #[test]
    fn playback_denies_prefetch_and_limits_visible_thumbnails() {
        let visible = calculate_budget(
            MediaTaskKind::VisibleThumbnail,
            PerformancePreset::Performance,
            PressureLevel::Normal,
            true,
            false,
            24,
        );
        let prefetch = calculate_budget(
            MediaTaskKind::ThumbnailPrefetch,
            PerformancePreset::Performance,
            PressureLevel::Normal,
            true,
            false,
            24,
        );
        assert!(visible.allowed);
        assert_eq!(visible.cpu_threads, 1);
        assert!(visible.batch_size <= 3);
        assert!(!prefetch.allowed);
    }

    #[test]
    fn critical_pressure_uses_minimum_decode_budget() {
        let budget = calculate_budget(
            MediaTaskKind::VisibleThumbnail,
            PerformancePreset::Performance,
            PressureLevel::Critical,
            false,
            false,
            24,
        );
        assert_eq!(budget.cpu_threads, 1);
        assert_eq!(budget.decode_concurrency, 1);
        assert_eq!(budget.batch_size, 1);
        assert!(budget.cancel_low_priority);
    }

    #[test]
    fn runtime_config_can_calculate_nested_budgets_without_deadlock() {
        let manager = BackgroundMediaBackend::default();
        let config = manager.runtime_config();
        assert!(config.thumbnail_budget.cpu_threads >= 1);
        assert!(config.waveform_budget.max_parallel_jobs >= 1);
    }
}
