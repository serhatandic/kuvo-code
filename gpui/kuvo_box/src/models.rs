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
use serde_json::json;

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
    /// Whether it can run here now.
    pub runs: bool,
    /// What it needs, when it can't: `model`, `signIn`, `key`, `install`, `gone`.
    #[serde(default)]
    pub missing: Option<String>,
    #[serde(default)]
    pub account: Option<Account>,
    #[serde(default)]
    pub plan: Option<Plan>,
}

impl ModelState {
    /// Whether the chip names the model and Send sends with it, as KuvoClient's
    /// `SessionModelState.namesModel`: one that runs, or one whose account needs something (a
    /// message on it says what instead of going). For one gone, or none chosen, the chip says
    /// "Choose a Model" and Send waits for one.
    pub fn names_model(&self) -> bool {
        match self.missing.as_deref() {
            None => self.runs,
            Some("model" | "gone") => false,
            Some(_) => true,
        }
    }

    /// Whether the chip says "Choose a Model" and Send waits for one.
    pub fn needs_choosing(&self) -> bool {
        !self.names_model()
    }

    /// Why a message can't go on this model, as KuvoClient's `SessionModelState.refusal` says it
    /// (`accounts`: where its accounts are); none for one that runs.
    pub fn refusal(&self, accounts: &str) -> Option<String> {
        if self.runs && self.missing.is_none() {
            return None;
        }
        let name = self.name.clone().or_else(|| self.model.as_ref().map(|model| model.id.clone())).unwrap_or_else(|| "This model".into());
        let account = self.account.as_ref().map(|account| account.name.clone()).or_else(|| self.model.as_ref().map(|model| model.provider_id.clone())).unwrap_or_else(|| "its account".into());
        Some(match self.missing.as_deref() {
            None | Some("model") => "Choose a model to send it.".into(),
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

/// Where a conversation on a model runs: the box's engine, or its coding agents' bridge (Custom
/// Auto's lists too).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Engine,
    Agents,
}

impl Side {
    /// The side a conversation in `place` is on.
    pub fn of(place: Where) -> Side {
        match place {
            Where::Engine => Side::Engine,
            Where::Agents => Side::Agents,
        }
    }
}

/// A model a picker offers.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct OfferedModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    pub id: String,
    pub name: String,
    /// Where a conversation on it runs: a conversation is put on one of its own side's in place,
    /// and goes to another side's as a new session. None from a box before it said.
    #[serde(default)]
    pub side: Option<Side>,
    /// Its efforts (variants), as its side lists them.
    #[serde(default)]
    pub efforts: Vec<String>,
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

    /// Whether it's `model` (the same provider and id).
    pub fn is(&self, model: &ModelRef) -> bool {
        self.provider_id == model.provider_id && self.id == model.id
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
    /// The coding agents' accounts whose list isn't all they run yet: one of theirs not listed
    /// may still run.
    #[serde(default)]
    pub listing: Vec<String>,
    /// The model a new session starts on (`None` left out: the box couldn't say; `Some(None)`:
    /// nothing runs there).
    #[serde(default, deserialize_with = "present")]
    pub starting: Option<Option<ModelRef>>,
}

impl Offered {
    /// Whether both sides could say their models.
    pub fn is_whole(&self) -> bool {
        self.known.engine && self.known.agents
    }

    /// This answer, with what `before` said of a side this one couldn't (PROTOCOL.md, "The models
    /// offered": a client keeps what the box said of that side before, and asks again in a moment),
    /// as KuvoClient's `OfferedModels.keeping`: the engine's ahead, the agents' (and their
    /// `listing`) after.
    pub fn keeping(mut self, before: Option<&Offered>) -> Offered {
        let Some(before) = before else { return self };
        let on = |side: Side| move |model: &&OfferedModel| model.side == Some(side);
        if !self.known.engine && before.known.engine {
            let kept: Vec<OfferedModel> = before.models.iter().filter(on(Side::Engine)).cloned().collect();
            self.models.splice(0..0, kept);
            self.known.engine = true;
        }
        if !self.known.agents && before.known.agents {
            self.models.extend(before.models.iter().filter(on(Side::Agents)).cloned());
            self.listing = before.listing.clone();
            self.known.agents = true;
        }
        self
    }
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
    use serde_json::Value;

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
        // Can't run, with nothing said of why: one's to be chosen, as KuvoClient's `SessionModelState` says.
        let unsaid = state(json!({ "model": null, "runs": false }));
        assert!(unsaid.needs_choosing());
        assert_eq!(unsaid.refusal("x").as_deref(), Some("Choose a model to send it."));
        // What's missing counts whatever `runs` says, as in KuvoClient's `SessionModelState`.
        let gone_but_runs = state(json!({ "model": { "providerID": "openai", "id": "gpt-4" }, "runs": true, "missing": "gone" }));
        assert!(gone_but_runs.needs_choosing());
        assert_eq!(gone_but_runs.refusal("x").as_deref(), Some("gpt-4 is no longer available: choose another model."));
    }

    fn offered(value: Value) -> Offered {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_side_that_cant_say_keeps_what_it_said_before() {
        let engine = json!({ "providerID": "anthropic", "id": "opus", "name": "Opus", "side": "engine", "efforts": ["low", "high"] });
        let agents = json!({ "providerID": "claude-code", "id": "opus", "name": "Claude Code · Opus", "side": "agents", "efforts": [] });
        let before = offered(json!({ "models": [engine, agents], "known": { "engine": true, "agents": true }, "listing": ["codex"] }));
        // The bridge started again: its side isn't said now; what it said before stays.
        let now = offered(json!({ "models": [engine], "known": { "engine": true, "agents": false } })).keeping(Some(&before));
        assert_eq!(now.models.iter().map(|model| model.provider_id.as_str()).collect::<Vec<_>>(), ["anthropic", "claude-code"]);
        assert_eq!((now.known.agents, now.listing.clone()), (true, vec!["codex".to_owned()]));
        assert!(now.is_whole());
        assert_eq!(now.models[0].efforts, ["low", "high"]);
        // The engine's, the same, ahead.
        let now = offered(json!({ "models": [agents], "known": { "engine": false, "agents": true } })).keeping(Some(&before));
        assert_eq!(now.models.iter().map(|model| model.side).collect::<Vec<_>>(), [Some(Side::Engine), Some(Side::Agents)]);
        // Nothing before: as said, not whole.
        assert!(!offered(json!({ "models": [], "known": { "engine": false, "agents": true } })).keeping(None).is_whole());
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
