//! What the rail's areas list, as a box says it (PROTOCOL.md): its bots (`kuvo/bots`) and group
//! chats (`kuvo/groups`), the Work Queue's categories (`kuvo/work-queue`), the machines a Mac runs
//! sessions on (`kuvo/machines`), and the plan limits of every account across your computers
//! (`kuvo/agents/api/kuvo/limits`'s `rows`).
//!
//! Some of what the new sidebar draws the box doesn't say yet (#711): what a bot is doing now, the
//! queue's counts, a limit's level, what waits on you in each area, and "Needs you". Each
//! is read here as an optional field in the shape #711 is asked for, marked `BOX-NEEDED`; a box
//! that doesn't send it leaves it `None`, and the app draws the plain form, working out nothing.
//! Only the stand-in box sends them today.

use serde::Deserialize;

use crate::client::BoxClient;
use crate::error::{Error, Result};

// MARK: Bots

/// A bot's look, as the box sends it: a colour, a shape and a face, by name. One a newer box names
/// that a client doesn't know is drawn as the client's own fallback (graphite, round), as the Mac's.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Look {
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub shape: String,
    #[serde(default)]
    pub face: String,
}

/// What a bot is doing now, as facts: how many of its sessions are at work, and waiting on you.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BotNow {
    #[serde(default)]
    pub working: usize,
    #[serde(default)]
    pub asking: usize,
}

/// One bot, as `kuvo/bots` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Bot {
    pub id: String,
    pub session: String,
    pub name: String,
    pub look: Look,
    /// What it does, in a few words.
    #[serde(default)]
    pub job: String,
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub machine: Option<String>,
    // BOX-NEEDED: what a bot is doing now, `now: {working, asking}` (its sessions at work and waiting on you) on each bot in `GET kuvo/bots` (and `kuvo/bots/events`) (#711).
    #[serde(default)]
    pub now: Option<BotNow>,
}

/// The last thing said in a group chat.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct GroupLast {
    pub time: f64,
}

/// One group chat, as `kuvo/groups` lists it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub discussing: bool,
    #[serde(default)]
    pub unread: bool,
    #[serde(default)]
    pub last: Option<GroupLast>,
}

// MARK: The Work Queue

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    #[serde(default, rename = "builtIn")]
    pub built_in: bool,
}

/// How many items are in progress, and in each category, across your computers.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct QueueCounts {
    #[serde(default, rename = "inProgress")]
    pub in_progress: usize,
    #[serde(default)]
    pub categories: std::collections::HashMap<String, usize>,
}

/// The Work Queue's categories, in the box's order, and (once the box says them) their counts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkQueue {
    pub categories: Vec<Category>,
    pub counts: Option<QueueCounts>,
}

// MARK: Machines

/// A machine this Mac runs sessions on, as Settings › Machines lists it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Machine {
    pub id: String,
    pub name: String,
    /// `notConnected`, `connecting`, `reconnecting`, `installing`, `connected`, `failed`, `stopped`.
    #[serde(default)]
    pub connection: String,
    /// How it stands, in the box's words.
    #[serde(default)]
    pub status: String,
}

// MARK: Plan limits

/// How close a share is to its limit, as the box says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Calm,
    Near,
    Over,
}

/// One window of a plan's limits.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LimitWindow {
    pub id: String,
    /// How much of it is gone, 0 to 1.
    pub used: f32,
    #[serde(default, rename = "resetsAt")]
    pub resets_at: Option<f64>,
    #[serde(default)]
    pub minutes: Option<u32>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    // BOX-NEEDED: a window's level, `windows[].level: calm|near|over` in `GET kuvo/agents/api/kuvo/limits`' rows, so every client colours alike (#711).
    #[serde(default)]
    pub level: Option<Level>,
}

/// An account across your computers, as the limits' `rows` list it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Account {
    /// Its mark and colour: `claude`, `codex`, `grok`, `cursor`, `antigravity`, `copilot`,
    /// `openrouter`, `zai`, `ollama`, `opencode`.
    pub service: String,
    /// The row's own name, where the box gives one (two accounts it tells apart).
    #[serde(default)]
    pub name: Option<String>,
    /// The coding agent whose sign-in it is (`claude`…); none for the engine's.
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default, deserialize_with = "readable")]
    pub windows: Vec<LimitWindow>,
}

/// A list's items this can read: one it can't is left out, not all of them (KuvoClient's `Readable`).
fn readable<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned>(deserializer: D) -> std::result::Result<Vec<T>, D::Error> {
    let values = Vec::<serde_json::Value>::deserialize(deserializer)?;
    Ok(values.into_iter().filter_map(|value| serde_json::from_value(value).ok()).collect())
}

impl Account {
    /// Its name, as KuvoClient's `LimitsAccount.title` says it: the row's own, else its coding
    /// agent's or its service's, with what you called it ("Claude · Work").
    pub fn title(&self) -> String {
        if let Some(name) = &self.name {
            return name.clone();
        }
        let base = match &self.agent {
            Some(agent) => agent_name(agent).map(str::to_owned).unwrap_or_else(|| capitalized(agent)),
            None => service_name(&self.service).map(str::to_owned).unwrap_or_else(|| capitalized(&self.service)),
        };
        match self.label.as_deref().map(str::trim).filter(|label| !label.is_empty()) {
            Some(label) => format!("{base} · {label}"),
            None => base,
        }
    }

    /// Its windows still current: one that started over since it was read is left out (what's used
    /// now isn't known), as KuvoClient's `windows(at:)`.
    pub fn windows_at(&self, now: f64) -> impl Iterator<Item = &LimitWindow> {
        self.windows.iter().filter(move |window| window.resets_at.is_none_or(|at| at > now))
    }

    /// The window with the least left, as the ring shows it (KuvoClient's `tightest(at:)`).
    pub fn tightest(&self, now: f64) -> Option<&LimitWindow> {
        self.windows_at(now).fold(None, |most: Option<&LimitWindow>, window| match most {
            Some(most) if most.used >= window.used => Some(most),
            _ => Some(window),
        })
    }
}

impl LimitWindow {
    /// Its name, as KuvoClient's `LimitsWindow.title`: "Session", "Weekly", "Sonnet", "Premium requests".
    pub fn title(&self) -> String {
        if let Some(name) = self.name.as_ref().filter(|name| !name.is_empty()) {
            return name.clone();
        }
        if let Some(model) = self.model.as_ref().filter(|model| !model.is_empty()) {
            return model.clone();
        }
        match self.minutes {
            Some(300) => "Session".into(),
            Some(10_080) => "Weekly".into(),
            Some(minutes) if (40_000..=45_000).contains(&minutes) => "Monthly".into(),
            Some(minutes) if minutes >= 1_440 => format!("{}-day", minutes / 1_440),
            Some(minutes) if minutes >= 60 => format!("{}-hour", minutes / 60),
            _ => "Limit".into(),
        }
    }
}

/// The coding agents by their own names (KuvoClient's `AccountNames.agents`).
fn agent_name(agent: &str) -> Option<&'static str> {
    Some(match agent {
        "claude" => "Claude",
        "codex" => "Codex",
        "grok" => "Grok",
        "cursor" => "Cursor",
        "antigravity" => "Antigravity",
        _ => return None,
    })
}

/// The engine's services by their plans' names (KuvoClient's `AccountNames.services`).
fn service_name(service: &str) -> Option<&'static str> {
    Some(match service {
        "codex" => "ChatGPT",
        "grok" => "SuperGrok",
        "copilot" => "Copilot",
        "openrouter" => "OpenRouter",
        "zai" => "Z.ai",
        "ollama" => "Ollama",
        "opencode" => "OpenCode Go",
        _ => return None,
    })
}

/// Swift's `capitalized` for one word.
fn capitalized(word: &str) -> String {
    let mut chars = word.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars.flat_map(char::to_lowercase)).collect()).unwrap_or_default()
}

// MARK: What waits on you

/// A session waiting on you, and what it asks, in a few words.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NeedsYou {
    pub session: String,
    /// What it asks ("asks to run a command"), in the box's words.
    #[serde(default)]
    pub asks: String,
}

/// What waits on you in each area, across the box, and the sessions that do, in the box's order.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct Waiting {
    #[serde(default)]
    pub sessions: usize,
    #[serde(default)]
    pub bots: usize,
    #[serde(default)]
    pub queue: usize,
    #[serde(default, rename = "needsYou")]
    pub needs_you: Vec<NeedsYou>,
}

impl BoxClient {
    /// The bots that live on this box.
    pub fn bots(&self) -> Result<Vec<Bot>> {
        #[derive(Deserialize)]
        struct Answer {
            bots: Vec<serde_json::Value>,
        }
        let answer: Answer = self.get("kuvo/bots")?;
        // One a newer box lists in a shape this can't read is left out, not the whole list.
        Ok(answer.bots.into_iter().filter_map(|bot| serde_json::from_value(bot).ok()).collect())
    }

    /// The group chats that live on this box.
    pub fn groups(&self) -> Result<Vec<Group>> {
        #[derive(Deserialize)]
        struct Answer {
            groups: Vec<serde_json::Value>,
        }
        let answer: Answer = self.get("kuvo/groups")?;
        Ok(answer.groups.into_iter().filter_map(|group| serde_json::from_value(group).ok()).collect())
    }

    /// The Work Queue's categories, in the box's order.
    pub fn work_queue(&self) -> Result<WorkQueue> {
        #[derive(Deserialize)]
        struct Answer {
            #[serde(default)]
            categories: Vec<Category>,
            // BOX-NEEDED: the Work Queue's counts across your computers, `counts: {inProgress, categories: {<id>: n}}` in `GET kuvo/work-queue/categories` (and an events route) (#711).
            #[serde(default)]
            counts: Option<QueueCounts>,
        }
        let answer: Answer = self.get("kuvo/work-queue/categories")?;
        Ok(WorkQueue { categories: answer.categories, counts: answer.counts })
    }

    /// The machines this Mac runs sessions on (a machine's box has none: `Ok(vec![])` from one that
    /// doesn't answer the route).
    pub fn machines(&self) -> Result<Vec<Machine>> {
        #[derive(Deserialize)]
        struct Answer {
            #[serde(default)]
            machines: Vec<serde_json::Value>,
        }
        match self.get::<Answer>("kuvo/machines") {
            Ok(answer) => Ok(answer.machines.into_iter().filter_map(|machine| serde_json::from_value(machine).ok()).collect()),
            Err(Error::Refused(refusal)) if refusal.status == 404 => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    /// Every account across your computers, in the box's order (its limits' `rows`).
    pub fn accounts(&self) -> Result<Vec<Account>> {
        #[derive(Deserialize)]
        struct Data {
            #[serde(default)]
            rows: Vec<serde_json::Value>,
        }
        #[derive(Deserialize)]
        struct Answer {
            data: Data,
        }
        let answer: Answer = self.get("kuvo/agents/api/kuvo/limits")?;
        Ok(answer.data.rows.into_iter().filter_map(|row| serde_json::from_value(row).ok()).collect())
    }

    /// What waits on you in each area. `Ok(None)` from a box that doesn't say yet.
    pub fn waiting(&self) -> Result<Option<Waiting>> {
        // BOX-NEEDED: what waits on you in each area, and the sessions that do with what each asks, a new `GET kuvo/waiting` (and `kuvo/waiting/events`, ndjson) → `{sessions, bots, queue, needsYou: [{session, asks}]}` across the box (`kuvo/attention` is taken: it's the client-in-use lease) (#711).
        match self.get::<Waiting>("kuvo/waiting") {
            Ok(waiting) => Ok(Some(waiting)),
            Err(Error::Refused(refusal)) if refusal.status == 404 => Ok(None),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bot_the_box_lists_in_an_unknown_shape_leaves_the_rest() {
        let bots: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"id":"bot_1","session":"ses_1","name":"Mira","look":{"color":"sky","shape":"round","face":"calm"},"job":"Looks after the website","paused":false,"watching":0,"agents":false,"folder":"/x","jobDetails":""},
                {"id":"bot_2","name":"No session"}]"#,
        )
        .unwrap();
        let read: Vec<Bot> = bots.into_iter().filter_map(|bot| serde_json::from_value(bot).ok()).collect();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].now, None, "a box from before #711 says nothing of what it's doing");
    }

    #[test]
    fn a_limits_row_without_levels_reads_as_none() {
        let row: Account = serde_json::from_str(r#"{"service":"claude","label":"Work","windows":[{"id":"five_hour","used":0.4,"read":1,"source":"usage"},{"id":"newer"}]}"#).unwrap();
        assert_eq!(row.windows.len(), 1, "a window in a shape this can't read is left out");
        assert_eq!(row.windows[0].level, None);
    }

    /// Held to KuvoClient's `LimitsAccount.title`, `LimitsWindow.title` and `tightest(at:)`.
    #[test]
    fn accounts_and_windows_are_named_and_ringed_as_kuvoclient_does() {
        let row = |json: &str| serde_json::from_str::<Account>(json).unwrap();
        assert_eq!(row(r#"{"service":"claude","agent":"claude","label":"Work"}"#).title(), "Claude · Work");
        assert_eq!(row(r#"{"service":"codex"}"#).title(), "ChatGPT", "the engine's ChatGPT sign-in");
        assert_eq!(row(r#"{"service":"codex","agent":"codex"}"#).title(), "Codex");
        assert_eq!(row(r#"{"service":"opencode"}"#).title(), "OpenCode Go");
        assert_eq!(row(r#"{"service":"claude","agent":"claude","name":"Claude (studio)","label":"Work"}"#).title(), "Claude (studio)");
        let window = |minutes: Option<u32>, model: Option<&str>, name: Option<&str>| LimitWindow { id: "w".into(), used: 0., resets_at: None, minutes, model: model.map(str::to_owned), name: name.map(str::to_owned), level: None };
        assert_eq!(window(Some(300), None, None).title(), "Session");
        assert_eq!(window(Some(10_080), Some("Sonnet"), None).title(), "Sonnet");
        assert_eq!(window(Some(43_200), None, None).title(), "Monthly");
        assert_eq!(window(None, None, Some("Premium requests")).title(), "Premium requests");
        // The fullest window still current; one that started over since isn't counted.
        let account = row(r#"{"service":"codex","windows":[{"id":"a","used":0.9,"resetsAt":100,"read":1},{"id":"b","used":0.4,"resetsAt":500,"read":1},{"id":"c","used":0.2,"read":1}]}"#);
        assert_eq!(account.tightest(50.).map(|window| window.id.as_str()), Some("a"));
        assert_eq!(account.tightest(200.).map(|window| window.id.as_str()), Some("b"));
    }
}
