//! A message's parts (PROTOCOL.md, "A message's parts", `messages.send`): what was written, and what
//! went with it (the keyword it was sent with, the widget it answers, comments on the changes, files
//! its note names, agents it names with "&", that it came from a phone, or that another agent wrote
//! it). A client sends them as fields ([`Sending`], `kuvo/sessions/<id>/send`) and the box writes the
//! text the agent reads; the box keeps them with the message (`metadata.kuvo.parts`), and reads them
//! from the text of one from before (`kuvo/messages/parts`). A client draws from these, and parses
//! no text. Held to `Packages/KuvoLink/Vectors/message-parts.json`, as KuvoClient's `MessageParts` is.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths;

/// What a box answers `kuvo/sessions/<id>/send` and `kuvo/messages/parts` with in `features`.
pub const FEATURE: &str = "messages.send";

/// The route a message (or a command) goes to `session` by.
pub fn send_route(session: &str) -> String {
    format!("kuvo/sessions/{}/send", paths::segment(session))
}

/// The route that reads the parts of messages from before.
pub const READ_ROUTE: &str = "kuvo/messages/parts";

/// How many texts one read takes.
pub const READ_MOST: usize = 500;

/// A comment on one line of the changes: its file, the line's number on its side (a removed line's
/// on the old side), the line as it read, and what was said of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    pub file: String,
    pub line: i64,
    pub side: Side,
    pub snippet: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    New,
    Old,
}

/// An agent: as it was named, and its address ("unknown" for a message that can't be answered).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    pub session: String,
}

/// A message's parts.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Parts {
    /// What was written ("Can you review?"; a command's, as typed).
    pub words: String,
    /// The keyword it was sent with, as typed ("/loop every hour").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyword: Option<String>,
    /// The title of the widget it answers ("" for one without a title).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<Comment>,
    /// Files its note names that it doesn't carry: sent as paths, or left behind.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    /// The agents it names with "&".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<Agent>,
    /// Sent from a phone.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub phone: bool,
    /// Another agent wrote it: who (and how to answer).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mail: Option<Agent>,
}

impl Parts {
    /// Just words: a message as it's shown while its parts aren't known.
    pub fn words(words: impl Into<String>) -> Parts {
        Parts { words: words.into(), ..Parts::default() }
    }

    /// The parts kept with a message (`metadata.kuvo.parts`), or none for one from before. Read
    /// leniently, as KuvoClient reads them: what doesn't read is left out, not the whole.
    pub fn kept(metadata: Option<&Value>) -> Option<Parts> {
        let parts = metadata?.get("kuvo")?.get("parts")?.as_object()?;
        let words = parts.get("words")?.as_str()?.to_owned();
        let string = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
        let list = |name: &str| parts.get(name).and_then(Value::as_array).cloned().unwrap_or_default();
        let agent = |value: &Value| Some(Agent { name: string(value.get("name"))?, session: string(value.get("session"))? });
        let comments = list("comments")
            .iter()
            .filter_map(|each| {
                Some(Comment {
                    file: string(each.get("file"))?,
                    line: each.get("line")?.as_i64()?,
                    side: if each.get("side").and_then(Value::as_str) == Some("old") { Side::Old } else { Side::New },
                    snippet: string(each.get("snippet"))?,
                    text: string(each.get("text"))?,
                })
            })
            .collect();
        Some(Parts {
            words,
            keyword: string(parts.get("keyword")),
            widget: string(parts.get("widget")),
            comments,
            paths: list("paths").iter().filter_map(|path| path.as_str().map(str::to_owned)).collect(),
            agents: list("agents").iter().filter_map(agent).collect(),
            phone: parts.get("phone") == Some(&Value::Bool(true)),
            mail: parts.get("mail").and_then(agent),
        })
    }
}

/// A file a message carries, as the engine takes it: `file://` on the box's own disk, or `data:`
/// inline (which the box keeps).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct File {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Where the files a message sent are, for its note: with their contents (`included`), as paths for
/// the agent to open, and those left behind (they couldn't be read or sent).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Notes {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub included: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unsent: Vec<String>,
}

impl Notes {
    pub fn is_empty(&self) -> bool {
        self.included.is_empty() && self.paths.is_empty() && self.unsent.is_empty()
    }
}

/// How a message goes to the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    /// To the agent now, read at its next step.
    Steer,
    /// After the run under way ends.
    Queue,
}

/// What a client sends: what was written and what goes with it, as fields; the box writes the text
/// the agent reads. `command`: run that command, `words` its arguments. `named`: the sessions picked
/// from the "&" list as it was written.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Sending {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub words: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<File>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<Delivery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyword: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widget: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<Comment>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub named: Vec<String>,
    #[serde(skip_serializing_if = "Notes::is_empty")]
    pub notes: Notes,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

impl Sending {
    pub fn words(words: impl Into<String>) -> Sending {
        Sending { words: words.into(), ..Sending::default() }
    }
}
