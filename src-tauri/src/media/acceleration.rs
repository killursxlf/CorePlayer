use super::binaries::{ffmpeg_path, media_command};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Auto,
    Gpu,
    Cpu,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub mode: Mode,
    pub device_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub encoders: Vec<String>,
    pub decoders: Vec<String>,
    pub diagnostics: Vec<String>,
    index: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub task: String,
    pub accelerator: String,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub playback_cpu: bool,
    pub settings: Settings,
    pub devices: Vec<Device>,
    pub checked: bool,
    pub diagnostic: Option<String>,
    pub usage: HashMap<String, Usage>,
}

#[derive(Clone, Default)]
pub struct Acceleration {
    playing: Arc<AtomicBool>,
    settings_path: Option<std::path::PathBuf>,
    state: Arc<Mutex<Status>>,
    busy: Arc<AtomicBool>,
    // ponytail: one GPU worker across adapters; per-device limits if multi-GPU throughput matters.
    decode_checks: Arc<Mutex<HashMap<String, Result<bool, String>>>>,
}

pub struct Lease(Arc<AtomicBool>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub struct Plan {
    pub device: Device,
    pub decode: bool,
    pub encoder: Option<String>,
    _lease: Lease,
}

#[cfg(test)]
fn run(command: &mut Command) -> Result<std::process::Output, String> {
    let output = super::ffprobe::run_probe_with_timeout(command, Duration::from_secs(12))
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(2000)
            .collect())
    }
}

fn run_unless_playing(
    command: &mut Command,
    playing: &AtomicBool,
) -> Result<std::process::Output, String> {
    let output = super::ffprobe::run_probe_cancellable(command, Duration::from_secs(12), || {
        playing.load(Ordering::Acquire)
    })
    .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(2000)
            .collect())
    }
}

fn base(ffmpeg: &Path) -> Command {
    let mut command = media_command(ffmpeg);
    command.args([
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-threads",
        "1",
    ]);
    command
}

impl Device {
    fn verify(&self, ffmpeg: &Path, playing: &AtomicBool) -> Result<(), String> {
        let mut cmd = base(ffmpeg);
        cmd.args(["-loglevel", "verbose", "-init_hw_device"])
            .arg(format!("d3d11va=gpu:{}", self.index))
            .args([
                "-f",
                "lavfi",
                "-i",
                "color=size=640x360",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ]);
        let output = run_unless_playing(&mut cmd, playing)?;
        let expected = format!("({})", self.name);
        if !String::from_utf8_lossy(&output.stderr)
            .lines()
            .any(|line| line.contains("Using device ") && line.contains(&expected))
        {
            return Err("Selected adapter disappeared or changed; FFmpeg's implicit default adapter is not accepted".into());
        }
        Ok(())
    }
    fn init(&self, encode: bool) -> Vec<String> {
        let mut args = vec![
            "-init_hw_device".into(),
            format!("d3d11va=gpu:{}", self.index),
        ];
        if encode && self.vendor == "qsv" {
            args.extend(["-init_hw_device".into(), "qsv=encoder@gpu".into()]);
        }
        args.extend([
            "-filter_hw_device".into(),
            if encode && self.vendor == "qsv" {
                "encoder"
            } else {
                "gpu"
            }
            .into(),
        ]);
        args
    }
    fn decode_args(&self) -> [&'static str; 6] {
        [
            "-hwaccel",
            "d3d11va",
            "-hwaccel_device",
            "gpu",
            "-hwaccel_output_format",
            "d3d11",
        ]
    }
    fn label(&self) -> String {
        format!(
            "{} / {}",
            self.name,
            match self.vendor.as_str() {
                "nvenc" => "NVENC / NVDEC (D3D11VA)",
                "qsv" => "Intel Quick Sync",
                _ => "AMF / D3D11VA",
            }
        )
    }
}

impl Acceleration {
    pub fn set_playing(&self, playing: bool) {
        self.playing.store(playing, Ordering::Release);
    }
    pub fn load(path: Option<std::path::PathBuf>) -> Self {
        let result = Self {
            settings_path: path,
            ..Self::default()
        };
        if let Some(settings) = result
            .settings_path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        {
            let mut state = result.state.lock().unwrap();
            state.playback_cpu = settings.mode == Mode::Cpu;
            state.settings = settings;
        }
        result
    }
    pub fn status(&self) -> Status {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn settings(&self, settings: Settings) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if settings.mode != Mode::Cpu
            && settings
                .device_id
                .as_ref()
                .is_some_and(|id| !state.devices.iter().any(|d| &d.id == id))
        {
            return Err("The selected GPU is unavailable. Refresh devices or select Auto.".into());
        }
        if let Some(path) = &self.settings_path {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let temporary = super::atomic_file::temporary_path(path);
            let saved = serde_json::to_vec(&settings).map_err(|e| e.to_string())?;
            let result = std::fs::write(&temporary, saved)
                .and_then(|_| super::atomic_file::replace(&temporary, path));
            if let Err(error) = result {
                let _ = std::fs::remove_file(temporary);
                return Err(error.to_string());
            }
        }
        state.settings = settings;
        Ok(())
    }

    fn lease(&self) -> Option<Lease> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .ok()
            .map(|_| Lease(self.busy.clone()))
    }

    pub fn report(&self, task: &str, accelerator: &str, reason: Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            state.usage.insert(
                task.into(),
                Usage {
                    task: task.into(),
                    accelerator: accelerator.into(),
                    reason,
                },
            );
        }
    }

    pub fn discover(&self) -> Status {
        let Some(_lease) = self.lease() else {
            return self.status();
        };
        let detected = self.detect();
        if self.playing.load(Ordering::Acquire) {
            return self.status();
        }
        if let Ok(mut state) = self.state.lock() {
            match detected {
                Ok(devices) => {
                    state.devices = devices;
                    state.diagnostic = None;
                }
                Err(error) => {
                    state.devices.clear();
                    state.diagnostic = Some(error);
                }
            }
            state.checked = true;
        }
        if let Ok(mut cache) = self.decode_checks.lock() {
            cache.clear();
        }
        self.status()
    }

    fn detect(&self) -> Result<Vec<Device>, String> {
        if !cfg!(windows) {
            return Err(
                "GPU device selection currently requires Windows / D3D11. CPU remains available."
                    .into(),
            );
        }
        let ffmpeg = ffmpeg_path().map_err(|e| e.to_string())?;
        let root = std::env::temp_dir().join(format!("coreplayer-gpu-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let result = (|| {
            let mut samples = Vec::new();
            for (codec, encoder) in [
                ("h264", "libx264"),
                ("hevc", "libx265"),
                ("vp9", "libvpx-vp9"),
                ("av1", "libaom-av1"),
            ] {
                if self.playing.load(Ordering::Acquire) {
                    return Err("GPU detection paused for playback".into());
                }
                let path = root.join(format!("{codec}.mkv"));
                let mut cmd = base(&ffmpeg);
                cmd.args([
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=640x360:rate=25",
                    "-frames:v",
                    "4",
                    "-c:v",
                    encoder,
                    "-threads",
                    "1",
                ]);
                if matches!(codec, "h264" | "hevc") {
                    cmd.args(["-preset", "ultrafast"]);
                } else {
                    cmd.args(["-cpu-used", "8"]);
                }
                cmd.arg(&path);
                if run_unless_playing(&mut cmd, &self.playing).is_ok() {
                    samples.push((codec, path));
                }
            }
            let mut devices = Vec::new();
            // ponytail: bounded adapter scan (16); use DXGI enumeration if larger workstations need it.
            for index in 0..16 {
                if self.playing.load(Ordering::Acquire) {
                    return Err("GPU detection paused for playback".into());
                }
                let mut cmd = base(&ffmpeg);
                cmd.args(["-loglevel", "verbose", "-init_hw_device"])
                    .arg(format!("d3d11va=gpu:{index}"))
                    .args([
                        "-f",
                        "lavfi",
                        "-i",
                        "color=size=640x360",
                        "-frames:v",
                        "1",
                        "-f",
                        "null",
                        "-",
                    ]);
                let Ok(output) = run_unless_playing(&mut cmd, &self.playing) else {
                    break;
                };
                let text = String::from_utf8_lossy(&output.stderr);
                let Some(line) = text
                    .lines()
                    .find_map(|l| l.split_once("Using device ").map(|(_, s)| s))
                else {
                    break;
                };
                let vendor = if line.starts_with("10de:") {
                    "nvenc"
                } else if line.starts_with("8086:") {
                    "qsv"
                } else if line.starts_with("1002:") {
                    "amf"
                } else {
                    continue;
                };
                let name = line
                    .split_once('(')
                    .map(|(_, s)| s.trim_end_matches(['.', ')']))
                    .unwrap_or(line)
                    .to_string();
                let mut device = Device {
                    id: format!("d3d11:{index}:{name}"),
                    name,
                    vendor: vendor.into(),
                    index,
                    encoders: Vec::new(),
                    decoders: Vec::new(),
                    diagnostics: Vec::new(),
                };
                for codec in ["h264", "hevc", "av1"] {
                    let encoder = format!("{codec}_{vendor}");
                    let mut cmd = base(&ffmpeg);
                    cmd.args(device.init(true)).args([
                        "-f",
                        "lavfi",
                        "-i",
                        "testsrc2=size=640x360:rate=25",
                        "-vf",
                        "format=nv12,hwupload",
                        "-c:v",
                        &encoder,
                        "-frames:v",
                        "4",
                        "-f",
                        "null",
                        "-",
                    ]);
                    match run_unless_playing(&mut cmd, &self.playing) {
                        Ok(_) => device.encoders.push(encoder),
                        Err(e) => device.diagnostics.push(format!("{encoder}: {e}")),
                    }
                }
                for (codec, path) in &samples {
                    match check_decode(&ffmpeg, &device, path, &self.playing) {
                        Ok(_) => device.decoders.push((*codec).into()),
                        Err(e) => device.diagnostics.push(format!("{codec} decode: {e}")),
                    }
                }
                if !device.encoders.is_empty() || !device.decoders.is_empty() {
                    devices.push(device);
                }
            }
            Ok(devices)
        })();
        let _ = std::fs::remove_dir_all(root);
        result
    }

    pub fn plan(
        &self,
        command: &Command,
        task: &str,
        playback: bool,
        decode_worthwhile: bool,
    ) -> Option<Plan> {
        let state = self.status();
        let cpu = |reason: &str| {
            self.report(task, "CPU", Some(reason.into()));
            None
        };
        if state.settings.mode == Mode::Cpu {
            return cpu("CPU selected in settings");
        }
        if playback {
            return cpu("GPU reserved for smooth playback");
        }
        if !decode_worthwhile && state.settings.mode == Mode::Auto {
            return cpu("CPU avoids GPU setup and transfers for a single thumbnail");
        }
        let Some(lease) = self.lease() else {
            return cpu("GPU worker limit reached (1); playback has priority");
        };
        let args: Vec<_> = command
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        let value = |key: &str| args.windows(2).find(|a| a[0] == key).map(|a| a[1].as_str());
        if args.iter().any(|a| a == "-vn") { return cpu("Audio-only export uses CPU"); }
        let codec = match value("-c:v") {
            Some("libx264") => Some("h264"),
            Some("libx265") => Some("hevc"),
            Some("libaom-av1") => Some("av1"),
            _ => None,
        };
        if value("-c") == Some("copy") || value("-c:v") == Some("copy") {
            self.report(task, "Stream copy", None);
            return None;
        }
        let Some(device) = state
            .devices
            .iter()
            .filter(|d| {
                state
                    .settings
                    .device_id
                    .as_ref()
                    .is_none_or(|id| id == &d.id)
            })
            .max_by_key(|d| {
                usize::from(
                    codec.is_some_and(|c| d.encoders.contains(&format!("{c}_{}", d.vendor))),
                )
            })
            .cloned()
        else {
            return cpu(if state.checked {
                "No verified GPU available"
            } else {
                "GPU detection has not completed"
            });
        };
        if let Err(error) = ffmpeg_path()
            .map_err(|e| e.to_string())
            .and_then(|ffmpeg| device.verify(&ffmpeg, &self.playing))
        {
            return cpu(&error);
        }
        let encoder = codec
            .map(|c| format!("{c}_{}", device.vendor))
            .filter(|e| device.encoders.contains(e));
        let mut decode = false;
        let mut reason = None;
        if value("-/filter_complex").is_some() {
            reason = Some("Timeline filters decode on CPU; GPU is used for encoding".into());
        } else if decode_worthwhile || state.settings.mode == Mode::Gpu {
            if let Some(input) = value("-i") {
                let fingerprint =
                    super::ffmpeg::create_video_cache_id(input).unwrap_or_else(|_| input.into());
                let key = format!("{}:{fingerprint}", device.id);
                let cached = self
                    .decode_checks
                    .lock()
                    .ok()
                    .and_then(|cache| cache.get(&key).cloned());
                let checked = cached.unwrap_or_else(|| {
                    let result = ffmpeg_path().map_err(|e| e.to_string()).and_then(|ffmpeg| {
                        check_decode(&ffmpeg, &device, Path::new(input), &self.playing)
                    });
                    if let Ok(mut cache) = self.decode_checks.lock() {
                        if cache.len() >= 128 {
                            cache.clear();
                        }
                        if !self.playing.load(Ordering::Acquire) {
                            cache.insert(key, result.clone());
                        }
                    }
                    result
                });
                match checked {
                    Ok(faster) => {
                        decode = faster || state.settings.mode == Mode::Gpu;
                        if !decode {
                            reason = Some("CPU decode was faster in the source sample".into());
                        }
                    }
                    Err(error) => reason = Some(format!("CPU decode: {error}")),
                }
            }
        } else {
            reason = Some("CPU decode avoids GPU setup for a single thumbnail".into());
        }
        if self.playing.load(Ordering::Acquire) {
            return cpu("GPU reserved for smooth playback");
        }
        if !decode && encoder.is_none() {
            return cpu(reason
                .as_deref()
                .unwrap_or("Codec is not supported by the selected GPU"));
        }
        let plan = Plan {
            device,
            decode,
            encoder,
            _lease: lease,
        };
        self.report(
            task,
            &format!(
                "{}; decode: {}; encode: {}",
                plan.device.label(),
                if decode { "GPU" } else { "CPU" },
                plan.encoder.as_deref().unwrap_or("CPU")
            ),
            reason,
        );
        Some(plan)
    }
}

/// Subscribe through the existing WebView2 COM channel; no debugging port is opened.
#[cfg(windows)]
pub fn observe_playback(window: &tauri::WebviewWindow, acceleration: Acceleration) {
    let failed = acceleration.clone();
    let result = window.with_webview(move |webview| unsafe {
        use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler, CoTaskMemPWSTR};
        use windows_core::{w, PWSTR};
        let install = || -> windows_core::Result<()> {
            let core = webview.controller().CoreWebView2()?;
            let receiver = core.GetDevToolsProtocolEventReceiver(w!("Media.playerPropertiesChanged"))?;
            let report = acceleration.clone();
            let mut players: HashMap<String, HashMap<String, String>> = HashMap::new();
            let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, event| {
                let Some(event) = event else { return Ok(()) };
                let mut raw = PWSTR::null();
                event.ParameterObjectAsJson(&mut raw)?;
                let text = CoTaskMemPWSTR::from(raw).to_string();
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    let Some(id) = value["playerId"].as_str() else { return Ok(()) };
                    if !players.contains_key(id) && players.len() >= 16 { players.clear(); }
                    let properties = players.entry(id.into()).or_default();
                    for item in value["properties"].as_array().into_iter().flatten() {
                        if let (Some(name), Some(value)) = (item["name"].as_str(), item["value"].as_str()) {
                            properties.insert(name.into(), value.into());
                        }
                    }
                    if let Some(name) = properties.get("kVideoDecoderName") {
                        let platform = properties.get("kIsPlatformVideoDecoder").map(|s| s == "true");
                        let accelerator = format!("WebView: {name} ({})", match platform { Some(true) => "GPU", Some(false) => "CPU", None => "unconfirmed" });
                        let reason = (platform == Some(false)).then(|| if report.status().playback_cpu {
                            "CPU selected at application startup".into()
                        } else { "WebView selected software decoding; hardware unavailable or stream unsupported (driver details not exposed)".into() });
                        report.report("playback", &accelerator, reason);
                    }
                }
                Ok(())
            }));
            let mut token = 0;
            receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)?;
            let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
                if let Err(error) = result { acceleration.report("playback", "WebView (unconfirmed)", Some(error.to_string())); }
                Ok(())
            }));
            core.CallDevToolsProtocolMethod(w!("Media.enable"), w!("{}"), &callback)?;
            Ok(())
        };
        if let Err(error) = install() { failed.report("playback", "WebView (unconfirmed)", Some(error.to_string())); }
    });
    if let Err(error) = result {
        log::warn!("Playback diagnostics unavailable: {error}");
    }
}

fn check_decode(
    ffmpeg: &Path,
    device: &Device,
    path: &Path,
    playing: &AtomicBool,
) -> Result<bool, String> {
    let mut hashes = Vec::new();
    let mut elapsed = Vec::new();
    for gpu in [false, true] {
        let mut cmd = base(ffmpeg);
        if gpu {
            cmd.args(device.init(false)).args(device.decode_args());
        }
        cmd.arg("-i")
            .arg(path)
            .args(["-map", "0:V:0", "-an", "-frames:v", "24", "-vf"])
            .arg(if gpu {
                "hwdownload,format=nv12,format=yuv420p"
            } else {
                "format=yuv420p"
            })
            .args(["-fps_mode", "passthrough", "-f", "framemd5", "-"]);
        let start = Instant::now();
        let output = run_unless_playing(&mut cmd, playing)?;
        elapsed.push(start.elapsed());
        hashes.push(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|l| !l.starts_with('#'))
                .collect::<Vec<_>>()
                .join("\n"),
        );
    }
    if hashes[0].is_empty() || hashes[0] != hashes[1] {
        return Err("GPU sample pixels/timestamps differ from CPU; using CPU".into());
    }
    Ok(elapsed[1] < elapsed[0])
}

impl Plan {
    pub fn command(&self, original: &Command) -> Command {
        let mut args: Vec<OsString> = original.get_args().map(OsString::from).collect();
        let mut prefix: Vec<OsString> = self
            .device
            .init(self.encoder.is_some())
            .into_iter()
            .map(OsString::from)
            .collect();
        if self.decode {
            prefix.extend(self.device.decode_args().map(OsString::from));
        }
        let encoder = self.encoder.as_deref();
        if let Some(encoder) = encoder {
            let quality = take_option(&mut args, "-crf").unwrap_or_else(|| "24".into());
            take_option(&mut args, "-preset");
            take_option(&mut args, "-pix_fmt");
            if let Some(index) = args.iter().position(|a| a == "-c:v") {
                args[index + 1] = encoder.into();
            }
            let has_bitrate = args.iter().any(|a| a == "-b:v");
            let mut quality_args: Vec<OsString> = Vec::new();
            if !has_bitrate {
                let options: Vec<&str> = match self.device.vendor.as_str() {
                    "nvenc" => vec!["-rc", "vbr", "-b:v", "0", "-cq"],
                    "qsv" => vec!["-global_quality"],
                    _ => vec!["-rc", "cqp", "-qp_i"],
                };
                quality_args.extend(options.into_iter().map(OsString::from));
                quality_args.push(quality.clone());
                if self.device.vendor == "amf" {
                    quality_args.extend(["-qp_p".into(), quality.clone(), "-qp_b".into(), quality]);
                }
            }
            // Options belong to the output, immediately before its path.
            args.splice(args.len() - 1..args.len() - 1, quality_args);
        }
        let filters = take_option(&mut args, "-vf").map(|s| s.to_string_lossy().into_owned());
        if let Some(index) = args.iter().position(|a| a == "-/filter_complex") {
            if encoder.is_some() {
                let script = Path::new(&args[index + 1]);
                let gpu_script = script.with_extension("gpu.filter");
                if let Ok(graph) = std::fs::read_to_string(script) {
                    if std::fs::write(&gpu_script, format!("{graph};\n[timelinev]format=nv12,hwupload[gpuv]")).is_ok() {
                        args[index + 1] = gpu_script.into_os_string();
                        for value in &mut args { if value == "[timelinev]" { *value = "[gpuv]".into(); } }
                    }
                }
            }
            prefix.extend(args);
            let mut command = media_command(original.get_program());
            command.args(prefix);
            return command;
        }
        let mut chain = Vec::new();
        if self.decode {
            chain.push("hwdownload,format=nv12".to_string());
        }
        if let Some(filters) = filters {
            chain.push(filters);
        }
        if encoder.is_some() {
            chain.push("format=nv12,hwupload".into());
        }
        if !chain.is_empty() {
            args.splice(
                args.len() - 1..args.len() - 1,
                ["-vf".into(), chain.join(",").into()],
            );
        }
        prefix.extend(args);
        let mut command = media_command(original.get_program());
        command.args(prefix);
        command
    }
}

fn take_option(args: &mut Vec<OsString>, key: &str) -> Option<OsString> {
    let index = args.iter().position(|a| a == key)?;
    args.remove(index);
    Some(args.remove(index))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cpu_mode_and_busy_gpu_fall_back_and_leases_release() {
        let manager = Acceleration::default();
        let lease = manager.lease().unwrap();
        assert!(manager.lease().is_none());
        drop(lease);
        assert!(manager.lease().is_some());
        manager
            .settings(Settings {
                mode: Mode::Cpu,
                device_id: None,
            })
            .unwrap();
        assert!(manager
            .plan(&Command::new("ffmpeg"), "proxy", false, true)
            .is_none());
        assert_eq!(manager.status().usage["proxy"].accelerator, "CPU");
        assert!(manager
            .settings(Settings {
                mode: Mode::Gpu,
                device_id: Some("missing".into())
            })
            .is_err());
    }
    #[test]
    fn hardware_arguments_preserve_audio_filters_timestamps_and_paths() {
        let manager = Acceleration::default();
        let plan = Plan {
            device: Device {
                id: "d3d11:2".into(),
                name: "test".into(),
                vendor: "nvenc".into(),
                index: 2,
                encoders: vec![],
                decoders: vec![],
                diagnostics: vec![],
            },
            decode: true,
            encoder: Some("h264_nvenc".into()),
            _lease: manager.lease().unwrap(),
        };
        let mut cpu = Command::new("ffmpeg");
        cpu.args([
            "-ss",
            "1.25",
            "-i",
            "a b.mp4",
            "-vf",
            "scale=640:360,setsar=1",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "20",
            "-c:a",
            "copy",
            "-fps_mode",
            "vfr",
            "out.mp4",
        ]);
        let gpu = plan.command(&cpu);
        let args: Vec<_> = gpu
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.windows(2).any(|a| a == ["-c:a", "copy"]));
        assert!(args.windows(2).any(|a| a == ["-ss", "1.25"]));
        assert!(args.windows(2).any(|a| a == ["-i", "a b.mp4"]));
        assert!(args.contains(
            &"hwdownload,format=nv12,scale=640:360,setsar=1,format=nv12,hwupload".into()
        ));
        assert!(!args.contains(&"-crf".into()));
        assert_eq!(args.last().unwrap(), "out.mp4");
        assert!(cpu.get_args().any(|a| a == "libx264"));
    }

    #[test]
    #[ignore = "Requires FFmpeg/ffprobe; probes installed GPUs and exercises driver failure"]
    fn hardware_roundtrip_and_cpu_recovery() {
        let ffmpeg = ffmpeg_path().unwrap();
        let manager = Acceleration::default();
        let status = manager.discover();
        println!("{}", serde_json::to_string_pretty(&status).unwrap());
        let root =
            std::env::temp_dir().join(format!("coreplayer-gpu-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("source.mp4");
        let mut cmd = base(&ffmpeg);
        cmd.args([
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=3",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-vf",
            "select='if(lt(t,1),not(mod(n,2)),1)'",
            "-fps_mode",
            "vfr",
        ])
        .arg(&source);
        run(&mut cmd).unwrap();
        for device in &status.devices {
            manager
                .settings(Settings {
                    mode: Mode::Gpu,
                    device_id: Some(device.id.clone()),
                })
                .unwrap();
            for encoder in &device.encoders {
                let output = root.join(format!("{}-{encoder}.mkv", device.index));
                use super::super::models::{
                    AudioCodec, ExportClip, ExportFormat, ExportMode, ExportSettings, VideoCodec,
                };
                let settings = ExportSettings {
                    format: ExportFormat::Mkv,
                    mode: ExportMode::Encode,
                    video_codec: if encoder.starts_with("hevc") {
                        VideoCodec::H265
                    } else if encoder.starts_with("av1") {
                        VideoCodec::Av1
                    } else {
                        VideoCodec::H264
                    },
                    audio_codec: AudioCodec::Copy,
                    video_bitrate_kbps: None,
                    audio_bitrate_kbps: None,
                    fps: None,
                    width: Some(640),
                    height: Some(360),
                    crf: Some(20),
                    preset: "fast".into(),
                };
                let clip = ExportClip {
                    source_start: None,
                    id: "gpu-test".into(),
                    label: "VFR".into(),
                    start_time: 0.0,
                    end_time: 3.0,
                };
                let cpu = super::super::ffmpeg::build_export_command(
                    &ffmpeg,
                    source.to_str().unwrap(),
                    output.to_str().unwrap(),
                    &clip,
                    &settings,
                    &[],
                    1,
                )
                .unwrap();
                let reference = root.join(format!("{}-{encoder}-cpu.mkv", device.index));
                let mut reference_command = super::super::ffmpeg::build_export_command(
                    &ffmpeg,
                    source.to_str().unwrap(),
                    reference.to_str().unwrap(),
                    &clip,
                    &settings,
                    &[],
                    1,
                )
                .unwrap();
                run(&mut reference_command).unwrap();
                let plan = manager
                    .plan(&cpu, "test", false, true)
                    .expect("verified hardware plan");
                assert!(
                    plan.decode,
                    "Hardware decoding must be verified, not silently replaced"
                );
                let mut gpu = plan.command(&cpu);
                run(&mut gpu).unwrap();
                drop(plan);
                let probe = super::super::ffprobe::probe_media(output.to_str().unwrap()).unwrap();
                assert!(probe.has_audio == Some(true) && probe.has_video == Some(true));
                assert!((probe.duration - 3.0).abs() < 0.1);
                let mut audio = Vec::new();
                for input in [&reference, &output] {
                    let mut cmd = base(&ffmpeg);
                    cmd.arg("-i")
                        .arg(input)
                        .args(["-map", "0:a:0", "-c:a", "copy", "-f", "hash", "-"]);
                    audio.push(run(&mut cmd).unwrap().stdout);
                }
                assert_eq!(audio[0], audio[1], "audio packets must be preserved");
                let mut timelines = Vec::new();
                for path in [&source, &output] {
                    let mut probe = media_command(super::super::binaries::ffprobe_path().unwrap());
                    probe
                        .args([
                            "-v",
                            "error",
                            "-select_streams",
                            "v:0",
                            "-show_frames",
                            "-show_entries",
                            "frame=best_effort_timestamp_time",
                            "-of",
                            "json",
                        ])
                        .arg(path);
                    let value: serde_json::Value =
                        serde_json::from_slice(&run(&mut probe).unwrap().stdout).unwrap();
                    let pts: Vec<f64> = value["frames"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|f| {
                            f["best_effort_timestamp_time"]
                                .as_str()
                                .unwrap()
                                .parse()
                                .unwrap()
                        })
                        .collect();
                    timelines.push(pts);
                }
                assert_eq!(
                    timelines[0].len(),
                    timelines[1].len(),
                    "no dropped/duplicated frames"
                );
                for (source, output) in timelines[0].iter().zip(&timelines[1]) {
                    assert!(
                        (source - timelines[0][0] - (output - timelines[1][0])).abs() < 0.002,
                        "VFR timestamps changed"
                    );
                }
                let mut compare = base(&ffmpeg);
                compare
                    .args(["-loglevel", "info", "-i"])
                    .arg(&source)
                    .arg("-i")
                    .arg(&output)
                    .args([
                        "-lavfi",
                        "[0:v]setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim",
                        "-an",
                        "-f",
                        "null",
                        "-",
                    ]);
                let result = run(&mut compare).unwrap();
                let diagnostics = String::from_utf8_lossy(&result.stderr);
                let ssim: f64 = diagnostics
                    .rsplit_once("All:")
                    .unwrap()
                    .1
                    .split_whitespace()
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                println!(
                    "{} {encoder}: SSIM={ssim:.6}, duration={:.6}, audio packets identical",
                    device.name, probe.duration
                );
                assert!(ssim > 0.95, "unexpected image degradation: {diagnostics}");
            }
        }
        // A device can disappear AFTER discovery. Keep a verified encoder but use an invalid adapter.
        let backend = super::super::ffmpeg::BackgroundMediaBackend::default();
        {
            let mut state = backend.acceleration.state.lock().unwrap();
            state.checked = true;
            state.settings.mode = Mode::Gpu;
            state.devices = vec![Device {
                id: "missing".into(),
                index: 999,
                name: "Disconnected GPU".into(),
                vendor: "nvenc".into(),
                encoders: vec!["h264_nvenc".into()],
                decoders: vec!["h264".into()],
                diagnostics: vec![],
            }];
        }
        let proxy = super::super::ffmpeg::generate_playback_proxy(
            source.to_str().unwrap(),
            "gpu-failure",
            &backend,
            backend.proxy_token(),
        )
        .unwrap();
        assert_eq!(
            backend.acceleration.status().usage["proxy"].accelerator,
            "CPU"
        );
        let result = super::super::ffprobe::probe_media(&proxy).unwrap();
        assert!(result.has_audio == Some(true) && (result.duration - 3.0).abs() < 0.1);
        println!("Disconnected GPU: proxy completed on CPU with video and audio");
        let _ = std::fs::remove_file(proxy);
        if let Some(device) = status.devices.first() {
            let other_source = root.join("encoder-failure.mp4");
            std::fs::copy(&source, &other_source).unwrap();
            {
                let mut state = backend.acceleration.state.lock().unwrap();
                let mut device = device.clone();
                device.vendor = "unavailable_encoder".into();
                device.encoders = vec!["h264_unavailable_encoder".into()];
                state.devices = vec![device];
            }
            let proxy = super::super::ffmpeg::generate_playback_proxy(
                other_source.to_str().unwrap(),
                "encoder-failure",
                &backend,
                backend.proxy_token(),
            )
            .unwrap();
            let usage = backend.acceleration.status().usage["proxy"].clone();
            assert_eq!(usage.accelerator, "CPU");
            assert!(usage.reason.unwrap().contains("retrying from source"));
            assert!(
                super::super::ffprobe::probe_media(&proxy)
                    .unwrap()
                    .has_audio
                    == Some(true)
            );
            let _ = std::fs::remove_file(proxy);
            println!("Encoder startup failure: proxy retried successfully on CPU");
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
