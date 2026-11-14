//! What the stand-in box says of its accounts and settings, and how it signs in: the engine's plans
//! and providers and the coding agents' accounts (`…/api/integration`), the ways in the box offers
//! for each (`kuvo/sign-in/accounts`, `…/methods`, shaped as `Vectors/sign-in.json` records them),
//! sign-ins that go on until a test says how they end (or, in the app's `--stand-in`, finish after a
//! few asks), keys, installs, Disconnect and Sign Out; and this computer's settings (`kuvo/config`,
//! `kuvo/approval`, `kuvo/sandbox`, `kuvo/sandbox/allowed`, `kuvo/browser/settings`, the usage
//! settings). All made up: no key is real, and every page is at `.invalid`, which never resolves.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

/// How a sign-in under way stands.
#[derive(Clone, Debug)]
struct Attempt {
    agents: bool,
    account: String,
    status: Value,
    asked: u32,
}

/// The stand-in's accounts and settings.
#[derive(Clone, Debug)]
pub struct Settings {
    engine: Vec<Value>,
    agents: Vec<Value>,
    ways: BTreeMap<String, Value>,
    ended: Vec<String>,
    attempts: BTreeMap<String, Attempt>,
    next: u32,
    /// The bridge isn't running (`503`).
    pub agents_down: bool,
    /// It can't say just now which sign-ins ended (`503`).
    pub ended_unreadable: bool,
    /// Sign-ins finish by themselves after a few asks (the app's `--stand-in`).
    pub finishes: bool,
    config: Value,
    approval: Value,
    sandbox: Value,
    allowed: Vec<Value>,
    browser: Value,
    usage: Value,
    usage_version: u32,
}

/// What a sign-in under way comes to, when a test says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    Complete,
    Failed,
    Expired,
}

fn integration(id: &str, name: &str, connections: Value, metadata: Value) -> Value {
    json!({ "id": id, "name": name, "methods": [], "connections": connections, "metadata": metadata })
}

fn ways(methods: Value, environment: Value, hint: &str) -> Value {
    json!({ "methods": methods, "environment": environment, "hint": hint })
}

fn signed_in(label: &str, method: &str) -> Value {
    json!([{ "type": "credential", "id": format!("cred_{}", label.len()), "method": method, "label": label }])
}

impl Default for Settings {
    fn default() -> Settings {
        let engine = vec![
            integration("github-copilot", "GitHub Copilot", signed_in("sam-codes", "oauth"), json!({})),
            integration("openrouter", "OpenRouter", signed_in("Team key", "key"), json!({})),
            integration("gitlab", "GitLab Duo", signed_in("sam", "oauth"), json!({})),
            integration("anthropic", "Anthropic", json!([]), json!({})),
            integration("openai", "OpenAI", json!([]), json!({})),
            integration("amazon-bedrock", "Amazon Bedrock", json!([]), json!({})),
            integration("deepseek", "DeepSeek", json!([]), json!({})),
            integration("groq", "Groq", json!([]), json!({})),
            integration("mistral", "Mistral", json!([]), json!({})),
            // Its page turns every sign-in down (`access_denied`), for what a failure shows.
            integration("poe", "Poe", json!([]), json!({})),
            // A web search service and an MCP server's sign-in, which the engine lists too: the box
            // doesn't yet say they aren't providers (BOX-NEEDED in `kuvo_box/src/accounts.rs`).
            integration("tavily", "Tavily", json!([]), json!({})),
            integration("linear", "Linear", json!([]), json!({ "source": "mcp" })),
        ];
        let agents = vec![
            integration("claude-code", "Claude Code", signed_in("sam@example.com", "oauth"), json!({ "agent": "claude", "installed": true, "version": "2.4.1", "remoteSignIn": true })),
            integration("claude-code@w0rk1a2b", "Claude Code · Work", signed_in("sam@studio.example", "oauth"), json!({ "agent": "claude", "installed": true, "version": "2.4.1", "accountID": "w0rk1a2b", "accountLabel": "Work", "remoteSignIn": true })),
            integration("codex-cli", "Codex", signed_in("sam@example.com", "oauth"), json!({ "agent": "codex", "installed": true, "version": "0.98.0", "signsOut": true, "remoteSignIn": true })),
            integration("antigravity", "Antigravity", signed_in("sam@example.com", "oauth"), json!({ "agent": "antigravity", "installed": true, "signInEnded": true, "remoteSignIn": true })),
            integration("cursor", "Cursor", json!([]), json!({ "agent": "cursor", "installed": true, "version": "1.9.0", "remoteSignIn": true })),
            integration("grok-cli", "Grok", json!([]), json!({ "agent": "grok", "installed": false, "install": "npm install -g @stand-in/grok-cli", "remoteSignIn": true })),
        ];
        let mut all = BTreeMap::new();
        let browser_sign_in = json!([{ "type": "oauth", "id": "browser", "label": "Sign in" }]);
        for agent in ["claude-code", "claude-code@w0rk1a2b", "antigravity", "grok-cli"] {
            all.insert(format!("agents:{agent}"), ways(browser_sign_in.clone(), json!([]), "Sign in"));
        }
        for agent in ["codex-cli", "cursor"] {
            all.insert(format!("agents:{agent}"), ways(json!([{ "type": "oauth", "id": "browser", "label": "Sign in" }, { "type": "key", "label": "API key" }]), json!([]), "Sign in"));
        }
        let region = json!([{ "key": "region", "type": "text", "label": "Region", "default": "us-east-1" }]);
        all.insert("github-copilot".into(), ways(json!([{ "type": "oauth", "id": "device", "label": "Sign in with GitHub" }]), json!([]), "Sign in with GitHub"));
        all.insert("openrouter".into(), ways(json!([{ "type": "key", "label": "API key" }]), json!([]), "API key"));
        all.insert("gitlab".into(), ways(json!([{ "type": "oauth", "id": "browser", "label": "Login with GitLab" }]), json!([]), "Sign in with GitLab"));
        all.insert(
            "anthropic".into(),
            ways(json!([{ "type": "oauth", "id": "max", "label": "Claude Pro/Max" }, { "type": "oauth", "id": "console", "label": "Create an API Key" }, { "type": "key", "label": "Manually enter API Key" }, { "type": "oauth", "id": "legacy-device", "label": "Device code (legacy)", "legacy": true }]), json!(["ANTHROPIC_API_KEY"]), "Claude Pro/Max"),
        );
        all.insert("openai".into(), ways(json!([{ "type": "key", "label": "Use an API key" }]), json!(["OPENAI_API_KEY"]), "API key"));
        all.insert("amazon-bedrock".into(), ways(json!([{ "type": "external", "id": "aws", "label": "AWS credentials on this computer", "form": region }, { "type": "key", "label": "Bedrock API key", "form": region }]), json!(["AWS_ACCESS_KEY_ID", "AWS_PROFILE"]), "API key"));
        all.insert("deepseek".into(), ways(json!([{ "type": "key", "label": "Use an API key" }]), json!(["DEEPSEEK_API_KEY"]), "API key"));
        all.insert("groq".into(), ways(json!([]), json!(["GROQ_API_KEY"]), "Connect"));
        all.insert("mistral".into(), ways(json!([{ "type": "key", "label": "Use an API key" }]), json!(["MISTRAL_API_KEY"]), "API key"));
        all.insert("poe".into(), ways(json!([{ "type": "oauth", "id": "device", "label": "Sign in" }]), json!([]), "Sign in"));
        all.insert("tavily".into(), ways(json!([{ "type": "key", "label": "API key" }]), json!([]), "API key"));
        Settings {
            engine,
            agents,
            ways: all,
            ended: vec!["gitlab".into()],
            attempts: BTreeMap::new(),
            next: 1,
            agents_down: false,
            ended_unreadable: false,
            finishes: false,
            config: json!({ "$schema": "https://opencode.ai/config.json", "model": "anthropic/claude-sonnet-5-5", "agents": { "title": { "model": "google/gemini-3-pro" } } }),
            approval: json!({ "fullAccess": false, "default": "auto", "auto": { "engine": {}, "agents": {} }, "otherComputers": false }),
            sandbox: json!({ "on": true, "able": true, "agents": true }),
            allowed: vec![
                json!({ "id": "alw_1", "project": "/Users/sam/Projects/storefront", "kind": "write", "path": "/Users/sam/Library/Caches/storefront-build", "at": 1_794_000_000_000.0_f64, "owner": { "kind": "project", "name": "storefront" } }),
                json!({ "id": "alw_2", "kind": "write", "path": "/Users/sam/Documents/Release Notes", "at": 1_793_500_000_000.0_f64, "owner": { "kind": "bot", "id": "bot_release", "name": "Release Captain" } }),
            ],
            browser: json!({ "searchEngine": "duckDuckGo", "searchEngines": [{ "id": "google", "title": "Google" }, { "id": "duckDuckGo", "title": "DuckDuckGo" }, { "id": "bing", "title": "Bing" }, { "id": "brave", "title": "Brave Search" }, { "id": "kagi", "title": "Kagi" }, { "id": "ecosia", "title": "Ecosia" }], "tidiesAgentTabs": true, "offersToSave": true, "never": ["bank.example", "intranet.example"] }),
            usage: json!({ "underTenPercent": true, "healthyToClose": false, "closeToRunningOut": true }),
            usage_version: 3,
        }
    }
}

fn path_part(part: &str) -> String {
    super::percent_decode(part)
}

impl Settings {
    /// Every sign-in under way ends so.
    pub fn end_sign_ins(&mut self, ending: Ending, message: Option<&str>) {
        let attempts: Vec<String> = self.attempts.iter().filter(|(_, attempt)| attempt.status["status"] == "pending").map(|(id, _)| id.clone()).collect();
        for id in attempts {
            self.end(&id, ending, message);
        }
    }

    /// Forgets every sign-in under way, as an engine that started over does (its status: `404`).
    pub fn forget_sign_ins(&mut self) {
        self.attempts.clear();
    }

    /// From now on, a sign-in's status carries this device code, as the bridge says it once its
    /// page is ready.
    pub fn set_user_code(&mut self, code: &str) {
        for attempt in self.attempts.values_mut() {
            attempt.status["userCode"] = json!(code);
        }
    }

    fn end(&mut self, id: &str, ending: Ending, message: Option<&str>) {
        let Some(attempt) = self.attempts.get_mut(id) else { return };
        let (agents, account) = (attempt.agents, attempt.account.clone());
        attempt.status = match ending {
            Ending::Complete => json!({ "status": "complete" }),
            Ending::Failed => json!({ "status": "failed", "message": message, "failure": failure(message) }),
            Ending::Expired => json!({ "status": "expired", "failure": "The sign-in timed out. Try again." }),
        };
        if ending == Ending::Complete {
            self.connect(agents, &account, "oauth", "Signed in");
        }
    }

    fn list(&mut self, agents: bool) -> &mut Vec<Value> {
        if agents { &mut self.agents } else { &mut self.engine }
    }

    fn connect(&mut self, agents: bool, account: &str, method: &str, label: &str) {
        if let Some(found) = self.list(agents).iter_mut().find(|each| each["id"] == account) {
            found["connections"] = json!([{ "type": "credential", "id": "cred_new", "method": method, "label": label }]);
            if let Some(metadata) = found["metadata"].as_object_mut() {
                metadata.remove("signInEnded");
            }
        }
        self.ended.retain(|ended| ended != account);
    }

    fn ways_of(&self, agents: bool, account: &str) -> Option<Value> {
        let key = if agents { format!("agents:{account}") } else { account.to_owned() };
        self.ways.get(&key).cloned()
    }

    /// Its answer to `method route` (`query`: a query value by name), if it's one of these routes.
    pub fn answer(&mut self, method: &str, route: &str, query: &dyn Fn(&str) -> Option<String>, body: &Value) -> Option<(u16, Value)> {
        let segments: Vec<&str> = route.split('/').collect();
        let agents_side = route.starts_with("kuvo/agents/api/");
        let api: Vec<&str> = if agents_side { segments[3..].to_vec() } else if route.starts_with("api/") { segments[1..].to_vec() } else { Vec::new() };
        if agents_side && self.agents_down && api.first() == Some(&"integration") {
            return Some((503, json!({ "message": "The coding agents aren’t running." })));
        }
        if !api.is_empty()
            && let Some(answer) = self.integration_answer(method, agents_side, &api, body)
        {
            return Some(answer);
        }
        let answer = match (method, segments.as_slice()) {
            ("GET", ["kuvo", "sign-in", "accounts"]) => {
                let agents = query("agents").is_some();
                if agents && self.agents_down {
                    return Some((503, json!({ "message": "The coding agents aren’t running." })));
                }
                let list = if agents { &self.agents } else { &self.engine };
                let accounts: Vec<Value> = list
                    .iter()
                    .filter_map(|each| {
                        let id = each["id"].as_str()?;
                        let mut ways = self.ways_of(agents, id).unwrap_or_else(|| ways(json!([]), json!([]), "Connect"));
                        ways["id"] = json!(id);
                        Some(ways)
                    })
                    .collect();
                (200, json!({ "accounts": accounts }))
            }
            ("GET", ["kuvo", "sign-in", "methods"]) => {
                let account = query("integration").unwrap_or_default();
                match self.ways_of(query("agents").is_some(), &account) {
                    Some(ways) => (200, ways),
                    None => (404, json!({ "message": "There’s no such account here." })),
                }
            }
            ("GET", ["kuvo", "sign-in", "status"]) => {
                let attempt = query("attempt").unwrap_or_default();
                let Some(found) = self.attempts.get_mut(&attempt) else { return Some((404, json!({ "message": "That sign-in isn’t known here." }))) };
                found.asked += 1;
                if self.finishes && found.asked >= 3 && found.status["status"] == "pending" {
                    self.end(&attempt, Ending::Complete, None);
                }
                (200, self.attempts[&attempt].status.clone())
            }
            ("GET", ["kuvo", "accounts", "ended"]) if self.ended_unreadable => (503, json!({ "message": "The engine can’t say which sign-in each plan uses just now." })),
            ("GET", ["kuvo", "accounts", "ended"]) => (200, json!({ "providers": self.ended })),
            ("POST", ["kuvo", "accounts", provider, "forget"]) => {
                let provider = path_part(provider);
                match self.engine.iter_mut().find(|each| each["id"] == provider.as_str()) {
                    Some(found) => {
                        found["connections"] = json!([]);
                        self.ended.retain(|ended| *ended != provider);
                        (200, json!({}))
                    }
                    None => (404, json!({ "message": "That isn’t a plan here." })),
                }
            }
            ("GET", ["kuvo", "config"]) => (200, self.config.clone()),
            ("PATCH", ["kuvo", "config"]) => {
                for change in body["changes"].as_array().cloned().unwrap_or_default() {
                    let path: Vec<String> = change["path"].as_array().map(|parts| parts.iter().filter_map(|part| part.as_str().map(str::to_owned)).collect()).unwrap_or_default();
                    let now = path.iter().try_fold(&self.config, |value, key| value.get(key)).cloned().unwrap_or(Value::Null);
                    if change.get("was").is_some() && change["was"] != now {
                        return Some((409, json!({ "message": "This setting changed on its computer since. Read it again." })));
                    }
                    set_at(&mut self.config, &path, change["value"].clone());
                }
                (200, self.config.clone())
            }
            ("GET", ["kuvo", "approval"]) => (200, self.approval.clone()),
            ("PATCH", ["kuvo", "approval"]) => match body.get("otherComputers").and_then(Value::as_bool) {
                Some(allowed) => {
                    self.approval["otherComputers"] = json!(allowed);
                    (200, self.approval.clone())
                }
                None => (400, json!({ "message": "Say otherComputers as true or false." })),
            },
            ("GET", ["kuvo", "sandbox"]) => (200, self.sandbox.clone()),
            ("POST", ["kuvo", "sandbox", "check"]) => (200, json!({})),
            ("GET", ["kuvo", "sandbox", "allowed"]) => (200, json!({ "allowed": self.allowed })),
            ("DELETE", ["kuvo", "sandbox", "allowed", id]) => {
                let before = self.allowed.len();
                self.allowed.retain(|rule| rule["id"] != *id);
                if self.allowed.len() == before { (404, json!({ "message": "That folder isn’t allowed here." })) } else { (200, json!({})) }
            }
            ("GET", ["kuvo", "browser", "settings"]) => (200, self.browser.clone()),
            ("PATCH", ["kuvo", "browser", "settings"]) => {
                if let Some(engine) = body.get("searchEngine").and_then(Value::as_str) {
                    let known = self.browser["searchEngines"].as_array().is_some_and(|engines| engines.iter().any(|each| each["id"] == engine));
                    if !known {
                        return Some((400, json!({ "message": "That isn’t a search engine the browser knows." })));
                    }
                }
                for key in ["searchEngine", "tidiesAgentTabs", "offersToSave", "never"] {
                    if let Some(value) = body.get(key) {
                        self.browser[key] = value.clone();
                    }
                }
                (200, self.browser.clone())
            }
            ("GET", ["kuvo", "agents", "api", "kuvo", "usage", "settings"]) => (200, self.usage_answer(&[])),
            ("PUT", ["kuvo", "agents", "api", "kuvo", "usage", "settings"]) => {
                let based = body.pointer("/based/notifications").and_then(Value::as_str).map(str::to_owned);
                if based.as_deref() != Some(self.usage_version().as_str()) {
                    return Some((200, self.usage_answer(&["notifications"])));
                }
                if let Some(part) = body.get("notifications") {
                    self.usage = part.clone();
                    self.usage_version += 1;
                }
                (200, self.usage_answer(&[]))
            }
            _ => return None,
        };
        Some(answer)
    }

    pub fn set_sandbox(&mut self, sandbox: Value) {
        self.sandbox = sandbox;
    }

    pub fn set_config(&mut self, path: &[&str], value: Value) {
        let path: Vec<String> = path.iter().map(|part| (*part).to_owned()).collect();
        set_at(&mut self.config, &path, value);
    }

    fn usage_version(&self) -> String {
        format!("{}/mac", self.usage_version)
    }

    fn usage_answer(&self, stale: &[&str]) -> Value {
        json!({ "data": {
            "settings": { "notifications": self.usage },
            "versions": { "notifications": self.usage_version() },
            "imported": true,
            "stale": stale,
            "notificationAvailability": [{ "provider": "devin", "available": false, "message": "Devin doesn’t share its limits, so it can’t warn you before they run out." }],
        } })
    }

    fn integration_answer(&mut self, method: &str, agents: bool, api: &[&str], body: &Value) -> Option<(u16, Value)> {
        let account = api.get(1).map(|part| path_part(part)).unwrap_or_default();
        let known = |this: &Self| (if agents { &this.agents } else { &this.engine }).iter().any(|each| each["id"] == account.as_str());
        let answer = match (method, api) {
            ("GET", ["integration"]) => (200, json!({ "data": if agents { &self.agents } else { &self.engine } })),
            ("POST", ["integration", _, "connect", "oauth"]) if known(self) => {
                let id = format!("att_{}", self.next);
                self.next += 1;
                let method_id = body["methodID"].as_str().unwrap_or_default();
                // A device sign-in's code as `userCode`, the engine's too: what the box is asked to
                // say (BOX-NEEDED in `settings/sign_in.rs`); the bridge says it already.
                let device = method_id == "device";
                let accepts_code = agents && account.starts_with("claude-code");
                let attempt = json!({
                    "attemptID": id, "url": format!("https://sign-in.stand-in.invalid/{account}/{method_id}"),
                    "instructions": if device { "Enter the code on the page." } else { "" },
                    "mode": "auto", "acceptsCode": accepts_code,
                    "userCode": if device { Some("WDJB-MJHT") } else { None },
                    "time": { "created": 0, "expires": 900_000 },
                });
                let status = if account == "poe" {
                    json!({ "status": "failed", "message": "access_denied", "failure": failure(Some("access_denied")) })
                } else {
                    json!({ "status": "pending" })
                };
                self.attempts.insert(id, Attempt { agents, account: account.clone(), status, asked: 0 });
                (200, json!({ "data": attempt }))
            }
            ("POST", ["integration", _, "connect", "oauth", attempt, "complete"]) => {
                let attempt = path_part(attempt);
                if !self.attempts.contains_key(&attempt) {
                    return Some((404, json!({ "message": "That sign-in isn’t known here." })));
                }
                if body["code"].as_str().is_none_or(|code| code.trim().is_empty() || code.contains("wrong")) {
                    return Some((400, json!({ "message": "That code wasn’t taken. Paste the whole code the page gave." })));
                }
                self.end(&attempt, Ending::Complete, None);
                (200, json!({ "data": true }))
            }
            ("DELETE", ["integration", _, "connect", "oauth", attempt]) => {
                self.attempts.remove(&path_part(attempt));
                (200, json!({ "data": true }))
            }
            ("POST", ["integration", _, "connect", "key"]) if known(self) => {
                let key = body["key"].as_str().unwrap_or_default();
                if !key.starts_with("sk-") {
                    return Some((400, json!({ "message": "That key wasn’t accepted (401 Unauthorized)." })));
                }
                self.connect(agents, &account, "key", "API key");
                (200, json!({ "data": true }))
            }
            ("POST", ["integration", _, "connect", "external"]) if known(self) => {
                self.connect(agents, &account, "external", "AWS credentials");
                (200, json!({ "data": true }))
            }
            ("POST", ["integration", _, "install"]) if agents && known(self) => {
                if let Some(found) = self.agents.iter_mut().find(|each| each["id"] == account.as_str()) {
                    found["metadata"]["installed"] = json!(true);
                    found["metadata"]["version"] = json!("1.2.0");
                }
                (200, json!({ "data": { "installed": true, "version": "1.2.0" } }))
            }
            ("POST", ["integration", _, "disconnect"]) if agents && known(self) => {
                if let Some(found) = self.agents.iter_mut().find(|each| each["id"] == account.as_str()) {
                    found["connections"] = json!([]);
                }
                (200, json!({ "data": true }))
            }
            ("DELETE", ["kuvo", "accounts", _]) if agents => {
                let account = api.get(2).map(|part| path_part(part)).unwrap_or_default();
                self.agents.retain(|each| each["id"] != account.as_str());
                (200, json!({ "data": true }))
            }
            ("GET" | "POST" | "DELETE", ["integration", ..]) => (404, json!({ "message": "There’s no such account here." })),
            _ => return None,
        };
        Some(answer)
    }
}

/// What the box says of a failed sign-in, as `Vectors/sign-in.json` words the cases used here.
fn failure(message: Option<&str>) -> String {
    match message {
        Some(message) if message.contains("access_denied") => "The sign-in was turned down on its page. Try again to sign in.".into(),
        Some(message) if !message.trim().is_empty() => message.to_owned(),
        _ => "Signing in didn’t work.".into(),
    }
}

/// Sets `value` at `path`, making the levels that aren't there; `null` removes it.
fn set_at(document: &mut Value, path: &[String], value: Value) {
    let Some((last, parents)) = path.split_last() else { return };
    let mut at = document;
    for key in parents {
        if !at.get(key).is_some_and(Value::is_object) {
            at[key.as_str()] = Value::Object(Map::new());
        }
        at = &mut at[key.as_str()];
    }
    if value.is_null() {
        if let Some(object) = at.as_object_mut() {
            object.remove(last);
        }
    } else {
        at[last.as_str()] = value;
    }
}
