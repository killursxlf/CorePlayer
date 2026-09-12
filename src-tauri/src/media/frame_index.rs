use super::{
    binaries::{ffprobe_path, media_command},
    errors::MediaError,
    ffmpeg::create_video_cache_id,
    ffprobe::run_probe_cancellable,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

const MAX_WINDOWS: usize = 8;
const MAX_FRAMES: usize = 8192;
const EPSILON: f64 = 0.000002;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameStep {
    pub time: f64,
    pub seek_time: f64,
    pub at_boundary: bool,
}

#[derive(Debug)]
struct FrameWindow {
    fingerprint: String,
    frames: Vec<f64>,
    first: bool,
    last: bool,
}

impl FrameWindow {
    fn step(&self, time: f64, direction: i8) -> Option<FrameStep> {
        if self.frames.is_empty() {
            return None;
        }
        let upper = self
            .frames
            .partition_point(|frame| *frame <= time + EPSILON);
        // The first decoded frame need not be the first frame of the file.
        if upper == 0 && !self.first {
            return None;
        }
        if upper == self.frames.len() && !self.last {
            return None;
        }
        let current = upper.saturating_sub(1);
        let index = if direction > 0 {
            if upper == 0 {
                0
            } else {
                (current + 1).min(self.frames.len() - 1)
            }
        } else {
            if current == 0 && !self.first {
                return None;
            }
            current.saturating_sub(1)
        };
        // Need the following timestamp to choose a point strictly inside this frame.
        if index + 1 == self.frames.len() && !self.last {
            return None;
        }
        let target = *self.frames.get(index)?;
        let inset = self
            .frames
            .get(index + 1)
            .map(|next| ((next - target) / 4.0).min(0.001))
            .unwrap_or(0.000001);
        Some(FrameStep {
            time: target,
            seek_time: target + inset,
            at_boundary: upper > 0 && index == current,
        })
    }
}

#[derive(Default)]
pub struct FrameIndex {
    epoch: AtomicU64,
    windows: Mutex<VecDeque<FrameWindow>>,
}

impl FrameIndex {
    pub fn token(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }
    pub fn cancel(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }

    pub fn step(
        &self,
        input: &str,
        time: f64,
        direction: i8,
        token: u64,
    ) -> Result<FrameStep, MediaError> {
        if !time.is_finite() || time < 0.0 || !matches!(direction, -1 | 1) {
            return Err(MediaError::Io("Invalid frame step request.".into()));
        }
        let fingerprint = create_video_cache_id(input)?;
        // One lookup at a time bounds decoder processes and coalesces cache misses.
        let mut windows = self
            .windows
            .lock()
            .map_err(|_| MediaError::Io("Frame index lock is poisoned.".into()))?;
        if self.token() != token {
            return Err(MediaError::Io("Frame lookup cancelled.".into()));
        }
        if let Some(index) = windows.iter().position(|window| {
            window.fingerprint == fingerprint && window.step(time, direction).is_some()
        }) {
            let window = windows.remove(index).unwrap();
            let result = window.step(time, direction).unwrap();
            windows.push_front(window);
            return Ok(result);
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        // Expand only when a long frame/hold or an index boundary needs more context.
        for span in [2.0, 8.0, 32.0, 128.0] {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let start = (time - span).max(0.0);
            let end = time + span;
            let mut command = media_command(ffprobe_path()?);
            command.args(["-v", "error", "-threads", "1", "-select_streams", "V:0", "-read_intervals"])
                .arg(format!("{start:.6}%{end:.6}"))
                .args(["-show_frames", "-show_entries", "frame=best_effort_timestamp_time:stream=start_time,duration:format=start_time,duration", "-of", "json"])
                .arg(input);
            let output = run_probe_cancellable(&mut command, remaining, || self.token() != token)?;
            if !output.status.success() || !output.stderr.is_empty() {
                return Err(MediaError::Io(format!(
                    "Could not read exact frame timestamps: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                )));
            }
            let value: Value = serde_json::from_slice(&output.stdout)
                .map_err(|error| MediaError::Io(error.to_string()))?;
            let window = parse_window(&value, &fingerprint, start, end)?;
            let result = window.step(time, direction);
            if self.token() != token {
                return Err(MediaError::Io("Frame lookup cancelled.".into()));
            }
            if create_video_cache_id(input)? != fingerprint {
                return Err(MediaError::Io(
                    "The source changed during frame lookup.".into(),
                ));
            }
            windows.push_front(window);
            windows.truncate(MAX_WINDOWS);
            if let Some(result) = result {
                return Ok(result);
            }
        }
        Err(MediaError::Io("Could not locate the adjacent frame within the analysis limit. Try the optimized copy.".into()))
    }
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_str()?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn parse_window(
    value: &Value,
    fingerprint: &str,
    start: f64,
    end: f64,
) -> Result<FrameWindow, MediaError> {
    let raw = value["frames"]
        .as_array()
        .ok_or_else(|| MediaError::Io("This source has no indexed video frames.".into()))?;
    if raw.len() > MAX_FRAMES {
        return Err(MediaError::Io(
            "Frame analysis exceeded its memory limit.".into(),
        ));
    }
    let mut frames = Vec::with_capacity(raw.len());
    for frame in raw {
        let time = number(&frame["best_effort_timestamp_time"])
            .ok_or_else(|| MediaError::Io("A frame has no presentation timestamp.".into()))?;
        // Preserve positive stream offsets. Chromium's video timeline uses these PTS.
        if time >= 0.0 {
            frames.push(time);
        }
    }
    frames.sort_by(f64::total_cmp);
    if frames.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(MediaError::Io(
            "Frames share a timestamp; this source cannot be stepped exactly in the preview."
                .into(),
        ));
    }
    let stream = &value["streams"][0];
    if stream.is_null() {
        return Err(MediaError::Io("This source has no video stream.".into()));
    }
    let video_start = number(&stream["start_time"]).unwrap_or(0.0).max(0.0);
    let video_end = number(&stream["duration"])
        .filter(|duration| *duration > 0.0)
        .map(|duration| duration + video_start)
        .or_else(|| {
            number(&value["format"]["duration"]).map(|duration| {
                duration
                    + number(&value["format"]["start_time"])
                        .unwrap_or(0.0)
                        .max(0.0)
            })
        });
    Ok(FrameWindow {
        fingerprint: fingerprint.into(),
        first: start <= video_start
            || frames
                .first()
                .is_some_and(|frame| *frame <= video_start + EPSILON),
        last: video_end.is_some_and(|duration| end >= duration + EPSILON),
        frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn steps_display_order_and_holds_at_boundaries() {
        let window = FrameWindow {
            fingerprint: "test".into(),
            frames: vec![0.0, 0.04, 0.12, 0.14, 0.3],
            first: true,
            last: true,
        };
        for (time, direction, expected) in [
            (0.0, -1, 0.0),
            (0.0, 1, 0.04),
            (0.06, 1, 0.12),
            (0.06, -1, 0.0),
            (0.14, -1, 0.12),
            (0.3, 1, 0.3),
            (0.32, -1, 0.14),
        ] {
            let step = window.step(time, direction).unwrap();
            assert_eq!(step.time, expected);
            assert!(step.seek_time > step.time);
        }
    }
    #[test]
    fn partial_windows_never_guess_a_missing_neighbour() {
        let window = FrameWindow {
            fingerprint: "test".into(),
            frames: vec![4.0, 4.04, 4.12],
            first: false,
            last: false,
        };
        assert!(window.step(3.9, 1).is_none());
        assert!(window.step(4.0, -1).is_none());
        assert!(window.step(4.04, 1).is_none());
        assert!(window.step(4.2, 1).is_none());
        assert_eq!(window.step(4.04, -1).unwrap().time, 4.0);
    }
    #[test]
    fn decoded_pts_are_sorted_without_removing_nonzero_start_time() {
        let value = serde_json::json!({"frames":[{"best_effort_timestamp_time":"5.12"},{"best_effort_timestamp_time":"5.0"},{"best_effort_timestamp_time":"5.04"}],"streams":[{"start_time":"5.0","duration":".16"}]});
        let window = parse_window(&value, "test", 3.0, 7.0).unwrap();
        assert_eq!(window.step(5.0, 1).unwrap().time, 5.04);
        assert_eq!(window.step(0.0, 1).unwrap().time, 5.0);
    }

    #[test]
    #[ignore = "Requires FFmpeg and ffprobe"]
    fn exact_frame_steps_match_decoded_vfr_b_frames_and_offsets() {
        use super::super::binaries::ffmpeg_path;
        let fixture_root = std::env::var_os("COREPLAYER_FRAME_FIXTURES");
        let root = fixture_root
            .as_ref()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir().join(format!("coreplayer-frame-step-{}", uuid::Uuid::new_v4()))
            });
        std::fs::create_dir_all(&root).unwrap();
        let mut fixtures = Vec::new();
        for (name, offset, filter) in [
            (
                "vfr",
                "0",
                "select='if(lt(t,4),not(mod(n,3)),if(lt(t,8),not(mod(n,2)),1))'",
            ),
            ("offset", "5", "null"),
            ("hold", "0", "select='eq(n,0)+eq(n,300)+eq(n,330)'"),
        ] {
            let path = root.join(format!("{name}.mp4"));
            let output = media_command(ffmpeg_path().unwrap())
                .args([
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=30000/1001:duration=12",
                    "-vf",
                    filter,
                    "-fps_mode",
                    "vfr",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "fast",
                    "-threads",
                    "1",
                    "-g",
                    "240",
                    "-bf",
                    "3",
                    "-sc_threshold",
                    "0",
                    "-output_ts_offset",
                    offset,
                ])
                .arg(&path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let path = path.to_str().unwrap();
            let output = media_command(ffprobe_path().unwrap())
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "V:0",
                    "-show_frames",
                    "-show_entries",
                    "frame=best_effort_timestamp_time",
                    "-of",
                    "json",
                    path,
                ])
                .output()
                .unwrap();
            let value: Value = serde_json::from_slice(&output.stdout).unwrap();
            let times: Vec<_> = value["frames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|frame| number(&frame["best_effort_timestamp_time"]).unwrap())
                .collect();
            assert!(times.len() >= 3);
            let index = FrameIndex::default();
            let started = Instant::now();
            for (position, time) in times.iter().enumerate() {
                let next = index.step(path, *time, 1, index.token()).unwrap();
                let previous = index.step(path, *time, -1, index.token()).unwrap();
                assert_eq!(
                    next.time,
                    times[(position + 1).min(times.len() - 1)],
                    "{name} next at {time}"
                );
                assert_eq!(
                    previous.time,
                    times[position.saturating_sub(1)],
                    "{name} previous at {time}"
                );
                if let Some(after) = times.get(position + 1) {
                    let middle = (*time + after) / 2.0;
                    assert_eq!(
                        index.step(path, middle, 1, index.token()).unwrap().time,
                        *after
                    );
                    assert_eq!(
                        index.step(path, middle, -1, index.token()).unwrap().time,
                        times[position.saturating_sub(1)]
                    );
                }
            }
            assert_eq!(
                index.step(path, 0.0, -1, index.token()).unwrap().time,
                times[0]
            );
            assert!(index.windows.lock().unwrap().len() <= MAX_WINDOWS);
            let token = index.token();
            index.cancel();
            assert!(index.step(path, 0.0, 1, token).is_err());
            println!(
                "{name}: {} decoded frames, all forward/backward/interior steps match in {:?}",
                times.len(),
                started.elapsed()
            );
            fixtures.push(serde_json::json!({"name":name,"path":path,"times":times,"probe":super::super::ffprobe::probe_media(path).unwrap()}));
        }
        if fixture_root.is_some() {
            let source = root.join("vfr.mp4");
            let backend = super::super::ffmpeg::BackgroundMediaBackend::default();
            let proxy = super::super::ffmpeg::generate_playback_proxy(
                source.to_str().unwrap(),
                "frame-browser",
                &backend,
                backend.proxy_token(),
            )
            .unwrap();
            let path = root.join("proxy.mp4");
            std::fs::copy(&proxy, &path).unwrap();
            fixtures.push(serde_json::json!({"name":"proxy","path":path,"times":fixtures[0]["times"],"probe":super::super::ffprobe::probe_media(path.to_str().unwrap()).unwrap()}));
            std::fs::write(
                root.join("frames.json"),
                serde_json::to_vec_pretty(&fixtures).unwrap(),
            )
            .unwrap();
        } else {
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
