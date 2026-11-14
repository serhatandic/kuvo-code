//! Searching a box's sessions, for the sidebar's search: by their names, as the lists name them,
//! as you type; and by what was said in them, which the box searches (`kuvo/search`, PROTOCOL.md).

use serde::Deserialize;

use crate::client::BoxClient;
use crate::error::Result;
use crate::sessions::{Listing, project_name};

/// The fewest characters the box's search of conversations is asked for (fewer find too much).
pub const SEARCHED_FROM: usize = 3;

/// A conversation whose words have the search: the words around where they were found, and the
/// subagent that said them, when it wasn't the conversation itself.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Found {
    pub session: String,
    pub snippet: String,
    #[serde(default, deserialize_with = "subagent_id")]
    pub subagent: Option<String>,
}

fn subagent_id<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<String>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| value.get("id").and_then(|id| id.as_str()).map(str::to_owned)))
}

impl BoxClient {
    /// Sessions whose conversation has `query`, the latest first (at most `limit`).
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Found>> {
        #[derive(Deserialize)]
        struct Answer {
            results: Vec<Found>,
        }
        let answer: Answer = self.get(&format!("kuvo/search?q={}&limit={limit}", crate::paths::query_value(query.trim())))?;
        Ok(answer.results)
    }
}

impl Listing {
    /// The sessions the lists show (a project's or a chat, archived too) whose title or project's
    /// name has `query` (any case), newest first, as the Mac's sidebar finds them by name.
    pub fn named(&self, query: &str) -> Vec<String> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Vec::new();
        }
        let mut found: Vec<(&String, f64)> = self
            .sessions()
            .iter()
            .filter(|(_, facts)| facts.kind.is_project() || facts.kind.is_chat())
            .filter(|(_, facts)| {
                let title = facts.title.as_deref().filter(|title| !title.trim().is_empty()).unwrap_or("New Session");
                let project = facts.project.as_deref().map(|project| project_name(project, self.projects())).unwrap_or_default();
                title.to_lowercase().contains(&query) || project.to_lowercase().contains(&query)
            })
            .map(|(id, facts)| (id, facts.updated))
            .collect();
        found.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        found.into_iter().map(|(id, _)| id.clone()).collect()
    }
}
