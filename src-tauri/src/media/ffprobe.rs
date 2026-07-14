use std::{fs, path::Path, process::Command};

use serde_json::Value;

use crate::media::{binaries::ffprobe_path, errors::MediaError, models::MediaProbe};

pub fn validate_probe_input(input_path: &str) -> Result<(), MediaError> {
    if std::path::Path::new(input_path).is_file() {
        Ok(())
    } else {
        Err(MediaError::InputMissing)
    }
}

pub fn probe_media(input_path: &str) -> Result<MediaProbe, MediaError> {
    validate_probe_input(input_path)?;

    let Ok(ffprobe) = ffprobe_path() else {
        return Ok(probe_media_fallback(input_path));
    };

    let output = Command::new(ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(input_path)
        .output();

    let output = match output {
        Ok(output) if output.status.success() => output,
        _ => return Ok(probe_media_fallback(input_path)),
    };

    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| MediaError::Io(format!("Could not parse ffprobe output: {error}")))?;

    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let format = value.get("format").cloned().unwrap_or(Value::Null);
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"));
    let audio_count = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .count();
    let subtitle_count = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("subtitle"))
        .count();

    let duration = format
        .get("duration")
        .and_then(Value::as_str)
        .and_then(parse_positive_number)
        .or_else(|| {
            video
                .and_then(|stream| stream.get("duration"))
                .and_then(Value::as_str)
                .and_then(parse_positive_number)
        })
        .unwrap_or(0.0);
    let codec = video
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

    let mut probe = MediaProbe {
        duration,
        codec,
        resolution,
        fps,
        time_base,
        rotation,
        has_audio: Some(audio_count > 0),
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

    let fallback = probe_media_fallback(input_path);
    if probe.codec.is_none() {
        probe.codec = fallback.codec;
    }
    if probe.resolution.is_none() {
        probe.resolution = fallback.resolution;
    }
    if probe.fps.is_none() {
        probe.fps = fallback.fps;
    }
    if probe.duration <= 0.0 {
        probe.duration = fallback.duration;
    }
    if probe.bitrate.is_none() {
        probe.bitrate = fallback.bitrate;
    }

    Ok(probe)
}

fn probe_media_fallback(input_path: &str) -> MediaProbe {
    let path = Path::new(input_path);
    let data = fs::read(path)
        .map(|bytes| bytes.into_iter().take(8 * 1024 * 1024).collect::<Vec<_>>())
        .unwrap_or_default();
    let file_size = fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let matroska = parse_matroska_probe(&data);
    let duration = matroska.duration.unwrap_or(0.0);

    MediaProbe {
        duration,
        codec: matroska.codec,
        resolution: match (matroska.width, matroska.height) {
            (Some(width), Some(height)) => Some(format!("{width} x {height}")),
            _ => None,
        },
        fps: matroska.fps,
        time_base: None,
        rotation: Some(0),
        has_audio: matroska.has_audio,
        variable_fps: Some(false),
        bitrate: if duration > 0.0 && file_size > 0 {
            Some(format_bitrate(file_size as f64 * 8.0 / duration))
        } else {
            None
        },
        audio_streams: matroska.has_audio.map(|has_audio| {
            if has_audio {
                "1+ streams".to_string()
            } else {
                "None".to_string()
            }
        }),
        subtitles: matroska.has_subtitles.map(|has_subtitles| {
            if has_subtitles {
                "1+ tracks".to_string()
            } else {
                "None".to_string()
            }
        }),
    }
}

#[derive(Default)]
struct MatroskaProbe {
    codec: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
    fps: Option<f64>,
    duration: Option<f64>,
    has_audio: Option<bool>,
    has_subtitles: Option<bool>,
}

fn parse_matroska_probe(data: &[u8]) -> MatroskaProbe {
    let mut probe = MatroskaProbe::default();
    let timecode_scale = find_unsigned(data, &[0x2A, 0xD7, 0xB1]).unwrap_or(1_000_000);

    if let Some(duration) = find_float(data, &[0x44, 0x89]) {
        probe.duration = Some(duration * timecode_scale as f64 / 1_000_000_000.0);
    }

    probe.width = find_unsigned(data, &[0xB0]);
    probe.height = find_unsigned(data, &[0xBA]);

    if let Some(default_duration) = find_unsigned(data, &[0x23, 0xE3, 0x83]) {
        if default_duration > 0 {
            probe.fps = Some((1_000_000_000.0 / default_duration as f64 * 100.0).round() / 100.0);
        }
    }

    let codec_ids = find_strings(data, &[0x86]);
    probe.codec = codec_ids
        .iter()
        .find(|codec| codec.starts_with("V_"))
        .map(|codec| format_codec_id(codec))
        .or_else(|| codec_ids.first().map(|codec| format_codec_id(codec)));
    probe.has_audio = Some(codec_ids.iter().any(|codec| codec.starts_with("A_")));
    probe.has_subtitles = Some(codec_ids.iter().any(|codec| codec.starts_with("S_")));

    probe
}

fn find_unsigned(data: &[u8], id: &[u8]) -> Option<u64> {
    let (offset, size) = find_element(data, id)?;
    if size == 0 || size > 8 || offset + size > data.len() {
        return None;
    }

    let mut value = 0u64;
    for byte in &data[offset..offset + size] {
        value = (value << 8) | u64::from(*byte);
    }
    Some(value)
}

fn find_float(data: &[u8], id: &[u8]) -> Option<f64> {
    let (offset, size) = find_element(data, id)?;
    if offset + size > data.len() {
        return None;
    }

    match size {
        4 => {
            let bytes = data[offset..offset + 4].try_into().ok()?;
            Some(f32::from_be_bytes(bytes) as f64)
        }
        8 => {
            let bytes = data[offset..offset + 8].try_into().ok()?;
            Some(f64::from_be_bytes(bytes))
        }
        _ => None,
    }
}

fn find_strings(data: &[u8], id: &[u8]) -> Vec<String> {
    let mut strings = Vec::new();
    let mut search_from = 0;

    while search_from < data.len() {
        let Some(position) =
            find_bytes(&data[search_from..], id).map(|position| position + search_from)
        else {
            break;
        };
        search_from = position + id.len();

        let Some((size, size_len)) = read_vint_size(&data[search_from..]) else {
            continue;
        };
        let offset = search_from + size_len;
        let end = offset.saturating_add(size);
        if size == 0 || size > 128 || end > data.len() {
            continue;
        }
        if let Ok(value) = std::str::from_utf8(&data[offset..end]) {
            let trimmed = value.trim_matches(char::from(0)).trim();
            if trimmed.contains('_') && trimmed.chars().all(|ch| ch.is_ascii_graphic()) {
                strings.push(trimmed.to_string());
            }
        }
    }

    strings
}

fn find_element(data: &[u8], id: &[u8]) -> Option<(usize, usize)> {
    let position = find_bytes(data, id)?;
    let size_offset = position + id.len();
    let (size, size_len) = read_vint_size(&data[size_offset..])?;
    Some((size_offset + size_len, size))
}

fn find_bytes(data: &[u8], needle: &[u8]) -> Option<usize> {
    data.windows(needle.len())
        .position(|window| window == needle)
}

fn read_vint_size(data: &[u8]) -> Option<(usize, usize)> {
    let first = *data.first()?;
    if first == 0 {
        return None;
    }

    let leading_zeros = first.leading_zeros() as usize;
    let length = leading_zeros + 1;
    if length == 0 || length > 8 || data.len() < length {
        return None;
    }

    let marker_mask = 1u8 << (8 - length);
    let mut value = usize::from(first & !marker_mask);
    for byte in &data[1..length] {
        value = (value << 8) | usize::from(*byte);
    }
    Some((value, length))
}

fn format_codec_id(codec_id: &str) -> String {
    match codec_id {
        "V_MPEG4/ISO/AVC" => "H.264 / AVC".to_string(),
        "V_MPEGH/ISO/HEVC" => "H.265 / HEVC".to_string(),
        "V_AV1" => "AV1".to_string(),
        "V_VP8" => "VP8".to_string(),
        "V_VP9" => "VP9".to_string(),
        "V_MPEG2" => "MPEG-2 Video".to_string(),
        "A_AAC" => "AAC".to_string(),
        "A_AC3" => "AC-3".to_string(),
        "A_EAC3" => "E-AC-3".to_string(),
        "A_OPUS" => "Opus".to_string(),
        "A_VORBIS" => "Vorbis".to_string(),
        "A_FLAC" => "FLAC".to_string(),
        value => value.to_string(),
    }
}

fn parse_rate(value: &str) -> Option<f64> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator = numerator.parse::<f64>().ok()?;
    let denominator = denominator.parse::<f64>().ok()?;
    if denominator == 0.0 || numerator <= 0.0 {
        None
    } else {
        Some((numerator / denominator * 100.0).round() / 100.0)
    }
}

fn parse_positive_number(value: &str) -> Option<f64> {
    let parsed = value.parse::<f64>().ok()?;
    if parsed > 0.0 {
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
