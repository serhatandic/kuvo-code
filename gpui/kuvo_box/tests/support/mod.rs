//! A stand-in box for the tests: a small HTTP server on 127.0.0.1 that takes only its password,
//! answers what each test tells it to, and keeps every request it was sent. Streams are fed by the
//! test, a line at a time, so nothing waits on a clock. Its home is a folder of its own, laid out as
//! a box's, which goes with the test; nothing of the user's is read or touched.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine as _;
use serde_json::Value;

/// A request the stand-in was sent.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Option<Value>,
}

impl Seen {
    pub fn route(&self) -> &str {
        self.path.split('?').next().unwrap_or(&self.path)
    }
}

/// What it answers.
pub enum Answer {
    /// A whole answer, after an interim `102 Processing` when `interim`.
    Whole { status: u16, body: Value, interim: bool },
    /// A stream (chunked), a line or event for each string the test sends; it ends when the test
    /// drops its sender.
    Stream { content_type: &'static str, lines: Receiver<String> },
}

impl Answer {
    pub fn json(status: u16, body: Value) -> Answer {
        Answer::Whole { status, body, interim: false }
    }
}

type Handler = dyn Fn(&Seen) -> Answer + Send + Sync;

pub struct StandInBox {
    pub port: u16,
    pub password: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    handler: Arc<Mutex<Arc<Handler>>>,
    /// Streams the test made for the next requests that open one, by route, in order.
    streams: Arc<Mutex<HashMap<String, VecDeque<Receiver<String>>>>>,
}

impl StandInBox {
    pub fn start(handler: impl Fn(&Seen) -> Answer + Send + Sync + 'static) -> StandInBox {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let port = listener.local_addr().unwrap().port();
        let password = "stand-in-password".to_owned();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Mutex<Arc<Handler>>> = Arc::new(Mutex::new(Arc::new(handler)));
        let streams = Arc::new(Mutex::new(HashMap::new()));
        let (s, h, st, pw) = (seen.clone(), handler.clone(), streams.clone(), password.clone());
        thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(connection) = connection else { continue };
                let (s, h, st, pw) = (s.clone(), h.clone(), st.clone(), pw.clone());
                thread::spawn(move || serve(connection, &pw, &s, &h, &st));
            }
        });
        StandInBox { port, password, seen, handler, streams }
    }

    /// Answers with `handler` from now on.
    pub fn answer(&self, handler: impl Fn(&Seen) -> Answer + Send + Sync + 'static) {
        *self.handler.lock().unwrap() = Arc::new(handler);
    }

    /// A stream for the next request to `route` that opens one; the test sends its lines.
    pub fn stream_for(&self, route: &str) -> Sender<String> {
        let (sender, receiver) = channel();
        self.streams.lock().unwrap().entry(route.to_owned()).or_default().push_back(receiver);
        sender
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    pub fn seen_routes(&self) -> Vec<String> {
        self.seen().iter().map(|seen| format!("{} {}", seen.method, seen.path)).collect()
    }
}

fn serve(connection: TcpStream, password: &str, seen: &Mutex<Vec<Seen>>, handler: &Mutex<Arc<Handler>>, streams: &Mutex<HashMap<String, VecDeque<Receiver<String>>>>) {
    let mut writer = connection.try_clone().unwrap();
    let mut reader = BufReader::new(connection);
    let mut first = String::new();
    if reader.read_line(&mut first).unwrap_or(0) == 0 {
        return;
    }
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let path = parts.next().unwrap_or("/").trim_start_matches('/').to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let length: usize = headers.get("content-length").and_then(|length| length.parse().ok()).unwrap_or(0);
    let mut body = vec![0; length];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    // Only its own password, as a box's server takes it.
    let expected = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}")));
    if headers.get("authorization") != Some(&expected) {
        let _ = writer.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }
    let request = Seen { method, path, headers, body: (!body.is_empty()).then(|| serde_json::from_slice(&body).expect("a JSON body")) };
    seen.lock().unwrap().push(request.clone());
    let waiting = streams.lock().unwrap().get_mut(request.route()).and_then(VecDeque::pop_front);
    let answer = match waiting {
        Some(lines) => Answer::Stream { content_type: if request.route().ends_with("api/event") { "text/event-stream" } else { "application/x-ndjson" }, lines },
        None => {
            let handler = handler.lock().unwrap().clone();
            handler(&request)
        }
    };
    match answer {
        Answer::Whole { status, body, interim } => {
            if interim {
                let _ = writer.write_all(b"HTTP/1.1 102 Processing\r\n\r\n");
            }
            let body = serde_json::to_vec(&body).unwrap();
            let head = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = writer.write_all(head.as_bytes()).and_then(|_| writer.write_all(&body));
        }
        Answer::Stream { content_type, lines } => {
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
            if writer.write_all(head.as_bytes()).is_err() {
                return;
            }
            let sse = content_type == "text/event-stream";
            for line in lines {
                let piece = if sse { format!("data: {line}\n\n") } else { format!("{line}\n") };
                let chunk = format!("{:x}\r\n{piece}\r\n", piece.len());
                if writer.write_all(chunk.as_bytes()).and_then(|_| writer.flush()).is_err() {
                    return;
                }
            }
            let _ = writer.write_all(b"0\r\n\r\n");
        }
    }
}

/// A folder for one test, gone with it.
pub fn home() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("kuvo-box-test").tempdir().expect("a folder for the test")
}

/// A process whose command line is a box's server's (`… kuvo-link.js serve`), as `run/serve.json`
/// names one: it waits on its input, and ends when the test lets it go (its input closes).
pub struct ServeProcess {
    child: Child,
}

impl ServeProcess {
    pub fn start() -> ServeProcess {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "echo ready; read _", "kuvo-link.js", "serve"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        unset_kuvo(&mut command);
        let mut child = command.spawn().expect("sh");
        // Once it says so, it runs as itself (not still the test, before its exec).
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        ServeProcess { child }
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }
}

impl Drop for ServeProcess {
    fn drop(&mut self) {
        // Its input closed, it ends by itself; waited for, so nothing's left behind.
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

/// Every `KUVO_*` variable taken out of what `command` runs with.
pub fn unset_kuvo(command: &mut Command) {
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("KUVO_") {
            command.env_remove(name);
        }
    }
}

/// Writes `run/serve.json` in `folder`.
pub fn write_record(folder: &Path, pid: u32, port: u16, password: &str) {
    std::fs::create_dir_all(folder.join("run")).unwrap();
    std::fs::write(folder.join("run/serve.json"), serde_json::json!({ "pid": pid, "port": port, "password": password }).to_string()).unwrap();
}

/// The app's box folder under `home`.
pub fn app_box(home: &Path) -> PathBuf {
    home.join("Library/Application Support/run.kuvo.code/box")
}

/// Every feature the client needs, and a few more.
pub fn current_features() -> Value {
    let mut names: Vec<&str> = kuvo_box::gate::REQUIRED.to_vec();
    names.extend(["queue", "work-queue", "asks"]);
    serde_json::json!(names)
}

pub fn mac_info(features: Value) -> Value {
    serde_json::json!({ "kind": "mac", "name": "Stand-in Mac", "app": "0.9.0", "engine": "2.2.6", "features": features, "agents": true, "started": 1.0, "chats": "/home/me/.kuvo-code/chats", "integrations": {} })
}
