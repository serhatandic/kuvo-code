//! Following a box as it changes: its session lists, and one conversation. Each follow runs on a
//! thread of its own and hands what it sees to an [`async_channel`] receiver, which a GPUI view
//! awaits on its executor and a command-line tool reads with `next_blocking`. Only the latest is
//! kept: a view that reads late gets the state now, never a backlog. Dropping the [`Follow`] (or
//! calling [`Follow::stop`]) ends it, closing what it has open, a request still waiting for its
//! answer too.
//!
//! Over a box's own server, what's followed streams. Over SSH, a box answers each request once,
//! so it's read again on a timer ([`Timing`]).

use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::client::BoxClient;
use crate::error::{Error, Refusal};
use crate::lines;
use crate::messages::{self, Applied, Conversation, Message, Page, Where};
use crate::parts::Parts;
use crate::sessions::{self, Line, Listing};
use crate::transport::{Closer, Request, Stream};

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
    /// The box is older than this client needs, and waits for its update. It's asked again now
    /// and then, and the list follows once it has updated.
    Held { missing: Vec<String> },
    /// Reading it failed; it's tried again.
    Failed(Error),
}

/// What a conversation's follow says.
#[derive(Debug, Clone, PartialEq)]
pub enum ConversationUpdate {
    /// The conversation as it is now.
    Conversation(Conversation),
    /// Reading it failed; it's tried again.
    Failed(Error),
    /// It isn't on the box (any more): the follow ends.
    Gone(Refusal),
}

/// Something followed. Ends when dropped.
pub struct Follow<T> {
    updates: async_channel::Receiver<T>,
    stop: Arc<Stop>,
    /// What a conversation's reader is asked for.
    wants: Option<Arc<Wants>>,
}

impl Follow<ConversationUpdate> {
    /// Reads the messages before those shown (as you scroll up), and puts them ahead of them: the
    /// conversation that follows has them, and `earlier` says whether there are more.
    pub fn load_earlier(&self) {
        if let Some(wants) = &self.wants {
            wants.earlier();
        }
    }
}

impl<T> Follow<T> {
    /// What it sees, the latest of it.
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
    /// What else wakes as it ends (a reader waiting to be asked).
    wakes: Mutex<Vec<Arc<Wants>>>,
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
        for wants in self.wakes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter() {
            wants.close();
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

    /// Keeps `closer` to close on stop; false (and closed) when it's stopped already.
    fn hold(&self, closer: Closer) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.0 {
            drop(state);
            closer.close();
            return false;
        }
        state.1.push(closer);
        true
    }

    fn release(&self) {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).1.clear();
    }
}

/// What a conversation's reader is asked for: its newest messages again, earlier ones, or to end.
/// Asked again while it reads, it reads once more after.
#[derive(Default)]
struct Wants {
    state: Mutex<(bool, bool, bool)>,
    woken: Condvar,
}

impl Wants {
    fn again(&self) {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).0 = true;
        self.woken.notify_all();
    }

    fn earlier(&self) {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).1 = true;
        self.woken.notify_all();
    }

    fn close(&self) {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).2 = true;
        self.woken.notify_all();
    }

    /// What's wanted (the newest again, earlier ones), waiting for it up to `most` (none: as long
    /// as it takes); the newest again once `most` has gone by; none once it's ended.
    fn next(&self, most: Option<Duration>) -> Option<(bool, bool)> {
        let state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let waiting = |state: &mut (bool, bool, bool)| !state.0 && !state.1 && !state.2;
        let (mut state, timed_out) = match most {
            Some(most) => {
                let (state, result) = self.woken.wait_timeout_while(state, most, waiting).unwrap_or_else(|poisoned| poisoned.into_inner());
                (state, result.timed_out())
            }
            None => (self.woken.wait_while(state, waiting).unwrap_or_else(|poisoned| poisoned.into_inner()), false),
        };
        if state.2 {
            return None;
        }
        let wanted = (state.0 || timed_out, state.1);
        state.0 = false;
        state.1 = false;
        Some(wanted)
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

/// Hands on the latest update, in place of one not taken yet.
struct Latest<T> {
    sender: async_channel::Sender<T>,
    taken: async_channel::Receiver<T>,
}

impl<T> Latest<T> {
    fn put(&self, update: T) {
        let mut update = update;
        loop {
            match self.sender.try_send(update) {
                Ok(()) | Err(async_channel::TrySendError::Closed(_)) => return,
                Err(async_channel::TrySendError::Full(back)) => {
                    let _ = self.taken.try_recv();
                    update = back;
                }
            }
        }
    }

    /// Ends the channel, so a reader waiting on it hears so (its own copy of the receiver would
    /// keep it open).
    fn close(&self) {
        self.sender.close();
    }
}

fn spawn<T: Send + 'static>(name: &str, run: impl FnOnce(&Latest<T>, Arc<Stop>) + Send + 'static) -> Follow<T> {
    let (sender, updates) = async_channel::bounded(1);
    let latest = Latest { sender, taken: updates.clone() };
    let stop = Arc::new(Stop::default());
    let theirs = stop.clone();
    let started = thread::Builder::new().name(name.into()).spawn(move || {
        run(&latest, theirs);
        latest.close();
    });
    if started.is_err() {
        updates.close();
    }
    Follow { updates, stop, wants: None }
}

/// The rest of an answer, for what it says when it's a refusal.
fn refusal(stream: &mut Stream) -> Refusal {
    let mut body = Vec::new();
    let _ = std::io::Read::read_to_end(&mut stream.reader, &mut body);
    Refusal::from_answer(stream.status, &body)
}

impl BoxClient {
    /// Follows the box's session lists: the list now, and again as it changes (`kuvo/sessions/list/
    /// events`, resumed from where it was after a drop; over SSH, read again every half minute).
    pub fn follow_sessions(&self, timing: Timing) -> Follow<ListUpdate> {
        let client = self.clone();
        spawn("kuvo-box sessions", move |latest, stop| follow_sessions(client, timing, latest, stop))
    }

    /// Follows one conversation: its messages now, the words it streams as they come, and its
    /// messages read again as each step, tool call or turn ends (over SSH, read again every few
    /// seconds).
    pub fn follow_conversation(&self, session: &str, timing: Timing) -> Follow<ConversationUpdate> {
        let client = self.clone();
        let session = session.to_owned();
        let wants = Arc::new(Wants::default());
        let theirs = wants.clone();
        let mut follow = spawn("kuvo-box conversation", move |latest, stop| {
            stop.wakes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(theirs.clone());
            // (Stopped before it started: it ends at once.)
            if stop.is_stopped() {
                return;
            }
            follow_conversation(client, session, timing, latest, &stop, &theirs);
        });
        follow.wants = Some(wants);
        follow
    }
}

fn follow_sessions(client: BoxClient, timing: Timing, latest: &Latest<ListUpdate>, stop: Arc<Stop>) {
    let mut listing = Listing::new();
    let mut backoff = Backoff::new(timing);
    while !stop.is_stopped() {
        let streams = client.streams();
        let path = if streams { sessions::events_route(listing.at()) } else { sessions::route(listing.at()) };
        let mut stream = match client.open(&Request::get(path), &|closer| stop.hold(closer)) {
            Ok(stream) => stream,
            Err(Error::NeedsUpdating { missing }) => {
                latest.put(ListUpdate::Held { missing });
                if stop.wait(timing.held_again) {
                    return;
                }
                // Asked again whether it has updated.
                let _ = client.connect();
                continue;
            }
            Err(error) => {
                stop.release();
                if stop.is_stopped() {
                    return;
                }
                latest.put(ListUpdate::Failed(error));
                if backoff.wait(&stop) {
                    return;
                }
                continue;
            }
        };
        if !(200..300).contains(&stream.status) {
            let refusal = refusal(&mut stream);
            stop.release();
            latest.put(if stream.status == 503 { ListUpdate::Waiting(refusal.message) } else { ListUpdate::Failed(Error::Refused(refusal)) });
            if backoff.wait(&stop) {
                return;
            }
            continue;
        }
        loop {
            match lines::next_line(&mut *stream.reader) {
                Ok(Some(text)) => match serde_json::from_str::<Line>(&text) {
                    Ok(line) => {
                        backoff.reset();
                        if listing.take(line) {
                            latest.put(ListUpdate::Listing(listing.clone()));
                        }
                    }
                    Err(error) => latest.put(ListUpdate::Failed(Error::BadAnswer(format!("A line of the session list couldn't be read: {error}")))),
                },
                Ok(None) => break,
                Err(error) => {
                    if !stop.is_stopped() {
                        latest.put(ListUpdate::Failed(Error::Unreachable(format!("The session list stopped coming ({}).", error.kind()))));
                    }
                    break;
                }
            }
        }
        stop.release();
        // A stream that ended is opened again from where it was; a box that answers once is read
        // again in a while.
        let stopped = if streams { backoff.wait(&stop) } else { stop.wait(timing.lists_again) };
        if stopped {
            return;
        }
    }
}

/// A followed conversation: what's shown, and while a read is on its way, the events that came
/// meanwhile (to apply again on top of it).
struct Shown {
    conversation: Conversation,
    during: Option<Vec<Value>>,
}

/// How many of a conversation's newest messages a follow reads.
const READ: usize = 100;

/// Reads the conversation, and shows it with what came meanwhile: under the lock, so no older
/// copy is ever handed on after a newer one. The parts of messages from before are read first, so
/// the page shows as written. False once it's gone, which ends the follow.
fn read(client: &BoxClient, shown: &Mutex<Shown>, latest: &Latest<ConversationUpdate>) -> bool {
    let (session, place) = {
        let mut now = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        now.during = Some(Vec::new());
        (now.conversation.session.clone(), now.conversation.place)
    };
    let read: Result<Page, Error> = client.get(&messages::newest_route(place, &session, READ));
    let (parts, running) = match &read {
        Ok(page) => (read_parts(client, shown, &page.data), is_running(client, place, &session)),
        Err(_) => (Vec::new(), None),
    };
    let mut now = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let during = now.during.take().unwrap_or_default();
    match read {
        Ok(page) => {
            let earlier = page.earlier(READ);
            now.conversation.take_parts(parts);
            now.conversation.catch_up(page.data, earlier, &during, running);
            latest.put(ConversationUpdate::Conversation(now.conversation.clone()));
            true
        }
        Err(Error::Refused(refusal)) if refusal.status == 404 => {
            latest.put(ConversationUpdate::Gone(client.not_here()));
            false
        }
        Err(error) => {
            latest.put(ConversationUpdate::Failed(error));
            true
        }
    }
}

/// Reads the messages before those shown, and puts them ahead.
fn read_earlier(client: &BoxClient, shown: &Mutex<Shown>, latest: &Latest<ConversationUpdate>) {
    let (session, place, cursor) = {
        let now = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(cursor) = now.conversation.earlier.clone() else { return };
        (now.conversation.session.clone(), now.conversation.place, cursor)
    };
    match client.earlier_messages(&session, place, &cursor, READ) {
        Ok((older, earlier)) => {
            let parts = read_parts(client, shown, &older);
            let mut now = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            now.conversation.take_parts(parts);
            now.conversation.take_earlier(older, earlier);
            latest.put(ConversationUpdate::Conversation(now.conversation.clone()));
        }
        Err(error) => latest.put(ConversationUpdate::Failed(error)),
    }
}

/// The parts of those of `messages` from before, as their box reads them; none where it couldn't
/// say (they show as written, and are asked again with the next read).
fn read_parts(client: &BoxClient, shown: &Mutex<Shown>, messages: &[Message]) -> Vec<((String, String), Parts)> {
    let unread = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).conversation.unread_parts(messages);
    if unread.is_empty() {
        return Vec::new();
    }
    let texts: Vec<String> = unread.iter().map(|(_, text)| text.clone()).collect();
    match client.read_parts(&texts) {
        Ok(parts) => unread.into_iter().zip(parts).collect(),
        Err(_) => Vec::new(),
    }
}

/// Whether a run is under way in it, as its engine (or bridge) says (`api/session/active`); none
/// when it couldn't say.
fn is_running(client: &BoxClient, place: Where, session: &str) -> Option<bool> {
    let active: Value = client.get(&format!("{}api/session/active", place.prefix())).ok()?;
    Some(active.get("data")?.as_object()?.contains_key(session))
}

/// Reads as it's asked to (or, `most` given, on that timer), until it's ended or the conversation's
/// gone.
fn reader(client: &BoxClient, shown: &Mutex<Shown>, latest: &Latest<ConversationUpdate>, stop: &Stop, wants: &Wants, most: Option<Duration>) {
    while let Some((again, earlier)) = wants.next(most) {
        if stop.is_stopped() {
            return;
        }
        if earlier {
            read_earlier(client, shown, latest);
        }
        if again && !read(client, shown, latest) {
            stop.stop();
            return;
        }
    }
}

fn follow_conversation(client: BoxClient, session: String, timing: Timing, latest: &Latest<ConversationUpdate>, stop: &Stop, wants: &Wants) {
    let mut backoff = Backoff::new(timing);
    // Where it lives, once.
    let place = loop {
        match client.where_is(&session) {
            Ok(place) => break place,
            Err(Error::Refused(refusal)) if refusal.status == 404 => {
                latest.put(ConversationUpdate::Gone(refusal));
                return;
            }
            Err(error) => {
                latest.put(ConversationUpdate::Failed(error));
                if backoff.wait(stop) {
                    return;
                }
            }
        }
    };
    let shown = Mutex::new(Shown { conversation: Conversation::new(session, place), during: None });

    if !client.streams() {
        // Read now, then again on the timer, and earlier ones as asked.
        wants.again();
        reader(&client, &shown, latest, stop, wants, Some(timing.conversation_again));
        return;
    }

    // Reads come on a thread of their own, so the events keep coming meanwhile; it ends with this.
    thread::scope(|scope| {
        let (client, shown) = (&client, &shown);
        let reads = thread::Builder::new().name("kuvo-box conversation reads".into()).spawn_scoped(scope, move || reader(client, shown, latest, stop, wants, None));
        if reads.is_ok() {
            follow_events(client, place, timing, latest, stop, shown, wants);
        }
        wants.close();
    });
}

fn follow_events(client: &BoxClient, place: Where, timing: Timing, latest: &Latest<ConversationUpdate>, stop: &Stop, shown: &Mutex<Shown>, wants: &Wants) {
    let mut backoff = Backoff::new(timing);
    while !stop.is_stopped() {
        let mut stream = match client.open(&Request::get(place.events_route()), &|closer| stop.hold(closer)) {
            Ok(stream) if (200..300).contains(&stream.status) => stream,
            Ok(mut stream) => {
                let refusal = refusal(&mut stream);
                stop.release();
                latest.put(ConversationUpdate::Failed(Error::Refused(refusal)));
                if backoff.wait(stop) {
                    return;
                }
                continue;
            }
            Err(error) => {
                stop.release();
                if stop.is_stopped() {
                    return;
                }
                latest.put(ConversationUpdate::Failed(error));
                if backoff.wait(stop) {
                    return;
                }
                continue;
            }
        };
        // Read once it's listening, so nothing from before is missed.
        wants.again();
        loop {
            match lines::next_event(&mut *stream.reader) {
                Ok(Some(data)) => {
                    let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
                    backoff.reset();
                    let applied = {
                        let mut now = shown.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        let applied = now.conversation.apply(&event);
                        if applied != Applied::Nothing
                            && let Some(during) = now.during.as_mut()
                        {
                            during.push(event);
                        }
                        if applied == Applied::Changed {
                            latest.put(ConversationUpdate::Conversation(now.conversation.clone()));
                        }
                        applied
                    };
                    if applied == Applied::ReadAgain {
                        wants.again();
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    if !stop.is_stopped() {
                        latest.put(ConversationUpdate::Failed(Error::Unreachable(format!("The conversation stopped coming ({}).", error.kind()))));
                    }
                    break;
                }
            }
        }
        stop.release();
        if stop.is_stopped() || backoff.wait(stop) {
            return;
        }
    }
}
