use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use uuid::Uuid;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const READ_BUFFER_BYTES: usize = 256 * 1024;
const MAX_CONNECTIONS: usize = 16;
const MAX_REQUESTS_PER_CONNECTION: usize = 100;
pub const MAX_RESPONSE_RANGE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone)]
struct MediaEntry {
    _lease: Arc<super::proxy_cache::Lease>,
    cancelled: Arc<AtomicBool>,
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
    connections: Arc<Mutex<HashMap<u64, TcpStream>>>,
}

impl MediaHttpServer {
    pub fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let entries = Arc::new(RwLock::new(HashMap::new()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let thread_entries = entries.clone();
        let thread_shutdown = shutdown.clone();
        let token = Uuid::new_v4().to_string();
        let thread_token = token.clone();
        let connections = Arc::new(Mutex::new(HashMap::<u64, TcpStream>::new()));
        let thread_connections = connections.clone();
        thread::spawn(move || {
            let mut connection_id = 0_u64;
            while !thread_shutdown.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        if thread_shutdown.load(Ordering::Acquire) {
                            break;
                        }
                        let Ok(mut active) = thread_connections.lock() else {
                            break;
                        };
                        // Bound threads, sockets and body buffers even during a seek storm.
                        if active.len() >= MAX_CONNECTIONS {
                            continue;
                        }
                        let Ok(socket) = stream.try_clone() else {
                            continue;
                        };
                        connection_id = connection_id.wrapping_add(1);
                        let id = connection_id;
                        active.insert(id, socket);
                        drop(active);
                        let entries = thread_entries.clone();
                        let token = thread_token.clone();
                        let connections = thread_connections.clone();
                        let shutdown = thread_shutdown.clone();
                        let spawned =
                            thread::Builder::new()
                                .name("media-http".into())
                                .spawn(move || {
                                    let _guard = ConnectionGuard { id, connections };
                                    let _ = handle_connection(stream, &entries, &token, &shutdown);
                                });
                        if spawned.is_err() {
                            if let Ok(mut active) = thread_connections.lock() {
                                active.remove(&id);
                            }
                        }
                    }
                    Err(_) => thread::sleep(Duration::from_millis(50)),
                }
            }
        });
        Ok(Self {
            port,
            token,
            entries,
            shutdown,
            connections,
        })
    }

    pub fn register(&self, input_path: &str) -> std::io::Result<PlaybackRegistration> {
        let path = std::fs::canonicalize(input_path)?;
        let metadata = path.metadata()?;
        if !metadata.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Media source is not a file.",
            ));
        }
        let size = metadata.len();
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let mime_type = mime_for_path(&path).to_string();
        let media_id = Uuid::new_v4().to_string();
        let registered_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let entry = MediaEntry {
            _lease: Arc::new(super::proxy_cache::Lease::new(&path)),
            cancelled: Arc::new(AtomicBool::new(false)),
            path,
            size,
            modified_ms,
            mime_type: mime_type.clone(),
            registered_ms,
        };
        self.entries
            .write()
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
        let Some(rest) = url.split("/media/").nth(1) else {
            return;
        };
        let id = rest.split('?').next().unwrap_or_default();
        if let Ok(mut entries) = self.entries.write() {
            if let Some(entry) = entries.remove(id) {
                entry.cancelled.store(true, Ordering::Release);
            }
        }
    }

    pub fn registration_count(&self) -> usize {
        self.entries
            .read()
            .map(|entries| entries.len())
            .unwrap_or(0)
    }
}

impl Drop for MediaHttpServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        // Wake the blocking accept without a polling delay on every new seek.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Ok(active) = self.connections.lock() {
            for socket in active.values() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
}

struct ConnectionGuard {
    id: u64,
    connections: Arc<Mutex<HashMap<u64, TcpStream>>>,
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.connections.lock() {
            active.remove(&self.id);
        }
    }
}

fn handle_connection(
    mut stream: TcpStream,
    entries: &RwLock<HashMap<String, MediaEntry>>,
    session_token: &str,
    shutdown: &AtomicBool,
) -> std::io::Result<()> {
    stream.set_nodelay(true)?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut pending = Vec::with_capacity(2048);
    for index in 0..MAX_REQUESTS_PER_CONNECTION {
        if shutdown.load(Ordering::Acquire) {
            break;
        }
        let Some(request) = read_request(&mut stream, &mut pending, shutdown)? else {
            return Ok(());
        };
        if !handle_request(
            &mut stream,
            entries,
            session_token,
            &request,
            shutdown,
            index + 1 < MAX_REQUESTS_PER_CONNECTION,
        )? {
            return Ok(());
        }
    }
    Ok(())
}

fn handle_request(
    stream: &mut TcpStream,
    entries: &RwLock<HashMap<String, MediaEntry>>,
    session_token: &str,
    request: &str,
    shutdown: &AtomicBool,
    allow_keep_alive: bool,
) -> std::io::Result<bool> {
    let mut lines = request.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let target = request_parts.next().unwrap_or_default();
    let protocol = request_parts.next().unwrap_or_default();
    if method != "GET" && method != "HEAD" {
        write_simple(stream, 405, "Method Not Allowed", &[("Allow", "GET, HEAD")])?;
        return Ok(false);
    }
    let headers = lines.collect::<Vec<_>>();
    let connection_header = headers.iter().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("connection")
            .then(|| value.trim())
    });
    let keep_alive = allow_keep_alive
        && protocol == "HTTP/1.1"
        && !connection_header.is_some_and(|value| value.eq_ignore_ascii_case("close"));
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let supplied_token = query
        .split('&')
        .find_map(|part| part.strip_prefix("token="));
    if supplied_token != Some(session_token) {
        write_simple(stream, 403, "Forbidden", &[])?;
        return Ok(false);
    }
    let Some(media_id) = path
        .strip_prefix("/media/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
    else {
        write_simple(stream, 404, "Not Found", &[])?;
        return Ok(false);
    };
    let entry = entries
        .read()
        .ok()
        .and_then(|registry| registry.get(media_id).cloned());
    let Some(entry) = entry else {
        write_simple(stream, 404, "Not Found", &[])?;
        return Ok(false);
    };
    let metadata = entry.path.metadata()?;
    if !metadata.is_file() || metadata.len() != entry.size {
        write_simple(stream, 409, "Conflict", &[])?;
        return Ok(false);
    }
    let current_modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    if current_modified != entry.modified_ms {
        write_simple(stream, 409, "Conflict", &[])?;
        return Ok(false);
    }
    let range_header = headers.iter().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("range").then(|| value.trim())
    });
    let resolved = match resolve_range(range_header, entry.size, MAX_RESPONSE_RANGE_BYTES) {
        Ok(value) => value,
        Err(_) => {
            let header = format!("Content-Range: bytes */{}\r\n", entry.size);
            write_raw(
                stream,
                "HTTP/1.1 416 Range Not Satisfiable\r\n",
                &header,
                &[],
            )?;
            return Ok(false);
        }
    };
    let (status, start, end, content_length) = match resolved {
        Some(range) => (206, range.start, range.end, range.length),
        None => (200, 0, entry.size.saturating_sub(1), entry.size),
    };
    log::trace!(
        "[media-http] method={method} id={media_id} range={} actual={start}-{end} status={status} length={content_length} size={} age_ms={}",
        range_header.is_some(),
        entry.size,
        SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or(0).saturating_sub(entry.registered_ms),
    );
    let mut headers = format!(
        "Content-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: {}\r\n",
        entry.mime_type,
        content_length,
        if keep_alive { "keep-alive" } else { "close" },
    );
    if keep_alive {
        headers.push_str("Keep-Alive: timeout=5, max=100\r\n");
    }
    if status == 206 {
        headers.push_str(&format!(
            "Content-Range: bytes {start}-{end}/{}\r\n",
            entry.size
        ));
    }
    write!(
        stream,
        "HTTP/1.1 {} {}\r\n{}\r\n",
        status,
        if status == 206 {
            "Partial Content"
        } else {
            "OK"
        },
        headers
    )?;
    if method == "HEAD" || content_length == 0 {
        stream.flush()?;
        return Ok(keep_alive);
    }
    let mut file = File::open(&entry.path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = content_length;
    let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
    while remaining > 0 {
        if shutdown.load(Ordering::Acquire) || entry.cancelled.load(Ordering::Acquire) {
            return Ok(false);
        }
        let requested = usize::try_from(remaining.min(READ_BUFFER_BYTES as u64))
            .map_err(|_| std::io::Error::other("Range buffer conversion failed."))?;
        let read = file.read(&mut buffer[..requested])?;
        if read == 0 {
            return Ok(false);
        }
        if stream.write_all(&buffer[..read]).is_err() {
            return Ok(false);
        }
        remaining = remaining
            .checked_sub(read as u64)
            .ok_or_else(|| std::io::Error::other("Range byte counter underflow."))?;
    }
    stream.flush()?;
    Ok(keep_alive)
}

fn read_request(
    stream: &mut TcpStream,
    bytes: &mut Vec<u8>,
    shutdown: &AtomicBool,
) -> std::io::Result<Option<String>> {
    let mut buffer = [0_u8; 2048];
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if shutdown.load(Ordering::Acquire) {
            return Ok(None);
        }
        if let Some(end) = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
        {
            if end > MAX_HEADER_BYTES {
                return Err(std::io::Error::other("HTTP headers are too large."));
            }
            let request = bytes.drain(..end).collect::<Vec<_>>();
            return String::from_utf8(request)
                .map(Some)
                .map_err(|_| std::io::Error::other("HTTP headers are not UTF-8."));
        }
        if bytes.len() >= MAX_HEADER_BYTES {
            return Err(std::io::Error::other("HTTP headers are too large."));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        // Also observe shutdown when an outstanding read on a cloned Windows
        // socket is not woken immediately by shutdown() on the registry handle.
        stream.set_read_timeout(Some(remaining.min(Duration::from_millis(250))))?;
        let read = match stream.read(&mut buffer) {
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(error) => return Err(error),
        };
        if read == 0 {
            return Ok(None);
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
}

fn write_simple(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    extra: &[(&str, &str)],
) -> std::io::Result<()> {
    let mut headers = String::from("Content-Length: 0\r\nConnection: close\r\n");
    for (name, value) in extra {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    write!(stream, "HTTP/1.1 {status} {reason}\r\n{headers}\r\n")
}

fn write_raw(
    stream: &mut TcpStream,
    status: &str,
    headers: &str,
    body: &[u8],
) -> std::io::Result<()> {
    write!(
        stream,
        "{status}{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

fn mime_for_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mkv" => "video/x-matroska",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ts" | "mts" | "m2ts" => "video/mp2t",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ResolvedRange {
    start: u64,
    end: u64,
    length: u64,
}

fn resolve_range(
    value: Option<&str>,
    file_size: u64,
    max_bytes: u64,
) -> Result<Option<ResolvedRange>, ()> {
    let Some(value) = value else { return Ok(None) };
    if file_size == 0 || max_bytes == 0 || !value.starts_with("bytes=") || value.contains(',') {
        return Err(());
    }
    let spec = &value[6..];
    let (left, right) = spec.split_once('-').ok_or(())?;
    let (start, requested_end) = if left.is_empty() {
        let suffix = right.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (
            file_size.saturating_sub(suffix.min(file_size)),
            file_size - 1,
        )
    } else {
        let start = left.parse::<u64>().map_err(|_| ())?;
        if start >= file_size {
            return Err(());
        }
        let end = if right.is_empty() {
            file_size - 1
        } else {
            right.parse::<u64>().map_err(|_| ())?.min(file_size - 1)
        };
        if end < start {
            return Err(());
        }
        (start, end)
    };
    let capped_end = start
        .checked_add(max_bytes - 1)
        .ok_or(())?
        .min(requested_end);
    let length = capped_end
        .checked_sub(start)
        .and_then(|value| value.checked_add(1))
        .ok_or(())?;
    Ok(Some(ResolvedRange {
        start,
        end: capped_end,
        length,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn wait_until(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !condition() {
            assert!(Instant::now() < deadline, "condition timed out");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn connections_are_bounded_and_shutdown_closes_idle_sockets() {
        let server = MediaHttpServer::start().unwrap();
        let mut sockets = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            sockets.push(TcpStream::connect(("127.0.0.1", server.port)).unwrap());
        }
        wait_until(|| server.connections.lock().unwrap().len() == MAX_CONNECTIONS);
        let mut excess = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        excess
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let result = excess.read(&mut [0; 1]);
        assert!(
            matches!(result, Ok(0))
                || result.is_err_and(|error| error.kind() == std::io::ErrorKind::ConnectionReset)
        );
        let connections = server.connections.clone();
        drop(server);
        wait_until(|| connections.lock().unwrap().is_empty());
    }

    #[test]
    fn pipelined_ranges_keep_their_bytes_and_unregistration_revokes_access() {
        let path = std::env::temp_dir().join(format!("coreplayer-pipeline-{}.mp4", Uuid::new_v4()));
        std::fs::write(&path, b"0123456789").unwrap();
        let server = MediaHttpServer::start().unwrap();
        let registration = server.register(path.to_str().unwrap()).unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let target = format!("/media/{}?token={}", registration.media_id, server.token);
        write!(socket, "GET {target} HTTP/1.1\r\nRange: bytes=1-2\r\n\r\nGET {target} HTTP/1.1\r\nRange: bytes=7-8\r\nConnection: close\r\n\r\n").unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        assert_eq!(response.matches("HTTP/1.1 206").count(), 2);
        assert!(response.contains("\r\n\r\n12HTTP/1.1 206"));
        assert!(response.ends_with("\r\n\r\n78"));
        let entry = server
            .entries
            .read()
            .unwrap()
            .get(&registration.media_id)
            .unwrap()
            .clone();
        server.unregister_url(&registration.stream_url);
        assert!(entry.cancelled.load(Ordering::Acquire));
        let mut socket = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        write!(socket, "GET {target} HTTP/1.1\r\nConnection: close\r\n\r\n").unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 404"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn parses_ranges_with_64_bit_offsets() {
        assert_eq!(resolve_range(None, 100, 8), Ok(None));
        assert_eq!(
            resolve_range(Some("bytes=0-0"), 100, 8),
            Ok(Some(ResolvedRange {
                start: 0,
                end: 0,
                length: 1
            }))
        );
        assert_eq!(
            resolve_range(Some("bytes=0-1023"), 10_000, 8 * 1024 * 1024),
            Ok(Some(ResolvedRange {
                start: 0,
                end: 1023,
                length: 1024
            }))
        );
        assert_eq!(
            resolve_range(Some("bytes=1024-"), 10_000, 1024),
            Ok(Some(ResolvedRange {
                start: 1024,
                end: 2047,
                length: 1024
            }))
        );
        assert_eq!(
            resolve_range(Some("bytes=-64"), 1000, 1024),
            Ok(Some(ResolvedRange {
                start: 936,
                end: 999,
                length: 64
            }))
        );
        let start = 32_u64 * 1024 * 1024 * 1024;
        assert_eq!(
            resolve_range(
                Some(&format!("bytes={start}-")),
                100_u64 * 1024 * 1024 * 1024,
                8 * 1024 * 1024
            )
            .unwrap()
            .unwrap()
            .start,
            start
        );
    }

    #[test]
    fn rejects_invalid_and_unsatisfiable_ranges() {
        for value in [
            "",
            "bytes=",
            "bytes=5-4",
            "bytes=-0",
            "bytes=100-",
            "bytes=0-1,4-5",
            "bytes=x-y",
            "bytes=18446744073709551616-",
        ] {
            assert!(resolve_range(Some(value), 100, 8).is_err(), "{value}");
        }
        assert!(resolve_range(Some("bytes=0-0"), 0, 8).is_err());
    }

    #[test]
    fn caps_open_and_oversized_ranges() {
        assert_eq!(
            resolve_range(Some("bytes=10-999"), 1000, 8),
            Ok(Some(ResolvedRange {
                start: 10,
                end: 17,
                length: 8
            }))
        );
        assert_eq!(
            resolve_range(Some("bytes=95-9999"), 100, 8),
            Ok(Some(ResolvedRange {
                start: 95,
                end: 99,
                length: 5
            }))
        );
    }

    #[test]
    fn streams_bytes_beyond_twenty_gib_from_sparse_file() {
        let path = std::env::temp_dir().join(format!("coreplayer-range-{}.mkv", Uuid::new_v4()));
        let offset = 20_u64 * 1024 * 1024 * 1024 + 12_345;
        let mut file = File::create(&path).expect("create sparse test file");
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::io::AsRawHandle;
            #[link(name = "kernel32")]
            extern "system" {
                fn DeviceIoControl(
                    handle: *mut std::ffi::c_void,
                    code: u32,
                    input: *mut std::ffi::c_void,
                    input_size: u32,
                    output: *mut std::ffi::c_void,
                    output_size: u32,
                    returned: *mut u32,
                    overlapped: *mut std::ffi::c_void,
                ) -> i32;
            }
            let mut returned = 0;
            let result = unsafe {
                DeviceIoControl(
                    file.as_raw_handle(),
                    0x000900c4,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            assert_ne!(
                result,
                0,
                "FSCTL_SET_SPARSE: {}",
                std::io::Error::last_os_error()
            );
        }
        file.set_len(offset + 4).expect("resize sparse test file");
        file.seek(SeekFrom::Start(offset))
            .expect("seek sparse test file");
        file.write_all(b"TEST").expect("write sparse marker");
        drop(file);

        let server = MediaHttpServer::start().expect("start media server");
        let registration = server
            .register(path.to_str().expect("utf8 path"))
            .expect("register media");
        let mut stream =
            TcpStream::connect(("127.0.0.1", server.port)).expect("connect media server");
        write!(
            stream,
            "GET /media/{}?token={} HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes={}-{}\r\nConnection: close\r\n\r\n",
            registration.media_id,
            server.token,
            offset,
            offset + 3
        ).expect("write range request");
        let mut response = Vec::new();
        stream
            .read_to_end(&mut response)
            .expect("read range response");
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("response headers");
        assert!(String::from_utf8_lossy(&response[..split]).starts_with("HTTP/1.1 206"));
        assert_eq!(&response[split + 4..], b"TEST");
        let _ = std::fs::remove_file(path);
    }
}
