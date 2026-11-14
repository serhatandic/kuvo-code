//! What "@" (files) and "&" (agents and sessions) suggest as you type (PROTOCOL.md, "Mentions",
//! `sessions.mentions`): the box finds and ranks them; a client lists them and puts in `text`.

use serde::Deserialize;

use crate::client::BoxClient;
use crate::error::Result;
use crate::paths;

/// Which list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum For {
    /// "@": the conversation's folder's files.
    Files,
    /// "&": bots and sessions to name.
    Agents,
}

/// One suggestion: what goes in the message, its name, what's beside it, what it is, and (an
/// agent's) its session, which the send names.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Mention {
    pub text: String,
    pub title: String,
    pub detail: Option<String>,
    pub kind: String,
    pub session: Option<String>,
}

impl BoxClient {
    /// The best of what `wanted` suggests for `query` (what's typed after the mark) in `session`.
    pub fn mentions(&self, session: &str, wanted: For, query: &str) -> Result<Vec<Mention>> {
        #[derive(Deserialize)]
        struct Answer {
            mentions: Vec<Mention>,
        }
        let what = match wanted {
            For::Files => "files",
            For::Agents => "agents",
        };
        let answer: Answer = self.get(&format!("kuvo/sessions/{}/mentions?for={what}&q={}", paths::segment(session), paths::query_value(query)))?;
        Ok(answer.mentions)
    }
}
