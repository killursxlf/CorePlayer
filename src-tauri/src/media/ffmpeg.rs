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

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

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

const ASS_PLAY_RES_X: f64 = 960.0;
const ASS_PLAY_RES_Y: f64 = 540.0;

#[path = "timeline_export.rs"]
mod timeline_export;

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
    pub battery_saver: Option<bool>,
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
    pub acceleration: super::acceleration::Status,
    pub playback_proxy: Option<PlaybackProxyProgress>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackProxyProgress {
    pub video_id: String,
    pub progress: f64,
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
    ui_long_task_ratio: f64,
}

impl Default for PressureState {
    fn default() -> Self {
        Self {
            level: PressureLevel::Normal,
            stable_samples: 0,
            dropped_frame_ratio: 0.0,
            ui_long_task_ratio: 0.0,
        }
    }
}

#[derive(Clone, Default)]
pub struct BackgroundMediaBackend {
    pub acceleration: super::acceleration::Acceleration,
    epoch: Arc<AtomicU64>,
    proxy_epoch: Arc<AtomicU64>,
    proxy_lock: Arc<Mutex<()>>,
    decoder_lock: Arc<Mutex<()>>,
    waveform_lock: Arc<Mutex<()>>,
    waveform_epoch: Arc<AtomicU64>,
    window_hidden: Arc<AtomicBool>,
    playing: Arc<AtomicBool>,
    exporting: Arc<AtomicBool>,
    active_tasks: Arc<AtomicU64>,
    preset: Arc<Mutex<PerformancePreset>>,
    pressure: Arc<Mutex<PressureState>>,
    cpu_sample: Arc<Mutex<Option<(u64, u64, u64, Instant)>>>,
    cpu_load: Arc<Mutex<Option<f64>>>,
    hardware_decode_available: Arc<Mutex<Option<bool>>>,
    proxy_progress: Arc<Mutex<Option<PlaybackProxyProgress>>>,
}

impl BackgroundMediaBackend {
    pub fn proxy_token(&self) -> u64 {
        self.proxy_epoch.load(Ordering::Relaxed)
    }

    pub fn cancel_proxy(&self) {
        self.proxy_epoch.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut progress) = self.proxy_progress.lock() {
            *progress = None;
        }
    }

    pub fn token(&self) -> u64 {
        self.epoch.load(Ordering::Relaxed)
    }

    pub fn cancel_all(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.waveform_epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub fn cancel_thumbnails(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    pub fn waveform_token(&self) -> u64 {
        self.waveform_epoch.load(Ordering::Acquire)
    }

    pub fn set_playing(&self, playing: bool) {
        self.acceleration.set_playing(playing);
        self.playing.store(playing, Ordering::SeqCst);
        if playing {
            self.cancel_all();
        }
    }

    pub fn set_exporting(&self, exporting: bool) {
        self.exporting.store(exporting, Ordering::SeqCst);
        if exporting {
            self.cancel_all();
            self.cancel_proxy();
        }
    }

    pub fn set_preset(&self, preset: PerformancePreset) -> Result<(), MediaError> {
        *self
            .preset
            .lock()
            .map_err(|_| MediaError::Io("Performance preset lock is poisoned.".to_string()))? =
            preset;
        Ok(())
    }

    pub fn update_metrics(&self, metrics: RuntimeMetrics) -> Result<(), MediaError> {
        if let Some(available) = metrics.hardware_decode_available {
            if let Ok(mut stored) = self.hardware_decode_available.lock() {
                *stored = Some(available);
            }
        }
        self.window_hidden
            .store(!metrics.window_visible, Ordering::Relaxed);
        let sampled_load = sample_cpu_load(&self.cpu_sample);
        let cpu_load = self
            .cpu_load
            .lock()
            .map(|mut stored| {
                if sampled_load.is_some() {
                    *stored = sampled_load;
                }
                *stored
            })
            .unwrap_or(sampled_load);
        let available_ram = memory_status().map(|(_, available)| available);
        let mut state = self
            .pressure
            .lock()
            .map_err(|_| MediaError::Io("Pressure state lock is poisoned.".to_string()))?;
        let ratio = if metrics.dropped_frame_ratio.is_finite() {
            metrics.dropped_frame_ratio.clamp(0.0, 1.0)
        } else {
            0.0
        };
        state.dropped_frame_ratio = ratio;
        let playback = self.playing.load(Ordering::Relaxed);
        let target = if playback && ratio >= 0.08
            || state.ui_long_task_ratio >= 0.4
            || cpu_load.is_some_and(|load| load >= 0.95)
            || available_ram.is_some_and(|bytes| bytes < 512 * 1024 * 1024)
        {
            PressureLevel::Critical
        } else if playback && ratio >= 0.03
            || state.ui_long_task_ratio >= 0.2
            || cpu_load.is_some_and(|load| load >= 0.80)
            || available_ram.is_some_and(|bytes| bytes < 1024 * 1024 * 1024)
        {
            PressureLevel::High
        } else if ratio >= 0.01 || metrics.user_active || state.ui_long_task_ratio >= 0.05 {
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
        Ok(())
    }

    pub fn hardware_profile(&self) -> HardwareProfile {
        static LOGICAL_CPUS: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
        let logical_cpus = *LOGICAL_CPUS.get_or_init(|| {
            std::thread::available_parallelism()
                .map(|value| value.get())
                .unwrap_or(1)
        });
        let memory = memory_status();
        let power = power_status();
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
            on_battery: power.0,
            battery_saver: power.1,
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
        let effective_preset = if preset == PerformancePreset::Auto {
            if hardware.on_battery == Some(true)
                || hardware.battery_saver == Some(true)
                || hardware.logical_cpus <= 4
                || hardware
                    .total_ram_bytes
                    .is_some_and(|bytes| bytes <= 4 * 1024 * 1024 * 1024)
            {
                PerformancePreset::PowerSaver
            } else if hardware.logical_cpus >= 12
                && hardware
                    .available_ram_bytes
                    .is_some_and(|bytes| bytes >= 8 * 1024 * 1024 * 1024)
            {
                PerformancePreset::Performance
            } else {
                PerformancePreset::Balanced
            }
        } else {
            preset
        };
        let mut budget = calculate_budget(
            kind,
            effective_preset,
            pressure,
            playback,
            exporting,
            hardware.logical_cpus,
        );
        if self.window_hidden.load(Ordering::Relaxed)
            && !matches!(kind, MediaTaskKind::Export | MediaTaskKind::Proxy)
        {
            budget.allowed = false;
            budget.prefetch_allowed = false;
            budget.reason = "window-hidden".into();
        }
        // One audio worker may run beside the video worker when there is headroom.
        if matches!(
            kind,
            MediaTaskKind::VisibleWaveform | MediaTaskKind::FullWaveform
        ) {
            budget.max_parallel_jobs = if hardware.logical_cpus >= 8
                && hardware
                    .available_ram_bytes
                    .is_some_and(|bytes| bytes >= 3 * 1024 * 1024 * 1024)
                && effective_preset != PerformancePreset::PowerSaver
                && pressure == PressureLevel::Normal
                && !playback
                && !exporting
            {
                2
            } else {
                1
            };
            budget.max_chunk_seconds = 30.0;
        }
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
            acceleration: self.acceleration.status(),
            playback_proxy: self
                .proxy_progress
                .lock()
                .ok()
                .and_then(|value| value.clone()),
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

    pub fn update_ui_load(&self, ratio: Option<f64>) {
        if let Some(ratio) = ratio.filter(|value| value.is_finite()) {
            if let Ok(mut state) = self.pressure.lock() {
                state.ui_long_task_ratio = ratio.clamp(0.0, 1.0);
            }
        }
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

#[cfg(windows)]
fn power_status() -> (Option<bool>, Option<bool>) {
    #[repr(C)]
    #[derive(Default)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_percent: u8,
        battery_saver: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }
    let mut status = SystemPowerStatus::default();
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
        return (None, None);
    }
    let battery = match status.ac_line_status {
        0 => Some(true),
        1 => Some(false),
        _ => None,
    };
    (battery, Some(status.battery_saver == 1))
}

#[cfg(not(windows))]
fn power_status() -> (Option<bool>, Option<bool>) {
    (None, None)
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
fn sample_cpu_load(sample: &Mutex<Option<(u64, u64, u64, Instant)>>) -> Option<f64> {
    let mut previous = sample.lock().ok()?;
    if previous.is_some_and(|last| last.3.elapsed() < Duration::from_millis(500)) {
        return None;
    }
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
    let current = (value(&idle), value(&kernel), value(&user), Instant::now());
    let result = previous.and_then(|last| {
        let idle_delta = current.0.saturating_sub(last.0);
        let total_delta = current.1.saturating_sub(last.1) + current.2.saturating_sub(last.2);
        (total_delta > 0).then_some((1.0 - idle_delta as f64 / total_delta as f64).clamp(0.0, 1.0))
    });
    *previous = Some(current);
    result
}

#[cfg(not(windows))]
fn sample_cpu_load(_sample: &Mutex<Option<(u64, u64, u64, Instant)>>) -> Option<f64> {
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
    let system_class_threads = if logical_cpus <= 4 {
        1
    } else if logical_cpus <= 12 {
        2
    } else {
        3
    };
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
    if exporting
        && !matches!(
            kind,
            MediaTaskKind::Export | MediaTaskKind::VisibleThumbnail
        )
    {
        allowed = false;
        reason = "export-active".to_string();
    }
    if playback {
        cpu_threads = 1;
        batch_size = batch_size.min(3);
        decode_concurrency = 1;
        if (low_priority && !matches!(kind, MediaTaskKind::Proxy))
            || matches!(kind, MediaTaskKind::VisibleWaveform)
        {
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
            if playback {
                0.0
            } else {
                300.0
            }
        } else if playback {
            4.0
        } else {
            12.0
        },
        prefetch_allowed: !playback
            && !exporting
            && pressure == PressureLevel::Normal
            && preset != PerformancePreset::PowerSaver,
        delay_ms: if playback {
            120
        } else if pressure == PressureLevel::Elevated {
            80
        } else {
            20
        },
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
        mut request: ExportTrimRequest,
        resources: BackgroundMediaBackend,
    ) -> Result<ExportStarted, MediaError> {
        if request.timeline { request.clips.sort_by(|a, b| a.start_time.total_cmp(&b.start_time)); }
        validate_request(&request)?;

        let mut operations = self
            .operations
            .lock()
            .map_err(|_| MediaError::Io("Export state lock is poisoned.".to_string()))?;

        if !operations.is_empty() {
            return Err(MediaError::ExportAlreadyRunning);
        }

        let operation_id = request
            .operation_id
            .clone()
            .filter(|id| !id.is_empty())
            .unwrap_or_else(create_operation_id);
        let output_path =
            with_format_extension(Path::new(&request.output_path), request.settings.format);
        let outputs = request_output_paths(&request);
        let temporary_outputs: Vec<String> = outputs
            .iter()
            .map(|path| {
                super::atomic_file::temporary_path(Path::new(path))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        let artifacts = ExportArtifacts(temporary_outputs.clone());
        let timeline_clips = if request.timeline { request.clips.clone() } else { vec![] };
        let clips = if request.timeline { vec![ExportClip { id: "timeline".into(), label: "Монтаж".into(), start_time: 0.0, end_time: request.clips.last().unwrap().end_time, source_start: None }] } else { request.clips.clone() };
        let total_duration = clips
            .iter()
            .map(|clip| clip.end_time - clip.start_time)
            .sum::<f64>()
            .max(0.001);

        let first_clip = clips[0].clone();
        let first_output = temporary_outputs[0].clone();
        let ffmpeg = ffmpeg_path()?;
        let export_threads = resources.budget(MediaTaskKind::Export).cpu_threads.max(1);
        let mut cpu_command = build_export_job(
            &ffmpeg,
            &request.input_path,
            &first_output,
            &first_clip,
            &request.settings,
            &request.annotations,
            export_threads,
            &timeline_clips,
        )?;

        let mut gpu = resources.acceleration.plan(&cpu_command, "export", resources.playing.load(Ordering::Acquire), true);
        let mut accelerated;
        let command = if let Some(plan) = gpu.as_ref() {
            accelerated = plan.command(&cpu_command);
            accelerated.stdout(Stdio::null()).stderr(Stdio::piped());
            &mut accelerated
        } else { &mut cpu_command };
        let spawned = command.spawn().or_else(|error| {
            if gpu.is_none() { return Err(error); }
            resources.acceleration.report("export", "CPU", Some(format!("GPU process failed: {error}")));
            gpu = None;
            cpu_command.spawn()
        });
        let mut child = spawned.map_err(|error| {
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
        resources.set_exporting(true);
        drop(operations);

        let operations_ref = self.operations.clone();
        let cancelled_ref = self.cancelled.clone();
        let thread_operation_id = operation_id.clone();
        let input_path = request.input_path.clone();
        let settings = request.settings.clone();
        let annotations = request.annotations.clone();

        thread::spawn(move || {
            let mut last_details = String::new();
            let mut completed_duration = 0.0;
            let mut status = None;
            let mut first_stderr = Some(stderr);
            'clips: for (clip, output) in clips.iter().zip(&temporary_outputs) {
                loop {
                    if cancelled_ref.lock().map(|set| set.contains(&thread_operation_id)).unwrap_or(true) {
                        break 'clips;
                    }
                    let stderr = if let Some(stderr) = first_stderr.take() { stderr } else {
                        match spawn_export_child(&ffmpeg, &input_path, output, clip, &settings, &annotations,
                            export_threads, gpu.as_ref(), &timeline_clips) {
                            Ok((child, stderr)) => {
                                if let Ok(mut guard) = child_ref.lock() {
                                    *guard = child;
                                    if cancelled_ref.lock().map(|set| set.contains(&thread_operation_id)).unwrap_or(true) {
                                        let _ = guard.kill();
                                    }
                                }
                                stderr
                            }
                            Err(error) => {
                                last_details = error.to_string();
                                if gpu.take().is_some() {
                                    resources.acceleration.report("export", "CPU", Some(last_details.clone()));
                                    continue;
                                }
                                status = None;
                                break 'clips;
                            }
                        }
                    };
                    status = run_export_child(&app, &thread_operation_id, stderr, child_ref.clone(),
                        clip.end_time - clip.start_time, completed_duration, total_duration, &clip.label,
                        &mut last_details, gpu.is_some().then_some(&resources));
                    if status.as_ref().is_some_and(|s| s.success()) { break; }
                    if gpu.take().is_some() && !cancelled_ref.lock().map(|set| set.contains(&thread_operation_id)).unwrap_or(true) {
                        resources.acceleration.report("export", "CPU", Some(format!("GPU failed; clip restarted on CPU: {last_details}")));
                        continue;
                    }
                    break 'clips;
                }
                completed_duration += clip.end_time - clip.start_time;
            }
            drop(gpu);

            let was_cancelled = cancelled_ref
                .lock()
                .map(|mut cancelled| cancelled.remove(&thread_operation_id))
                .unwrap_or(false);

            if !was_cancelled && status.as_ref().is_some_and(|s| s.success()) {
                for (temporary, output) in temporary_outputs.iter().zip(&outputs) {
                    let result = if clips.len() == 1
                        && Path::new(output) == Path::new(&request.output_path)
                    {
                        super::atomic_file::replace(Path::new(temporary), Path::new(output))
                    } else {
                        // Atomic no-clobber publication for names not confirmed by the save dialog.
                        fs::hard_link(temporary, output).and_then(|_| fs::remove_file(temporary))
                    };
                    if let Err(error) = result {
                        status = None;
                        last_details = error.to_string();
                        break;
                    }
                }
            }
            drop(artifacts);
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
                if !was_cancelled {
                    status_label = "failed".to_string();
                    message = format!("Export failed: {last_details}");
                }
            }

            if let Ok(mut operations) = operations_ref.lock() {
                operations.remove(&thread_operation_id);
                if let Ok(mut cancelled) = cancelled_ref.lock() {
                    cancelled.remove(&thread_operation_id);
                }
            }
            resources.set_exporting(false);
            let _ = app.emit(
                "export-progress",
                ExportProgressEvent {
                    operation_id: thread_operation_id.clone(),
                    progress: final_progress,
                    status: Some(status_label),
                    message: Some(message),
                },
            );
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

        let Some(child) = operations.get(&operation_id).cloned() else {
            return Ok(());
        };
        self.cancelled
            .lock()
            .map_err(|_| MediaError::Io("Export cancellation lock is poisoned.".to_string()))?
            .insert(operation_id);
        drop(operations);

        let mut child = child
            .lock()
            .map_err(|_| MediaError::Io("Export process lock is poisoned.".to_string()))?;
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        child.kill().map_err(MediaError::from)
    }
}

#[path = "waveform.rs"]
mod waveform;

pub fn generate_audio_waveform(
    request: AudioWaveformRequest,
    backend: &BackgroundMediaBackend,
    token: u64,
) -> Result<AudioWaveformResult, MediaError> {
    waveform::generate(request, backend, token, false)
}

pub fn generate_audio_waveform_cached(
    request: AudioWaveformRequest,
    backend: &BackgroundMediaBackend,
    token: u64,
    cache_only: bool,
) -> Result<AudioWaveformResult, MediaError> {
    if cache_only {
        waveform::generate(request, backend, token, true)
    } else {
        generate_audio_waveform(request, backend, token)
    }
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
        return Err(MediaError::Io(format!(
            "Thumbnail generation deferred: {}",
            budget.reason
        )));
    }
    let input_path = Path::new(&request.file_path);
    if !input_path.is_file() {
        return Err(MediaError::InputMissing);
    }

    if !request.start_time.is_finite()
        || !request.end_time.is_finite()
        || request.end_time < request.start_time
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
        return Err(MediaError::Io(
            "Background media task cancelled.".to_string(),
        ));
    }

    let interval = request.interval_seconds.max(0.001);
    let width = request.thumbnail_width.clamp(64, 320);
    let height = request.thumbnail_height.clamp(24, 180);
    let safe_video_id = sanitize_path_segment(&request.video_id);
    let cache_base = cache_root
        .join("thumbnail-cache")
        .join(safe_video_id)
        .join("v6-cover");
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

    let mut chunks: std::collections::BTreeMap<u64, Vec<f64>> = std::collections::BTreeMap::new();
    for time in &times {
        let chunk_id = (*time / 25.0).floor().max(0.0) as u64;
        chunks.entry(chunk_id).or_default().push(*time);
    }

    let mut items = Vec::new();
    for (chunk_id, chunk_times) in chunks {
        if !backend.is_current(token) {
            return Err(MediaError::Io(
                "Background media task cancelled.".to_string(),
            ));
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
                        return Err(MediaError::Io(
                            "Background media task cancelled.".to_string(),
                        ));
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

pub fn generate_playback_proxy(
    input_path: &str,
    video_id: &str,
    backend: &BackgroundMediaBackend,
    token: u64,
) -> Result<String, MediaError> {
    generate_playback_proxy_with_options(input_path, video_id, backend, token, false)
}

pub fn generate_playback_proxy_with_options(
    input_path: &str,
    video_id: &str,
    backend: &BackgroundMediaBackend,
    token: u64,
    force_cpu: bool,
) -> Result<String, MediaError> {
    let _lock = backend
        .proxy_lock
        .lock()
        .map_err(|_| MediaError::Io("Proxy lock is poisoned.".into()))?;
    if token != backend.proxy_token() {
        return Err(MediaError::Io("Playback proxy cancelled.".into()));
    }
    if let Ok(mut progress) = backend.proxy_progress.lock() {
        *progress = None;
    }
    let fingerprint = create_video_cache_id(input_path)?;
    let probe = super::ffprobe::probe_media(input_path)?;
    if probe.has_video != Some(true) {
        return Err(MediaError::Io("This file has no video to optimize.".into()));
    }
    let output = super::proxy_cache::root().join(format!("{fingerprint}-{}.mp4", if force_cpu { "cpu-v3" } else { "v2" }));
    // Cached output is validated before use; a partial/truncated file is never registered.
    if let Ok(cached) = super::ffprobe::probe_media(&output.to_string_lossy()) {
        if cached.has_video == Some(true) && (cached.duration - probe.duration).abs() < 0.25 {
            return Ok(output.to_string_lossy().into_owned());
        }
    }
    if token != backend.proxy_token() {
        return Err(MediaError::Io("Playback proxy cancelled.".into()));
    }
    if !backend.budget(MediaTaskKind::Proxy).allowed {
        return Err(MediaError::Io("Playback optimization is unavailable while exporting or under heavy load. Pause playback and retry.".into()));
    }
    super::proxy_cache::reserve_space()?;
    let _output_lease = super::proxy_cache::Lease::new(&output);
    let temporary = super::atomic_file::temporary_path(&output);
    let _temporary_lease = super::proxy_cache::Lease::new(&temporary);
    let _artifacts = ExportArtifacts(vec![temporary.to_string_lossy().into_owned()]);
    if let Ok(mut progress) = backend.proxy_progress.lock() {
        *progress = Some(PlaybackProxyProgress {
            video_id: video_id.into(),
            progress: 0.0,
        });
    }
    let _active = ActiveTaskGuard::new(backend.active_tasks.clone());
    let mut command = media_command(ffmpeg_path()?);
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", "-i"])
        .arg(input_path)
        .args(["-filter_threads", "1", "-map", "0:V:0", "-map", "0:a:0?", "-vf",
            "scale=w='max(2,trunc(min(1280,min(720,ih)*dar)/2)*2)':h='max(2,trunc(min(720,min(1280,iw*sar)/dar)/2)*2)':flags=fast_bilinear,setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
            "-force_key_frames", "expr:gte(t,n_forced*0.5)", "-fps_mode", "vfr",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-threads", "1",
            "-progress", "pipe:1", "-nostats", "-fs"])
        .arg(super::proxy_cache::MAX_PROXY_BYTES.to_string())
        .arg(&temporary).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut gpu = if force_cpu {
        backend.acceleration.report("proxy", "CPU", Some("WebView could not play the source; preparing a compatible H.264/AAC copy on CPU".into()));
        None
    } else { backend.acceleration.plan(&command, "proxy", backend.playing.load(Ordering::Acquire), true) };
    loop {
    let mut accelerated;
    let attempt = if let Some(plan) = gpu.as_ref() {
        accelerated = plan.command(&command);
        &mut accelerated
    } else { &mut command };
    attempt.stdout(Stdio::piped()).stderr(Stdio::piped());
    configure_background_priority(attempt);
    let mut child = match attempt.spawn() {
        Ok(child) => child,
        Err(error) if gpu.is_some() => {
            backend.acceleration.report("proxy", "CPU", Some(format!("GPU process failed: {error}")));
            gpu = None;
            continue;
        }
        Err(error) => return Err(error.into()),
    };
    let stderr = child.stderr.take().expect("piped proxy stderr");
    let stdout = child.stdout.take().expect("piped proxy progress");
    let reader = thread::spawn(move || {
        let mut stderr = stderr;
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 {
                break;
            }
            let keep = count.min(65_536_usize.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&buffer[..keep]);
        }
        bytes
    });
    let progress_backend = backend.clone();
    let duration = probe.duration;
    let encoded_time = Arc::new(AtomicU64::new(0));
    let progress_time = encoded_time.clone();
    let progress_reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(time) = line
                .strip_prefix("out_time_us=")
                .and_then(|value| value.parse::<f64>().ok())
            {
                progress_time.store(time.max(0.0) as u64, Ordering::Release);
                if let Ok(mut progress) = progress_backend.proxy_progress.lock() {
                    if let Some(progress) = progress.as_mut() {
                        progress.progress = (time / 1_000_000.0 / duration).clamp(0.0, 0.99);
                    }
                }
            }
        }
    });
    let mut last_progress = 0;
    let mut last_progress_at = Instant::now();
    let result = loop {
        if token != backend.proxy_token() {
            break Err(MediaError::Io("Playback proxy cancelled.".into()));
        }
        if !backend.budget(MediaTaskKind::Proxy).allowed {
            break Err(MediaError::Io("Playback optimization stopped to keep playback responsive. Pause playback and retry.".into()));
        }
        if gpu.is_some() && backend.playing.load(Ordering::Acquire) {
            break Err(MediaError::Io("GPU released for playback; restarting proxy on CPU.".into()));
        }
        if gpu.is_some() {
            let progress = encoded_time.load(Ordering::Acquire);
            if progress > last_progress { last_progress = progress; last_progress_at = Instant::now(); }
            if last_progress_at.elapsed() > Duration::from_secs(20) {
                break Err(MediaError::Io("GPU proxy made no progress for 20 seconds.".into()));
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Err(error) => break Err(MediaError::from(error)),
            Ok(None) => thread::sleep(Duration::from_millis(100)),
        }
    };
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let diagnostics = reader.join().unwrap_or_default();
    let _ = progress_reader.join();
    if gpu.is_some() && token == backend.proxy_token()
        && backend.budget(MediaTaskKind::Proxy).allowed
        && !result.as_ref().is_ok_and(|status| status.success()) {
        let reason = result.as_ref().err().map(ToString::to_string).unwrap_or_else(|| String::from_utf8_lossy(&diagnostics).trim().into());
        backend.acceleration.report("proxy", "CPU", Some(format!("GPU failed; retrying from source: {reason}")));
        gpu = None;
        continue;
    }
    if !result?.success() {
        return Err(MediaError::Io(format!(
            "Could not prepare playback copy: {}",
            String::from_utf8_lossy(&diagnostics).trim()
        )));
    }
    break;
    }
    if token != backend.proxy_token() {
        return Err(MediaError::Io("Playback proxy cancelled.".into()));
    }
    let completed = super::ffprobe::probe_media(&temporary.to_string_lossy())?;
    if (completed.duration - probe.duration).abs() >= 0.25
        || temporary.metadata()?.len() > super::proxy_cache::MAX_PROXY_BYTES
    {
        return Err(MediaError::Io("The optimized copy exceeded the 2 GiB cache limit or was incomplete. The original remains available.".into()));
    }
    if create_video_cache_id(input_path)? != fingerprint {
        return Err(MediaError::Io(
            "The source changed while preparing playback.".into(),
        ));
    }
    super::atomic_file::replace(&temporary, &output)?;
    if let Ok(mut progress) = backend.proxy_progress.lock() {
        if let Some(progress) = progress.as_mut() {
            progress.progress = 1.0;
        }
    }
    Ok(output.to_string_lossy().into_owned())
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
        .arg(format!("scale={width}:{height}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop={width}:{height},setsar=1"))
        .arg("-q:v")
        .arg("5")
        .arg(&temp)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let status = run_thumbnail_status(&mut command, backend, token, false).map_err(MediaError::from)?;
    if !status.success() || !temp.is_file() {
        let _ = fs::remove_file(&temp);
        return Err(MediaError::Io(
            "FFmpeg could not generate a timeline thumbnail.".to_string(),
        ));
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
    let filter = format!("fps={fps:.6},scale={width}:{height}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop={width}:{height},setsar=1");
    let duration = (end_time - start_time).max(interval);

    let ffmpeg = ffmpeg_path()?;
    let threads = backend.thumbnail_threads();
    let mut command = media_command(&ffmpeg);
    command
        .arg("-hide_banner")
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
    let status = run_thumbnail_status(&mut command, backend, token, true);

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

fn run_thumbnail_status(command: &mut Command, backend: &BackgroundMediaBackend, token: u64, batch: bool)
    -> Result<std::process::ExitStatus, std::io::Error> {
    if let Some(plan) = backend.acceleration.plan(command, "thumbnails", backend.playing.load(Ordering::Acquire), batch) {
        let mut gpu = plan.command(command);
        gpu.stdout(Stdio::null()).stderr(Stdio::null());
        let result = run_background_status(&mut gpu, backend, token);
        if result.as_ref().is_ok_and(|status| status.success()) { return result; }
        if !backend.is_current(token) { return result; }
        backend.acceleration.report("thumbnails", "CPU", Some("GPU thumbnail decode failed or timed out; retrying on CPU".into()));
        if batch {
            if let Some(directory) = command.get_args().last().and_then(|path| Path::new(path).parent()) {
                // Only private FFmpeg image-sequence artifacts are removed before retry.
                for entry in fs::read_dir(directory)?.filter_map(Result::ok) {
                    if entry.file_name().to_string_lossy().starts_with("frame_") && entry.path().extension().is_some_and(|e| e == "jpg") {
                        fs::remove_file(entry.path())?;
                    }
                }
            }
        }
    }
    run_background_status(command, backend, token)
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
        if clip.source_start.is_some_and(|time| !time.is_finite() || time < 0.0) {
            return Err(MediaError::InvalidStartTime);
        }
        if !clip.start_time.is_finite() || clip.start_time < 0.0 {
            return Err(MediaError::InvalidStartTime);
        }

        if !clip.end_time.is_finite() || clip.end_time <= clip.start_time {
            return Err(MediaError::InvalidEndTime);
        }
    }

    let input_canonical = input_path.canonicalize()?;
    if request.timeline && request.clips.windows(2).any(|pair| pair[0].end_time > pair[1].start_time + 0.000001) {
        return Err(MediaError::Io("Timeline clips must be ordered and must not overlap.".into()));
    }
    let outputs = request_output_paths(request);
    let mut unique = HashSet::new();
    for output in outputs {
        let output_path = PathBuf::from(&output);
        let parent = output_path.parent().ok_or(MediaError::EmptyOutputPath)?;
        if !parent.is_dir() {
            return Err(MediaError::Io("Output directory does not exist.".into()));
        }
        if normalize_path(&output_path) == input_canonical
            || (output_path.exists() && output_path.canonicalize()? == input_canonical)
        {
            return Err(MediaError::SameInputOutput);
        }
        if !unique.insert(normalize_path(&output_path)) {
            return Err(MediaError::Io("Export filenames must be unique.".into()));
        }
        if output_path.exists()
            && ((!request.timeline && request.clips.len() > 1) || output_path != Path::new(&request.output_path))
        {
            return Err(MediaError::Io(format!(
                "Output already exists: {output}. Choose a new export name."
            )));
        }
    }
    let settings = &request.settings;
    if matches!(settings.format, ExportFormat::Webm)
        && (matches!(settings.mode, ExportMode::StreamCopy)
            || !matches!(settings.video_codec, VideoCodec::Vp9 | VideoCodec::Av1)
            || settings.audio_codec != AudioCodec::Opus)
    {
        return Err(MediaError::Io(
            "WebM requires encoding with VP9/AV1 and Opus. Use MKV to copy source streams.".into(),
        ));
    }
    if settings
        .fps
        .is_some_and(|fps| !fps.is_finite() || fps <= 0.0 || fps > 240.0)
        || settings
            .width
            .is_some_and(|v| v < 2 || v > 16384 || v % 2 != 0)
        || settings
            .height
            .is_some_and(|v| v < 2 || v > 16384 || v % 2 != 0)
        || settings.crf.is_some_and(|v| {
            v > if matches!(settings.video_codec, VideoCodec::H264 | VideoCodec::H265) {
                51
            } else {
                63
            }
        })
    {
        return Err(MediaError::Io(
            "Invalid export dimensions, FPS or CRF. Dimensions must be even.".into(),
        ));
    }
    if settings.video_codec == VideoCodec::Copy
        && (settings.width.is_some() || settings.height.is_some() || settings.fps.is_some())
        && matches!(settings.mode, ExportMode::Encode)
    {
        return Err(MediaError::Io(
            "Choose a video encoder to change resolution or FPS.".into(),
        ));
    }
    for clip in &request.clips {
        let crops: Vec<_> = request
            .annotations
            .iter()
            .filter(|a| {
                a.visible
                    && a.annotation_type == ExportAnnotationType::Crop
                    && a.start_time < clip.end_time
                    && a.end_time > clip.start_time
            })
            .collect();
        if crops.len() > 1
            || crops
                .iter()
                .any(|a| a.start_time > clip.start_time || a.end_time < clip.end_time)
        {
            return Err(MediaError::Io("Use one crop covering the entire exported clip; output dimensions cannot change during a clip.".into()));
        }
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
    gpu: Option<&super::acceleration::Plan>,
    timeline: &[ExportClip],
) -> Result<(Child, std::process::ChildStderr), MediaError> {
    let mut command = build_export_job(
        ffmpeg,
        input_path,
        output_path,
        clip,
        settings,
        annotations,
        threads,
        timeline,
    )?;
    if let Some(plan) = gpu {
        command = plan.command(&command);
        command.stdout(Stdio::null()).stderr(Stdio::piped());
    }
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

fn build_export_job(ffmpeg: &Path, input: &str, output: &str, clip: &ExportClip, settings: &ExportSettings, annotations: &[ExportAnnotation], threads: usize, timeline: &[ExportClip]) -> Result<Command, MediaError> {
    if timeline.is_empty() { build_export_command(ffmpeg, input, output, clip, settings, annotations, threads) }
    else { timeline_export::build(ffmpeg, input, output, timeline, settings, annotations, threads) }
}

pub(super) fn build_export_command(
    ffmpeg: &Path,
    input_path: &str,
    output_path: &str,
    clip: &ExportClip,
    settings: &ExportSettings,
    annotations: &[ExportAnnotation],
    threads: usize,
) -> Result<Command, MediaError> {
    let mut command = media_command(ffmpeg);
    command
        .args(["-hide_banner", "-nostdin", "-y", "-filter_threads", "1"])
        .arg("-threads")
        .arg(threads.clamp(1, 8).to_string())
        .arg("-ss")
        .arg(format_seconds(clip.source_start.unwrap_or(clip.start_time)))
        .arg("-i")
        .arg(input_path)
        .arg("-t")
        .arg(format_seconds(clip.end_time - clip.start_time))
        .args(["-map", "0:V:0?", "-map", "0:a?", "-map_metadata", "0"]);
    let overlay_path = write_clip_ass_overlay(
        clip,
        annotations,
        &Path::new(output_path).with_extension("ass"),
    )?;
    let filters = annotation_filters(clip, annotations, overlay_path.as_deref());
    let copies_video = filters.is_empty()
        && (matches!(settings.mode, ExportMode::StreamCopy)
            || settings.video_codec == VideoCodec::Copy);
    apply_export_settings(&mut command, settings, filters);
    command.arg("-threads").arg(threads.clamp(1, 8).to_string());
    if copies_video {
        command.args(["-avoid_negative_ts", "make_zero"]);
    }
    if matches!(settings.format, ExportFormat::Mp4 | ExportFormat::Mov) {
        command.args(["-movflags", "+faststart"]);
    }
    command
        .args(["-progress", "pipe:2"])
        .arg(output_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    Ok(command)
}

struct ExportArtifacts(Vec<String>);
impl Drop for ExportArtifacts {
    fn drop(&mut self) {
        for output in &self.0 {
            let _ = fs::remove_file(output);
            let _ = fs::remove_file(Path::new(output).with_extension("ass"));
            let _ = fs::remove_file(Path::new(output).with_extension("filter"));
            let _ = fs::remove_file(Path::new(output).with_extension("gpu.filter"));
        }
    }
}

fn annotation_filters(
    clip: &ExportClip,
    annotations: &[ExportAnnotation],
    overlay: Option<&Path>,
) -> Vec<String> {
    let active: Vec<_> = annotations
        .iter()
        .filter(|a| a.visible && a.start_time < clip.end_time && a.end_time > clip.start_time)
        .collect();
    let mut filters = Vec::new();
    for (index, a) in active
        .iter()
        .filter(|a| a.annotation_type == ExportAnnotationType::Blur)
        .enumerate()
    {
        let x = clamp01(a.x);
        let y = clamp01(a.y);
        let w = a.width.clamp(0.001, (1.0 - x).max(0.001));
        let h = a.height.clamp(0.001, (1.0 - y).max(0.001));
        let start = (a.start_time - clip.start_time).max(0.0);
        let end = a.end_time.min(clip.end_time) - clip.start_time;
        let radius = (a.thickness * 2.0).clamp(4.0, 80.0);
        let alpha = a.opacity.clamp(0.0, 100.0) / 100.0;
        filters.push(format!("split[base{index}][region{index}];[region{index}]crop=w='max(2,trunc(iw*{w}/2)*2)':h='max(2,trunc(ih*{h}/2)*2)':x='trunc(iw*{x}/2)*2':y='trunc(ih*{y}/2)*2',boxblur=luma_radius='min({radius},min(w,h)/2)':luma_power=2:chroma_radius='min({radius},min(cw,ch)/2)',format=rgba,colorchannelmixer=aa={alpha}[blur{index}];[base{index}][blur{index}]overlay=x='trunc(main_w*{x}/2)*2':y='trunc(main_h*{y}/2)*2':enable='gte(t,{start})*lt(t,{end})'"));
    }
    if let Some(path) = overlay {
        filters.push(format!("ass='{}'", escape_filter_path(path)));
    }
    if let Some(a) = active
        .iter()
        .find(|a| a.annotation_type == ExportAnnotationType::Crop)
    {
        filters.push(format!("crop=w='max(2,trunc(iw*{}/2)*2)':h='max(2,trunc(ih*{}/2)*2)':x='trunc(iw*{}/2)*2':y='trunc(ih*{}/2)*2'", clamp01(a.width), clamp01(a.height), clamp01(a.x), clamp01(a.y)));
    }
    filters
}

fn apply_export_settings(
    command: &mut Command,
    settings: &ExportSettings,
    mut filters: Vec<String>,
) {
    let has_overlay = !filters.is_empty();

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
    if !filters.is_empty() {
        command.arg("-vf").arg(filters.join(","));
    }
    if settings.video_codec != VideoCodec::Copy || has_overlay {
        command.args(["-pix_fmt", "yuv420p"]);
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
    path: &Path,
) -> Result<Option<PathBuf>, MediaError> {
    let events = annotations
        .iter()
        .filter(|annotation| {
            annotation.visible
                && !matches!(
                    annotation.annotation_type,
                    ExportAnnotationType::Blur | ExportAnnotationType::Crop
                )
        })
        .filter_map(|annotation| ass_event_for_annotation(clip, annotation))
        .collect::<Vec<_>>();

    if events.is_empty() {
        return Ok(None);
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
    Ok(Some(path.to_path_buf()))
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
        ExportAnnotationType::Blur | ExportAnnotationType::Crop => None,
        ExportAnnotationType::Rectangle => {
            let draw_alpha = alpha;
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
        ExportAnnotationType::Highlight => {
            Some(ass_draw(&rect_path(x, y, width, height), &color, &alpha))
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
    if clean.len() != 6 || !clean.bytes().all(|b| b.is_ascii_hexdigit()) {
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
    command.arg("-crf").arg(crf.to_string());
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
    gpu_resources: Option<&BackgroundMediaBackend>,
) -> Option<std::process::ExitStatus> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(64);
    let reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if sender.send(line).is_err() { break; }
        }
    });
    let mut last_progress = 0.0;
    let mut last_progress_at = Instant::now();
    loop {
        if gpu_resources.is_some_and(|resources| resources.playing.load(Ordering::Acquire)) {
            *last_details = "GPU released for smooth playback".into();
            if let Ok(mut child) = child_ref.lock() { let _ = child.kill(); }
            break;
        }
        if gpu_resources.is_some() && last_progress_at.elapsed() > Duration::from_secs(20) {
            *last_details = "GPU export made no progress for 20 seconds".into();
            if let Ok(mut child) = child_ref.lock() { let _ = child.kill(); }
            break;
        }
        let line = match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => line,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if let Some(clip_progress) = parse_progress_line(&line, clip_duration) {
            // The displayed fraction caps at 99%; watchdog progress must keep advancing on long exports.
            let encoded_time = line.split_once('=').and_then(|(_, value)| value.parse::<f64>().ok()).unwrap_or(0.0);
            if encoded_time > last_progress { last_progress = encoded_time; last_progress_at = Instant::now(); }
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
    drop(receiver);
    let _ = reader.join();

    child_ref
        .lock()
        .ok()
        .and_then(|mut child| child.wait().ok())
}

fn request_output_paths(request: &ExportTrimRequest) -> Vec<String> {
    if request.timeline { vec![with_format_extension(Path::new(&request.output_path), request.settings.format)] }
    else { output_paths_for_clips(&request.output_path, &request.clips, request.settings.format) }
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
    fn proxy_survives_play_pause_but_yields_to_pressure_and_export() {
        let manager = BackgroundMediaBackend::default();
        let token = manager.proxy_token();
        manager.set_playing(true);
        assert_eq!(manager.proxy_token(), token);
        let budget = calculate_budget(
            MediaTaskKind::Proxy,
            PerformancePreset::Balanced,
            PressureLevel::Normal,
            true,
            false,
            8,
        );
        assert!(budget.allowed);
        assert_eq!(budget.cpu_threads, 1);
        for pressure in [PressureLevel::High, PressureLevel::Critical] {
            assert!(
                !calculate_budget(
                    MediaTaskKind::Proxy,
                    PerformancePreset::Balanced,
                    pressure,
                    true,
                    false,
                    8
                )
                .allowed
            );
        }
        manager.set_playing(false);
        assert_eq!(manager.proxy_token(), token);
        manager.set_exporting(true);
        assert_ne!(manager.proxy_token(), token);
        assert!(!manager.budget(MediaTaskKind::Proxy).allowed);
    }

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
#[cfg(test)]
#[path = "export_tests.rs"]
mod export_tests;
#[cfg(test)]
#[path = "playback_tests.rs"]
mod playback_tests;
