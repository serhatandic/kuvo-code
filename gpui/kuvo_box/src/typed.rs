//! What a typed message means (PROTOCOL.md, "What a typed message means", `typed`): the composer's
//! text is its box's to read, at `kuvo/sessions/<session>/typed`. The box decides, does what's its
//! own, and says what the client does with the rest; a client keeps the draft, puts back what it's
//! told to, and draws.
//!
//! Kept here, as drawing: which keyword a text starts with as it's typed ([`keyword`]), and whether
//! a text goes to the box at all ([`asks_box`]), held to `Vectors/typed.json`.

use serde::{Deserialize, Serialize};

use crate::paths;

/// What a box answers the route with in `kuvo/info`'s `features`.
pub const FEATURE: &str = "typed";

/// The route that answers for `session`.
pub fn route(session: &str) -> String {
    format!("kuvo/sessions/{}/typed", paths::segment(session))
}

/// The keywords every client knows, in the order "/" lists them where the box doesn't say.
pub const KEYWORDS: &[&str] = &["goal", "loop", "plan", "autopilot", "review", "btw", "handoff", "compact"];

/// Whether `text` is asked of the box: one whose first character that isn't a space is "/" or
/// "!". Any other is a plain message, which a client sends without asking.
pub fn asks_box(text: &str) -> bool {
    matches!(text.chars().find(|c| !c.is_whitespace()), Some('/' | '!'))
}

/// What the box would answer for a plain text (one [`asks_box`] doesn't ask about) where it isn't
/// sent as a message: in the box's order (`typed/decide.ts`), a model that can't run first (every
/// plain text needs the model), all of it kept, saying why; then, with the side thread's tag on, a
/// follow-up there. None: it's sent. Held to `Vectors/typed.json`'s `decide` cases.
pub fn plain_answer(text: &str, side: bool, refusal: Option<&str>) -> Option<Answer> {
    if let Some(refusal) = refusal {
        return Some(Answer { restore: Some(Restore { text: text.to_owned(), beside: None }), error: Some(refusal.to_owned()), ..Answer::default() });
    }
    side.then(|| Answer { side_thread: Some(true), ..Answer::default() })
}

/// The keyword `text` starts with and what follows it ("/PLAN  sketch it" → `plan`, "sketch it"),
/// for drawing it as it's typed the way the box will read it once sent.
pub fn keyword(text: &str) -> Option<(&'static str, String)> {
    let text = text.trim();
    let rest = text.strip_prefix('/')?;
    let name: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    let keyword = KEYWORDS.iter().find(|known| known.eq_ignore_ascii_case(&name))?;
    Some((keyword, rest[name.len()..].trim().to_owned()))
}

/// What's sent: the text as typed, whether pictures or files are attached, whether the side
/// thread's tag is on the composer, why the conversation's model can't run (as the client says
/// it), and the model picked last in "Who reads it".
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ask {
    /// This send's own id: the same send again (after a dropped connection) is answered as it
    /// was, never done twice.
    pub id: String,
    pub text: String,
    pub files: bool,
    pub side: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<ModelRef>,
}

impl Ask {
    pub fn new(id: impl Into<String>, text: impl Into<String>) -> Ask {
        Ask { id: id.into(), text: text.into(), files: false, side: false, refusal: None, reviewer: None }
    }
}

/// A model, by its provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

/// What goes back to the composer: `text` into an empty one; beside words written since,
/// `beside` in front of them where it's given, else `text`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Restore {
    pub text: String,
    #[serde(default)]
    pub beside: Option<String>,
}

impl Restore {
    /// What goes in front of the composer's `draft`.
    pub fn text_beside(&self, draft: &str) -> &str {
        if draft.is_empty() { &self.text } else { self.beside.as_deref().unwrap_or(&self.text) }
    }
}

/// A command to run, with what follows its name.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Run {
    pub name: String,
    pub arguments: String,
}

/// A message to send: its words, the keyword it was sent with as typed ("/plan"), whether the
/// composer's quotes go with it, and whether it goes to the agent now, never to wait in the queue.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Send {
    pub text: String,
    #[serde(default)]
    pub typed: Option<String>,
    #[serde(default)]
    pub quoted: Option<bool>,
    #[serde(default)]
    pub steer: Option<bool>,
}

/// A /loop's wake-up.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct WakeUp {
    /// Seconds since 1970.
    pub due: f64,
    pub every: String,
    pub note: String,
}

/// The box's answer, in the order a client applies it: what the box did (to show at once), what
/// the client does, then what goes back to the composer. Every field is left out where it doesn't
/// apply; what this client doesn't draw yet is kept as JSON.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    // What the box did.
    pub keyword: Option<String>,
    pub goal: Option<serde_json::Value>,
    pub goal_cleared: Option<bool>,
    pub asked_bot: Option<bool>,
    pub autopilot: Option<serde_json::Value>,
    pub wake_up: Option<WakeUp>,
    pub side_question: Option<serde_json::Value>,
    pub handoff: Option<serde_json::Value>,
    pub review: Option<serde_json::Value>,
    // What the client does.
    pub show_goal: Option<bool>,
    /// The mode the box switched the conversation to, to show.
    pub agent: Option<String>,
    pub toggle_autopilot: Option<bool>,
    pub compact: Option<bool>,
    /// A command to run in the conversation's folder.
    pub shell: Option<String>,
    pub command: Option<Run>,
    pub send: Option<Send>,
    pub side_thread: Option<bool>,
    // What goes back.
    pub restore: Option<Restore>,
    pub error: Option<String>,
}

impl Answer {
    /// The composer's files go (with what's sent or run); they stay otherwise.
    pub fn takes_files(&self) -> bool {
        self.send.is_some() || self.command.is_some()
    }

    /// What a box that couldn't answer for a text says (any status but 200): what goes back to the
    /// composer (`written` as it was, where the box didn't say), and why.
    pub fn refused(status: u16, body: &[u8], written: &str) -> Answer {
        #[derive(Deserialize)]
        struct Refused {
            message: Option<String>,
            restore: Option<Restore>,
        }
        let refused: Option<Refused> = serde_json::from_slice(body).ok();
        let (message, restore) = refused.map(|r| (r.message, r.restore)).unwrap_or((None, None));
        Answer {
            restore: Some(restore.unwrap_or(Restore { text: written.to_owned(), beside: None })),
            error: Some(message.unwrap_or_else(|| format!("Its computer couldn’t say what that means ({status}). Try again."))),
            ..Answer::default()
        }
    }
}

/// A keyword "/" offers in a conversation, as its box words it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OfferedKeyword {
    pub name: String,
    pub title: String,
    pub summary: String,
    /// What's written in grey after it until something is: none for one that takes nothing.
    #[serde(default)]
    pub argument: Option<String>,
}

/// One of the engine's commands as "/" lists it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OfferedCommand {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// What "/" offers in a conversation.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Offers {
    pub keywords: Vec<OfferedKeyword>,
    pub commands: Vec<OfferedCommand>,
}
