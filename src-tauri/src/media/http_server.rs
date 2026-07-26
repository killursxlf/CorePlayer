use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Arc, RwLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use uuid::Uuid;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const READ_BUFFER_BYTES: usize = 128 * 1024;
pub const MAX_RESPONSE_RANGE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone)]
struct MediaEntry {
    path: PathBuf,
    size: u64,
    modified_ms: u128,
    mime_type: String,
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    registered_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackRegistration {
    pub media_id: String,
    pub stream_url: String,
    pub file_size: u64,
    pub mime_type: String,
}

pub struct MediaHttpServer {
    port: u16,
    token: String,
    entries: Arc<RwLock<HashMap<String, MediaEntry>>>,
    shutdown: Arc<AtomicBool>,
}

impl MediaHttpServer {
    pub fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let entries = Arc::new(RwLock::new(HashMap::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_entries = entries.clone();
        let thread_shutdown = shutdown.clone();
        let token = Uuid::new_v4().to_string();
        let thread_token = token.clone();
        thread::spawn(move || {
            while !thread_shutdown.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let entries = thread_entries.clone();
                        let token = thread_token.clone();
                        thread::spawn(move || {
                            let _ = handle_connection(stream, &entries, &token);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => thread::sleep(Duration::from_millis(50)),
                }
            }
        });
        Ok(Self { port, token, entries, shutdown })
    }

    pub fn register(&self, input_path: &str) -> std::io::Result<PlaybackRegistration> {
        let path = std::fs::canonicalize(input_path)?;
        let metadata = path.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Media source is not a file."));
        }
        let size = metadata.len();
        let modified_ms = metadata.modified().ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let mime_type = mime_for_path(&path).to_string();
        let media_id = Uuid::new_v4().to_string();
        let registered_ms = SystemTime::now().duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis()).unwrap_or(0);
        let entry = MediaEntry { path, size, modified_ms, mime_type: mime_type.clone(), registered_ms };
        self.entries.write()
            .map_err(|_| std::io::Error::other("Media registry lock is poisoned."))?
            .insert(media_id.clone(), entry);
        Ok(PlaybackRegistration {
            stream_url: format!(
                "http://127.0.0.1:{}/media/{}?token={}",
                self.port, media_id, self.token
            ),
            media_id,
            file_size: size,
            mime_type,
        })
    }

    pub fn unregister_url(&self, url: &str) {
        let Some(rest) = url.split("/media/").nth(1) else { return };
        let id = rest.split('?').next().unwrap_or_default();
        if let Ok(mut entries) = self.entries.write() {
            entries.remove(id);
        }
    }

    pub fn registration_count(&self) -> usize {
        self.entries.read().map(|entries| entries.len()).unwrap_or(0)
    }
}

impl Drop for MediaHttpServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
    }
}

fn handle_connection(
    mut stream: TcpStream,
    entries: &RwLock<HashMap<String, MediaEntry>>,
    session_token: &str,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    let request = read_request(&mut stream)?;
    let mut lines = request.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let target = request_parts.next().unwrap_or_default();
    if method != "GET" && method != "HEAD" {
        return write_simple(&mut stream, 405, "Method Not Allowed", &[("Allow", "GET, HEAD")]);
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let supplied_token = query.split('&').find_map(|part| part.strip_prefix("token="));
    if supplied_token != Some(session_token) {
        return write_simple(&mut stream, 403, "Forbidden", &[]);
    }
    let Some(media_id) = path.strip_prefix("/media/").filter(|id| !id.is_empty() && !id.contains('/')) else {
        return write_simple(&mut stream, 404, "Not Found", &[]);
    };
    let entry = entries.read().ok().and_then(|registry| registry.get(media_id).cloned());
    let Some(entry) = entry else {
        return write_simple(&mut stream, 404, "Not Found", &[]);
    };
    let metadata = entry.path.metadata()?;
    if !metadata.is_file() || metadata.len() != entry.size {
        return write_simple(&mut stream, 409, "Conflict", &[]);
    }
    let current_modified = metadata.modified().ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis()).unwrap_or(0);
    if current_modified != entry.modified_ms {
        return write_simple(&mut stream, 409, "Conflict", &[]);
    }
    let range_header = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("range").then(|| value.trim())
    });
    let resolved = match resolve_range(range_header, entry.size, MAX_RESPONSE_RANGE_BYTES) {
        Ok(value) => value,
        Err(_) => {
            let header = format!("Content-Range: bytes */{}\r\n", entry.size);
            return write_raw(&mut stream, "HTTP/1.1 416 Range Not Satisfiable\r\n", &header, &[]);
        }
    };
    let (status, start, end, content_length) = match resolved {
        Some(range) => (206, range.start, range.end, range.length),
        None => (200, 0, entry.size.saturating_sub(1), entry.size),
    };
    #[cfg(debug_assertions)]
    eprintln!(
        "[media-http] method={method} id={media_id} range={} actual={start}-{end} status={status} length={content_length} size={} age_ms={}",
        range_header.is_some(),
        entry.size,
        SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or(0).saturating_sub(entry.registered_ms),
    );
    let mut headers = format!(
        "Content-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n",
        entry.mime_type, content_length
    );
    if status == 206 {
        headers.push_str(&format!("Content-Range: bytes {start}-{end}/{}\r\n", entry.size));
    }
    write!(stream, "HTTP/1.1 {} {}\r\n{}\r\n", status, if status == 206 { "Partial Content" } else { "OK" }, headers)?;
    if method == "HEAD" || content_length == 0 {
        return stream.flush();
    }
    let mut file = File::open(&entry.path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = content_length;
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
    while remaining > 0 {
        let requested = usize::try_from(remaining.min(READ_BUFFER_BYTES as u64))
            .map_err(|_| std::io::Error::other("Range buffer conversion failed."))?;
        let read = file.read(&mut buffer[..requested])?;
        if read == 0 { break; }
        if stream.write_all(&buffer[..read]).is_err() {
            return Ok(());
        }
        remaining = remaining.checked_sub(read as u64)
            .ok_or_else(|| std::io::Error::other("Range byte counter underflow."))?;
    }
    Ok(())
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut bytes = Vec::with_capacity(2048);
    let mut buffer = [0_u8; 2048];
    loop {
        let read = stream.read(&mut buffer)?;
        if read == 0 { break; }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") { break; }
        if bytes.len() > MAX_HEADER_BYTES {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "HTTP headers are too large."));
        }
    }
    String::from_utf8(bytes).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "HTTP headers are not UTF-8."))
}

fn write_simple(stream: &mut TcpStream, status: u16, reason: &str, extra: &[(&str, &str)]) -> std::io::Result<()> {
    let mut headers = String::from("Content-Length: 0\r\nConnection: close\r\n");
    for (name, value) in extra {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    write!(stream, "HTTP/1.1 {status} {reason}\r\n{headers}\r\n")
}

fn write_raw(stream: &mut TcpStream, status: &str, headers: &str, body: &[u8]) -> std::io::Result<()> {
    write!(stream, "{status}{headers}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len())?;
    stream.write_all(body)
}

fn mime_for_path(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "mkv" => "video/x-matroska",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ts" | "mts" | "m2ts" => "video/mp2t",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ResolvedRange { start: u64, end: u64, length: u64 }

fn resolve_range(value: Option<&str>, file_size: u64, max_bytes: u64) -> Result<Option<ResolvedRange>, ()> {
    let Some(value) = value else { return Ok(None) };
    if file_size == 0 || max_bytes == 0 || !value.starts_with("bytes=") || value.contains(',') {
        return Err(());
    }
    let spec = &value[6..];
    let (left, right) = spec.split_once('-').ok_or(())?;
    let (start, requested_end) = if left.is_empty() {
        let suffix = right.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 { return Err(()); }
        (file_size.saturating_sub(suffix.min(file_size)), file_size - 1)
    } else {
        let start = left.parse::<u64>().map_err(|_| ())?;
        if start >= file_size { return Err(()); }
        let end = if right.is_empty() { file_size - 1 } else { right.parse::<u64>().map_err(|_| ())?.min(file_size - 1) };
        if end < start { return Err(()); }
        (start, end)
    };
    let capped_end = start.checked_add(max_bytes - 1).ok_or(())?.min(requested_end);
    let length = capped_end.checked_sub(start).and_then(|value| value.checked_add(1)).ok_or(())?;
    Ok(Some(ResolvedRange { start, end: capped_end, length }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn parses_ranges_with_64_bit_offsets() {
        assert_eq!(resolve_range(None, 100, 8), Ok(None));
        assert_eq!(resolve_range(Some("bytes=0-0"), 100, 8), Ok(Some(ResolvedRange { start: 0, end: 0, length: 1 })));
        assert_eq!(resolve_range(Some("bytes=0-1023"), 10_000, 8 * 1024 * 1024), Ok(Some(ResolvedRange { start: 0, end: 1023, length: 1024 })));
        assert_eq!(resolve_range(Some("bytes=1024-"), 10_000, 1024), Ok(Some(ResolvedRange { start: 1024, end: 2047, length: 1024 })));
        assert_eq!(resolve_range(Some("bytes=-64"), 1000, 1024), Ok(Some(ResolvedRange { start: 936, end: 999, length: 64 })));
        let start = 32_u64 * 1024 * 1024 * 1024;
        assert_eq!(resolve_range(Some(&format!("bytes={start}-")), 100_u64 * 1024 * 1024 * 1024, 8 * 1024 * 1024).unwrap().unwrap().start, start);
    }

    #[test]
    fn rejects_invalid_and_unsatisfiable_ranges() {
        for value in ["", "bytes=", "bytes=5-4", "bytes=-0", "bytes=100-", "bytes=0-1,4-5", "bytes=x-y", "bytes=18446744073709551616-"] {
            assert!(resolve_range(Some(value), 100, 8).is_err(), "{value}");
        }
        assert!(resolve_range(Some("bytes=0-0"), 0, 8).is_err());
    }

    #[test]
    fn caps_open_and_oversized_ranges() {
        assert_eq!(resolve_range(Some("bytes=10-999"), 1000, 8), Ok(Some(ResolvedRange { start: 10, end: 17, length: 8 })));
        assert_eq!(resolve_range(Some("bytes=95-9999"), 100, 8), Ok(Some(ResolvedRange { start: 95, end: 99, length: 5 })));
    }

    #[test]
    #[cfg_attr(target_os = "windows", ignore = "NTFS sparse allocation requires platform-specific FSCTL_SET_SPARSE")]
    fn streams_bytes_beyond_twenty_gib_from_sparse_file() {
        let path = std::env::temp_dir().join(format!("coreplayer-range-{}.mkv", Uuid::new_v4()));
        let offset = 20_u64 * 1024 * 1024 * 1024 + 12_345;
        let mut file = File::create(&path).expect("create sparse test file");
        file.set_len(offset + 4).expect("resize sparse test file");
        file.seek(SeekFrom::Start(offset)).expect("seek sparse test file");
        file.write_all(b"TEST").expect("write sparse marker");
        drop(file);

        let server = MediaHttpServer::start().expect("start media server");
        let registration = server.register(path.to_str().expect("utf8 path")).expect("register media");
        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).expect("connect media server");
        write!(
            stream,
            "GET /media/{}?token={} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes={}-{}\r\nConnection: close\r\n\r\n",
            registration.media_id,
            server.token,
            offset,
            offset + 3
        ).expect("write range request");
        let mut response = Vec::new();
        stream.read_to_end(&mut response).expect("read range response");
        let split = response.windows(4).position(|window| window == b"\r\n\r\n").expect("response headers");
        assert!(String::from_utf8_lossy(&response[..split]).starts_with("HTTP/1.1 206"));
        assert_eq!(&response[split + 4..], b"TEST");
        let _ = std::fs::remove_file(path);
    }
}
