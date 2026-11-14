//! Accounts and signing in (PROTOCOL.md, "Signing in" and the coding agents' accounts): the
//! engine's plans and providers (`api/integration`) and the coding agents' accounts
//! (`kuvo/agents/api/integration`), with the ways in, their order and their words as the box says
//! them (`kuvo/sign-in/accounts`, `kuvo/sign-in/methods`), how a sign-in goes
//! (`kuvo/sign-in/status`, with what to say when it didn't work), and signing in and out through the
//! engine's and the bridge's own routes. The engine does the signing in; nothing here reimplements
//! it, decides a way in, or words a failure.
//!
//! Never read here: a key or a sign-in's secret (`api/credential` lists them; this never asks it).

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::client::BoxClient;
use crate::error::{Error, Refusal, Result};
use crate::paths::{query_value, segment};
use crate::transport::Request;

/// Which side of the box an account lives on: the engine's plans and providers, or the coding
/// agents' bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Side {
    Engine,
    Agents,
}

impl Side {
    /// Where its `api/…` routes are.
    fn api(self) -> &'static str {
        match self {
            Side::Engine => "api",
            Side::Agents => "kuvo/agents/api",
        }
    }

    fn agents_query(self) -> &'static str {
        match self {
            Side::Engine => "",
            Side::Agents => "&agents=1",
        }
    }
}

/// A field a way in asks for besides its key (Amazon Bedrock's region), as the engine describes it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FormField {
    pub key: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub required: bool,
    /// `text`, `string`, `boolean`, …: this app draws text and on/off; any other kind is said to
    /// need Kuvo Code on the Mac or iPhone.
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub default: Option<Value>,
    #[serde(default)]
    pub placeholder: Option<String>,
}

impl FormField {
    /// Its name, as the engine gives it.
    pub fn name(&self) -> String {
        self.title.clone().or_else(|| self.label.clone()).unwrap_or_else(|| self.key.clone())
    }

    /// Whether this app can draw it: a text field or an on/off switch.
    pub fn drawable(&self) -> bool {
        matches!(self.kind.as_deref(), None | Some("text" | "string" | "boolean"))
    }

    pub fn is_switch(&self) -> bool {
        self.kind.as_deref() == Some("boolean")
    }
}

/// One way into an account, as the box offers it: its kind (`oauth`, `key`, `external`), the
/// engine's id for it, the button's words, what else it asks for, and whether it's offered apart.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Method {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub form: Vec<FormField>,
    #[serde(default)]
    pub legacy: bool,
}

/// An account's ways in, in the box's order, with the environment variables that sign in too and
/// the line its card names under its name.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct Ways {
    #[serde(default, deserialize_with = "crate::accounts::readable")]
    pub methods: Vec<Method>,
    #[serde(default)]
    pub environment: Vec<String>,
    #[serde(default)]
    pub hint: String,
}

impl Ways {
    /// The ways offered first, in order.
    pub fn primary(&self) -> impl Iterator<Item = &Method> {
        self.methods.iter().filter(|method| !method.legacy)
    }

    /// Those offered apart, after them ("Other ways to sign in").
    pub fn legacy(&self) -> impl Iterator<Item = &Method> {
        self.methods.iter().filter(|method| method.legacy)
    }
}

/// What an account is signed in with (a key, a sign-in, credentials on the computer, or a variable
/// in the shell), and how it stands, as the engine says. Never its secret.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Connection {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub label: Option<String>,
    /// `key`, `oauth` or `external`.
    #[serde(default)]
    pub method: Option<String>,
    /// The variable, for one from the shell's environment.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub status: Option<ConnectionStatus>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ConnectionStatus {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub message: String,
}

/// One account the engine or the coding agents' bridge lists (`…/api/integration`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Integration {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub metadata: Option<Value>,
}

impl Integration {
    pub fn connected(&self) -> bool {
        !self.connections.is_empty()
    }

    fn meta(&self, key: &str) -> Option<&Value> {
        self.metadata.as_ref().and_then(|metadata| metadata.get(key))
    }

    fn flag(&self, key: &str) -> bool {
        self.meta(key).and_then(Value::as_bool).unwrap_or(false)
    }

    /// A coding agent's program isn't installed on this computer (`metadata.installed: false`).
    pub fn needs_install(&self) -> bool {
        self.meta("installed").and_then(Value::as_bool) == Some(false)
    }

    /// The installer the bridge would run, as its maker gives it.
    pub fn install_command(&self) -> Option<&str> {
        self.meta("install").and_then(Value::as_str)
    }

    /// Its maker ended the sign-in (`metadata.signInEnded`).
    pub fn sign_in_ended(&self) -> bool {
        self.flag("signInEnded")
    }

    /// A coding agent that can be signed out of from here (`metadata.signsOut`).
    pub fn signs_out(&self) -> bool {
        self.flag("signsOut")
    }

    /// An account you added beside an agent's own sign-in (`metadata.accountID`).
    pub fn added(&self) -> bool {
        self.meta("accountID").and_then(Value::as_str).is_some()
    }

    /// The agent couldn't say just now whether it's signed in (`metadata.unchecked`).
    pub fn unchecked(&self) -> bool {
        self.flag("unchecked")
    }

    /// Its program's version, as the bridge reads it.
    pub fn version(&self) -> Option<&str> {
        self.meta("version").and_then(Value::as_str)
    }

    /// Which coding agent's (`claude`, `codex`…), as the bridge says.
    pub fn agent(&self) -> Option<&str> {
        self.meta("agent").and_then(Value::as_str)
    }
}

/// An account as Accounts draws it: the engine's or the bridge's listing, and the box's ways in.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountEntry {
    pub side: Side,
    pub integration: Integration,
    /// The box's ways in (`kuvo/sign-in/accounts`); empty: none to offer, so no Sign In.
    pub ways: Ways,
    /// The engine says its sign-in in use ended (`kuvo/accounts/ended`).
    pub ended: bool,
}

impl AccountEntry {
    /// Whether it can be signed in to from here.
    pub fn offers_sign_in(&self) -> bool {
        !self.ways.methods.is_empty()
    }

    /// Whether its sign-in ended, by the engine's word or the agent's.
    pub fn sign_in_ended(&self) -> bool {
        self.ended || self.integration.sign_in_ended()
    }
}

/// Every account on this box, as Accounts lists them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Accounts {
    /// The coding agents' accounts, in the bridge's order. Empty where its bridge isn't running
    /// (`agents_down` says why).
    pub agents: Vec<AccountEntry>,
    /// The engine's plans and providers, in its order, less those Accounts doesn't list.
    pub engine: Vec<AccountEntry>,
    /// Why the coding agents' bridge, or the engine, couldn't list its accounts just now (`503`).
    pub agents_down: Option<String>,
    pub engine_down: Option<String>,
    /// The box couldn't say which sign-ins ended just now (`503`): none is marked, and a client
    /// keeps what it last read.
    pub ended_unknown: bool,
}

/// A sign-in under way, as the engine or the bridge started it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Attempt {
    #[serde(rename = "attemptID")]
    pub id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub instructions: String,
    /// `auto`: it comes back by itself; `code`: you paste a code back.
    #[serde(default)]
    pub mode: String,
    /// It may end on a code to paste back instead (Claude Code's).
    #[serde(default, rename = "acceptsCode")]
    pub accepts_code: bool,
    /// A device code to enter on the page.
    #[serde(default, rename = "userCode")]
    pub user_code: Option<String>,
}

/// How a sign-in goes, as the box says (`kuvo/sign-in/status`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Status {
    /// `pending`, `complete`, `failed`, `expired`.
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default, rename = "userCode")]
    pub user_code: Option<String>,
    /// What to show once it `failed` or `expired`, in the box's words.
    #[serde(default)]
    pub failure: Option<String>,
}

impl Status {
    pub fn is_pending(&self) -> bool {
        self.status == "pending"
    }

    pub fn is_complete(&self) -> bool {
        self.status == "complete"
    }

    /// What went wrong, in the box's words (its engine's where the box gave none).
    pub fn failure_words(&self) -> Option<String> {
        matches!(self.status.as_str(), "failed" | "expired").then(|| self.failure.clone().or_else(|| self.message.clone()).unwrap_or_default())
    }
}

/// What installing a coding agent's program came to.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Installed {
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub version: Option<String>,
    /// Why not, in the installer's words.
    #[serde(default)]
    pub message: Option<String>,
}

/// A list's items this can read: one it can't is left out, not all of them.
pub(crate) fn readable<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned>(deserializer: D) -> std::result::Result<Vec<T>, D::Error> {
    let values = Vec::<Value>::deserialize(deserializer)?;
    Ok(values.into_iter().filter_map(|value| serde_json::from_value(value).ok()).collect())
}

/// The data an engine or bridge answer carries (`{data: …}`).
#[derive(Deserialize)]
struct Data<T> {
    data: T,
}

impl BoxClient {
    /// One side's accounts, with the box's ways in.
    fn side_accounts(&self, side: Side, ended: &[String]) -> Result<Vec<AccountEntry>> {
        let listed_here: Data<Vec<Value>> = self.get(&format!("{}/integration", side.api()))?;
        let integrations: Vec<Integration> = listed_here.data.into_iter().filter_map(|value| serde_json::from_value(value).ok()).collect();
        #[derive(Deserialize)]
        struct Entry {
            id: String,
            #[serde(flatten)]
            ways: Ways,
        }
        #[derive(Deserialize)]
        struct Answer {
            #[serde(default, deserialize_with = "readable")]
            accounts: Vec<Entry>,
        }
        let route = match side {
            Side::Engine => "kuvo/sign-in/accounts",
            Side::Agents => "kuvo/sign-in/accounts?agents=1",
        };
        let ways: Vec<Entry> = self.get::<Answer>(route).map(|answer| answer.accounts)?;
        // BOX-NEEDED: which of the engine's integrations are providers Accounts lists, `kind: "provider" | "search" | "agentDuplicate"` on each account in `GET kuvo/sign-in/accounts` (or the box leaving the rest out: web search services, MCP servers' sign-ins, the engine's own way to a plan a coding agent brings): until the box says, every account it lists is shown, none left out here.
        Ok(integrations
            .into_iter()
            .map(|integration| {
                let ways = ways.iter().find(|entry| entry.id == integration.id).map(|entry| entry.ways.clone()).unwrap_or_default();
                let ended = ended.contains(&integration.id);
                AccountEntry { side, integration, ways, ended }
            })
            .collect())
    }

    /// Every account on this box: the coding agents' (where their bridge runs) and the engine's.
    pub fn sign_in_accounts(&self) -> Result<Accounts> {
        #[derive(Deserialize)]
        struct Ended {
            #[serde(default)]
            providers: Vec<String>,
        }
        let (ended, ended_unknown) = match self.get::<Ended>("kuvo/accounts/ended") {
            Ok(ended) => (ended.providers, false),
            Err(Error::Refused(refusal)) if refusal.status == 503 => (Vec::new(), true),
            Err(error) => return Err(error),
        };
        // Either side not running (503) leaves its accounts out, saying why; the other's stay.
        let side = |side: Side| match self.side_accounts(side, &ended) {
            Ok(accounts) => Ok((accounts, None)),
            Err(Error::Refused(refusal)) if refusal.status == 503 => Ok((Vec::new(), Some(refusal.message))),
            Err(error) => Err(error),
        };
        let (engine, engine_down) = side(Side::Engine)?;
        let (agents, agents_down) = side(Side::Agents)?;
        Ok(Accounts { agents, engine, agents_down, engine_down, ended_unknown })
    }

    /// An account's ways in, as the box offers them now.
    pub fn sign_in_methods(&self, side: Side, account: &str) -> Result<Ways> {
        self.get(&format!("kuvo/sign-in/methods?integration={}{}", query_value(account), side.agents_query()))
    }

    /// Starts a sign-in in the browser (`oauth`), with what its form asked.
    pub fn start_sign_in(&self, side: Side, account: &str, method: &str, answer: Option<&Map<String, Value>>) -> Result<Attempt> {
        let mut body = json!({ "methodID": method });
        if let Some(answer) = answer.filter(|answer| !answer.is_empty()) {
            body["answer"] = Value::Object(answer.clone());
        }
        let data: Data<Attempt> = self.value(&Request::post(format!("{}/integration/{}/connect/oauth", side.api(), segment(account)), body))?;
        Ok(data.data)
    }

    /// How a sign-in goes, as the box says (the engine's status, with its failure in words).
    pub fn sign_in_status(&self, side: Side, account: &str, attempt: &str) -> Result<Status> {
        let wait = if self.streams() { "" } else { "&wait=20" };
        self.get(&format!("kuvo/sign-in/status?integration={}&attempt={}{}{wait}", query_value(account), query_value(attempt), side.agents_query()))
    }

    /// Hands the engine the code a sign-in's page gave.
    pub fn complete_sign_in(&self, side: Side, account: &str, attempt: &str, code: &str) -> Result<()> {
        self.done(&Request::post(format!("{}/integration/{}/connect/oauth/{}/complete", side.api(), segment(account), segment(attempt)), json!({ "code": code })))
    }

    /// Gives a sign-in up.
    pub fn cancel_sign_in(&self, side: Side, account: &str, attempt: &str) -> Result<()> {
        self.done(&Request::delete(format!("{}/integration/{}/connect/oauth/{}", side.api(), segment(account), segment(attempt))))
    }

    /// Signs in with a key, and what its form asked. The key goes to the engine and nowhere else.
    pub fn add_key(&self, side: Side, account: &str, key: &str, answer: Option<&Map<String, Value>>) -> Result<()> {
        let mut body = json!({ "key": key });
        if let Some(answer) = answer.filter(|answer| !answer.is_empty()) {
            body["answer"] = Value::Object(answer.clone());
        }
        self.done(&Request::post(format!("{}/integration/{}/connect/key", side.api(), segment(account)), body))
    }

    /// Signs in with credentials the computer has already (AWS's, gcloud's).
    pub fn use_external(&self, side: Side, account: &str, method: &str, answer: Option<&Map<String, Value>>) -> Result<()> {
        let mut body = json!({ "methodID": method });
        if let Some(answer) = answer.filter(|answer| !answer.is_empty()) {
            body["answer"] = Value::Object(answer.clone());
        }
        self.done(&Request::post(format!("{}/integration/{}/connect/external", side.api(), segment(account)), body))
    }

    /// Installs a coding agent's program on this computer, with its maker's installer.
    pub fn install_agent(&self, account: &str) -> Result<Installed> {
        let data: Data<Installed> = self.value(&Request::post(format!("kuvo/agents/api/integration/{}/install", segment(account)), json!({})))?;
        Ok(data.data)
    }

    /// Disconnect: this box's sign-ins and keys for one of the engine's plans or providers.
    pub fn forget_account(&self, account: &str) -> Result<()> {
        self.done(&Request::post(format!("kuvo/accounts/{}/forget", segment(account)), json!({})))
    }

    /// Signs a coding agent out, where it says it can be (`metadata.signsOut`).
    pub fn sign_out_agent(&self, account: &str) -> Result<()> {
        self.done(&Request::post(format!("kuvo/agents/api/integration/{}/disconnect", segment(account)), json!({})))
    }

    /// Removes an account you added beside an agent's own sign-in.
    pub fn remove_agent_account(&self, account: &str) -> Result<()> {
        self.done(&Request::delete(format!("kuvo/agents/api/kuvo/accounts/{}", segment(account))))
    }

    /// Sends `request`; anything but a success is the box's refusal.
    pub(crate) fn done(&self, request: &Request) -> Result<()> {
        let response = self.send(request)?;
        if response.is_success() { Ok(()) } else { Err(Error::Refused(Refusal::from_answer(response.status, &response.body))) }
    }
}

/// A refusal's words, for a card or a line under a field.
pub fn said(error: &Error) -> String {
    match error {
        Error::Refused(refusal) => refusal.message.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The box's ways in, read as `Vectors/sign-in.json` records them: each kind, its words and
    /// form, the legacy ones apart, and an account with none.
    #[test]
    fn ways_in_read_as_the_shared_vectors_say_them() {
        let vectors: Value = serde_json::from_str(include_str!("../../../protocol/vectors/sign-in.json")).unwrap();
        for case in vectors["methods"].as_array().unwrap() {
            let offered = &case["offered"];
            let ways: Ways = serde_json::from_value(offered.clone()).unwrap();
            assert_eq!(ways.methods.len(), offered["methods"].as_array().unwrap().len(), "{}", case["provider"]);
            assert_eq!(ways.hint, offered["hint"].as_str().unwrap());
            let legacy = offered["methods"].as_array().unwrap().iter().filter(|method| method["legacy"] == json!(true)).count();
            assert_eq!(ways.legacy().count(), legacy);
            assert_eq!(ways.primary().count() + legacy, ways.methods.len());
        }
    }

    #[test]
    fn a_failure_is_shown_in_the_boxs_words() {
        let vectors: Value = serde_json::from_str(include_str!("../../../protocol/vectors/sign-in.json")).unwrap();
        for case in vectors["failures"].as_array().unwrap() {
            let status: Status = serde_json::from_value(json!({ "status": case["status"], "message": case["message"], "failure": case["failure"] })).unwrap();
            assert_eq!(status.failure_words().as_deref(), case["failure"].as_str());
        }
        let pending: Status = serde_json::from_value(json!({ "status": "pending", "message": "Downloading…" })).unwrap();
        assert_eq!(pending.failure_words(), None);
    }
}
