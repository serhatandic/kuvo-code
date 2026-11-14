//! A conversation's model, as its box says (PROTOCOL.md, "A session's model", `sessions.models`),
//! the models a picker offers ("The models offered", `models.offered`), a model's efforts (its
//! variants, as the engine or the coding agents' bridge lists them, `api/model`), picking one for a
//! conversation (`api/session/<id>/model`), and starting a conversation (`kuvo/sessions`,
//! `sessions.start.empty`).
//!
//! The box decides what runs, which model a new one starts on, and what a model that can't run
//! means for a composer, in its own words (`refusal`, `choose`, `action`); a client draws the chip,
//! the picker and why Send waits from what it says.

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

/// What to offer doing about a model that can't run, as its box words it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Action {
    /// `signIn`, `addKey`, `install` (its account's) or `choose` (a model).
    #[serde(rename = "do")]
    pub kind: String,
    /// A button's words ("Sign In", "Choose a Model").
    pub label: String,
    /// What it does ("Sign in to Anthropic").
    pub help: String,
}

/// What a session's box says of its model, and what that means for a composer, decided and worded
/// by the box (`models.readiness`): a client draws `refusal`, `choose` and `action` as they are.
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
    /// Why a message on it can't go, and what to do, in the box's words; none where one can go.
    #[serde(default)]
    pub refusal: Option<String>,
    /// The chip says "Choose a Model" and Send waits for one (a model gone, or none to run on).
    #[serde(default)]
    pub choose: bool,
    /// What to offer doing about it (none for one a newer box words otherwise: the rest stands).
    #[serde(default, deserialize_with = "lenient")]
    pub action: Option<Action>,
}

/// An action as the box says it; one this client can't read is none, never the whole answer lost.
fn lenient<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<Action>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

impl ModelState {
    /// As without the box's word on it (a model just picked, or one it can't say about now): it
    /// runs, as far as this client says, with no refusal of its own.
    pub fn unsaid(&mut self) {
        self.runs = true;
        self.missing = None;
        self.account = None;
        self.plan = None;
        self.refusal = None;
        self.choose = false;
        self.action = None;
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
    /// and goes to another side's as a new session (`models.offered.sides`, which the gate needs).
    pub side: Side,
    /// Its efforts (variants), as its side lists them.
    pub efforts: Vec<String>,
    /// Other ids a conversation may name it by (Claude Code's `default`).
    pub aliases: Vec<String>,
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

    /// Whether it's `model`: the same provider, and its id or one it's known by.
    pub fn is(&self, model: &ModelRef) -> bool {
        self.provider_id == model.provider_id && (self.id == model.id || self.aliases.contains(&model.id))
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
        let on = |side: Side| move |model: &&OfferedModel| model.side == side;
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
    /// model picked last on this client), in `folder` (a project's or a conversation's: what its
    /// own settings add is offered there too, `models.offered.folder`).
    pub fn offered_models(&self, wanted: Option<&ModelRef>, folder: Option<&str>) -> Result<Offered> {
        let mut query = Vec::new();
        if let Some(folder) = folder.filter(|folder| !folder.is_empty()) {
            query.push(format!("folder={}", paths::query_value(folder)));
        }
        if let Some(wanted) = wanted {
            query.push(format!("provider={}&model={}", paths::query_value(&wanted.provider_id), paths::query_value(&wanted.id)));
            if let Some(variant) = &wanted.variant {
                query.push(format!("variant={}", paths::query_value(variant)));
            }
        }
        let path = if query.is_empty() { "kuvo/models/offered".to_owned() } else { format!("kuvo/models/offered?{}", query.join("&")) };
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
    fn an_action_this_client_cant_read_leaves_the_rest() {
        let said = state(json!({ "model": null, "runs": false, "missing": "model", "refusal": "Choose a model to send it.", "choose": true, "action": { "do": "choose" } }));
        assert_eq!((said.refusal.as_deref(), said.choose, said.action), (Some("Choose a model to send it."), true, None));
    }

    #[test]
    fn what_the_box_didnt_say_is_drawn_as_running() {
        let mut gone = state(json!({ "model": { "providerID": "openai", "id": "gpt-4" }, "runs": false, "missing": "gone", "refusal": "gpt-4 is no longer available: choose another model.", "choose": true, "action": { "do": "choose", "label": "Choose a Model", "help": "Choose another model" } }));
        assert!(gone.choose);
        gone.unsaid();
        assert_eq!((gone.runs, gone.choose, gone.refusal, gone.action), (true, false, None, None));
    }

    fn offered(value: Value) -> Offered {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_side_that_cant_say_keeps_what_it_said_before() {
        let engine = json!({ "providerID": "anthropic", "id": "opus", "name": "Opus", "side": "engine", "efforts": ["low", "high"], "aliases": [] });
        let agents = json!({ "providerID": "claude-code", "id": "opus", "name": "Claude Code · Opus", "side": "agents", "efforts": [], "aliases": ["default"] });
        let before = offered(json!({ "models": [engine, agents], "known": { "engine": true, "agents": true }, "listing": ["codex"] }));
        // The bridge started again: its side isn't said now; what it said before stays.
        let now = offered(json!({ "models": [engine], "known": { "engine": true, "agents": false } })).keeping(Some(&before));
        assert_eq!(now.models.iter().map(|model| model.provider_id.as_str()).collect::<Vec<_>>(), ["anthropic", "claude-code"]);
        assert_eq!((now.known.agents, now.listing.clone()), (true, vec!["codex".to_owned()]));
        assert!(now.is_whole());
        assert_eq!(now.models[0].efforts, ["low", "high"]);
        // The engine's, the same, ahead.
        let now = offered(json!({ "models": [agents], "known": { "engine": false, "agents": true } })).keeping(Some(&before));
        assert_eq!(now.models.iter().map(|model| model.side).collect::<Vec<_>>(), [Side::Engine, Side::Agents]);
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
