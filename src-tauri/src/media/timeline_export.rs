use super::*;

/// Seek each source range, concatenate decoded frames, then encode only once.
pub(super) fn build(ffmpeg: &Path, input: &str, output: &str, clips: &[ExportClip], settings: &ExportSettings, annotations: &[ExportAnnotation], threads: usize) -> Result<Command, MediaError> {
    let fail = |message: &str| MediaError::Io(message.into());
    if clips.is_empty() { return Err(fail("The timeline is empty.")); }
    // ponytail: bounded input decoders; use staged batches when projects exceed 256 clips.
    if clips.len() > 256 { return Err(fail("Single-file export supports up to 256 clips. Export a smaller selection as separate files.")); }
    let probe = crate::media::ffprobe::probe_media(input)?;
    let has_video = probe.has_video != Some(false);
    let mut probe_command = media_command(crate::media::binaries::ffprobe_path()?);
    probe_command.args(["-v", "error", "-show_streams", "-of", "json", input]);
    let metadata = crate::media::ffprobe::run_probe_with_timeout(&mut probe_command, Duration::from_secs(20))?;
    if !metadata.status.success() { return Err(fail("Could not read audio stream layouts.")); }
    let metadata: serde_json::Value = serde_json::from_slice(&metadata.stdout).map_err(|e| fail(&e.to_string()))?;
    let streams = metadata["streams"].as_array().ok_or_else(|| fail("No media streams."))?;
    let layouts: Vec<String> = streams.iter().filter(|s| s["codec_type"] == "audio").map(|s| {
        let layout = s["channel_layout"].as_str().map(str::to_owned)
            .unwrap_or_else(|| format!("{}c", s["channels"].as_u64().unwrap_or(2)));
        if !layout.chars().all(|c| c.is_ascii_alphanumeric() || "().+-_".contains(c)) { return Err(fail("Unsupported audio channel layout.")); }
        Ok(layout)
    }).collect::<Result<_, _>>()?;
    let audio_count = layouts.len().max(1);
    let layouts = if layouts.is_empty() { vec!["stereo".into()] } else { layouts };
    let dimensions: Vec<u32> = probe.resolution.as_deref().unwrap_or("1920 x 1080").split('x').filter_map(|s| s.trim().parse().ok()).collect();
    let (sw, sh) = (dimensions.first().copied().unwrap_or(1920), dimensions.get(1).copied().unwrap_or(1080));
    let (width, height) = match (settings.width, settings.height) {
        (Some(w), Some(h)) => (w, h),
        (Some(w), None) => (w, ((w as f64 * sh as f64 / sw as f64 / 2.0).round() as u32 * 2).max(2)),
        (None, Some(h)) => (((h as f64 * sw as f64 / sh as f64 / 2.0).round() as u32 * 2).max(2), h),
        _ => ((sw / 2 * 2).max(2), (sh / 2 * 2).max(2)),
    };
    let fps = settings.fps.or(probe.fps).unwrap_or(30.0).clamp(1.0, 240.0);
    let end = clips.last().unwrap().end_time;
    let whole = ExportClip { id: "timeline".into(), label: "Timeline".into(), source_start: None, start_time: 0.0, end_time: end };
    let overlay = write_clip_ass_overlay(&whole, annotations, &Path::new(output).with_extension("ass"))?;
    let mut command = media_command(ffmpeg);
    command.args(["-hide_banner", "-nostdin", "-y", "-filter_complex_threads", "1"]);
    let mut segments = Vec::new();
    let mut cursor = 0.0;
    for (input_index, clip) in clips.iter().enumerate() {
        let source = clip.source_start.unwrap_or(clip.start_time);
        let span = clip.end_time - clip.start_time;
        if !source.is_finite() || source < 0.0 || !span.is_finite() || span <= 0.0 || source + span > probe.duration + 0.05 || clip.start_time < cursor - 0.000001 {
            return Err(fail("Invalid or overlapping source ranges in timeline."));
        }
        if clip.start_time > cursor + 0.000001 { segments.push((None, cursor, clip.start_time)); }
        segments.push((Some(input_index), clip.start_time, clip.end_time));
        command.args(["-threads", "1", "-ss", &format!("{source:.6}"), "-t", &format!("{span:.6}"), "-i", input]);
        cursor = clip.end_time;
    }
    let mut graph = Vec::new();
    let mut concat_inputs = String::new();
    for (index, (source, start, end)) in segments.iter().enumerate() {
        let span = end - start;
        if has_video {
            let beginning = if let Some(input) = source { format!("[{input}:V:0]setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={span:.6},trim=duration={span:.6}") }
                else { format!("color=c=black:s={width}x{height}:r={fps}:d={span:.6}") };
            let active: Vec<_> = annotations.iter().filter(|a| a.start_time < *end && a.end_time > *start).cloned().collect();
            let effects = annotation_filters(&whole, &active, overlay.as_deref()).join(",")
                .replace("[base", &format!("[s{index}base")).replace("[region", &format!("[s{index}region")).replace("[blur", &format!("[s{index}blur"));
            let effects = if effects.is_empty() { String::new() } else { format!(",setpts=PTS+{start:.6}/TB,{effects},setpts=PTS-{start:.6}/TB") };
            graph.push(format!("{beginning}{effects},scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,settb=AVTB[v{index}]"));
            concat_inputs.push_str(&format!("[v{index}]"));
        }
        for (audio, layout) in layouts.iter().enumerate() {
            let beginning = match source {
                Some(input) if probe.has_audio == Some(true) => format!("[{input}:a:{audio}]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts={layout},apad"),
                _ => format!("anullsrc=r=48000:cl={layout}"),
            };
            graph.push(format!("{beginning},atrim=duration={span:.6},asetpts=N/SR/TB[a{index}_{audio}]"));
            concat_inputs.push_str(&format!("[a{index}_{audio}]"));
        }
    }
    let video_label = if has_video { "[joinedv]" } else { "" };
    let audio_labels: String = (0..audio_count).map(|a| format!("[joineda{a}]")).collect();
    graph.push(format!("{concat_inputs}concat=n={}:v={}:a={audio_count}{video_label}{audio_labels}", segments.len(), usize::from(has_video)));
    if has_video {
        let rate = settings.fps.map(|fps| format!("fps={fps},")).unwrap_or_default();
        graph.push(format!("[joinedv]{rate}null[timelinev]"));
        command.args(["-map", "[timelinev]"]);
    }
    if probe.has_audio == Some(true) {
        for audio in 0..audio_count { command.args(["-map", &format!("[joineda{audio}]")]); }
    } else { graph.push("[joineda0]anullsink".into()); }
    let script = Path::new(output).with_extension("filter");
    fs::write(&script, graph.join(";\n"))?;
    command.arg("-/filter_complex").arg(script);
    let mut encoding = settings.clone();
    encoding.mode = ExportMode::Encode;
    if encoding.video_codec == VideoCodec::Copy { encoding.video_codec = if matches!(settings.format, ExportFormat::Webm) { VideoCodec::Vp9 } else { VideoCodec::H264 }; }
    if encoding.audio_codec == AudioCodec::Copy { encoding.audio_codec = if matches!(settings.format, ExportFormat::Webm) { AudioCodec::Opus } else { AudioCodec::Aac }; }
    encoding.width = None; encoding.height = None; encoding.fps = None;
    apply_export_settings(&mut command, &encoding, vec![]);
    if !has_video { command.arg("-vn"); }
    command.args(["-map_metadata", "0", "-t", &format!("{cursor:.6}"), "-threads", &threads.clamp(1, 8).to_string(), "-fps_mode", "vfr"]);
    if matches!(settings.format, ExportFormat::Mp4 | ExportFormat::Mov) { command.args(["-movflags", "+faststart"]); }
    command.args(["-progress", "pipe:2", output]).stdout(Stdio::null()).stderr(Stdio::piped());
    Ok(command)
}
