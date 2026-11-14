//! A box's settings, as each computer keeps its own (PROTOCOL.md): its engine's settings document
//! (`kuvo/config`, changed a path at a time), what approval it starts conversations with
//! (`kuvo/approval`), its sandbox (`kuvo/sandbox`) and the folders its agents may also write to
//! (`kuvo/sandbox/allowed`), its browser's settings (`kuvo/browser/settings`), and the usage panel's
//! settings shared by your computers, the usage notices among them
//! (`kuvo/agents/api/kuvo/usage/settings`). This reads and changes them; the box decides what each
//! means.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::client::BoxClient;
use crate::error::Result;
use crate::paths::segment;
use crate::transport::Request;

fn with_method(method: &str, path: impl Into<String>, body: Value) -> Request {
    Request { method: method.into(), path: path.into(), headers: Vec::new(), body: Some(body) }
}

// MARK: The engine's settings

/// The engine's settings document as the box serves it, read by path.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Config(pub Value);

impl Config {
    /// The value at `path` (`["agents", "title", "model"]`), if set.
    pub fn at(&self, path: &[&str]) -> Option<&Value> {
        path.iter().try_fold(&self.0, |value, key| value.get(key))
    }

    /// A model it names at `path` (`provider/model`), if set.
    pub fn model_at(&self, path: &[&str]) -> Option<String> {
        self.at(path).and_then(Value::as_str).map(str::to_owned)
    }
}

// MARK: Approval

/// Why Auto can't run on one side now.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Held {
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub why: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct AutoSide {
    #[serde(default)]
    pub held: Option<Held>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct AutoSides {
    #[serde(default)]
    pub engine: AutoSide,
    #[serde(default)]
    pub agents: AutoSide,
}

/// This computer's approval: whether Full Access was confirmed here, the mode a new conversation
/// starts with (the last picked here), whether Auto runs on each side, and whether your other
/// computers may start work here (a box that doesn't say: `None`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Approval {
    #[serde(default, rename = "fullAccess")]
    pub full_access: bool,
    /// `askFirst`, `acceptEdits`, `auto` or `fullAccess`.
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub auto: AutoSides,
    #[serde(default, rename = "otherComputers")]
    pub other_computers: Option<bool>,
}

// MARK: The sandbox

/// The sandbox on this computer, as the box checks it. There's no switch: it's on wherever it can
/// be, and says why not.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct Sandbox {
    #[serde(default)]
    pub on: bool,
    /// Why it's off, in the box's words, where it gives them.
    #[serde(default)]
    pub why: Option<String>,
    /// `kernel`, `namespaces`, `macos`, `engineMissing`, `checking`, `checkFailed`, `plugin`,
    /// `engineDown`, `waiting`.
    #[serde(default)]
    pub reason: Option<String>,
    /// `help`, `softwareUpdate`, `retry`, `fix`, `restartEngine`: a word for a client to map,
    /// which this one doesn't (its button's words are the box's to say, below).
    #[serde(default)]
    pub action: Option<String>,
    /// The box's route that does it (`POST kuvo/sandbox/check`).
    #[serde(default)]
    pub route: Option<String>,
    // BOX-NEEDED: the words of the button that does `action`, `actionLabel` in `GET kuvo/sandbox` (and `why` for every `reason`): KuvoClient's `SandboxNotice` words them in each client today; this draws a button only with the box's words and its `route`.
    #[serde(default, rename = "actionLabel")]
    pub action_label: Option<String>,
}

impl Sandbox {
    /// What its button sends, where the box words one and names its route: `(method, path)`.
    pub fn button(&self) -> Option<(String, String, String)> {
        let label = self.action_label.clone().filter(|label| !label.trim().is_empty())?;
        let (method, path) = self.route.as_deref()?.split_once(' ')?;
        Some((label, method.to_owned(), path.to_owned()))
    }
}

/// Whose a folder the sandbox also lets agents write to is.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AllowedOwner {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
}

/// A folder agents may also write to.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Allowed {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub owner: Option<AllowedOwner>,
    /// When it was given (ms).
    #[serde(default)]
    pub at: Option<f64>,
    /// The folder's gone since.
    #[serde(default)]
    pub gone: bool,
}

// MARK: The browser

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SearchEngine {
    pub id: String,
    pub title: String,
}

/// This computer's browser's settings.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BrowserSettings {
    #[serde(rename = "searchEngine")]
    pub search_engine: String,
    #[serde(default, rename = "searchEngines")]
    pub search_engines: Vec<SearchEngine>,
    #[serde(default, rename = "tidiesAgentTabs")]
    pub tidies_agent_tabs: bool,
    #[serde(default, rename = "offersToSave")]
    pub offers_to_save: bool,
    /// Sites it never offers to save a sign-in for.
    #[serde(default)]
    pub never: Vec<String>,
}

// MARK: Usage settings

/// Which usage notices are on, as your computers share them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, serde::Serialize)]
pub struct UsageNotices {
    #[serde(default, rename = "underTenPercent")]
    pub under_ten_percent: bool,
    #[serde(default, rename = "healthyToClose")]
    pub healthy_to_close: bool,
    #[serde(default, rename = "closeToRunningOut")]
    pub close_to_running_out: bool,
}

/// A provider whose usage notices can't be sent, in the box's words.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct NoticeAvailability {
    pub provider: String,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub message: String,
}

/// The usage settings this app draws: the notices, the version they're changed from, and the
/// providers that can't send them.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UsageSettings {
    pub notices: UsageNotices,
    /// The notices part's version (`None`: never set), sent back as what a change is based on.
    pub version: Option<String>,
    pub unavailable: Vec<NoticeAvailability>,
}

impl BoxClient {
    /// The engine's settings document.
    pub fn config(&self) -> Result<Config> {
        self.get::<Value>("kuvo/config").map(Config)
    }

    /// Sets one value at `path` (`None` removes it), from what was read there (`was`), so one
    /// changed meanwhile is refused (409) rather than overwritten. Answers the whole document.
    pub fn set_config(&self, path: &[&str], value: Option<&str>, was: Option<&str>) -> Result<Config> {
        let change = json!({ "path": path, "value": value, "was": was });
        self.value::<Value>(&with_method("PATCH", "kuvo/config", json!({ "changes": [change] }))).map(Config)
    }

    pub fn approval(&self) -> Result<Approval> {
        self.get("kuvo/approval")
    }

    /// Whether your other computers may start work here.
    pub fn set_other_computers(&self, allowed: bool) -> Result<Approval> {
        self.value(&with_method("PATCH", "kuvo/approval", json!({ "otherComputers": allowed })))
    }

    pub fn sandbox(&self) -> Result<Sandbox> {
        self.get("kuvo/sandbox")
    }

    /// Does what the sandbox's button says, at the route the box named for it, then reads it again.
    pub fn sandbox_action(&self, method: &str, path: &str) -> Result<Sandbox> {
        self.done(&with_method(method, path, json!({})))?;
        self.sandbox()
    }

    pub fn also_allowed(&self) -> Result<Vec<Allowed>> {
        #[derive(Deserialize)]
        struct Answer {
            #[serde(default, deserialize_with = "crate::accounts::readable")]
            allowed: Vec<Allowed>,
        }
        self.get::<Answer>("kuvo/sandbox/allowed").map(|answer| answer.allowed)
    }

    pub fn remove_allowed(&self, id: &str) -> Result<()> {
        self.done(&Request::delete(format!("kuvo/sandbox/allowed/{}", segment(id))))
    }

    pub fn browser_settings(&self) -> Result<BrowserSettings> {
        self.get("kuvo/browser/settings")
    }

    /// Changes some of the browser's settings (`{"searchEngine": "kagi"}`), answered whole.
    pub fn set_browser_settings(&self, changes: Value) -> Result<BrowserSettings> {
        self.value(&with_method("PATCH", "kuvo/browser/settings", changes))
    }

    pub fn usage_settings(&self) -> Result<UsageSettings> {
        let answer: Value = self.get("kuvo/agents/api/kuvo/usage/settings")?;
        Ok(usage_settings(&answer))
    }

    /// Turns the usage notices on and off, as one part, from the version read.
    pub fn set_usage_notices(&self, notices: UsageNotices, based: Option<&str>) -> Result<UsageSettings> {
        let body = json!({ "notifications": notices, "based": { "notifications": based } });
        let answer: Value = self.value(&with_method("PUT", "kuvo/agents/api/kuvo/usage/settings", body))?;
        Ok(usage_settings(&answer))
    }
}

fn usage_settings(answer: &Value) -> UsageSettings {
    let data = answer.get("data").unwrap_or(answer);
    let notices = data.pointer("/settings/notifications").and_then(|part| serde_json::from_value(part.clone()).ok()).unwrap_or_default();
    let version = data.pointer("/versions/notifications").and_then(Value::as_str).map(str::to_owned);
    let unavailable = data
        .get("notificationAvailability")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|item| serde_json::from_value::<NoticeAvailability>(item.clone()).ok()).filter(|item| !item.available).collect())
        .unwrap_or_default();
    UsageSettings { notices, version, unavailable }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_settings_read_the_notices_part_and_its_version() {
        let read = usage_settings(&json!({ "data": { "settings": { "notifications": { "underTenPercent": true } }, "versions": { "notifications": "3/mac" }, "notificationAvailability": [{ "provider": "devin", "available": false, "message": "Devin doesn’t say its limits." }] } }));
        assert!(read.notices.under_ten_percent && !read.notices.close_to_running_out);
        assert_eq!(read.version.as_deref(), Some("3/mac"));
        assert_eq!(read.unavailable.len(), 1);
        let never_set = usage_settings(&json!({ "data": { "settings": {}, "versions": {} } }));
        assert_eq!(never_set, UsageSettings::default());
    }

    #[test]
    fn a_config_is_read_by_path() {
        let config = Config(json!({ "model": "anthropic/claude-sonnet-4-5", "agents": { "title": { "model": "openai/gpt-5-mini" } } }));
        assert_eq!(config.model_at(&["agents", "title", "model"]).as_deref(), Some("openai/gpt-5-mini"));
        assert_eq!(config.model_at(&["subagent_model"]), None);
    }
}
