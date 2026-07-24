use std::{
    env,
    path::{Path, PathBuf},
};

use crate::media::errors::MediaError;

pub fn ffmpeg_path() -> Result<PathBuf, MediaError> {
    resolve_binary("ffmpeg", "FFMPEG_PATH")
}

pub fn ffprobe_path() -> Result<PathBuf, MediaError> {
    resolve_binary("ffprobe", "FFPROBE_PATH")
}

fn resolve_binary(name: &str, env_var: &str) -> Result<PathBuf, MediaError> {
    let exe_names = binary_names(name);
    let mut checked = Vec::new();

    if let Some(path) = env::var_os(env_var).map(PathBuf::from) {
        for candidate in expand_candidate(path, &exe_names) {
            checked.push(candidate.clone());
            if is_file(&candidate) {
                return Ok(candidate);
            }
        }
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(app_dir) = current_exe.parent() {
            for dir in [
                app_dir,
                &app_dir.join("bin"),
                &app_dir.join("resources"),
                &app_dir.join("ffmpeg"),
            ] {
                for candidate in expand_candidate(dir.to_path_buf(), &exe_names) {
                    checked.push(candidate.clone());
                    if is_file(&candidate) {
                        return Ok(candidate);
                    }
                }
            }
        }
    }

    for candidate in path_candidates(&exe_names) {
        checked.push(candidate.clone());
        if is_file(&candidate) {
            return Ok(candidate);
        }
    }

    for candidate in common_windows_candidates(&exe_names) {
        checked.push(candidate.clone());
        if is_file(&candidate) {
            return Ok(candidate);
        }
    }

    Err(MediaError::FfmpegUnavailable {
        binary: name.to_string(),
        checked: checked
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
    })
}

fn expand_candidate(path: PathBuf, exe_names: &[String]) -> Vec<PathBuf> {
    if path.extension().is_some() {
        return vec![path];
    }

    exe_names
        .iter()
        .map(|exe_name| path.join(exe_name))
        .collect()
}

fn path_candidates(exe_names: &[String]) -> Vec<PathBuf> {
    let Some(path_var) = env::var_os("PATH") else {
        return Vec::new();
    };

    env::split_paths(&path_var)
        .flat_map(|dir| expand_candidate(dir, exe_names))
        .collect()
}

fn common_windows_candidates(exe_names: &[String]) -> Vec<PathBuf> {
    #[cfg(not(windows))]
    {
        let _ = exe_names;
        Vec::new()
    }

    #[cfg(windows)]
    {
        let mut roots = Vec::new();
        if let Some(program_files) = env::var_os("ProgramFiles").map(PathBuf::from) {
            roots.push(program_files);
        }
        if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)").map(PathBuf::from) {
            roots.push(program_files_x86);
        }
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.push(local_app_data);
        }
        if let Some(user_profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
            roots.push(user_profile);
        }
        roots.push(PathBuf::from("C:\\"));
        roots.push(PathBuf::from("C:\\tools"));
        roots.push(PathBuf::from("C:\\ProgramData"));

        roots
            .into_iter()
            .flat_map(|root| {
                [
                    root.join("ffmpeg").join("bin"),
                    root.join("FFmpeg").join("bin"),
                    root.join("ffmpeg-master-latest-win64-gpl").join("bin"),
                    root.join("ffmpeg-8.1.2-full_build").join("bin"),
                    root.join("ffmpeg-8.1.2-full_build-www.gyan.dev")
                        .join("bin"),
                    root.join("gyan.dev").join("ffmpeg").join("bin"),
                    root.join("Microsoft")
                        .join("WinGet")
                        .join("Packages")
                        .join("Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe")
                        .join("ffmpeg-8.1.2-full_build")
                        .join("bin"),
                    root.join("scoop").join("shims"),
                    root.join("chocolatey").join("bin"),
                ]
            })
            .flat_map(|dir| expand_candidate(dir, exe_names))
            .collect()
    }
}

fn binary_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if name.contains('.') {
            vec![name.to_string()]
        } else {
            vec![
                format!("{name}.exe"),
                format!("{name}.cmd"),
                format!("{name}.bat"),
            ]
        }
    }

    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

fn is_file(path: &Path) -> bool {
    path.is_file()
}
