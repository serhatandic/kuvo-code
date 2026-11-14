//! A box on this computer, over its own server (PROTOCOL.md, "This Mac's box", "Kept for clients"):
//! HTTP/1.1 on `127.0.0.1` at the port its `run/serve.json` names, with Basic
//! `opencode:<password>` from that file, saying who's asking with `x-kuvo-from`.
//!
//! A small client of our own rather than an HTTP library: it only ever talks to 127.0.0.1 in plain
//! HTTP, must skip the box's interim `102 Processing` while a route holds a request, and must be
//! closable from another thread while a followed route waits for its next line.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;

use crate::error::{Error, Result};
use crate::place;
use crate::transport::{Closer, Request, Response, Stream, Transport};

/// Who a client is to a box on its own computer, as its server takes it (`x-kuvo-from`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speaker {
    /// Kuvo Code's own app with this Mac's box (`app`): the app's box in its folder, or this Mac's
    /// box moved into a home of its own.
    App,
    /// Kuvo Code on this computer reaching a box that isn't its own (`mac`), taken as `box route`
    /// takes it: a machine's box attached in place, once it says `box.serve.mac`.
    Mac,
}

impl Speaker {
    pub fn header(self) -> &'static str {
        match self {
            Speaker::App => "app",
            Speaker::Mac => "mac",
        }
    }
}

/// A box's own server on 127.0.0.1.
pub struct LocalServer {
    endpoint: Endpoint,
    speaker: Speaker,
    label: String,
    /// The server last found (its pid and port), and how many times it's been found somewhere new.
    found: Mutex<(Option<(i64, u16)>, u64)>,
}

/// Where it answers.
enum Endpoint {
    /// At a port and password given once.
    Fixed { port: u16, password: String },
    /// Where a box's record (`run/serve.json`) says, read again for each request, so a server
    /// started again (a new port and password each time) is found, and one gone isn't sent anything:
    /// its port could be anyone's by then.
    Recorded { folder: PathBuf },
}

impl std::fmt::Debug for LocalServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never its password.
        f.debug_struct("LocalServer").field("speaker", &self.speaker).field("label", &self.label).finish_non_exhaustive()
    }
}

/// How long to wait for 127.0.0.1 to take the connection: a server that's there takes it at once.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a whole answer may go with nothing coming: a box holding a request says it's still
/// working every 20 seconds (`102 Processing`), so only a server that's stopped answering waits
/// this long. A followed route has none: it's quiet while nothing changes, and is closed by what
/// follows it.
const QUIET_TIMEOUT: Duration = Duration::from_secs(90);

impl LocalServer {
    /// A server at a port and password known already.
    pub fn new(port: u16, password: impl Into<String>, speaker: Speaker, label: impl Into<String>) -> LocalServer {
        LocalServer::with(Endpoint::Fixed { port, password: password.into() }, speaker, label)
    }

    /// The server a box's record in `folder` names, as it names it at each request (checked to
    /// be the box's server each time: [`crate::place::serve_record`]).
    pub fn recorded(folder: impl Into<PathBuf>, speaker: Speaker, label: impl Into<String>) -> LocalServer {
        LocalServer::with(Endpoint::Recorded { folder: folder.into() }, speaker, label)
    }

    fn with(endpoint: Endpoint, speaker: Speaker, label: impl Into<String>) -> LocalServer {
        LocalServer { endpoint, speaker, label: label.into(), found: Mutex::new((None, 0)) }
    }

    /// Where it answers now: its port and password.
    fn locate(&self) -> Result<(u16, String)> {
        let (pid, port, password) = match &self.endpoint {
            Endpoint::Fixed { port, password } => (0, *port, password.clone()),
            Endpoint::Recorded { folder } => {
                let record = place::serve_record(folder, place::runs_serve)?;
                (record.pid, record.port as u16, record.password)
            }
        };
        let mut found = self.found.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if found.0 != Some((pid, port)) {
            if found.0.is_some() {
                found.1 += 1;
            }
            found.0 = Some((pid, port));
        }
        Ok((port, password))
    }

    fn connect(&self) -> Result<(TcpStream, u16, String)> {
        let (port, password) = self.locate()?;
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT)
            .map_err(|error| Error::NotRunning(format!("Kuvo Code on {} isn't answering ({}).", self.label, error.kind())))?;
        let _ = stream.set_nodelay(true);
        Ok((stream, port, password))
    }

    fn write_request(&self, stream: &mut TcpStream, port: u16, password: &str, request: &Request) -> Result<()> {
        let body = match &request.body {
            Some(value) => serde_json::to_vec(value).map_err(|error| Error::BadAnswer(error.to_string()))?,
            None => Vec::new(),
        };
        let path = request.path.trim_start_matches('/');
        // A path is one token on the request line: one that isn't is never sent.
        if path.contains(|c: char| c.is_whitespace() || c.is_control()) || !request.method.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(Error::BadAnswer(format!("That isn't a route: {path:?}")));
        }
        let mut head = format!("{} /{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n", request.method.to_ascii_uppercase(), path, port);
        let token = base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"));
        head.push_str(&format!("Authorization: Basic {token}\r\nx-kuvo-from: {}\r\n", self.speaker.header()));
        for (name, value) in &request.headers {
            // (A header can't carry a line break: one that does isn't sent.)
            if name.contains(['\r', '\n', ':']) || value.contains(['\r', '\n']) {
                continue;
            }
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        if request.body.is_some() {
            head.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", body.len()));
        } else if request.method.eq_ignore_ascii_case("POST") || request.method.eq_ignore_ascii_case("PUT") || request.method.eq_ignore_ascii_case("PATCH") {
            head.push_str("Content-Length: 0\r\n");
        }
        head.push_str("\r\n");
        stream
            .write_all(head.as_bytes())
            .and_then(|_| stream.write_all(&body))
            .and_then(|_| stream.flush())
            .map_err(|error| self.dropped(error))
    }

    fn dropped(&self, error: io::Error) -> Error {
        Error::Unreachable(format!("The connection to Kuvo Code on {} dropped ({}).", self.label, error.kind()))
    }

    /// Sends `request` and reads its answer's head, its body left to read. `hold` gets what closes
    /// the connection before anything's sent.
    fn begin(&self, request: &Request, quiet: Option<Duration>, hold: &dyn Fn(Closer) -> bool) -> Result<(Head, BodyReader)> {
        let (mut stream, port, password) = self.connect()?;
        let socket = stream.try_clone().map_err(|error| self.dropped(error))?;
        if !hold(Closer::new(move || {
            let _ = socket.shutdown(Shutdown::Both);
        })) {
            return Err(Error::Unreachable("Stopped.".into()));
        }
        let _ = stream.set_read_timeout(quiet);
        self.write_request(&mut stream, port, &password, request)?;
        let mut reader = BufReader::new(stream);
        let head = read_head(&mut reader).map_err(|error| self.dropped(error))?;
        if head.status == 401 {
            return Err(Error::NotRunning(format!("Kuvo Code on {} didn't take this client's password: it may have started again.", self.label)));
        }
        let body = BodyReader::new(reader, &head);
        Ok((head, body))
    }
}

impl Transport for LocalServer {
    fn send(&self, request: &Request) -> Result<Response> {
        let (head, mut body) = self.begin(request, Some(QUIET_TIMEOUT), &|_| true)?;
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes).map_err(|error| self.dropped(error))?;
        Ok(Response { status: head.status, content_type: head.content_type, body: bytes })
    }

    fn open(&self, request: &Request, hold: &dyn Fn(Closer) -> bool) -> Result<Stream> {
        let kept: Mutex<Option<Closer>> = Mutex::new(None);
        let (head, body) = self.begin(request, None, &|closer| {
            *kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(closer.clone());
            hold(closer)
        })?;
        let closer = kept.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner()).unwrap_or_else(Closer::nothing);
        Ok(Stream { status: head.status, content_type: head.content_type, reader: Box::new(BufReader::new(body)), closer })
    }

    fn refresh(&self) -> u64 {
        // (One gone now is found so by the request itself.)
        let _ = self.locate();
        self.found.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).1
    }

    fn streams(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        self.label.clone()
    }
}

/// An answer's head: its status and what its body is.
#[derive(Debug)]
struct Head {
    status: u16,
    content_type: Option<String>,
    length: Option<u64>,
    chunked: bool,
}

/// Reads the head, skipping interim answers (`100 Continue`, the box's `102 Processing` while it
/// holds a request).
fn read_head(reader: &mut impl BufRead) -> io::Result<Head> {
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed before answering"));
        }
        let mut parts = line.trim_end().splitn(3, ' ');
        let version = parts.next().unwrap_or("");
        let status: u16 = parts.next().and_then(|code| code.parse().ok()).ok_or_else(|| bad("a status line"))?;
        if !version.starts_with("HTTP/1.") {
            return Err(bad("HTTP/1.x"));
        }
        let mut head = Head { status, content_type: None, length: None, chunked: false };
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header)? == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed in the head"));
            }
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            let Some((name, value)) = header.split_once(':') else { continue };
            let value = value.trim();
            match name.trim().to_ascii_lowercase().as_str() {
                "content-type" => head.content_type = Some(value.to_owned()),
                "content-length" => head.length = value.parse().ok(),
                "transfer-encoding" => head.chunked = value.to_ascii_lowercase().contains("chunked"),
                _ => {}
            }
        }
        if (100..200).contains(&status) && status != 101 {
            continue;
        }
        return Ok(head);
    }
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("expected {what}"))
}

/// A body as it comes: chunked, of a known length, or until the connection closes.
struct BodyReader {
    inner: BufReader<TcpStream>,
    kind: BodyKind,
}

enum BodyKind {
    Length(u64),
    Chunked { left: u64, done: bool },
    UntilClosed,
}

impl BodyReader {
    fn new(inner: BufReader<TcpStream>, head: &Head) -> BodyReader {
        let kind = if head.status == 204 || head.status == 304 {
            BodyKind::Length(0)
        } else if head.chunked {
            BodyKind::Chunked { left: 0, done: false }
        } else if let Some(length) = head.length {
            BodyKind::Length(length)
        } else {
            BodyKind::UntilClosed
        };
        BodyReader { inner, kind }
    }
}

impl Read for BodyReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        match &mut self.kind {
            BodyKind::Length(left) => {
                if *left == 0 {
                    return Ok(0);
                }
                let most = buffer.len().min(usize::try_from(*left).unwrap_or(usize::MAX));
                let read = self.inner.read(&mut buffer[..most])?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the answer was cut off"));
                }
                *left -= read as u64;
                Ok(read)
            }
            BodyKind::UntilClosed => self.inner.read(buffer),
            BodyKind::Chunked { left, done } => {
                if *done {
                    return Ok(0);
                }
                if *left == 0 {
                    let mut size = String::new();
                    if self.inner.read_line(&mut size)? == 0 {
                        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the answer was cut off"));
                    }
                    let size = size.trim().split(';').next().unwrap_or("");
                    let size = u64::from_str_radix(size, 16).map_err(|_| bad("a chunk's size"))?;
                    if size == 0 {
                        // Trailers, up to the blank line.
                        loop {
                            let mut trailer = String::new();
                            if self.inner.read_line(&mut trailer)? == 0 || trailer.trim().is_empty() {
                                break;
                            }
                        }
                        *done = true;
                        return Ok(0);
                    }
                    *left = size;
                }
                let most = buffer.len().min(usize::try_from(*left).unwrap_or(usize::MAX));
                let read = self.inner.read(&mut buffer[..most])?;
                if read == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "the answer was cut off"));
                }
                *left -= read as u64;
                if *left == 0 {
                    let mut end = [0u8; 2];
                    self.inner.read_exact(&mut end)?;
                }
                Ok(read)
            }
        }
    }
}
