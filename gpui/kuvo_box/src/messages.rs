//! A conversation's messages, as its engine keeps them (`api/session/<id>/message`) or, for a
//! coding agent's session, its agents bridge (`kuvo/agents/api/session/<id>/message`), and how its
//! live events (`api/event`) change what's shown until the next read.
//!
//! The engine's transcript: a user message, each model step (an assistant message with its text,
//! thinking and tool calls), the engine's notes, commands you ran, switches of mode and model,
//! summaries, and the end of each turn (`idle`). A kind this client doesn't know is kept by its id,
//! type and time.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::parts::Parts;
use crate::paths;

/// Where a conversation lives on its box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Where {
    /// The box's engine (`api/…`).
    Engine,
    /// The coding agents' bridge (`kuvo/agents/api/…`): Claude Code, Codex, Cursor, Grok…
    Agents,
}

impl Where {
    /// The prefix its routes take.
    pub fn prefix(self) -> &'static str {
        match self {
            Where::Engine => "",
            Where::Agents => "kuvo/agents/",
        }
    }

    /// `api/session/<id>` there, then `rest`.
    pub fn session_route(self, session: &str, rest: &str) -> String {
        format!("{}api/session/{}{}", self.prefix(), paths::segment(session), rest)
    }

    /// Its event stream.
    pub fn events_route(self) -> String {
        format!("{}api/event", self.prefix())
    }
}

/// When something happened, in ms since 1970.
#[derive(Debug, Clone, Copy, PartialEq, Default, Deserialize)]
pub struct Time {
    #[serde(default)]
    pub created: f64,
    #[serde(default)]
    pub completed: Option<f64>,
}

/// One entry of a conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    User(UserMessage),
    /// One model step.
    Assistant(Step),
    /// Words the engine or a plugin added for you, kept apart from your messages.
    Synthetic(Note),
    /// The engine's notices ("Instructions updated").
    System(Note),
    /// A command you ran yourself in the conversation's folder.
    Shell(ShellRun),
    /// The end of a turn, and how it went (`succeeded`, `failed`, `interrupted`).
    Idle { id: String, time: Time, outcome: String },
    /// Anything else (a switch of mode or model, a summary, a kind from a newer engine): kept by
    /// its id, type and time, with all it said.
    Other { id: String, kind: String, time: Time, raw: Value },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UserMessage {
    pub id: String,
    pub time: Time,
    #[serde(default)]
    pub text: String,
    /// Files sent with it, as the engine keeps them.
    #[serde(default)]
    pub files: Vec<Value>,
    #[serde(default)]
    pub metadata: Option<Value>,
    /// The parts its box read of it, for one from before that keeps none (`kuvo/messages/parts`).
    #[serde(skip)]
    pub read_parts: Option<Parts>,
}

impl UserMessage {
    /// The parts its box kept with it, if it kept any.
    pub fn kept_parts(&self) -> Option<Parts> {
        Parts::kept(self.metadata.as_ref())
    }

    /// Its parts, to draw it by: kept with it, else as its box read them, else (not read yet, or its
    /// box couldn't) its text as it is.
    pub fn parts(&self) -> Parts {
        self.kept_parts().or_else(|| self.read_parts.clone()).unwrap_or_else(|| Parts::words(self.text.clone()))
    }

    /// One of the box's own notes to the agent (`kuvo.note`), which has no parts to read.
    pub fn is_box_note(&self) -> bool {
        self.metadata.as_ref().and_then(|metadata| metadata.get("kuvo")?.get("note")).is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Step {
    pub id: String,
    pub time: Time,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<Value>,
    #[serde(default)]
    pub content: Vec<Content>,
    #[serde(default)]
    pub finish: Option<String>,
    #[serde(default)]
    pub error: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Note {
    pub id: String,
    pub time: Time,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ShellRun {
    pub id: String,
    pub time: Time,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub exit: Option<i64>,
}

/// One block of a step's output.
#[derive(Debug, Clone, PartialEq)]
pub enum Content {
    Text(String),
    /// Thinking, with whether it's done.
    Reasoning { text: String, done: bool },
    /// A tool call: its name and state as the engine says (`state.status`: `streaming`, `running`,
    /// `completed`, `failed`).
    Tool { id: String, name: String, state: Value },
    Other { kind: String, raw: Value },
}

impl Content {
    fn is_text(&self) -> bool {
        matches!(self, Content::Text(_))
    }
    fn is_reasoning(&self) -> bool {
        matches!(self, Content::Reasoning { .. })
    }
}

impl<'de> Deserialize<'de> for Content {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Value::deserialize(deserializer)?;
        let kind = raw.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
        let text = || raw.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
        Ok(match kind.as_str() {
            "text" => Content::Text(text()),
            "reasoning" => Content::Reasoning { text: text(), done: raw.pointer("/time/completed").is_some_and(|done| !done.is_null()) },
            "tool" => Content::Tool {
                id: raw.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                // (`bash` in a conversation recorded before the engine named it `shell`.)
                name: match raw.get("name").and_then(Value::as_str).unwrap_or("") {
                    "bash" => "shell".to_owned(),
                    name => name.to_owned(),
                },
                state: raw.get("state").cloned().unwrap_or(Value::Null),
            },
            _ => Content::Other { kind, raw },
        })
    }
}

impl<'de> Deserialize<'de> for Message {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let raw = Value::deserialize(deserializer)?;
        let kind = raw.get("type").and_then(Value::as_str).ok_or_else(|| D::Error::missing_field("type"))?.to_owned();
        let parse = |raw: Value| -> Result<Message, D::Error> {
            Ok(match kind.as_str() {
                "user" => Message::User(serde_json::from_value(raw).map_err(D::Error::custom)?),
                "assistant" => Message::Assistant(serde_json::from_value(raw).map_err(D::Error::custom)?),
                "synthetic" => Message::Synthetic(serde_json::from_value(raw).map_err(D::Error::custom)?),
                "system" => Message::System(serde_json::from_value(raw).map_err(D::Error::custom)?),
                "shell" => Message::Shell(serde_json::from_value(raw).map_err(D::Error::custom)?),
                "idle" => Message::Idle {
                    id: raw.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                    time: serde_json::from_value(raw.get("time").cloned().unwrap_or(Value::Null)).unwrap_or_default(),
                    outcome: raw.get("outcome").and_then(Value::as_str).unwrap_or("").to_owned(),
                },
                _ => Message::Other {
                    id: raw.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                    kind: kind.clone(),
                    time: serde_json::from_value(raw.get("time").cloned().unwrap_or(Value::Null)).unwrap_or_default(),
                    raw,
                },
            })
        };
        parse(raw)
    }
}

impl Message {
    pub fn id(&self) -> &str {
        match self {
            Message::User(m) => &m.id,
            Message::Assistant(m) => &m.id,
            Message::Synthetic(m) | Message::System(m) => &m.id,
            Message::Shell(m) => &m.id,
            Message::Idle { id, .. } | Message::Other { id, .. } => id,
        }
    }
}

/// A page of messages as the engine answers it: `{data, cursor}`.
#[derive(Debug, Clone, Deserialize)]
pub struct Page {
    pub data: Vec<Message>,
    #[serde(default)]
    pub cursor: Option<Cursor>,
}

/// Where a page leads.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Cursor {
    #[serde(default)]
    pub previous: Option<String>,
    #[serde(default)]
    pub next: Option<String>,
}

impl Page {
    /// The way back to the messages before it, when it was full (so there may be more).
    pub fn earlier(&self, limit: usize) -> Option<String> {
        let cursor = self.cursor.as_ref()?;
        (self.data.len() >= limit).then(|| cursor.next.clone().or_else(|| cursor.previous.clone())).flatten()
    }
}

/// The newest `limit` messages' route, newest first (a client shows them reversed).
pub fn newest_route(place: Where, session: &str, limit: usize) -> String {
    place.session_route(session, &format!("/message?limit={limit}&order=desc"))
}

/// The `limit` messages before `cursor` (a page's [`Page::earlier`]).
pub fn earlier_route(place: Where, session: &str, cursor: &str, limit: usize) -> String {
    place.session_route(session, &format!("/message?limit={limit}&cursor={}", paths::query_value(cursor)))
}

/// A conversation as a client shows it: its messages, oldest first, and whether a run is under way.
#[derive(Debug, Clone, PartialEq)]
pub struct Conversation {
    pub session: String,
    pub place: Where,
    /// Oldest first: the newest read, and any earlier pages read before them.
    pub messages: Vec<Message>,
    pub running: bool,
    /// The way back to messages before these, while there may be some.
    pub earlier: Option<String>,
    /// Whether an earlier page has been read (the way back is then its own, not the newest's).
    paged: bool,
}

/// The parts boxes read of messages from before (`kuvo/messages/parts`), by id, with the text each
/// was read from: asked once for each message, and put on it each time it's read again.
#[derive(Debug, Default)]
pub struct ReadParts(HashMap<String, (String, Parts)>);

impl ReadParts {
    /// Of `messages`, yours and other agents' whose parts are still to be read from their box (none
    /// kept with them, none read yet, not the box's own notes): their ids and texts. (A message that
    /// ran one of the engine's commands is read too, for now: which did isn't kept yet.)
    pub fn unread(&self, messages: &[Message]) -> Vec<(String, String)> {
        messages
            .iter()
            .filter_map(|message| match message {
                Message::User(user) if !user.is_box_note() && user.kept_parts().is_none() && self.0.get(&user.id).is_none_or(|(text, _)| *text != user.text) => {
                    Some((user.id.clone(), user.text.clone()))
                }
                _ => None,
            })
            .collect()
    }

    /// What a box read, kept by id.
    pub fn take(&mut self, read: Vec<((String, String), Parts)>) {
        if self.0.len() > 20_000 {
            self.0.clear();
        }
        for ((id, text), parts) in read {
            self.0.insert(id, (text, parts));
        }
    }

    /// Puts what was read on each of `messages` it's for.
    pub fn apply(&self, messages: &mut [Message]) {
        for message in messages {
            if let Message::User(user) = message
                && user.read_parts.is_none()
                && let Some((text, parts)) = self.0.get(&user.id)
                && *text == user.text
            {
                user.read_parts = Some(parts.clone());
            }
        }
    }
}

/// What an event asks of what's shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// Not this conversation's, or nothing to change.
    Nothing,
    /// Shown now (streamed words, a step begun or ended).
    Changed,
    /// Its messages are to be read again (a tool's call or end, a message delivered, a turn's end).
    ReadAgain,
}

impl Conversation {
    pub fn new(session: impl Into<String>, place: Where) -> Conversation {
        Conversation { session: session.into(), place, messages: Vec::new(), running: false, earlier: None, paged: false }
    }

    /// An earlier page's messages (newest first, as the engine answers), put ahead of those shown;
    /// `earlier`, the way back from it.
    pub fn take_earlier(&mut self, mut newest_first: Vec<Message>, earlier: Option<String>) {
        newest_first.reverse();
        newest_first.retain(|message| !self.messages.iter().any(|shown| shown.id() == message.id()));
        // Nothing new: there's nothing before.
        self.earlier = if newest_first.is_empty() { None } else { earlier };
        self.paged = true;
        newest_first.append(&mut self.messages);
        self.messages = newest_first;
    }

    /// One of the engine's events (`{id, type, data}`) applied: the words a step streams, as they
    /// come; anything else this conversation's is left to a read.
    pub fn apply(&mut self, event: &Value) -> Applied {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        let data = event.get("data").cloned().unwrap_or(Value::Null);
        if data.get("sessionID").and_then(Value::as_str) != Some(self.session.as_str()) {
            return Applied::Nothing;
        }
        let step = data.get("assistantMessageID").and_then(Value::as_str).unwrap_or("").to_owned();
        let ordinal = data.get("ordinal").and_then(Value::as_u64).map(|n| n as usize);
        match kind {
            "session.execution.started" => {
                self.running = true;
                Applied::Changed
            }
            "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted" => {
                self.running = false;
                Applied::ReadAgain
            }
            "session.step.started" => {
                self.running = true;
                if self.step(&step).is_none() && !step.is_empty() {
                    let created = data.get("started").and_then(Value::as_f64).unwrap_or(0.0);
                    self.messages.push(Message::Assistant(Step {
                        id: step,
                        time: Time { created, completed: None },
                        agent: data.get("agent").and_then(Value::as_str).map(str::to_owned),
                        model: data.get("model").cloned(),
                        content: Vec::new(),
                        finish: None,
                        error: None,
                    }));
                }
                Applied::Changed
            }
            "session.text.started" | "session.reasoning.started" => {
                self.running = true;
                let text = kind == "session.text.started";
                match self.step(&step) {
                    Some(found) => {
                        let count = found.content.iter().filter(|c| if text { c.is_text() } else { c.is_reasoning() }).count();
                        if ordinal.is_none_or(|ordinal| ordinal >= count) {
                            found.content.push(if text { Content::Text(String::new()) } else { Content::Reasoning { text: String::new(), done: false } });
                        }
                        Applied::Changed
                    }
                    None => Applied::ReadAgain,
                }
            }
            "session.text.delta" | "session.reasoning.delta" => {
                let text = kind == "session.text.delta";
                let delta = data.get("delta").and_then(Value::as_str).unwrap_or("");
                let at = data.get("at").and_then(Value::as_u64).map(|at| at as usize);
                match self.block(&step, ordinal, text) {
                    Some(Content::Text(words)) | Some(Content::Reasoning { text: words, done: false }) => match new_part(delta, at, words) {
                        Some(new) => {
                            words.push_str(&new);
                            Applied::Changed
                        }
                        None => Applied::Nothing,
                    },
                    // Its start was missed: its end brings the words whole.
                    _ => Applied::Nothing,
                }
            }
            "session.text.ended" | "session.reasoning.ended" => {
                let text = kind == "session.text.ended";
                let whole = data.get("text").and_then(Value::as_str).unwrap_or("").to_owned();
                let ended = if text { Content::Text(whole) } else { Content::Reasoning { text: whole, done: true } };
                if let Some(block) = self.block(&step, ordinal, text) {
                    *block = ended;
                    return Applied::Changed;
                }
                // Its start was missed: the words show now, and the step's read puts them in place.
                match self.step(&step) {
                    Some(found) => {
                        found.content.push(ended);
                        Applied::Changed
                    }
                    None => Applied::ReadAgain,
                }
            }
            "session.step.ended" | "session.step.failed" => {
                if let Some(found) = self.step(&step) {
                    found.time.completed = Some(event.get("created").and_then(Value::as_f64).unwrap_or(found.time.created));
                    found.finish = data.get("finish").and_then(Value::as_str).map(str::to_owned).or(found.finish.take());
                    found.error = data.get("error").cloned().filter(|error| !error.is_null());
                }
                Applied::ReadAgain
            }
            // What adds or changes a message: read whole.
            "session.tool.called"
            | "session.tool.success"
            | "session.tool.failed"
            | "session.retry.scheduled"
            | "session.inbox.delivered"
            | "session.synthetic"
            | "session.shell.started"
            | "session.shell.ended"
            | "session.compaction.ended"
            | "session.revert.committed"
            | "session.instructions.updated"
            | "session.agent.selected"
            | "session.model.selected" => Applied::ReadAgain,
            // The rest (a tool's input or progress as it streams, a step's first output, a look at
            // the conversation, an ask) leave its messages as they are.
            _ => Applied::Nothing,
        }
    }

    /// A read's messages (newest first, as asked) in place of what was shown, then `during`, the
    /// events that came while it was on its way. A block of a step still being written keeps the
    /// words shown for it where they go on from the read's: the engine keeps a block's words only
    /// once it ends, and the coding agents' bridge keeps some of them, so a read mid-reply has
    /// fewer than what streamed. Pieces for such a block that came meanwhile are in the shown words
    /// already, and are left out. `running`: whether the box says a run is under way, where it said.
    pub fn catch_up(&mut self, mut newest_first: Vec<Message>, earlier: Option<String>, during: &[Value], running: Option<bool>) {
        newest_first.reverse();
        // What was shown before the newest read's (earlier pages, and those the newest left
        // behind as more came) stays ahead of it, while it reaches it. After a gap (the read and
        // what's shown share nothing: more came than a read holds while nothing was heard, or a
        // revert went back past it all), it starts again from the read.
        let reaches = self.messages.iter().any(|shown| newest_first.iter().any(|read| read.id() == shown.id()));
        let mut older: Vec<Message> = if reaches {
            self.messages.iter().take_while(|shown| !newest_first.iter().any(|read| read.id() == shown.id())).cloned().collect()
        } else {
            self.paged = false;
            Vec::new()
        };
        if !self.paged && older.is_empty() {
            self.earlier = earlier;
        }
        let read_from = older.len();
        older.extend(newest_first);
        let shown = std::mem::replace(&mut self.messages, older);
        let mut kept: Vec<(String, bool, usize)> = Vec::new();
        for message in self.messages[read_from..].iter_mut().rev() {
            let Message::Assistant(step) = message else { continue };
            if step.time.completed.is_some() {
                break;
            }
            let Some(before) = shown.iter().rev().find_map(|message| match message {
                Message::Assistant(before) if before.id == step.id => Some(before),
                _ => None,
            }) else {
                continue;
            };
            for text in [true, false] {
                let words_of = |content: &Content| match content {
                    Content::Text(words) if text => Some(words.clone()),
                    Content::Reasoning { text: words, done: false } if !text => Some(words.clone()),
                    _ => None,
                };
                let is_kind = |content: &Content| if text { content.is_text() } else { content.is_reasoning() };
                let shown_blocks: Vec<Option<String>> = before.content.iter().filter(|c| is_kind(c)).map(words_of).collect();
                let read_count = step.content.iter().filter(|c| is_kind(c)).count();
                for (ordinal, shown_words) in shown_blocks.into_iter().enumerate() {
                    let Some(shown_words) = shown_words else { continue };
                    if ordinal < read_count {
                        let Some(block) = step.content.iter_mut().filter(|c| is_kind(c)).nth(ordinal) else { continue };
                        let Some(read_words) = words_of(block) else { continue };
                        if !shown_words.starts_with(&read_words) {
                            continue;
                        }
                        if shown_words.len() > read_words.len() {
                            *block = if text { Content::Text(shown_words) } else { Content::Reasoning { text: shown_words, done: false } };
                        }
                    } else {
                        // Not in the read at all yet.
                        step.content.push(if text { Content::Text(shown_words) } else { Content::Reasoning { text: shown_words, done: false } });
                    }
                    kept.push((step.id.clone(), text, ordinal));
                }
            }
        }
        if let Some(running) = running {
            self.running = running;
        }
        for event in during {
            let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
            let text = match kind {
                "session.text.delta" => true,
                "session.reasoning.delta" => false,
                _ => {
                    self.apply(event);
                    continue;
                }
            };
            let data = event.get("data").cloned().unwrap_or(Value::Null);
            let step = data.get("assistantMessageID").and_then(Value::as_str).unwrap_or("");
            let ordinal = data.get("ordinal").and_then(Value::as_u64).map(|n| n as usize).or_else(|| {
                let found = self.messages.iter().rev().find_map(|message| match message {
                    Message::Assistant(found) if found.id == step => Some(found),
                    _ => None,
                })?;
                found.content.iter().filter(|c| if text { c.is_text() } else { c.is_reasoning() }).count().checked_sub(1)
            });
            if ordinal.is_some_and(|ordinal| kept.iter().any(|(id, kind, at)| id == step && *kind == text && *at == ordinal)) {
                continue;
            }
            self.apply(event);
        }
    }

    fn step(&mut self, id: &str) -> Option<&mut Step> {
        self.messages.iter_mut().rev().find_map(|message| match message {
            Message::Assistant(step) if step.id == id => Some(step),
            _ => None,
        })
    }

    /// The step's `ordinal`th block of its kind (its last without one).
    fn block(&mut self, step: &str, ordinal: Option<usize>, text: bool) -> Option<&mut Content> {
        let found = self.step(step)?;
        let mut blocks: Vec<&mut Content> = found.content.iter_mut().filter(|c| if text { c.is_text() } else { c.is_reasoning() }).collect();
        match ordinal {
            Some(ordinal) if ordinal < blocks.len() => Some(blocks.swap_remove(ordinal)),
            Some(_) => None,
            None => blocks.pop(),
        }
    }
}

/// What of `delta` is new after `text`: all of it, or (where the bridge says where it goes, in
/// UTF-16 units) only what goes past what's there, so a delta a read already has isn't doubled.
fn new_part(delta: &str, at: Option<usize>, text: &str) -> Option<String> {
    let Some(at) = at else { return Some(delta.to_owned()) };
    let have = text.encode_utf16().count();
    if at > have {
        // A gap: words were missed. The block's end (or the next read) puts it right.
        return None;
    }
    let skip = have - at;
    let units: Vec<u16> = delta.encode_utf16().collect();
    if skip >= units.len() {
        return None;
    }
    String::from_utf16(&units[skip..]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delta_the_shown_words_have_already_isnt_doubled() {
        // Where the bridge says where it goes: only what's past the words shown.
        assert_eq!(new_part("lo there", Some(3), "Hello").as_deref(), Some(" there"));
        assert_eq!(new_part("lo", Some(3), "Hello"), None);
        // A gap (words missed): nothing, until the block's end or a read.
        assert_eq!(new_part("xyz", Some(9), "Hello"), None);
        // The engine says nothing of where: all of it.
        assert_eq!(new_part("!", None, "Hello").as_deref(), Some("!"));
    }

    #[test]
    fn every_kind_of_message_is_read_and_one_unknown_is_kept() {
        let page: Page = serde_json::from_value(serde_json::json!({ "data": [
            { "type": "user", "id": "m1", "time": { "created": 1 }, "text": "Hi" },
            { "type": "assistant", "id": "m2", "time": { "created": 2 }, "agent": "build", "model": {}, "content": [
                { "type": "reasoning", "text": "hm", "time": { "created": 2, "completed": 3 } },
                { "type": "tool", "id": "t1", "name": "bash", "state": { "status": "completed" } },
                { "type": "image", "url": "x" }
            ] },
            { "type": "idle", "id": "m3", "time": { "created": 4 }, "outcome": "succeeded" },
            { "type": "agent-switched", "id": "m4", "time": { "created": 5 }, "agent": "plan" }
        ] })).unwrap();
        let Message::Assistant(step) = &page.data[1] else { panic!() };
        assert_eq!(step.content[0], Content::Reasoning { text: "hm".into(), done: true });
        assert!(matches!(&step.content[1], Content::Tool { name, .. } if name == "shell"));
        assert!(matches!(&step.content[2], Content::Other { kind, .. } if kind == "image"));
        assert!(matches!(&page.data[2], Message::Idle { outcome, .. } if outcome == "succeeded"));
        assert!(matches!(&page.data[3], Message::Other { kind, id, .. } if kind == "agent-switched" && id == "m4"));
    }
}
