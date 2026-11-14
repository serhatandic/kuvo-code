//! What a conversation waits on you for (PROTOCOL.md, "A conversation's asks", `sessions.asks`):
//! permissions and the agent's questions, its subagents' too, each worded by the box, and answering
//! them. A client draws an ask as the box says it and sends back the answer picked.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::client::BoxClient;
use crate::error::{Error, Refusal, Result};
use crate::follow::{Follow, Followed, Timing, follow_lines};
use crate::paths;
use crate::transport::Request;

/// The asks waiting, oldest first.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct Asks {
    pub asks: Vec<Ask>,
}

/// One ask, as the box words it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Ask {
    Permission(Permission),
    Question(Question),
    /// Anything else it waits on you for (an MCP server's form, the box's own asks), answered on a
    /// Mac or a phone; `dismiss`: whether it can be put away unanswered from here.
    Other { id: String, session: String, title: String, message: String, dismiss: bool },
    /// A kind this client doesn't know yet (a newer box's): left out, the rest still read.
    #[serde(other)]
    Unknown,
}

impl Ask {
    pub fn id(&self) -> &str {
        match self {
            Ask::Permission(permission) => &permission.id,
            Ask::Question(question) => &question.id,
            Ask::Other { id, .. } => id,
            Ask::Unknown => "",
        }
    }
}

/// A permission: what the card's title says, the engine's words, the whole command line it would
/// run, the changes it would make, what it covers, and its answers in their order.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Permission {
    pub id: String,
    pub session: String,
    pub title: String,
    pub message: Option<String>,
    pub command: Option<String>,
    #[serde(default)]
    pub files: Vec<Changes>,
    #[serde(default)]
    pub resources: Vec<String>,
    pub choices: Vec<Choice>,
}

/// A file a permission would change: its patch, as a step's changes are kept.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Changes {
    pub file: String,
    pub patch: String,
    pub additions: u64,
    pub deletions: u64,
    pub status: Option<String>,
}

/// One answer a permission offers: `once`, `always`, `reject`, or `instead` (Don't Allow, with
/// your words, which opens a line for them: its `placeholder`). `named`: what Always names, shown
/// as code after its title.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Choice {
    pub answer: String,
    pub title: String,
    pub named: Option<String>,
    pub placeholder: Option<String>,
}

/// The agent's questions.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Question {
    pub id: String,
    pub session: String,
    pub title: String,
    pub questions: Vec<Asked>,
}

/// One of a question's: what it asks, its choices, whether it takes several, words of your own,
/// and whether it must be answered.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Asked {
    pub key: String,
    pub title: Option<String>,
    pub question: String,
    #[serde(default)]
    pub options: Vec<Choose>,
    pub multiple: bool,
    pub custom: bool,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Choose {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

/// An answer, as the box takes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Answer {
    /// A permission's: `once`, `always` or `reject`; `instead` with your words.
    Permission { answer: String, #[serde(skip_serializing_if = "Option::is_none")] message: Option<String> },
    /// A question's answers, by each question's key: a choice's value, your words, or several.
    Questions { answers: serde_json::Map<String, Value> },
    /// A question put away unanswered.
    Dismiss { dismiss: bool },
}

impl Answer {
    pub fn permission(answer: &str, message: Option<String>) -> Answer {
        Answer::Permission { answer: answer.to_owned(), message }
    }

    pub fn dismiss() -> Answer {
        Answer::Dismiss { dismiss: true }
    }

    /// Each question's answer: one value, or several for one that takes several.
    pub fn questions(answers: impl IntoIterator<Item = (String, Vec<String>, bool)>) -> Answer {
        let answers = answers.into_iter().map(|(key, values, multiple)| (key, if multiple { json!(values) } else { json!(values.into_iter().next().unwrap_or_default()) })).collect();
        Answer::Questions { answers }
    }
}

/// Where a conversation's asks are.
pub fn route(session: &str) -> String {
    format!("kuvo/sessions/{}/asks", paths::segment(session))
}

impl BoxClient {
    /// What `session` waits on you for now.
    pub fn asks(&self, session: &str) -> Result<Asks> {
        self.get(&route(session))
    }

    /// Follows `session`'s asks: those now, and again as they change.
    pub fn follow_asks(&self, session: &str, timing: Timing) -> Follow<Followed<Asks>> {
        follow_lines(self, "kuvo-box asks", route(session), timing)
    }

    /// Answers `ask` in `session`. A refusal says why (an answer that didn't fit, or one already
    /// answered: `404`).
    pub fn answer_ask(&self, session: &str, ask: &str, answer: &Answer) -> Result<()> {
        let body = serde_json::to_value(answer).map_err(|error| Error::BadAnswer(error.to_string()))?;
        let response = self.send(&Request::post(format!("{}/{}", route(session), paths::segment(ask)), body))?;
        if response.is_success() { Ok(()) } else { Err(Error::Refused(Refusal::from_answer(response.status, &response.body))) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_read_as_the_box_words_them() {
        let asks: Asks = serde_json::from_value(json!({ "asks": [
            { "id": "per_1", "kind": "permission", "session": "ses_1", "title": "Allow running this command?", "message": null, "command": "git push", "files": [], "resources": ["git push"], "choices": [
                { "answer": "once", "title": "Allow Once", "named": null, "placeholder": null },
                { "answer": "always", "title": "Always Allow", "named": "git push", "placeholder": null }
            ] },
            { "id": "frm_1", "kind": "question", "session": "ses_sub", "title": "Question", "questions": [
                { "key": "q0", "title": "Database", "question": "Which one?", "options": [{ "value": "pg", "label": "Postgres", "description": null }], "multiple": false, "custom": true, "required": true }
            ] },
            { "id": "frm_2", "kind": "other", "session": "ses_1", "title": "Linear", "message": "Needs your answer.", "dismiss": true },
            { "id": "zzz_1", "kind": "poll", "session": "ses_1", "anything": [1, 2] }
        ] })).unwrap();
        assert_eq!(asks.asks[3], Ask::Unknown, "a newer kind doesn't spoil the rest");
        assert!(matches!(&asks.asks[0], Ask::Permission(permission) if permission.choices[1].named.as_deref() == Some("git push")));
        assert!(matches!(&asks.asks[1], Ask::Question(question) if question.questions[0].options[0].label == "Postgres"));
        assert_eq!(asks.asks[2].id(), "frm_2");
    }

    #[test]
    fn answers_go_as_the_box_takes_them() {
        assert_eq!(serde_json::to_value(Answer::permission("instead", Some("Use a branch".into()))).unwrap(), json!({ "answer": "instead", "message": "Use a branch" }));
        assert_eq!(serde_json::to_value(Answer::permission("once", None)).unwrap(), json!({ "answer": "once" }));
        let answers = Answer::questions([("q0".into(), vec!["pg".into()], false), ("q1".into(), vec!["a".into(), "b".into()], true)]);
        assert_eq!(serde_json::to_value(answers).unwrap(), json!({ "answers": { "q0": "pg", "q1": ["a", "b"] } }));
        assert_eq!(serde_json::to_value(Answer::dismiss()).unwrap(), json!({ "dismiss": true }));
    }
}
