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
use crate::transport::{Closer, Request, Response, Stream, Transport};
use crate::parts::{self, Comment, Delivery, File, Notes, Parts, Sending};
use crate::typed::{self, Answer, Ask, ModelRef, Offers, Restore};
use crate::{ids, place};

/// One box's routes. Cheap to clone: clones share the box's transport and its gate.
#[derive(Clone)]
pub struct BoxClient {
    transport: Arc<dyn Transport>,
    /// The gate, and which of the box's servers it was read from ([`Transport::refresh`]).
    gate: Arc<Mutex<(Gate, u64)>>,
}

/// What a composer sends: the text as typed, and what goes with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    /// The send's own id: the same send again (after a dropped connection) is taken once.
    pub id: String,
    /// What was typed (what it replies to apart: see [`BoxClient::send_draft`]'s `quote`).
    pub text: String,
    /// Files and pictures, as the engine takes them, and the note on those sent otherwise.
    pub files: Vec<File>,
    pub notes: Notes,
    /// Review comments on the changes that go with it.
    pub comments: Vec<Comment>,
    /// The sessions picked from the "&" list as it was written.
    pub named: Vec<String>,
    /// The title of the widget it answers ("" for one without a title).
    pub widget: Option<String>,
    /// Whether the side thread's tag is on the composer.
    pub side: bool,
    /// Why the conversation's model can't run, as the client says it (it's kept, not sent).
    pub refusal: Option<String>,
    /// The model picked last in "Who reads it", for a review.
    pub reviewer: Option<ModelRef>,
    /// Now, or after the run under way.
    pub delivery: Delivery,
}

impl Draft {
    pub fn new(id: impl Into<String>, text: impl Into<String>) -> Draft {
        Draft {
            id: id.into(),
            text: text.into(),
            files: Vec::new(),
            notes: Notes::default(),
            comments: Vec::new(),
            named: Vec::new(),
            widget: None,
            side: false,
            refusal: None,
            reviewer: None,
            delivery: Delivery::Steer,
        }
    }
}

/// What became of a text sent from a composer.
#[derive(Debug, Clone, PartialEq)]
pub enum Sent {
    /// A message, sent to the agent under this id.
    Message { id: String },
    /// The box read it (`typed`), or it was kept for a model that can't run: what it did and what
    /// the client does with the rest. Where it said to send a message or run a command, that's been
    /// sent (`message`, its id); anything else in it is the client's to do (a `!` command, compact,
    /// switch the mode shown, the side thread), and `restore` and `error` go back to the composer.
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
        BoxClient { transport: Arc::new(transport), gate: Arc::new(Mutex::new((Gate::Unknown, 0))) }
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

    /// Where the box stands with this client, as last read.
    pub fn gate(&self) -> Gate {
        self.gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).0.clone()
    }

    fn set_gate(&self, gate: Gate, server: u64) {
        *self.gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = (gate, server);
    }

    /// The gate for the box's server now: not known yet for one that started again since it was
    /// read (another version's, maybe), which is read again before it's asked anything else.
    fn current_gate(&self) -> Gate {
        let server = self.transport.refresh();
        let mut gate = self.gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if gate.1 != server {
            *gate = (Gate::Unknown, server);
        }
        gate.0.clone()
    }

    /// Reads `kuvo/info` and applies the update gate: a box lacking a name in [`gate::REQUIRED`]
    /// (or answering no `kuvo/info`, `404` or `405`) is held. Read again to let a held box go once
    /// it has updated.
    pub fn connect(&self) -> Result<BoxInfo> {
        let server = self.transport.refresh();
        let response = self.transport.send(&Request::get("kuvo/info"))?;
        if response.status == 404 || response.status == 405 {
            self.set_gate(Gate::for_features::<String>(None), server);
            return Err(Error::NeedsUpdating { missing: gate::REQUIRED.iter().map(|name| (*name).to_owned()).collect() });
        }
        let info: BoxInfo = decode(&response)?;
        self.set_gate(Gate::for_features(Some(&info.features)), server);
        Ok(info)
    }

    /// Refused in the client, without reaching the box, while it waits for its update.
    fn check_gate(&self, path: &str) -> Result<()> {
        if gate::is_allowed(path) {
            return Ok(());
        }
        if self.current_gate() == Gate::Unknown {
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

    /// Opens a followed route (behind the gate). `hold` gets what closes it, before its answer
    /// comes (see [`Transport::open`]).
    pub fn open(&self, request: &Request, hold: &dyn Fn(Closer) -> bool) -> Result<Stream> {
        self.check_gate(&request.path)?;
        self.transport.open(request, hold)
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

    /// Where `session` lives on this box: its engine, else its coding agents' bridge. Neither has
    /// it: a `404` refusal saying so.
    pub fn where_is(&self, session: &str) -> Result<Where> {
        for place in [Where::Engine, Where::Agents] {
            let response = self.send(&Request::get(place.session_route(session, "")))?;
            if response.is_success() {
                return Ok(place);
            }
            // The agents bridge not running (503) is "not known", not "not there".
            if response.status != 404 {
                return Err(Error::Refused(Refusal::from_answer(response.status, &response.body)));
            }
        }
        Err(Error::Refused(self.not_here()))
    }

    /// A conversation that isn't on this box (any more).
    pub(crate) fn not_here(&self) -> Refusal {
        Refusal { status: 404, message: format!("This conversation isn’t on {} any more.", self.describe()), reason: None, older_box: false }
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

    /// Sends a message as its fields (`kuvo/sessions/<id>/send`): the box writes what the agent
    /// reads, and keeps its parts with it. Taken once per `id` however often it comes.
    pub fn send_message(&self, session: &str, sending: &Sending) -> Result<()> {
        let body = serde_json::to_value(sending).map_err(|error| Error::BadAnswer(error.to_string()))?;
        let mut request = Request::post(parts::send_route(session), body);
        if let Some(id) = &sending.id {
            request = request.header("idempotency-key", id.clone());
        }
        let response = self.send(&request)?;
        if response.is_success() { Ok(()) } else { Err(Error::Refused(Refusal::from_answer(response.status, &response.body))) }
    }

    /// A composer's draft sent, as every client sends it: a plain message straight to the box as
    /// fields; a text starting "/" or "!" to the box first (`typed`), which says what it means,
    /// sending on the message or command it says to. `quote`, given what the composer replies to:
    /// the words with it, as the client writes a reply (KuvoClient's `Quoting.message`), for a
    /// message that takes it.
    pub fn send_draft(&self, session: &str, draft: &Draft, quote: Option<&dyn Fn(&str) -> String>) -> Result<Sent> {
        let quoted = |words: &str| quote.map_or_else(|| words.to_owned(), |quote| quote(words));
        if !typed::asks_box(&draft.text) {
            // With a model that can't run, it's kept, saying why, as the box would.
            if let Some(refusal) = &draft.refusal {
                let answer = Answer { restore: Some(Restore { text: draft.text.clone(), beside: None }), error: Some(refusal.clone()), ..Answer::default() };
                return Ok(Sent::Typed { answer: Box::new(answer), message: None });
            }
            let sending = Sending {
                id: Some(draft.id.clone()),
                words: quoted(&draft.text),
                files: draft.files.clone(),
                delivery: Some(draft.delivery),
                widget: draft.widget.clone(),
                comments: draft.comments.clone(),
                named: draft.named.clone(),
                notes: draft.notes.clone(),
                ..Sending::default()
            };
            self.send_message(session, &sending)?;
            return Ok(Sent::Message { id: draft.id.clone() });
        }
        let ask = Ask {
            id: draft.id.clone(),
            text: draft.text.clone(),
            files: !draft.files.is_empty() || !draft.notes.is_empty(),
            side: draft.side,
            refusal: draft.refusal.clone(),
            reviewer: draft.reviewer.clone(),
        };
        let answer = self.typed(session, &ask)?;
        let mut sending = Sending { id: Some(draft.id.clone()), files: draft.files.clone(), notes: draft.notes.clone(), delivery: Some(draft.delivery), ..Sending::default() };
        if let Some(send) = &answer.send {
            sending.words = if send.quoted == Some(true) { quoted(&send.text) } else { send.text.clone() };
            sending.keyword = send.typed.clone();
            sending.comments = draft.comments.clone();
            sending.named = draft.named.clone();
            if send.steer == Some(true) {
                sending.delivery = Some(Delivery::Steer);
            }
        } else if let Some(run) = &answer.command {
            sending.words = run.arguments.clone();
            sending.command = Some(run.name.clone());
        } else {
            return Ok(Sent::Typed { answer: Box::new(answer), message: None });
        }
        self.send_message(session, &sending)?;
        Ok(Sent::Typed { answer: Box::new(answer), message: Some(draft.id.clone()) })
    }

    /// The parts of messages from before (none kept with them), read from their texts by the box
    /// (`kuvo/messages/parts`), one for each, in order.
    pub fn read_parts(&self, texts: &[String]) -> Result<Vec<Parts>> {
        #[derive(serde::Deserialize)]
        struct Told {
            parts: Vec<Parts>,
        }
        let mut all = Vec::with_capacity(texts.len());
        for batch in texts.chunks(parts::READ_MOST) {
            let told: Told = self.value(&Request::post(parts::READ_ROUTE, json!({ "texts": batch })))?;
            if told.parts.len() != batch.len() {
                return Err(Error::BadAnswer("The box read a different number of messages than it was asked.".into()));
            }
            all.extend(told.parts);
        }
        Ok(all)
    }

    /// The messages before `cursor` (a page's [`Page::earlier`]), newest first as the engine
    /// answers, and the way back from them.
    pub fn earlier_messages(&self, session: &str, place: Where, cursor: &str, limit: usize) -> Result<(Vec<Message>, Option<String>)> {
        let page: Page = self.get(&messages::earlier_route(place, session, cursor, limit))?;
        let earlier = page.earlier(limit);
        Ok((page.data, earlier))
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
