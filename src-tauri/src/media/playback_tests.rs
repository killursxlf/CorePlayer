use super::*;

fn run(mut command: Command) {
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

fn video_frames(path: &str) -> Vec<(f64, bool)> {
    let output = media_command(super::super::binaries::ffprobe_path().unwrap())
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp_time,key_frame",
            "-of",
            "json",
            path,
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    json["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|frame| {
            (
                frame["best_effort_timestamp_time"]
                    .as_str()
                    .unwrap()
                    .parse()
                    .unwrap(),
                frame["key_frame"].as_u64() == Some(1),
            )
        })
        .collect()
}

#[test]
#[ignore = "Requires FFmpeg and ffprobe"]
fn playback_proxy_preserves_vfr_and_audio() {
    let root = std::env::temp_dir().join(format!(
        "coreplayer-proxy-regression-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).unwrap();
    let input = root.join("vfr.mp4");
    let mut command = media_command(ffmpeg_path().unwrap());
    command
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30:duration=8",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=8",
            "-vf",
            "select='if(lt(t,4),not(mod(n,2)),1)'",
            "-fps_mode",
            "vfr",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "240",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
        ])
        .arg(&input);
    run(command);
    let input = input.to_str().unwrap();
    let backend = BackgroundMediaBackend::default();
    backend.set_playing(true);
    let proxy =
        generate_playback_proxy(input, "vfr-test", &backend, backend.proxy_token()).unwrap();
    let original_frames = video_frames(input);
    let proxy_frames = video_frames(&proxy);
    assert_eq!(original_frames.len(), proxy_frames.len());
    for (original, proxy) in original_frames.iter().zip(&proxy_frames) {
        assert!(
            (original.0 - proxy.0).abs() < 0.0001,
            "Frame timestamps changed: {original:?} -> {proxy:?}"
        );
    }
    let keys: Vec<_> = proxy_frames
        .iter()
        .filter(|(_, key)| *key)
        .map(|(time, _)| *time)
        .collect();
    assert!(keys.windows(2).all(|pair| pair[1] - pair[0] <= 0.567));
    let info = super::super::ffprobe::probe_media(&proxy).unwrap();
    assert_eq!(info.has_audio, Some(true));
    assert_eq!(info.resolution.as_deref(), Some("640 x 360"));
    assert!((info.duration - 8.0).abs() < 0.05);
    let modified = fs::metadata(&proxy).unwrap().modified().unwrap();
    assert_eq!(
        generate_playback_proxy(input, "vfr-test", &backend, backend.proxy_token()).unwrap(),
        proxy
    );
    assert_eq!(
        fs::metadata(&proxy).unwrap().modified().unwrap(),
        modified,
        "A valid cached proxy must be reused"
    );
    // A corrupt cache entry must be rebuilt, even if it is larger than 1 KiB.
    fs::write(&proxy, [0_u8; 2048]).unwrap();
    generate_playback_proxy(input, "vfr-test", &backend, backend.proxy_token()).unwrap();
    assert!(super::super::ffprobe::probe_media(&proxy).is_ok());
    fs::remove_file(proxy).unwrap();
    fs::remove_dir_all(root).unwrap();
}

/// Serves real 4K and proxy files for the external Chrome/CDP benchmark.
/// Set COREPLAYER_BENCH_DIR to an empty disposable directory, then write stop to finish.
#[test]
#[ignore = "Manual playback benchmark with FFmpeg and a browser"]
fn playback_benchmark_server() {
    let root =
        PathBuf::from(std::env::var_os("COREPLAYER_BENCH_DIR").expect("Set COREPLAYER_BENCH_DIR"));
    fs::create_dir_all(&root).unwrap();
    let input = root.join("long-gop-4k.mp4");
    if !input.exists() {
        let mut generate = media_command(ffmpeg_path().unwrap());
        generate
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=3840x2160:rate=30:duration=24",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=24",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-threads",
                "2",
                "-g",
                "300",
                "-sc_threshold",
                "0",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
            ])
            .arg(&input);
        run(generate);
    }
    let backend = BackgroundMediaBackend::default();
    let started = Instant::now();
    let input_str = input.to_str().unwrap();
    let proxy =
        generate_playback_proxy(input_str, "benchmark", &backend, backend.proxy_token()).unwrap();
    let generation_ms = started.elapsed().as_millis();
    let server = super::super::http_server::MediaHttpServer::start().unwrap();
    let original = server.register(input_str).unwrap();
    let optimized = server.register(&proxy).unwrap();
    let probe = super::super::ffprobe::probe_media(input_str).unwrap();
    fs::write(root.join("server.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "original": original, "optimized": optimized, "probe": probe, "generationMs": generation_ms, "serverPid": std::process::id()
    })).unwrap()).unwrap();
    println!("Playback benchmark ready: {}", root.display());
    let deadline = Instant::now() + Duration::from_secs(300);
    while !root.join("stop").exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
}
