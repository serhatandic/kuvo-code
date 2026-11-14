//! A conversation's model, as its box says (PROTOCOL.md, "A session's model", `sessions.models`),
//! the models a picker offers ("The models offered", `models.offered`), a model's efforts (its
//! variants, as the engine or the coding agents' bridge lists them, `api/model`), picking one for a
//! conversation (`api/session/<id>/model`), and starting a conversation (`kuvo/sessions`,
//! `sessions.start.empty`).
//!
//! The box decides what runs and which model a new one starts on; a client draws the chip and the
//! picker from what it says. Kept here, as drawing: what the chip says and why Send waits, worded
//! as KuvoClient's `SessionModelState` words it.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::client::{BoxClient, decode};
use crate::error::{Error, Refusal, Result};
use crate::messages::Where;
use crate::paths;
use crate::transport::Request;
use crate::typed::ModelRef;

/// An account a model needs, as the box names it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// A plan whose models are under a coding agent ("SuperGrok", under Grok).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Plan {
    pub name: String,
    pub agent: String,
    pub provider: String,
}

/// What a session's box says of its model.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ModelState {
    /// The model it runs on (its own, else the engine's default); none when there's none to run on.
    pub model: Option<ModelRef>,
    /// As its provider or coding agent lists it.
    #[serde(default)]
    pub name: Option<String>,
    /// Whether it can run here now (none: the box can't say yet).
    #[serde(default)]
    pub runs: Option<bool>,
    /// What it needs, when it can't: `model`, `signIn`, `key`, `install`, `gone`.
    #[serde(default)]
    pub missing: Option<String>,
    #[serde(default)]
    pub account: Option<Account>,
    #[serde(default)]
    pub plan: Option<Plan>,
}

impl ModelState {
    /// Whether the chip says "Choose a Model" and Send waits for one: none to run on, or gone.
    pub fn needs_choosing(&self) -> bool {
        self.runs == Some(false) && matches!(self.missing.as_deref(), Some("model" | "gone"))
    }

    /// Why a message can't go on this model, as KuvoClient's `SessionModelState.refusal` says it
    /// (`accounts`: where its accounts are, "Settings › Accounts"); none while it runs or the box
    /// can't say.
    pub fn refusal(&self, accounts: &str) -> Option<String> {
        if self.runs != Some(false) {
            return None;
        }
        let name = self.name.clone().or_else(|| self.model.as_ref().map(|model| model.id.clone())).unwrap_or_else(|| "This model".into());
        let account = self.account.as_ref().map(|account| account.name.clone()).or_else(|| self.model.as_ref().map(|model| model.provider_id.clone())).unwrap_or_else(|| "its account".into());
        Some(match self.missing.as_deref() {
            Some("model") => "Choose a model to send it.".into(),
            Some("signIn") => format!("{name} needs a sign-in: sign in to {account} in {accounts}, or choose another model."),
            Some("key") => match &self.plan {
                Some(plan) => format!(
                    "{name} needs {} {account} key: add one in {accounts}, or choose another model (with {} {} plan, one under {}).",
                    article(&account),
                    article(&plan.name),
                    plan.name,
                    plan.agent
                ),
                None => format!("{name} needs {} {account} key: add one in {accounts}, or choose another model.", article(&account)),
            },
            Some("install") => format!("{name} needs {account} installed: install it in {accounts}, or choose another model."),
            Some("gone") => match &self.account {
                Some(account) => format!("{name} is no longer among {}’s models: choose another model.", account.name),
                None => format!("{name} is no longer available: choose another model."),
            },
            _ => format!("{name} can’t run now: choose another model."),
        })
    }
}

fn article(word: &str) -> &'static str {
    match word.to_lowercase().chars().next() {
        Some('a' | 'e' | 'i' | 'o' | 'u') => "an",
        _ if word.starts_with("xA") => "an",
        _ => "a",
    }
}

/// A model a picker offers.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OfferedModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    pub name: String,
    /// Its provider is retiring it: a picker leaves it out.
    #[serde(default)]
    pub retiring: bool,
    /// Its agent keeps it out of its picker: a picker leaves it out.
    #[serde(default)]
    pub hidden: bool,
}

impl OfferedModel {
    pub fn reference(&self) -> ModelRef {
        ModelRef { provider_id: self.provider_id.clone(), id: self.id.clone(), variant: None }
    }

    /// Whether a picker shows it.
    pub fn is_offered(&self) -> bool {
        !self.retiring && !self.hidden
    }
}

/// Whether each side of the box could say its models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
pub struct Known {
    #[serde(default)]
    pub engine: bool,
    #[serde(default)]
    pub agents: bool,
}

/// The models offered, in the order a picker draws them, and the one a new session starts on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Offered {
    pub models: Vec<OfferedModel>,
    #[serde(default)]
    pub known: Known,
    /// The model a new session starts on (`None` left out: the box couldn't say; `Some(None)`:
    /// nothing runs there).
    #[serde(default, deserialize_with = "present")]
    pub starting: Option<Option<ModelRef>>,
}

fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<Option<ModelRef>>, D::Error> {
    Option::<ModelRef>::deserialize(deserializer).map(Some)
}

/// Where a new conversation goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartIn {
    /// A project, by its folder (or its name) on the box.
    Project(String),
    /// A chat, in no project.
    Chat,
}

/// What a new conversation is, as the box made it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Started {
    pub session: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    /// Its project's folder; none for a chat.
    #[serde(default)]
    pub project: Option<String>,
}

impl BoxClient {
    /// What `sessions`' box says of each one's model (at most 200 at once); a session it can't say
    /// about yet is left out.
    pub fn session_models(&self, sessions: &[&str]) -> Result<HashMap<String, ModelState>> {
        #[derive(Deserialize)]
        struct Told {
            sessions: HashMap<String, ModelState>,
        }
        let mut all = HashMap::new();
        for batch in sessions.chunks(200) {
            let list = batch.iter().map(|session| paths::query_value(session)).collect::<Vec<_>>().join(",");
            let told: Told = self.get(&format!("kuvo/sessions/models?sessions={list}"))?;
            all.extend(told.sessions);
        }
        Ok(all)
    }

    /// The models a picker offers here, and the one a new session starts on for `wanted` (the
    /// model picked last on this client).
    pub fn offered_models(&self, wanted: Option<&ModelRef>) -> Result<Offered> {
        let mut path = "kuvo/models/offered".to_owned();
        if let Some(wanted) = wanted {
            path.push_str(&format!("?provider={}&model={}", paths::query_value(&wanted.provider_id), paths::query_value(&wanted.id)));
            if let Some(variant) = &wanted.variant {
                path.push_str(&format!("&variant={}", paths::query_value(variant)));
            }
        }
        self.get(&path)
    }

    /// The efforts `model` offers (its variants, "low", "high"…), as the engine (or the coding
    /// agents' bridge) lists it for `directory`; none for a model that has none or isn't listed.
    pub fn efforts(&self, place: Where, directory: Option<&str>, model: &ModelRef) -> Result<Vec<String>> {
        let mut request = Request::get(format!("{}api/model", place.prefix()));
        if let Some(directory) = directory {
            request = request.header("x-opencode-directory", directory);
        }
        let listed: Value = self.value(&request)?;
        let models = listed.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
        let found = models.iter().find(|each| {
            let same = |name: &str, wanted: &str| each.get(name).and_then(Value::as_str) == Some(wanted);
            same("providerID", &model.provider_id) && (same("id", &model.id) || each.get("aliases").and_then(Value::as_array).is_some_and(|aliases| aliases.iter().any(|alias| alias.as_str() == Some(model.id.as_str()))))
        });
        Ok(found
            .and_then(|found| found.get("variants")?.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|variant| variant.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect())
    }

    /// Puts `session` on `model` (with its effort as `variant`), from its next step.
    pub fn select_model(&self, session: &str, place: Where, model: &ModelRef) -> Result<()> {
        let body = json!({ "model": model });
        let response = self.send(&Request::post(place.session_route(session, "/model"), body))?;
        if response.is_success() { Ok(()) } else { Err(Error::Refused(Refusal::from_answer(response.status, &response.body))) }
    }

    /// Stops `session`'s run (`kuvo/sessions/<id>/stop`, `queue`): the box holds and pauses what
    /// waits to go, then stops the run.
    pub fn stop_session(&self, session: &str) -> Result<()> {
        let response = self.send(&Request::post(format!("kuvo/sessions/{}/stop", paths::segment(session)), json!({})))?;
        if response.is_success() { Ok(()) } else { Err(Error::Refused(Refusal::from_answer(response.status, &response.body))) }
    }

    /// Starts an empty conversation (`sessions.start.empty`) in `place`, on `model` where one's
    /// named, for the user's own first message.
    pub fn start_session(&self, place: &StartIn, model: Option<&ModelRef>) -> Result<Started> {
        let mut body = match place {
            StartIn::Project(project) => json!({ "project": project }),
            StartIn::Chat => json!({ "chat": true }),
        };
        if let Some(model) = model {
            body["model"] = json!(model);
        }
        decode(&self.send(&Request::post("kuvo/sessions", body))?)
    }
}

/// An effort's name as a chip shows it ("xhigh" → "Extra"), as KuvoClient's `EffortLevel` does.
pub fn effort_title(id: &str) -> String {
    match id.to_lowercase().as_str() {
        "xhigh" | "x-high" | "extra-high" | "extra_high" | "extrahigh" => "Extra".into(),
        "max" | "maximum" => "Max".into(),
        "none" | "off" => "Off".into(),
        _ => {
            let mut chars = id.chars();
            chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(value: Value) -> ModelState {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn the_chip_and_send_follow_what_the_box_says() {
        let runs = state(json!({ "model": { "providerID": "anthropic", "id": "claude-opus-5-5" }, "name": "Claude Opus 5.5", "runs": true }));
        assert_eq!((runs.needs_choosing(), runs.refusal("Settings › Accounts")), (false, None));
        let gone = state(json!({ "model": { "providerID": "openai", "id": "gpt-4" }, "name": "GPT-4", "runs": false, "missing": "gone", "account": { "id": "openai", "name": "OpenAI" } }));
        assert!(gone.needs_choosing());
        assert_eq!(gone.refusal("Settings › Accounts").as_deref(), Some("GPT-4 is no longer among OpenAI’s models: choose another model."));
        let sign_in = state(json!({ "model": { "providerID": "anthropic", "id": "claude-opus-5-5" }, "name": "Claude Opus 5.5", "runs": false, "missing": "signIn", "account": { "id": "anthropic", "name": "Anthropic" } }));
        assert!(!sign_in.needs_choosing());
        assert_eq!(sign_in.refusal("Settings › Accounts").as_deref(), Some("Claude Opus 5.5 needs a sign-in: sign in to Anthropic in Settings › Accounts, or choose another model."));
        let key = state(json!({ "model": { "providerID": "openai", "id": "gpt-6" }, "runs": false, "missing": "key", "account": { "id": "openai", "name": "OpenAI" } }));
        assert_eq!(key.refusal("Settings › Accounts").as_deref(), Some("gpt-6 needs an OpenAI key: add one in Settings › Accounts, or choose another model."));
        // Not said yet: nothing refused.
        assert_eq!(state(json!({ "model": null })).refusal("x"), None);
    }

    #[test]
    fn offered_reads_whether_the_box_said_where_new_ones_start() {
        let said: Offered = serde_json::from_value(json!({ "models": [], "known": { "engine": true, "agents": true }, "starting": null })).unwrap();
        assert_eq!(said.starting, Some(None));
        let unsaid: Offered = serde_json::from_value(json!({ "models": [], "known": { "engine": false, "agents": true } })).unwrap();
        assert_eq!(unsaid.starting, None);
    }

    #[test]
    fn efforts_are_titled_as_every_client_titles_them() {
        assert_eq!(["low", "xhigh", "max", "none", "medium"].map(effort_title), ["Low", "Extra", "Max", "Off", "Medium"]);
    }
}
