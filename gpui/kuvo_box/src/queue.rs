//! A conversation's queue (PROTOCOL.md, "The queue", `queue.items`): every message waiting, in the
//! order the box says clients show them, and taking one back (to edit it, or for good).

use serde::Deserialize;

use crate::client::BoxClient;
use crate::error::{Error, Refusal, Result};
use crate::follow::{Follow, Followed, Timing, follow_lines};
use crate::parts::File;
use crate::paths;
use crate::transport::Request;

/// A session's queue as clients show it.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct Queue {
    pub paused: bool,
    /// Every message waiting, in order; none while where it runs can't be read.
    pub items: Option<Vec<Item>>,
}

/// One message waiting: your words (without what the box adds for the agent), its files' names, the
/// keyword it went with, who it's from (none for yours), where it waits, and whether Stop held it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Item {
    pub id: String,
    pub words: String,
    #[serde(default)]
    pub files: Vec<String>,
    pub keyword: Option<String>,
    pub from: Option<String>,
    pub on: String,
    pub delivery: String,
    pub held: bool,
}

impl Item {
    /// Yours (not another agent's letter, a wake-up or a note): only yours can be edited.
    pub fn is_yours(&self) -> bool {
        self.from.is_none()
    }
}

/// One taken back: its words as shown, and its files as the send takes them, to put back in the
/// composer.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Removed {
    pub id: String,
    #[serde(default)]
    pub words: String,
    #[serde(default)]
    pub files: Vec<File>,
}

pub fn route(session: &str) -> String {
    format!("kuvo/sessions/{}/queue", paths::segment(session))
}

impl BoxClient {
    pub fn queue(&self, session: &str) -> Result<Queue> {
        self.get(&route(session))
    }

    /// Follows `session`'s queue: now, and again as it changes.
    pub fn follow_queue(&self, session: &str, timing: Timing) -> Follow<Followed<Queue>> {
        follow_lines(self, "kuvo-box queue", route(session), timing)
    }

    /// Takes `item` out of the queue (wherever it waits), with what it was.
    pub fn remove_queued(&self, session: &str, item: &str) -> Result<Option<Removed>> {
        #[derive(Deserialize)]
        struct Answer {
            removed: Option<Removed>,
        }
        let response = self.send(&Request::delete(format!("{}/{}", route(session), paths::segment(item))))?;
        if !response.is_success() {
            return Err(Error::Refused(Refusal::from_answer(response.status, &response.body)));
        }
        let answer: Answer = serde_json::from_slice(&response.body).map_err(|error| Error::BadAnswer(error.to_string()))?;
        Ok(answer.removed)
    }
}
