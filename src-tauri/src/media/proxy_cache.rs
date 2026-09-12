use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

pub const MAX_PROXY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CACHE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
static LEASES: OnceLock<Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();

pub fn root() -> PathBuf {
    std::env::temp_dir()
        .join("video-editor-cache")
        .join("playback-proxy")
}

/// A registered or currently generated proxy must survive cache maintenance.
pub struct Lease(PathBuf);
impl Lease {
    pub fn new(path: &Path) -> Self {
        let path = path.canonicalize().unwrap_or_else(|_| {
            path.parent()
                .and_then(|parent| parent.canonicalize().ok())
                .and_then(|parent| path.file_name().map(|name| parent.join(name)))
                .unwrap_or_else(|| path.to_owned())
        });
        if let Ok(mut leases) = LEASES.get_or_init(Default::default).lock() {
            *leases.entry(path.clone()).or_default() += 1;
        }
        Self(path)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut leases) = LEASES.get_or_init(Default::default).lock() {
            if let Some(count) = leases.get_mut(&self.0) {
                *count -= 1;
                if *count == 0 {
                    leases.remove(&self.0);
                }
            }
        }
    }
}

pub fn reserve_space() -> std::io::Result<()> {
    prune(&root(), CACHE_BYTES - MAX_PROXY_BYTES)
}

fn prune(root: &Path, target: u64) -> std::io::Result<()> {
    fs::create_dir_all(root)?;
    let leases = LEASES
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| std::io::Error::other("Proxy cache lock is poisoned."))?;
    let mut files = Vec::new();
    let mut bytes = 0_u64;
    // This directory is exclusively owned by the proxy generator. Never follow links.
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("mp4") {
            continue;
        }
        let metadata = entry.metadata()?;
        bytes = bytes.saturating_add(metadata.len());
        let canonical = path.canonicalize()?;
        if !leases.contains_key(&canonical) {
            files.push((
                metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                path,
                metadata.len(),
            ));
        }
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, path, size) in files {
        if bytes <= target {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            bytes = bytes.saturating_sub(size);
        }
    }
    if bytes > target {
        return Err(std::io::Error::other(
            "Playback cache is in use. Close another preview before preparing a new copy.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evicts_old_copies_but_preserves_registered_media() {
        let root = std::env::temp_dir().join(format!("proxy-cache-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let active = root.join("active.mp4");
        fs::write(&active, [0; 40]).unwrap();
        let lease = Lease::new(&active);
        fs::write(root.join("unused.mp4"), [0; 80]).unwrap();
        prune(&root, 40).unwrap();
        assert!(active.exists());
        assert!(!root.join("unused.mp4").exists());
        assert!(prune(&root, 0).is_err());
        drop(lease);
        prune(&root, 0).unwrap();
        fs::remove_dir(&root).unwrap();
    }
}
