//! What the rail's areas list, as a box says it (PROTOCOL.md): its bots (`kuvo/bots`) and group
//! chats (`kuvo/groups`), the Work Queue's categories (`kuvo/work-queue`), the machines a Mac runs
//! sessions on (`kuvo/machines`), and the plan limits of every account across your computers
//! (`kuvo/agents/api/kuvo/limits`'s `rows`).
//!
//! Some of what the new sidebar draws the box doesn't say yet (#711): what a bot is doing now, the
//! queue's counts, a ring's share and level, what waits on you in each area, and "Needs you". Each
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

/// What a bot is doing now, in the box's words and counts.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BotNow {
    /// Its sessions at work.
    #[serde(default)]
    pub working: usize,
    /// Its sessions waiting on you.
    #[serde(default)]
    pub asking: usize,
    /// What it's doing, in a few words ("1 at work, 1 waiting on you", "Wakes up Fri 09:00").
    #[serde(default)]
    pub words: Option<String>,
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
    // BOX-NEEDED: what a bot is doing now, `now: {working, asking, words}` on each bot in `GET kuvo/bots` (and `kuvo/bots/events`) (#711).
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

/// An account's ring: the share of its fullest window that hasn't started over, and its level.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Ring {
    pub used: f32,
    pub level: Level,
}

/// One window of a plan's limits.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LimitWindow {
    pub id: String,
    /// How much of it is gone, 0 to 1.
    #[serde(default)]
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
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub windows: Vec<LimitWindow>,
    // BOX-NEEDED: the ring's share and level per account, `rows[].ring: {used, level}` in `GET kuvo/agents/api/kuvo/limits` (and `kuvo.limits.updated`): the fullest window that hasn't started over (#711).
    #[serde(default)]
    pub ring: Option<Ring>,
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

    /// The Work Queue's categories across every queue on the box, read without asking GitHub.
    pub fn work_queue(&self) -> Result<WorkQueue> {
        #[derive(Deserialize)]
        struct Answer {
            #[serde(default)]
            categories: Vec<Category>,
            // BOX-NEEDED: the Work Queue's counts across your computers, `counts: {inProgress, categories: {<id>: n}}` in `GET kuvo/work-queue?owner=all&glance=1` (and its events) (#711).
            #[serde(default)]
            counts: Option<QueueCounts>,
        }
        let answer: Answer = self.get("kuvo/work-queue?owner=all&glance=1")?;
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
    fn a_limits_row_without_a_ring_reads_as_none() {
        let row: Account = serde_json::from_str(r#"{"service":"claude","label":"Work","windows":[{"id":"five_hour","used":0.4,"read":1,"source":"usage"}]}"#).unwrap();
        assert_eq!(row.ring, None);
        assert_eq!(row.windows[0].level, None);
    }
}
