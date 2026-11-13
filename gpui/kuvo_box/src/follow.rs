//! Following a box as it changes: its session lists, and one conversation. Each follow runs on a
//! thread of its own and hands what it sees to an [`async_channel`] receiver, which a GPUI view
//! awaits on its executor and a command-line tool reads with `recv_blocking`. Dropping the
//! [`Follow`] (or calling [`Follow::stop`]) ends it, closing what it has open.
//!
//! Over a box's own server, what's followed streams. Over SSH, a box answers each request once,
//! so it's read again on a timer ([`Timing`]).

use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::client::BoxClient;
use crate::error::{Error, Refusal};
use crate::lines;
use crate::messages::{self, Applied, Conversation, Page};
use crate::sessions::{self, Line, Listing};
use crate::transport::{Closer, Request};

/// How long a follow waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    /// After a stream drops or a read fails, before trying again; doubled each time, up to `most`.
    pub retry_after: Duration,
    pub most: Duration,
    /// How often a box that doesn't stream (a machine over SSH) has its session list read again:
    /// every half minute, as PROTOCOL.md says.
    pub lists_again: Duration,
    /// How often a conversation on such a box is read again.
    pub conversation_again: Duration,
    /// How often a box held for its update is asked again whether it has it.
    pub held_again: Duration,
}

impl Default for Timing {
    fn default() -> Timing {
        Timing {
            retry_after: Duration::from_secs(1),
            most: Duration::from_secs(30),
            lists_again: Duration::from_secs(30),
            conversation_again: Duration::from_secs(5),
            held_again: Duration::from_secs(10),
        }
    }
}

/// What a session lists' follow says.
#[derive(Debug, Clone, PartialEq)]
pub enum ListUpdate {
    /// The list as it is now.
    Listing(Listing),
    /// The box can't read its engine yet (`503`): its lists wait ("Loading sessions"), saying why.
    Waiting(String),
    /// The box is older than this client needs, and waits for its update.
    Held { missing: Vec<String> },
    /// Reading it failed; it's tried again.
    Failed(Error),
}

/// What a conversation's follow says.
#[derive(Debug, Clone, PartialEq)]
pub enum ConversationUpdate {
    /// The conversation as it is now.
    Conversation(Conversation),
    /// Reading it failed; it's tried again (a conversation that isn't there ends the follow).
    Failed(Error),
}

/// Something followed. Ends when dropped.
pub struct Follow<T> {
    updates: async_channel::Receiver<T>,
    stop: Arc<Stop>,
}

impl<T> Follow<T> {
    /// What it sees, as it sees it.
    pub fn updates(&self) -> &async_channel::Receiver<T> {
        &self.updates
    }

    /// The next update, waiting for it (for a thread that isn't a UI's); none once it's ended.
    pub fn next_blocking(&self) -> Option<T> {
        self.updates.recv_blocking().ok()
    }

    /// Ends it.
    pub fn stop(&self) {
        self.stop.stop();
    }
}

impl<T> Drop for Follow<T> {
    fn drop(&mut self) {
        self.stop.stop();
    }
}

/// Ending a follow from any thread: wakes its waits and closes what it has open.
#[derive(Default)]
struct Stop {
    state: Mutex<(bool, Vec<Closer>)>,
    woken: Condvar,
}

impl Stop {
    fn stop(&self) {
        let closers = {
            let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.0 = true;
            std::mem::take(&mut state.1)
        };
        self.woken.notify_all();
        for closer in closers {
            closer.close();
        }
    }

    fn is_stopped(&self) -> bool {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).0
    }

    /// Waits `time`, or until stopped: whether it's stopped.
    fn wait(&self, time: Duration) -> bool {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let (state, _) = self.woken.wait_timeout_while(state, time, |state| !state.0).unwrap_or_else(|poisoned| poisoned.into_inner());
        state.0
    }

    /// Keeps `closer` to close on stop; false (closing it) when it's stopped already.
    fn hold(&self, closer: &Closer) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.0 {
            drop(state);
            closer.close();
            return false;
        }
        state.1.push(closer.clone());
        true
    }

    fn release(&self) {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).1.clear();
    }
}

/// Waits after failures, longer each time.
struct Backoff {
    timing: Timing,
    next: Duration,
}

impl Backoff {
    fn new(timing: Timing) -> Backoff {
        Backoff { timing, next: timing.retry_after }
    }
    fn reset(&mut self) {
        self.next = self.timing.retry_after;
    }
    /// Waits, then waits longer next time: whether it's stopped meanwhile.
    fn wait(&mut self, stop: &Stop) -> bool {
        let now = self.next;
        self.next = (self.next * 2).min(self.timing.most).max(self.timing.retry_after);
        stop.wait(now)
    }
}

fn spawn<T: Send + 'static>(name: &str, run: impl FnOnce(async_channel::Sender<T>, Arc<Stop>) + Send + 'static) -> Follow<T> {
    let (sender, updates) = async_channel::unbounded();
    let stop = Arc::new(Stop::default());
    let theirs = stop.clone();
    // (A thread that can't start is a follow that ends at once: its receiver says so.)
    let _ = thread::Builder::new().name(name.into()).spawn(move || run(sender, theirs));
    Follow { updates, stop }
}

impl BoxClient {
    /// Follows the box's session lists: the list now, and again as it changes (`kuvo/sessions/list/
    /// events`, resumed from where it was after a drop; over SSH, read again every half minute).
    pub fn follow_sessions(&self, timing: Timing) -> Follow<ListUpdate> {
        let client = self.clone();
        spawn("kuvo-box sessions", move |sender, stop| follow_sessions(client, timing, sender, stop))
    }

    /// Follows one conversation: its messages now, the words it streams as they come, and its
    /// messages read again as each step, tool call or turn ends (over SSH, read again every few
    /// seconds).
    pub fn follow_conversation(&self, session: &str, timing: Timing) -> Follow<ConversationUpdate> {
        let client = self.clone();
        let session = session.to_owned();
        spawn("kuvo-box conversation", move |sender, stop| follow_conversation(client, session, timing, sender, stop))
    }
}

fn follow_sessions(client: BoxClient, timing: Timing, sender: async_channel::Sender<ListUpdate>, stop: Arc<Stop>) {
    let mut listing = Listing::new();
    let mut backoff = Backoff::new(timing);
    let send = |update: ListUpdate| sender.send_blocking(update).is_ok();
    while !stop.is_stopped() {
        let streams = client.streams();
        let path = if streams { sessions::events_route(listing.at()) } else { sessions::route(listing.at()) };
        let opened = client.open(&Request::get(path));
        let mut stream = match opened {
            Ok(stream) => stream,
            Err(Error::NeedsUpdating { missing }) => {
                if !send(ListUpdate::Held { missing }) || stop.wait(timing.held_again) {
                    return;
                }
                // Asked again whether it has updated.
                let _ = client.connect();
                continue;
            }
            Err(error) => {
                if !send(ListUpdate::Failed(error)) || backoff.wait(&stop) {
                    return;
                }
                continue;
            }
        };
        if !(200..300).contains(&stream.status) {
            let mut body = Vec::new();
            let _ = std::io::Read::read_to_end(&mut stream.reader, &mut body);
            let refusal = Refusal::from_answer(stream.status, &body);
            let update = if stream.status == 503 { ListUpdate::Waiting(refusal.message) } else { ListUpdate::Failed(Error::Refused(refusal)) };
            if !send(update) || backoff.wait(&stop) {
                return;
            }
            continue;
        }
        if !stop.hold(&stream.closer) {
            return;
        }
        loop {
            match lines::next_line(&mut *stream.reader) {
                Ok(Some(text)) => match serde_json::from_str::<Line>(&text) {
                    Ok(line) => {
                        backoff.reset();
                        if listing.take(line) && !send(ListUpdate::Listing(listing.clone())) {
                            stop.stop();
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = send(ListUpdate::Failed(Error::BadAnswer(format!("A line of the session list couldn't be read: {error}"))));
                    }
                },
                Ok(None) => break,
                Err(error) => {
                    if !stop.is_stopped() {
                        let _ = send(ListUpdate::Failed(Error::Unreachable(format!("The session list stopped coming ({}).", error.kind()))));
                    }
                    break;
                }
            }
        }
        stop.release();
        if stop.is_stopped() {
            return;
        }
        // A stream that ended is opened again from where it was; a box that answers once is read
        // again in a while.
        let stopped = if streams { backoff.wait(&stop) } else { stop.wait(timing.lists_again) };
        if stopped {
            return;
        }
    }
}

fn follow_conversation(client: BoxClient, session: String, timing: Timing, sender: async_channel::Sender<ConversationUpdate>, stop: Arc<Stop>) {
    let mut backoff = Backoff::new(timing);
    let send = |update: ConversationUpdate| sender.send_blocking(update).is_ok();
    // Where it lives, once.
    let place = loop {
        match client.where_is(&session) {
            Ok(place) => break place,
            Err(Error::Refused(refusal)) if refusal.status == 404 => {
                let _ = send(ConversationUpdate::Failed(Error::Refused(refusal)));
                return;
            }
            Err(error) => {
                if !send(ConversationUpdate::Failed(error)) || backoff.wait(&stop) {
                    return;
                }
            }
        }
    };
    let shown = Arc::new(Mutex::new(Conversation::new(session.clone(), place)));

    if !client.streams() {
        while !stop.is_stopped() {
            let update = match read_conversation(&client, &shown) {
                Ok(conversation) => ConversationUpdate::Conversation(conversation),
                Err(error) => ConversationUpdate::Failed(error),
            };
            if !send(update) || stop.wait(timing.conversation_again) {
                return;
            }
        }
        return;
    }

    // Reads asked for while one is under way come together as one more.
    let (again, asked) = mpsc::sync_channel::<()>(1);
    let reader = {
        let shown = shown.clone();
        let sender = sender.clone();
        let client = client.clone();
        thread::Builder::new().name("kuvo-box conversation reads".into()).spawn(move || {
            while asked.recv().is_ok() {
                let update = match read_conversation(&client, &shown) {
                    Ok(conversation) => ConversationUpdate::Conversation(conversation),
                    Err(error) => ConversationUpdate::Failed(error),
                };
                if sender.send_blocking(update).is_err() {
                    return;
                }
            }
        })
    };
    if reader.is_err() {
        return;
    }

    while !stop.is_stopped() {
        let mut stream = match client.open(&Request::get(place.events_route())) {
            Ok(stream) if (200..300).contains(&stream.status) => stream,
            Ok(mut stream) => {
                let mut body = Vec::new();
                let _ = std::io::Read::read_to_end(&mut stream.reader, &mut body);
                if !send(ConversationUpdate::Failed(Error::Refused(Refusal::from_answer(stream.status, &body)))) || backoff.wait(&stop) {
                    return;
                }
                continue;
            }
            Err(error) => {
                if !send(ConversationUpdate::Failed(error)) || backoff.wait(&stop) {
                    return;
                }
                continue;
            }
        };
        if !stop.hold(&stream.closer) {
            return;
        }
        // Read once it's listening, so nothing from before is missed.
        let _ = again.try_send(());
        loop {
            match lines::next_event(&mut *stream.reader) {
                Ok(Some(data)) => {
                    let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
                    backoff.reset();
                    let (applied, now) = {
                        let mut conversation = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        let applied = conversation.apply(&event);
                        (applied, (applied == Applied::Changed).then(|| conversation.clone()))
                    };
                    if let Some(now) = now
                        && !send(ConversationUpdate::Conversation(now))
                    {
                        stop.stop();
                        return;
                    }
                    if applied == Applied::ReadAgain {
                        let _ = again.try_send(());
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    if !stop.is_stopped() {
                        let _ = send(ConversationUpdate::Failed(Error::Unreachable(format!("The conversation stopped coming ({}).", error.kind()))));
                    }
                    break;
                }
            }
        }
        stop.release();
        if stop.is_stopped() || backoff.wait(&stop) {
            return;
        }
    }
}

/// The conversation's newest messages read, in place of what's shown.
fn read_conversation(client: &BoxClient, shown: &Mutex<Conversation>) -> Result<Conversation, Error> {
    let (session, place) = {
        let conversation = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        (conversation.session.clone(), conversation.place)
    };
    let page: Page = client.get(&messages::newest_route(place, &session, READ))?;
    let mut conversation = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    conversation.take_read(page.data);
    Ok(conversation.clone())
}

/// How many of a conversation's newest messages a follow reads.
const READ: usize = 100;
