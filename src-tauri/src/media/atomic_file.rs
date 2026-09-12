use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn temporary_path(destination: &Path) -> PathBuf {
    let extension = destination
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("tmp");
    destination.with_file_name(format!(
        ".lumen-{}.partial.{extension}",
        uuid::Uuid::new_v4()
    ))
}

/// Both paths must be on the same volume. The existing destination survives failures.
pub fn replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
    }
}

pub fn write(destination: &Path, contents: &[u8]) -> std::io::Result<()> {
    let temporary = temporary_path(destination);
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        replace(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn replaces_complete_contents() {
        let path = std::env::temp_dir().join(format!("lumen-{}.json", uuid::Uuid::new_v4()));
        super::write(&path, b"old project").unwrap();
        super::write(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        std::fs::remove_file(path).unwrap();
    }
}
