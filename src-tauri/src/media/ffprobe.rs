use std::{
    io::Read,
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::media::{
    binaries::{ffprobe_path, media_command},
    errors::MediaError,
    models::MediaProbe,
};

pub fn validate_probe_input(input_path: &str) -> Result<(), MediaError> {
    if std::path::Path::new(input_path).is_file() {
        Ok(())
    } else {
        Err(MediaError::InputMissing)
    }
}

pub fn probe_media(input_path: &str) -> Result<MediaProbe, MediaError> {
    validate_probe_input(input_path)?;

    let ffprobe = ffprobe_path()?;

    let mut command = media_command(ffprobe);
    command
        .arg("-v")
        .arg("error")
        .arg("-probesize")
        .arg("5000000")
        .arg("-analyzeduration")
        .arg("2000000")
        .arg("-print_format")
        .arg("json")
        .arg("-show_entries")
        .arg("format=duration,bit_rate:stream=codec_type,codec_name,codec_long_name,width,height,duration,avg_frame_rate,r_frame_rate,time_base,bit_rate:stream_tags=rotate:stream_side_data=rotation:stream_disposition=attached_pic")
        .arg(input_path);

    let output = run_probe_with_timeout(&mut command, Duration::from_secs(10))?;
    if !output.status.success() {
        return Err(MediaError::Io(format!(
            "Could not read media: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }

    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| MediaError::Io(format!("Could not parse ffprobe output: {error}")))?;

    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let format = value.get("format").cloned().unwrap_or(Value::Null);
    let video = streams.iter().find(|stream| {
        stream.get("codec_type").and_then(Value::as_str) == Some("video")
            && stream
                .pointer("/disposition/attached_pic")
                .and_then(Value::as_u64)
                != Some(1)
    });
    let audio_count = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .count();
    let subtitle_count = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("subtitle"))
        .count();

    if video.is_none() && audio_count == 0 {
        return Err(MediaError::Io(
            "The file contains no playable video or audio streams.".into(),
        ));
    }
    let primary = video.or_else(|| {
        streams
            .iter()
            .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
    });
    let duration = format
        .get("duration")
        .and_then(Value::as_str)
        .and_then(parse_positive_number)
        .or_else(|| {
            primary
                .and_then(|stream| stream.get("duration"))
                .and_then(Value::as_str)
                .and_then(parse_positive_number)
        })
        .unwrap_or(0.0);
    if duration <= 0.0 {
        return Err(MediaError::Io(
            "The media duration is unavailable or invalid.".into(),
        ));
    }
    let codec = primary
        .and_then(|stream| {
            stream
                .get("codec_long_name")
                .and_then(Value::as_str)
                .or_else(|| stream.get("codec_name").and_then(Value::as_str))
        })
        .map(str::to_string);
    let resolution = video.and_then(|stream| {
        let width = stream.get("width").and_then(Value::as_u64)?;
        let height = stream.get("height").and_then(Value::as_u64)?;
        Some(format!("{width} x {height}"))
    });
    let avg_fps = video
        .and_then(|stream| stream.get("avg_frame_rate"))
        .and_then(Value::as_str)
        .and_then(parse_rate);
    let real_fps = video
        .and_then(|stream| stream.get("r_frame_rate"))
        .and_then(Value::as_str)
        .and_then(parse_rate);
    let fps = avg_fps.or(real_fps);
    let time_base = video
        .and_then(|stream| stream.get("time_base"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let rotation = video.and_then(|stream| {
        stream
            .get("tags")
            .and_then(|tags| tags.get("rotate"))
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<i64>().ok())
            .or_else(|| {
                stream
                    .get("side_data_list")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items
                            .iter()
                            .find_map(|item| item.get("rotation").and_then(Value::as_i64))
                    })
            })
    });
    let variable_fps = avg_fps
        .zip(real_fps)
        .map(|(avg, real)| (avg - real).abs() > 0.01)
        .unwrap_or(false);
    let bitrate = format
        .get("bit_rate")
        .and_then(Value::as_str)
        .and_then(parse_positive_number)
        .or_else(|| {
            video
                .and_then(|stream| stream.get("bit_rate"))
                .and_then(Value::as_str)
                .and_then(parse_positive_number)
        })
        .map(format_bitrate);

    let probe = MediaProbe {
        duration,
        codec,
        resolution,
        fps,
        time_base,
        rotation,
        has_audio: Some(audio_count > 0),
        has_video: Some(video.is_some()),
        variable_fps: Some(variable_fps),
        bitrate,
        audio_streams: Some(if audio_count == 0 {
            "None".to_string()
        } else {
            format!(
                "{audio_count} stream{}",
                if audio_count == 1 { "" } else { "s" }
            )
        }),
        subtitles: Some(if subtitle_count == 0 {
            "None".to_string()
        } else {
            format!(
                "{subtitle_count} track{}",
                if subtitle_count == 1 { "" } else { "s" }
            )
        }),
    };

    Ok(probe)
}

fn read_bounded(mut reader: impl Read) -> std::io::Result<Vec<u8>> {
    const LIMIT: usize = 4 * 1024 * 1024;
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if bytes.len() + count <= LIMIT {
            bytes.extend_from_slice(&buffer[..count]);
        } else {
            return Err(std::io::Error::other(
                "FFprobe output exceeded the metadata limit.",
            ));
        }
    }
    Ok(bytes)
}

pub(crate) fn run_probe_with_timeout(command: &mut Command, timeout: Duration) -> std::io::Result<Output> {
    run_probe_cancellable(command, timeout, || false)
}

pub(crate) fn run_probe_cancellable(
    command: &mut Command,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
) -> std::io::Result<Output> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || read_bounded(stdout));
    let err = thread::spawn(move || read_bounded(stderr));
    let started = Instant::now();
    let status = loop {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            break Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Frame lookup cancelled.",
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            result => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(result.err().unwrap_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "Media analysis timed out.")
                }));
            }
        }
    };
    let stdout = out
        .join()
        .map_err(|_| std::io::Error::other("Metadata reader failed."))?;
    let stderr = err
        .join()
        .map_err(|_| std::io::Error::other("Metadata reader failed."))?;
    Ok(Output {
        status: status?,
        stdout: stdout?,
        stderr: stderr?,
    })
}

fn parse_rate(value: &str) -> Option<f64> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator = numerator.parse::<f64>().ok()?;
    let denominator = denominator.parse::<f64>().ok()?;
    if denominator == 0.0 || numerator <= 0.0 {
        None
    } else {
        parse_positive_number(&(numerator / denominator).to_string())
    }
}

fn parse_positive_number(value: &str) -> Option<f64> {
    let parsed = value.parse::<f64>().ok()?;
    if parsed.is_finite() && parsed > 0.0 {
        Some(parsed)
    } else {
        None
    }
}

fn format_bitrate(bits_per_second: f64) -> String {
    if bits_per_second >= 1_000_000.0 {
        format!("{:.2} Mbps", bits_per_second / 1_000_000.0)
    } else if bits_per_second >= 1_000.0 {
        format!("{:.0} Kbps", bits_per_second / 1_000.0)
    } else {
        format!("{bits_per_second:.0} bps")
    }
}
