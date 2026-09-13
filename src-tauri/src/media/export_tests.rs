use super::*;

fn settings() -> ExportSettings {
    ExportSettings {
        format: ExportFormat::Mp4,
        mode: ExportMode::Encode,
        video_codec: VideoCodec::H264,
        audio_codec: AudioCodec::Aac,
        video_bitrate_kbps: None,
        audio_bitrate_kbps: Some(192),
        fps: None,
        width: None,
        height: None,
        crf: Some(18),
        preset: "ultrafast".into(),
    }
}
fn effect(kind: ExportAnnotationType) -> ExportAnnotation {
    ExportAnnotation {
        id: "effect".into(),
        annotation_type: kind,
        label: "Effect".into(),
        color: "#ffffff".into(),
        opacity: 100.0,
        thickness: 8.0,
        font: "Arial".into(),
        visible: true,
        start_time: 0.0,
        end_time: 10.0,
        x: 0.25,
        y: 0.25,
        width: 0.5,
        height: 0.5,
        line_start_x: None,
        line_start_y: None,
        line_end_x: None,
        line_end_y: None,
        path_points: None,
    }
}
fn run(mut command: Command) {
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn clip() -> ExportClip {
    ExportClip {
        source_start: None,
        id: "test".into(),
        label: "Clip".into(),
        start_time: 1.1,
        end_time: 2.1,
    }
}

#[test]
fn invalid_colors_and_effect_overlays_are_safe() {
    assert_eq!(ass_color("я😀"), "FFFFFF");
    assert!(ass_text_for_annotation(&effect(ExportAnnotationType::Blur)).is_none());
    assert!(ass_text_for_annotation(&effect(ExportAnnotationType::Crop)).is_none());
    let mut rectangle = effect(ExportAnnotationType::Rectangle);
    rectangle.opacity = 50.0;
    assert!(ass_text_for_annotation(&rectangle)
        .unwrap()
        .contains("1a&H80&"));
}

#[test]
#[ignore = "Requires FFmpeg; measures the montage pipeline with many cuts and drawings"]
fn montage_throughput() {
    let root = std::env::temp_dir().join(format!("lumen-montage-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let ffmpeg = ffmpeg_path().unwrap();
    let input = root.join("input.mp4");
    let mut generate = media_command(&ffmpeg);
    generate.args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=12",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]).arg(&input);
    run(generate);
    let clips: Vec<_> = (0..24).map(|i| ExportClip { id: i.to_string(), label: i.to_string(),
        start_time: i as f64 * 0.5, end_time: (i+1) as f64 * 0.5, source_start: Some(i as f64 * 0.5) }).collect();
    let annotations: Vec<_> = (0..40).map(|i| { let mut a = effect(ExportAnnotationType::Rectangle);
        a.id = i.to_string(); a.x = (i % 10) as f64 * 0.06; a.y = (i / 10) as f64 * 0.1;
        a.width = 0.15; a.height = 0.15; a.end_time = 12.0; a }).collect();
    for (name, cuts) in [("continuous", clips.clone()), ("reordered", clips.iter().enumerate().map(|(i,c)| {
        let mut c = c.clone(); c.source_start = Some((23-i) as f64 * 0.5); c
    }).collect())] {
        let output = root.join(format!("{name}.mp4"));
        let start = Instant::now();
        let command = timeline_export::build(&ffmpeg, &input.to_string_lossy(), &output.to_string_lossy(), &cuts, &settings(), &annotations, 4).unwrap();
        let inputs = command.get_args().filter(|a| *a == "-i").count();
        run(command);
        println!("MONTAGE {name}: {:.3}s, {inputs} decoders, 12s 720p, 24 cuts, 40 drawings", start.elapsed().as_secs_f64());
        let probe = crate::media::ffprobe::probe_media(&output.to_string_lossy()).unwrap();
        assert!((probe.duration - 12.0).abs() < 0.06);
        assert_eq!(probe.has_audio, Some(true));
    }
    fs::remove_dir_all(root).unwrap();
}

/// Run explicitly with installed FFmpeg/ffprobe (or FFMPEG_PATH/FFPROBE_PATH).
#[test]
#[ignore = "Requires FFmpeg with libx264/libvpx/libass and ffprobe"]
fn media_regressions() {
    let root = std::env::temp_dir().join(format!("lumen-regression-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    println!("Media regression fixtures: {}", root.display());
    let ffmpeg = ffmpeg_path().unwrap();
    let input = root.join("fixture.mp4");
    let mut generate = media_command(&ffmpeg);
    generate
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x240:rate=30:duration=4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=4",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "150",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&input);
    run(generate);
    let input_str = input.to_string_lossy();
    let probe = crate::media::ffprobe::probe_media(&input_str).unwrap();
    assert_eq!(probe.audio_streams.as_deref(), Some("2 streams"));
    let broken = root.join("broken.mp4");
    fs::write(&broken, b"this is not video").unwrap();
    assert!(crate::media::ffprobe::probe_media(&broken.to_string_lossy()).is_err());
    let audio = root.join("audio.m4a");
    let mut extract = media_command(&ffmpeg);
    extract
        .args(["-v", "error", "-i"])
        .arg(&input)
        .args(["-map", "0:a:0", "-c", "copy"])
        .arg(&audio);
    run(extract);
    let audio_probe = crate::media::ffprobe::probe_media(&audio.to_string_lossy()).unwrap();
    assert_eq!(audio_probe.has_video, Some(false));
    assert_eq!(audio_probe.has_audio, Some(true));
    let audio_export = root.join("audio-export.mp4");
    run(build_export_command(
        &ffmpeg,
        &audio.to_string_lossy(),
        &audio_export.to_string_lossy(),
        &clip(),
        &settings(),
        &[],
        2,
    )
    .unwrap());
    assert_eq!(
        crate::media::ffprobe::probe_media(&audio_export.to_string_lossy())
            .unwrap()
            .has_video,
        Some(false)
    );

    let metadata = root.join("metadata.txt");
    fs::write(
        &metadata,
        format!(";FFMETADATA1\ncomment={}\n", "x".repeat(100_000)),
    )
    .unwrap();
    let tagged = root.join("tagged.mp4");
    let mut tag = media_command(&ffmpeg);
    tag.args(["-v", "error", "-i"])
        .arg(&input)
        .args(["-f", "ffmetadata", "-i"])
        .arg(&metadata)
        .args(["-map_metadata", "1", "-c", "copy"])
        .arg(&tagged);
    run(tag);
    let start = Instant::now();
    let tagged_probe = crate::media::ffprobe::probe_media(&tagged.to_string_lossy()).unwrap();
    assert!(tagged_probe.duration > 3.9 && start.elapsed() < Duration::from_secs(5));

    let backend = BackgroundMediaBackend::default();
    let video_id = create_video_cache_id(&input_str).unwrap();
    let thumbnails = generate_timeline_thumbnail_range(
        ThumbnailRequest {
            video_id: video_id.clone(),
            file_path: input_str.to_string(),
            start_time: 1.0,
            end_time: 1.0,
            interval_seconds: 1.0,
            thumbnail_width: 120,
            thumbnail_height: 68,
            generation: 1,
            priority: ThumbnailPriority::Visible,
        },
        root.join("thumbnails"),
        &backend,
        backend.token(),
    )
    .unwrap();
    assert_eq!(thumbnails.thumbnails.len(), 1);
    assert!(matches!(
        thumbnails.thumbnails[0].state,
        ThumbnailState::Ready
    ));
    let waveform = generate_audio_waveform(
        AudioWaveformRequest {
            video_id,
            file_path: input_str.to_string(),
            start_time: 0.0,
            end_time: 4.0,
            peak_count: 40,
        },
        &backend,
        backend.token(),
    )
    .unwrap();
    assert_eq!(waveform.peaks.len(), 40);
    assert!(waveform.peaks.iter().all(|p| *p > 0.1));
    let proxy_token = backend.proxy_token();
    backend.cancel_all();
    assert_eq!(
        proxy_token,
        backend.proxy_token(),
        "Timeline cancellation must not invalidate the proxy"
    );
    backend.cancel_proxy();
    assert!(
        generate_playback_proxy(&input_str, "cancelled-regression", &backend, proxy_token).is_err()
    );

    let plain = root.join("precise.mp4");
    run(build_export_command(
        &ffmpeg,
        &input_str,
        &plain.to_string_lossy(),
        &clip(),
        &settings(),
        &[],
        2,
    )
    .unwrap());
    let encoded = crate::media::ffprobe::probe_media(&plain.to_string_lossy()).unwrap();
    assert_eq!(encoded.audio_streams.as_deref(), Some("2 streams"));
    assert!((encoded.duration - 1.0).abs() < 0.05);
    let mut count = media_command(crate::media::binaries::ffprobe_path().unwrap());
    let frames = count
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "csv=p=0",
        ])
        .arg(&plain)
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&frames.stdout).trim(), "30");

    let cropped = root.join("crop.mp4");
    run(build_export_command(
        &ffmpeg,
        &input_str,
        &cropped.to_string_lossy(),
        &clip(),
        &settings(),
        &[effect(ExportAnnotationType::Crop)],
        2,
    )
    .unwrap());
    assert_eq!(
        crate::media::ffprobe::probe_media(&cropped.to_string_lossy())
            .unwrap()
            .resolution
            .as_deref(),
        Some("160 x 120")
    );
    let blurred = root.join("blur.mp4");
    let mut blur = effect(ExportAnnotationType::Blur);
    blur.start_time = 1.4;
    blur.end_time = 1.9;
    run(build_export_command(
        &ffmpeg,
        &input_str,
        &blurred.to_string_lossy(),
        &clip(),
        &settings(),
        &[blur],
        2,
    )
    .unwrap());
    let frame = |path: &Path, time: &str| {
        let result = media_command(&ffmpeg)
            .args(["-v", "error", "-ss", time, "-i"])
            .arg(path)
            .args([
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout.len(), 320 * 240 * 3);
        result.stdout
    };
    let difference = |time: &str| {
        let original = frame(&plain, time);
        let blurred = frame(&blurred, time);
        let mut sum = 0_u64;
        for y in 70..170 {
            for x in 90..230 {
                for channel in 0..3 {
                    let i = (y * 320 + x) * 3 + channel;
                    sum += original[i].abs_diff(blurred[i]) as u64;
                }
            }
        }
        sum as f64 / (100.0 * 140.0 * 3.0)
    };
    // Timeline position must not change the selected source footage or audio.
    let moved = root.join("moved.mp4");
    let mut moved_clip = clip();
    moved_clip.source_start = Some(moved_clip.start_time);
    moved_clip.start_time = 8.0;
    moved_clip.end_time = 9.0;
    run(build_export_command(&ffmpeg, &input_str, &moved.to_string_lossy(), &moved_clip, &settings(), &[], 2).unwrap());
    assert_eq!(frame(&plain, "0.5"), frame(&moved, "0.5"));
    let decoded_audio = |path: &Path| {
        let output = media_command(&ffmpeg).args(["-v", "error", "-i"]).arg(path)
            .args(["-map", "0:a:0", "-f", "s16le", "pipe:1"]).output().unwrap();
        assert!(output.status.success());
        output.stdout
    };
    assert_eq!(decoded_audio(&plain), decoded_audio(&moved));
    let moved_probe = crate::media::ffprobe::probe_media(&moved.to_string_lossy()).unwrap();
    assert!((moved_probe.duration - 1.0).abs() < 0.05);
    assert_eq!(moved_probe.audio_streams.as_deref(), Some("2 streams"));
    let timeline = root.join("timeline.mp4");
    let timeline_clips = vec![
        ExportClip { id: "later".into(), label: "Later".into(), start_time: 0.5, end_time: 1.5, source_start: Some(2.0) },
        ExportClip { id: "earlier".into(), label: "Earlier".into(), start_time: 2.0, end_time: 3.0, source_start: Some(0.0) },
    ];
    run(timeline_export::build(&ffmpeg, &input_str, &timeline.to_string_lossy(), &timeline_clips, &settings(), &[], 2).unwrap());
    let timeline_probe = crate::media::ffprobe::probe_media(&timeline.to_string_lossy()).unwrap();
    assert!((timeline_probe.duration - 3.0).abs() < 0.05);
    assert_eq!(timeline_probe.audio_streams.as_deref(), Some("2 streams"));
    for time in ["0.2", "1.7"] { assert!(frame(&timeline, time).iter().all(|v| *v < 8), "Gap must be black"); }
    for (edited, source) in [("0.8", "2.3"), ("2.3", "0.3")] {
        let actual = frame(&timeline, edited); let expected = frame(&input, source);
        let error = actual.iter().zip(&expected).map(|(a,b)| a.abs_diff(*b) as f64).sum::<f64>() / actual.len() as f64;
        assert!(error < 8.0, "Wrong source footage at {edited}: {error}");
    }
    let pcm = decoded_audio(&timeline);
    let rms = |start: f64, end: f64| {
        let samples: Vec<_> = pcm.chunks_exact(2).skip((start * 48000.0) as usize).take(((end-start)*48000.0) as usize).map(|b| i16::from_le_bytes([b[0], b[1]]) as f64).collect();
        (samples.iter().map(|s| s*s).sum::<f64>() / samples.len() as f64).sqrt()
    };
    assert!(rms(0.1,0.4) < 5.0 && rms(1.6,1.9) < 5.0, "Gap audio must be silent");
    assert!(rms(0.6,1.4) > 100.0 && rms(2.1,2.8) > 100.0, "Clip audio must follow the montage");
    let effect_output = root.join("timeline-effect.mp4");
    let mut note = effect(ExportAnnotationType::Rectangle); note.start_time = 2.0; note.end_time = 3.0;
    run(timeline_export::build(&ffmpeg, &input_str, &effect_output.to_string_lossy(), &timeline_clips, &settings(), &[note], 2).unwrap());
    assert_eq!(frame(&timeline, "0.8"), frame(&effect_output, "0.8"));
    assert_ne!(frame(&timeline, "2.3"), frame(&effect_output, "2.3"));
    let audio_timeline = root.join("audio-timeline.mp4");
    run(timeline_export::build(&ffmpeg, &audio.to_string_lossy(), &audio_timeline.to_string_lossy(), &timeline_clips, &settings(), &[], 2).unwrap());
    let audio_timeline_probe = crate::media::ffprobe::probe_media(&audio_timeline.to_string_lossy()).unwrap();
    assert_eq!(audio_timeline_probe.has_video, Some(false));
    assert!((audio_timeline_probe.duration - 3.0).abs() < 0.05);
    let silent_source = root.join("silent-source.mp4");
    let mut strip_audio = media_command(&ffmpeg);
    strip_audio.args(["-v", "error", "-i", &input_str, "-an", "-c:v", "copy"]).arg(&silent_source);
    run(strip_audio);
    let silent_timeline = root.join("silent-timeline.mp4");
    run(timeline_export::build(&ffmpeg, &silent_source.to_string_lossy(), &silent_timeline.to_string_lossy(), &timeline_clips, &settings(), &[], 2).unwrap());
    let silent_probe = crate::media::ffprobe::probe_media(&silent_timeline.to_string_lossy()).unwrap();
    assert_eq!(silent_probe.has_audio, Some(false));
    assert!((silent_probe.duration - 3.0).abs() < 0.05);
    let acceleration = crate::media::acceleration::Acceleration::default();
    for (device_index, device) in acceleration.discover().devices.into_iter().enumerate() {
        acceleration.settings(crate::media::acceleration::Settings { mode: crate::media::acceleration::Mode::Gpu, device_id: Some(device.id.clone()) }).unwrap();
        let output = root.join(format!("timeline-gpu-{device_index}.mp4"));
        let cpu = timeline_export::build(&ffmpeg, &input_str, &output.to_string_lossy(), &timeline_clips, &settings(), &[], 2).unwrap();
        if let Some(plan) = acceleration.plan(&cpu, "export", false, true) {
            run(plan.command(&cpu));
            let probe = crate::media::ffprobe::probe_media(&output.to_string_lossy()).unwrap();
            assert!((probe.duration - 3.0).abs() < 0.05);
            assert_eq!(decoded_audio(&output), pcm);
            println!("Timeline GPU export passed: {}", device.name);
        }
    }
    let before = difference("0.1");
    let during = difference("0.5");
    assert!(
        during > 5.0 && during > before * 3.0,
        "blur differences: before={before}, during={during}"
    );

    let rectangle = root.join("rectangle.mp4");
    run(build_export_command(
        &ffmpeg,
        &input_str,
        &rectangle.to_string_lossy(),
        &clip(),
        &settings(),
        &[effect(ExportAnnotationType::Rectangle)],
        2,
    )
    .unwrap());
    let original_frame = frame(&plain, "0.5");
    let rectangle_frame = frame(&rectangle, "0.5");
    let region_difference = |x0: usize, x1: usize, y0: usize, y1: usize| {
        let mut sum = 0_u64;
        for y in y0..y1 {
            for x in x0..x1 {
                for channel in 0..3 {
                    let i = (y * 320 + x) * 3 + channel;
                    sum += original_frame[i].abs_diff(rectangle_frame[i]) as u64;
                }
            }
        }
        sum as f64 / ((x1 - x0) * (y1 - y0) * 3) as f64
    };
    assert!(
        region_difference(90, 230, 60, 63) > 30.0,
        "Rectangle top edge must match normalized preview coordinates"
    );
    assert!(
        region_difference(100, 220, 100, 140) < 8.0,
        "Rectangle center must remain transparent"
    );

    let mut webm = settings();
    webm.format = ExportFormat::Webm;
    webm.video_codec = VideoCodec::Vp9;
    webm.audio_codec = AudioCodec::Opus;
    let webm_path = root.join("valid.webm");
    run(build_export_command(
        &ffmpeg,
        &input_str,
        &webm_path.to_string_lossy(),
        &clip(),
        &webm,
        &[],
        2,
    )
    .unwrap());
    assert!(
        crate::media::ffprobe::probe_media(&webm_path.to_string_lossy())
            .unwrap()
            .duration
            > 0.9
    );

    let mut request = ExportTrimRequest {
        timeline: false,
        operation_id: None,
        input_path: input_str.to_string(),
        output_path: root.join("fixture.webm").to_string_lossy().to_string(),
        clips: vec![clip()],
        settings: settings(),
        annotations: vec![],
    };
    assert!(matches!(
        validate_request(&request),
        Err(MediaError::SameInputOutput)
    ));
    request.output_path = root.join("batch.mp4").to_string_lossy().to_string();
    request.clips.push(clip());
    let outputs = output_paths_for_clips(
        &request.output_path,
        &request.clips,
        request.settings.format,
    );
    fs::write(&outputs[0], b"existing export").unwrap();
    assert!(validate_request(&request).is_err());
    assert_eq!(fs::read(&outputs[0]).unwrap(), b"existing export");
    request.timeline = true;
    request.clips = timeline_clips;
    assert_eq!(request_output_paths(&request), vec![request.output_path.clone()]);
    assert!(validate_request(&request).is_ok());
    let temporary = root.join("cancelled.partial.mp4");
    fs::write(&temporary, b"partial").unwrap();
    {
        let _guard = ExportArtifacts(vec![temporary.to_string_lossy().to_string()]);
    }
    assert!(!temporary.exists());
    fs::remove_dir_all(root).unwrap();
}
