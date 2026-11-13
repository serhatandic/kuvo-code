//! One box as a client sees it: its routes, wherever it is, behind its update gate.

use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::error::{Error, Refusal, Result};
use crate::gate::{self, Gate};
use crate::info::BoxInfo;
use crate::messages::{self, Message, Page, Where};
use crate::sessions::{self, Line};
use crate::ssh::SshBox;
use crate::transport::{Request, Response, Stream, Transport};
use crate::typed::{self, Answer, Ask, Offers};
use crate::{ids, place, paths};

/// One box's routes. Cheap to clone: clones share the box's transport and its gate.
#[derive(Clone)]
pub struct BoxClient {
    transport: Arc<dyn Transport>,
    gate: Arc<Mutex<Gate>>,
}

/// How a message goes to the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// To the agent now, read at its next step (`steer`).
    Now,
    /// After the run under way ends, in the queue the box carries (`queue`).
    Queue,
}

/// What became of a text sent from a composer.
#[derive(Debug, Clone, PartialEq)]
pub enum Sent {
    /// A message, sent to the agent under this id.
    Message { id: String },
    /// The box read it (`typed`): what it did and what the client does with the rest. Where it said
    /// to send a message, that's been sent (`message`, its id); anything else in it is the client's
    /// to do (run a command, compact, switch the mode shown), and `restore` and `error` go back to
    /// the composer.
    Typed { answer: Box<Answer>, message: Option<String> },
}

/// The Work Queue's counts, as its panel shows them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkCounts {
    /// Items not done ("24 open").
    pub open: usize,
    /// Every item, done too.
    pub all: usize,
}

impl BoxClient {
    /// A box reached through `transport`.
    pub fn new(transport: impl Transport + 'static) -> BoxClient {
        BoxClient { transport: Arc::new(transport), gate: Arc::new(Mutex::new(Gate::Unknown)) }
    }

    /// This Mac's own box, as found under `home` (the user's home folder): its server, by its record.
    /// [`Error::NotRunning`] when Kuvo Code isn't running here.
    pub fn this_mac(home: &Path) -> Result<BoxClient> {
        let found = place::this_mac(home).ok_or_else(|| Error::NotRunning("Kuvo Code isn't set up on this Mac.".into()))?;
        Ok(BoxClient::new(place::server(&found, "this Mac")?))
    }

    /// A machine's box over SSH.
    pub fn machine(ssh: SshBox) -> BoxClient {
        BoxClient::new(ssh)
    }

    /// Whether what this box follows keeps coming as things change (its own server), or is read
    /// again on a timer (a machine over SSH).
    pub fn streams(&self) -> bool {
        self.transport.streams()
    }

    pub fn gate(&self) -> Gate {
        self.gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    fn set_gate(&self, gate: Gate) {
        *self.gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = gate;
    }

    /// Reads `kuvo/info` and applies the update gate: a box lacking a name in [`gate::REQUIRED`]
    /// (or answering no `kuvo/info`, `404` or `405`) is held. Read again to let a held box go once
    /// it has updated.
    pub fn connect(&self) -> Result<BoxInfo> {
        let response = self.transport.send(&Request::get("kuvo/info"))?;
        if response.status == 404 || response.status == 405 {
            self.set_gate(Gate::for_features::<String>(None));
            return Err(Error::NeedsUpdating { missing: gate::REQUIRED.iter().map(|name| (*name).to_owned()).collect() });
        }
        let info: BoxInfo = decode(&response)?;
        self.set_gate(Gate::for_features(Some(&info.features)));
        Ok(info)
    }

    /// Refused in the client, without reaching the box, while it waits for its update.
    fn check_gate(&self, path: &str) -> Result<()> {
        if gate::is_allowed(path) {
            return Ok(());
        }
        if self.gate() == Gate::Unknown {
            match self.connect() {
                Ok(_) | Err(Error::NeedsUpdating { .. }) => {}
                Err(error) => return Err(error),
            }
        }
        match self.gate() {
            Gate::Held { missing } => Err(Error::NeedsUpdating { missing }),
            _ => Ok(()),
        }
    }

    /// Sends `request` (behind the gate) and reads its whole answer, whatever its status.
    pub fn send(&self, request: &Request) -> Result<Response> {
        self.check_gate(&request.path)?;
        self.transport.send(request)
    }

    /// Opens a followed route (behind the gate).
    pub fn open(&self, request: &Request) -> Result<Stream> {
        self.check_gate(&request.path)?;
        self.transport.open(request)
    }

    /// Its answer, read as `T`; what the box refuses, as it said it.
    pub fn value<T: DeserializeOwned>(&self, request: &Request) -> Result<T> {
        decode(&self.send(request)?)
    }

    pub fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.value(&Request::get(path))
    }

    // MARK: Sessions

    /// The session list now (`since`: only what changed after where a client was).
    pub fn session_list(&self, since: Option<&str>) -> Result<Line> {
        self.get(&sessions::route(since))
    }

    // MARK: A conversation

    /// Where `session` lives on this box: its engine, else its coding agents' bridge.
    pub fn where_is(&self, session: &str) -> Result<Where> {
        let mut last = None;
        for place in [Where::Engine, Where::Agents] {
            let response = self.send(&Request::get(place.session_route(session, "")))?;
            if response.is_success() {
                return Ok(place);
            }
            let refusal = Refusal::from_answer(response.status, &response.body);
            // The agents bridge not running (503) is "not known", not "not there".
            if response.status != 404 {
                return Err(Error::Refused(refusal));
            }
            last = Some(refusal);
        }
        Err(Error::Refused(last.unwrap_or_else(|| Refusal::from_answer(404, b"{}"))))
    }

    /// The conversation's newest `limit` messages, oldest first.
    pub fn messages(&self, session: &str, place: Where, limit: usize) -> Result<Vec<Message>> {
        let page: Page = self.get(&messages::newest_route(place, session, limit))?;
        let mut messages = page.data;
        messages.reverse();
        Ok(messages)
    }

    /// What "/" offers in the conversation.
    pub fn typed_offers(&self, session: &str) -> Result<Offers> {
        self.get(&typed::route(session))
    }

    /// What the box makes of a typed text. A refusal is an answer too: what goes back to the
    /// composer, and why ([`Answer::refused`]).
    pub fn typed(&self, session: &str, ask: &Ask) -> Result<Answer> {
        let body = serde_json::to_value(ask).map_err(|error| Error::BadAnswer(error.to_string()))?;
        let response = self.send(&Request::post(typed::route(session), body))?;
        if response.status == 200 {
            return decode(&response);
        }
        Ok(Answer::refused(response.status, &response.body, &ask.text))
    }

    /// Sends a message to the agent under `id`, which the box and the engine take once however
    /// often it comes. `Now` goes to the agent (`steer`); `Queue` waits for the run under way, in
    /// the queue the box carries.
    pub fn message(&self, session: &str, place: Where, id: &str, text: &str, delivery: Delivery) -> Result<()> {
        let request = match delivery {
            Delivery::Now => Request::post(place.session_route(session, "/prompt"), json!({ "id": id, "text": text, "delivery": "steer" })),
            Delivery::Queue => Request::post(
                format!("kuvo/sessions/{}/queue/add", paths::segment(session)),
                json!({ "id": id, "text": text, "delivery": "queue" }),
            ),
        }
        .header("idempotency-key", id);
        let response = self.send(&request)?;
        if response.is_success() { Ok(()) } else { Err(Error::Refused(Refusal::from_answer(response.status, &response.body))) }
    }

    /// A composer's text sent, as every client sends it: a plain message straight to the agent; a
    /// text starting "/" or "!" to the box first (`typed`), which says what it means, sending on
    /// what it says to send. `id` is the send's own: the same send again is answered as it was.
    pub fn send_text(&self, session: &str, place: Where, id: &str, text: &str, delivery: Delivery) -> Result<Sent> {
        if !typed::asks_box(text) {
            self.message(session, place, id, text, delivery)?;
            return Ok(Sent::Message { id: id.to_owned() });
        }
        let answer = self.typed(session, &Ask::new(id, text))?;
        let message = match &answer.send {
            Some(send) => {
                let delivery = if send.steer == Some(true) { Delivery::Now } else { delivery };
                self.message(session, place, id, &send.text, delivery)?;
                Some(id.to_owned())
            }
            None => None,
        };
        Ok(Sent::Typed { answer: Box::new(answer), message })
    }

    /// A new send's own id.
    pub fn new_id() -> String {
        ids::message()
    }

    // MARK: Counts

    /// The Work Queue's counts, every queue on the box (`owner=all`), read without asking GitHub.
    pub fn work_counts(&self) -> Result<WorkCounts> {
        let view: Value = self.get("kuvo/work-queue?owner=all&glance=1")?;
        let items = view.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let open = items.iter().filter(|item| item.get("category").and_then(Value::as_str) != Some("done")).count();
        Ok(WorkCounts { open, all: items.len() })
    }

    /// How many asks wait on you in the box's browser (`kuvo/asks`: a sign-in, a code, an action).
    pub fn asks_count(&self) -> Result<usize> {
        let asks: Value = self.get("kuvo/asks")?;
        Ok(asks.get("asks").and_then(Value::as_array).map_or(0, Vec::len))
    }

    /// Where it is, in words.
    pub fn describe(&self) -> String {
        self.transport.describe()
    }
}

/// A successful answer read as `T`, else the box's refusal.
pub(crate) fn decode<T: DeserializeOwned>(response: &Response) -> Result<T> {
    if !response.is_success() {
        return Err(Error::Refused(Refusal::from_answer(response.status, &response.body)));
    }
    serde_json::from_slice(&response.body).map_err(|error| Error::BadAnswer(format!("The answer couldn't be read: {error}")))
}
