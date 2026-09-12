use super::*;

const BINS_PER_SECOND: f64 = 200.0;
const MAX_DURATION: f64 = 300.0;

pub(super) fn generate(
    request: AudioWaveformRequest,
    backend: &BackgroundMediaBackend,
    token: u64,
    cache_only: bool,
) -> Result<AudioWaveformResult, MediaError> {
    let start = request.start_time;
    let duration = request.end_time - start;
    if !start.is_finite()
        || start < 0.0
        || !duration.is_finite()
        || duration <= 0.0
        || duration > MAX_DURATION
    {
        return Err(MediaError::Io(
            "Invalid waveform interval (maximum 300 seconds).".into(),
        ));
    }
    let fingerprint = create_video_cache_id(&request.file_path)?;
    let path = std::env::temp_dir()
        .join("video-editor-cache")
        .join("waveform-cache")
        .join(fingerprint.clone())
        .join(format!(
            "v5-rms200-{:016x}-{:016x}.f32",
            start.to_bits(),
            request.end_time.to_bits()
        ));
    let count = (duration * BINS_PER_SECOND).ceil() as usize;
    let result = |bins: Vec<f32>| AudioWaveformResult {
        video_id: request.video_id.clone(),
        start_time: start,
        end_time: request.end_time,
        peaks: resample(&bins, duration, request.peak_count.clamp(1, 20_000)),
    };
    // Cache access remains available while playback/export has priority.
    if let Some(bins) = read_cache(&path, count) {
        return Ok(result(bins));
    }
    if cache_only {
        return Err(MediaError::Io("Waveform is not cached yet.".into()));
    }
    let _audio_guard = backend
        .waveform_lock
        .lock()
        .map_err(|_| MediaError::Io("Waveform worker lock is poisoned.".into()))?;
    // Recheck after waiting: another viewport/zoom request may have filled this tile.
    if let Some(bins) = read_cache(&path, count) {
        return Ok(result(bins));
    }
    let budget = backend.budget(MediaTaskKind::VisibleWaveform);
    if !budget.allowed || backend.waveform_token() != token {
        return Err(MediaError::Io(
            "Waveform deferred by the resource budget.".into(),
        ));
    }
    let _video_guard = if budget.max_parallel_jobs < 2 {
        Some(
            backend
                .decoder_lock
                .lock()
                .map_err(|_| MediaError::Io("Background decoder lock is poisoned.".into()))?,
        )
    } else {
        None
    };
    if backend.waveform_token() != token || !backend.budget(MediaTaskKind::VisibleWaveform).allowed
    {
        return Err(MediaError::Io("Waveform task cancelled.".into()));
    }
    let _active = ActiveTaskGuard::new(backend.active_tasks.clone());
    let mut command = media_command(ffmpeg_path()?);
    // Only the RMS envelope crosses the pipe. FFmpeg computes energy at audio
    // sample rate, retaining all channels (a mono downmix can cancel stereo).
    let filter = format!(
        "aresample=48000:async=1:first_pts=0,atrim=duration={},asetnsamples=n=240:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-",
        format_seconds(duration)
    );
    command
        .args(["-hide_banner", "-nostdin", "-v", "error", "-threads"])
        .arg(budget.cpu_threads.to_string())
        .args(["-filter_threads", "1", "-ss"])
        .arg(format_seconds(start))
        .arg("-i")
        .arg(&request.file_path)
        .args(["-map", "0:a:0", "-t"])
        .arg(format_seconds(duration))
        .args(["-vn", "-sn", "-dn", "-af"])
        .arg(filter)
        .args(["-f", "null", "-"]);
    let bins = decode(&mut command, backend, token, count)?;
    if create_video_cache_id(&request.file_path)? != fingerprint {
        return Err(MediaError::Io(
            "Audio source changed during waveform generation.".into(),
        ));
    }
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_ok() {
            let bytes: Vec<_> = bins.iter().flat_map(|value| value.to_le_bytes()).collect();
            let _ = crate::media::atomic_file::write(&path, &bytes);
        }
    }
    Ok(result(bins))
}

fn read_cache(path: &Path, count: usize) -> Option<Vec<f32>> {
    if fs::metadata(path).ok()?.len() != (count * 4) as u64 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() != count * 4 {
        return None;
    }
    bytes
        .chunks_exact(4)
        .map(|bytes| {
            let value = f32::from_le_bytes(bytes.try_into().ok()?);
            (value.is_finite() && (0.0..=1.0).contains(&value)).then_some(value)
        })
        .collect()
}

fn resample(bins: &[f32], duration: f64, count: usize) -> Vec<f32> {
    (0..count)
        .map(|index| {
            let start = index as f64 * duration / count as f64;
            let end = (index + 1) as f64 * duration / count as f64;
            let first = (start * BINS_PER_SECOND).floor() as usize;
            let last = ((end * BINS_PER_SECOND).ceil() as usize).min(bins.len());
            let mut energy = 0.0;
            for (offset, value) in bins[first.min(last)..last].iter().enumerate() {
                let bin = first + offset;
                let overlap = (end.min((bin + 1) as f64 / BINS_PER_SECOND)
                    - start.max(bin as f64 / BINS_PER_SECOND))
                .max(0.0);
                energy += (*value as f64).powi(2) * overlap;
            }
            ((energy / (end - start)).sqrt() * 3.0).clamp(0.0, 1.0) as f32
        })
        .collect()
}

fn decode(
    command: &mut Command,
    backend: &BackgroundMediaBackend,
    token: u64,
    count: usize,
) -> Result<Vec<f32>, MediaError> {
    configure_background_priority(command);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| MediaError::Io("Missing waveform output.".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| MediaError::Io("Missing waveform diagnostics.".into()))?;
    let out = thread::spawn(move || -> std::io::Result<Vec<f32>> {
        let mut bins = Vec::with_capacity(count);
        // Bound even unexpected filter output. No raw PCM is retained in Rust.
        for line in BufReader::new(stdout.take(16 * 1024 * 1024)).lines() {
            let line = line?;
            if let Some(value) = line.strip_prefix("lavfi.astats.Overall.RMS_level=") {
                let db = value
                    .parse::<f64>()
                    .map_err(|_| std::io::Error::other("Invalid RMS metadata."))?;
                if db.is_nan() || db == f64::INFINITY {
                    return Err(std::io::Error::other("Non-finite RMS metadata."));
                }
                if bins.len() < count {
                    bins.push(10_f64.powf(db / 20.0).clamp(0.0, 1.0) as f32);
                }
            }
        }
        // Audio can end before (or within) the requested video interval. A
        // successful empty decode represents silence; missing streams/filters
        // are rejected through FFmpeg's exit status below.
        bins.resize(count, 0.0);
        Ok(bins)
    });
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stderr;
        let mut buffer = [0_u8; 4096];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            let keep = read.min((64 * 1024_usize).saturating_sub(bytes.len()));
            bytes.extend_from_slice(&buffer[..keep]);
        }
        bytes
    });
    let started = Instant::now();
    let mut checked_budget = Instant::now();
    let status = loop {
        let budget_revoked = checked_budget.elapsed() >= Duration::from_millis(250) && {
            checked_budget = Instant::now();
            !backend.budget(MediaTaskKind::VisibleWaveform).allowed
        };
        if backend.waveform_token() != token
            || budget_revoked
            || started.elapsed() > Duration::from_secs(30)
        {
            let _ = child.kill();
            let _ = child.wait();
            break Err(MediaError::Io(
                "Waveform task cancelled, deferred or timed out.".into(),
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error.into());
            }
        }
    };
    let bins = out
        .join()
        .map_err(|_| MediaError::Io("Waveform reader failed.".into()))?;
    let stderr = err.join().unwrap_or_default();
    if !status?.success() {
        return Err(MediaError::Io(
            String::from_utf8_lossy(&stderr).trim().to_string(),
        ));
    }
    bins.map_err(MediaError::from)
}
