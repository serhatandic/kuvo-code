//! Where a box's routes are reached: over its own server on this computer ([`crate::local`]), or
//! one request at a time through its CLI over SSH ([`crate::ssh`]). A client asks both the same way.

use std::io::BufRead;
use std::sync::Arc;

use crate::error::Result;

/// A request for one of a box's routes (PROTOCOL.md, "Messages in a session"): its method, its
/// path without a leading slash (`kuvo/info`, `api/session/ses_1/message?limit=50`), the headers
/// a box reads (`x-opencode-directory`, `idempotency-key`) and a JSON body.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<serde_json::Value>,
}

impl Request {
    pub fn get(path: impl Into<String>) -> Request {
        Request { method: "GET".into(), path: path.into(), headers: Vec::new(), body: None }
    }

    pub fn post(path: impl Into<String>, body: serde_json::Value) -> Request {
        Request { method: "POST".into(), path: path.into(), headers: Vec::new(), body: Some(body) }
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Request {
        self.headers.push((name.to_ascii_lowercase(), value.into()));
        self
    }

    /// The route it asks, without its query.
    pub fn route(&self) -> &str {
        self.path.split('?').next().unwrap_or(&self.path)
    }
}

/// A box's whole answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// An answer read as it comes: a followed route (`…/events`, ndjson) or the engine's event stream
/// (`api/event`, server-sent events). Closing it (or dropping its [`Closer`]) ends it from any
/// thread, which a reader blocked on it sees as the end.
pub struct Stream {
    pub status: u16,
    pub content_type: Option<String>,
    pub reader: Box<dyn BufRead + Send>,
    pub closer: Closer,
}

/// Ends a [`Stream`] from another thread.
#[derive(Clone)]
pub struct Closer(Arc<dyn Fn() + Send + Sync>);

impl Closer {
    pub fn new(close: impl Fn() + Send + Sync + 'static) -> Closer {
        Closer(Arc::new(close))
    }

    /// One that has nothing to close (an answer already read whole).
    pub fn nothing() -> Closer {
        Closer::new(|| {})
    }

    pub fn close(&self) {
        (self.0)()
    }
}

/// How a client reaches one box.
pub trait Transport: Send + Sync {
    /// Sends `request` and reads its whole answer.
    fn send(&self, request: &Request) -> Result<Response>;

    /// Opens a route that follows something. A transport that doesn't stream answers it once (a
    /// followed route's first line) and ends. `hold` is handed what closes it as soon as there's
    /// something to close, before the answer's head comes (a box holds some requests a while), so
    /// what opened it can end it meanwhile; `hold` saying no (it's ended already) ends it there.
    fn open(&self, request: &Request, hold: &dyn Fn(Closer) -> bool) -> Result<Stream>;

    /// Looks again where the box is, and says which time it's found it somewhere new: a client
    /// reads a box's `kuvo/info` again once its server started again (another version's, maybe).
    fn refresh(&self) -> u64 {
        0
    }

    /// Whether what [`Transport::open`] gives keeps coming as things change. One that doesn't is
    /// read again on a timer by what follows it.
    fn streams(&self) -> bool;

    /// Where it goes, in words (for a refusal of the client's own): "this Mac", a machine's name.
    fn describe(&self) -> String;
}
