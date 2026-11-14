//! A stand-in box, for running the app, its shots and its tests without a real one: a made-up Mac's
//! box with realistic sessions in a few projects and chats, conversations with tool steps and code,
//! one session at work, and enough history in one to page back through. It lives in this process, as
//! a [`Transport`] answering the routes the app uses the way a box answers them (its session list
//! and its events, the engine's messages and events, `typed`, `send`, the models), so the app's
//! client code runs as it would against a box. Nothing real is reached: no file, process or port.
//!
//! With [`Replies::Live`] (the app's `--stand-in`), a message sent gets an answer streamed back a
//! word at a time, as the engine streams one. Tests use [`Replies::Never`], so nothing happens on a
//! clock, and read what was sent with [`StandIn::seen`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, Read};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub use crate::time::now_ms;

use kuvo_box::Result;
use kuvo_box::transport::{Closer, Request, Response, Stream, Transport};
use serde_json::{Value, json};

/// Whether a message sent gets an answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Replies {
    /// Streamed back on a timer, as an engine would (the app run against the stand-in).
    Live,
    /// None: nothing happens by itself (tests and shots).
    Never,
}

/// A request the stand-in was sent.
#[derive(Clone, Debug, PartialEq)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
}

/// The stand-in box. Cheap to clone: clones share it.
#[derive(Clone)]
pub struct StandIn {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
    replies: Replies,
}

#[derive(Default)]
struct State {
    at: u64,
    sessions: BTreeMap<String, Value>,
    projects: BTreeMap<String, Value>,
    /// Each conversation's engine messages, oldest first.
    messages: HashMap<String, Vec<Value>>,
    running: HashSet<String>,
    models: HashMap<String, Value>,
    /// Open followed routes: the session list's and the engine's events, by an id of their own.
    lists: HashMap<u64, Sender<String>>,
    events: HashMap<u64, Sender<String>>,
    next: u64,
    seen: Vec<Seen>,
    /// Sends answered as an engine that's gone away answers them (`503`).
    sends_fail: bool,
    /// No model runs here: a new session starts on none.
    nothing_runs: bool,
    /// What it says of a session's model, where a test has said otherwise.
    model_states: HashMap<String, Value>,
    /// The coding agents' bridge can't say its models now (it's starting again).
    agents_unknown: bool,
    /// Its sessions' models can't be read now (`503`).
    models_fail: bool,
    /// What each conversation waits on you for, as the box words it (`kuvo/sessions/<id>/asks`).
    asks: HashMap<String, Vec<Value>>,
}

pub const NAME: &str = "Stand-in Mac";
const HOME: &str = "/Users/sam";


const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: f64 = 24.0 * HOUR;

impl StandIn {
    /// The stand-in with its sample sessions, as they'd be `now` (ms since 1970).
    pub fn new(replies: Replies) -> StandIn {
        StandIn::at(replies, now_ms())
    }

    pub fn at(replies: Replies, now: f64) -> StandIn {
        let stand_in = StandIn { inner: Arc::new(Inner { state: Mutex::new(State { at: 1, next: 1, ..State::default() }), replies }) };
        stand_in.fill(now);
        stand_in
    }

    /// An empty box: no projects, no sessions.
    pub fn empty(replies: Replies) -> StandIn {
        StandIn { inner: Arc::new(Inner { state: Mutex::new(State { at: 1, next: 1, ..State::default() }), replies }) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Every request it was sent, in order.
    pub fn seen(&self) -> Vec<Seen> {
        self.state().seen.clone()
    }

    /// Those it was sent to `route` (a path without its query).
    pub fn seen_at(&self, method: &str, route: &str) -> Vec<Seen> {
        self.seen().into_iter().filter(|seen| seen.method == method && seen.path.split('?').next() == Some(route)).collect()
    }

    /// A session's facts changed (as its box would say), and the list's followers hear it.
    pub fn set_facts(&self, session: &str, change: impl FnOnce(&mut Value)) {
        let mut state = self.state();
        if let Some(facts) = state.sessions.get_mut(session) {
            change(facts);
        }
        state.list_changed();
    }

    /// From now on, a message sent is answered as by an engine that isn't answering.
    pub fn fail_sends(&self) {
        self.state().sends_fail = true;
    }

    /// From now on, no model runs here (`kuvo/models/offered` says `starting: null`).
    pub fn nothing_runs(&self) {
        self.state().nothing_runs = true;
    }

    /// From now on, it says this of `session`'s model (`kuvo/sessions/models`); null leaves it out.
    pub fn set_model_state(&self, session: &str, state: Value) {
        self.state().model_states.insert(session.to_owned(), state);
    }

    /// Whether its sessions' models can be read (`kuvo/sessions/models` answers `503` while not).
    pub fn models_readable(&self, readable: bool) {
        self.state().models_fail = !readable;
    }

    /// Whether the coding agents' bridge can say its models (`known.agents`).
    pub fn agents_known(&self, known: bool) {
        self.state().agents_unknown = !known;
    }

    /// What `session` waits on you for, from now on (as the box words each ask).
    pub fn set_asks(&self, session: &str, asks: Vec<Value>) {
        self.state().asks.insert(session.to_owned(), asks);
    }

    /// An engine event, to those following the engine's events.
    pub fn emit(&self, kind: &str, data: Value) {
        self.state().emit(kind, data);
    }

    fn fill(&self, now: f64) {
        let mut state = self.state();
        let website = format!("{HOME}/Projects/website");
        let api = format!("{HOME}/Projects/api");
        let mobile = format!("{HOME}/Projects/mobile");
        let infra = format!("{HOME}/Projects/infra");
        let chats = format!("{HOME}/.kuvo-code/chats");
        state.projects.insert(website.clone(), json!({ "name": "Website", "updated": now - 2.0 * MINUTE }));
        state.projects.insert(api.clone(), json!({ "name": "API", "updated": now - 20.0 * MINUTE }));
        state.projects.insert(mobile.clone(), json!({ "name": "Mobile", "updated": now - 2.0 * DAY }));
        state.projects.insert(infra.clone(), json!({ "name": "Infra" }));

        let add = |state: &mut State, id: &str, folder: &str, title: &str, ago: f64, extra: Value| {
            let kind = if folder == chats { "chat" } else { "project" };
            let mut facts = json!({ "kind": kind, "directory": folder, "title": title, "created": now - ago - HOUR, "updated": now - ago });
            if kind == "project" {
                facts["project"] = json!(folder);
            }
            if let (Some(facts), Some(extra)) = (facts.as_object_mut(), extra.as_object()) {
                facts.extend(extra.clone());
            }
            state.sessions.insert(id.to_owned(), facts);
            state.models.insert(id.to_owned(), json!({ "providerID": "anthropic", "id": "claude-opus-5-5", "variant": "high" }));
        };
        add(&mut state, "ses_signup", &website, "Fix the sign-up form wiping on a taken email", 2.0 * MINUTE, json!({ "running": true }));
        add(&mut state, "ses_dark", &website, "Dark mode for the settings page", 2.0 * HOUR, json!({}));
        add(&mut state, "ses_cms", &website, "Move the blog to the new CMS", DAY, json!({ "asked": now - 3.0 * HOUR }));
        add(&mut state, "ses_lighthouse", &website, "Get the Lighthouse score above 90", 3.0 * DAY, json!({}));
        add(&mut state, "ses_limits", &api, "Rate limits per API key", 20.0 * MINUTE, json!({ "asked": now - 15.0 * MINUTE }));
        add(&mut state, "ses_webhook", &api, "Flaky webhook retry test", 5.0 * HOUR, json!({}));
        add(&mut state, "ses_push", &mobile, "Push notifications on Android 15", 2.0 * DAY, json!({}));
        add(&mut state, "ses_recipes", &chats, "Recipe ideas for the weekend", 4.0 * HOUR, json!({}));
        add(&mut state, "ses_lifetimes", &chats, "Explain Rust lifetimes with an example", 8.0 * DAY, json!({}));
        // A subagent's session: the lists show it nowhere.
        add(&mut state, "ses_sub", &website, "Check the other forms", MINUTE, json!({ "kind": "subagent", "parent": "ses_signup" }));
        state.models.insert("ses_recipes".into(), json!({ "providerID": "openai", "id": "gpt-6", "variant": "medium" }));
        state.running.insert("ses_signup".into());

        state.messages.insert("ses_signup".into(), signup(now));
        state.messages.insert("ses_limits".into(), limits(now));
        state.messages.insert("ses_lighthouse".into(), long_history(now));
        state.messages.insert("ses_recipes".into(), recipes(now));
        state.asks.insert("ses_cms".into(), vec![cms_question()]);
    }
}

/// A permission waiting in the rate limits' conversation: to install Redis's client.
pub fn redis_permission() -> Value {
    json!({
        "id": "per_redis", "kind": "permission", "session": "ses_limits", "title": "Allow running this command?",
        "message": null, "command": "npm install ioredis@5 --save", "files": [], "resources": ["npm install ioredis@5 --save"],
        "choices": [
            { "answer": "once", "title": "Allow Once", "named": null, "placeholder": null },
            { "answer": "always", "title": "Always Allow", "named": "npm install", "placeholder": null },
            { "answer": "reject", "title": "Don’t Allow", "named": null, "placeholder": null },
            { "answer": "instead", "title": "Tell It What to Do Instead…", "named": null, "placeholder": "Tell it what to do instead…" }
        ]
    })
}

/// The agent's question in the CMS move.
pub fn cms_question() -> Value {
    json!({
        "id": "frm_cms", "kind": "question", "session": "ses_cms", "title": "Question",
        "questions": [{
            "key": "q0", "title": "Old posts", "question": "The blog has 214 posts. Should the old URLs keep working once they move?",
            "options": [
                { "value": "redirect", "label": "Redirect them", "description": "301s from each old URL to its new one" },
                { "value": "keep", "label": "Keep the old URLs", "description": "the CMS serves them as they are" },
                { "value": "drop", "label": "Let them go", "description": null }
            ],
            "multiple": false, "custom": true, "required": true
        }]
    })
}

/// The messages of the session at work: a finished turn, then one under way.
fn signup(now: f64) -> Vec<Value> {
    let t = now - 30.0 * MINUTE;
    vec![
        user("msg_s1", t, "Users say the sign-up form gets completely wiped if the email is already taken. Can you look?", None),
        json!({ "type": "assistant", "id": "msg_s2", "time": { "created": t + 1000.0, "completed": t + 25_000.0 }, "agent": "build", "model": { "providerID": "anthropic", "id": "claude-opus-5-5" }, "finish": "stop", "content": [
            { "type": "reasoning", "text": "The form likely resets its state on any error from the server, not only on success.", "time": { "created": t + 1000.0, "completed": t + 3000.0 } },
            tool("call_1", "read", "completed", json!({ "filePath": "web/src/signup/Form.tsx" })),
            tool_with("call_2", "grep", "completed", json!({ "pattern": "reset\\(" }), json!({ "content": [{ "type": "text", "text": "Found 3 matches\nweb/src/signup/Form.tsx:\n  Line 48:     reset();\n  Line 71:   const { reset, setError } = useForm();\nweb/src/settings/Profile.tsx:\n  Line 33:     reset(profile);" }] })),
            { "type": "text", "text": "Found it. When the server answers **409** (the email is taken), the error path calls `reset()` before it shows the message, so every field is cleared:\n\n```tsx\n} catch (error) {\n  reset();\n  setError(error.message);\n}\n```\n\nMoving `reset()` into the success path keeps what was typed. Want me to do that, and put the error under the email field?" }
        ] }),
        json!({ "type": "idle", "id": "msg_s3", "time": { "created": t + 25_000.0 }, "outcome": "succeeded" }),
        user("msg_s4", t + 120_000.0, "Keep what they typed, and say which field is wrong", Some("/plan")),
        json!({ "type": "assistant", "id": "msg_s5", "time": { "created": t + 121_000.0 }, "agent": "build", "model": { "providerID": "anthropic", "id": "claude-opus-5-5" }, "content": [
            tool_with("call_3", "edit", "completed", json!({ "filePath": "web/src/signup/Form.tsx" }), json!({ "metadata": { "files": [{ "file": "web/src/signup/Form.tsx", "additions": 4, "deletions": 2, "status": "modified", "patch": SIGNUP_PATCH }] } })),
            tool_with("call_4", "shell", "completed", json!({ "command": "npm test -- signup" }), json!({ "content": [{ "type": "text", "text": test_output() }], "metadata": { "exit": 0 } })),
            { "type": "text", "text": "Moved the reset into the success path, and the 409 now sets the error on the email field. The sign-up tests pass; checking the lint" },
            tool("call_5", "shell", "running", json!({ "command": "npm run lint" }))
        ] }),
    ]
}

/// A conversation waiting on you.
fn limits(now: f64) -> Vec<Value> {
    let t = now - 40.0 * MINUTE;
    vec![
        user("msg_l1", t, "Add rate limits per API key: 100 requests a minute, with a header saying what's left.", None),
        json!({ "type": "assistant", "id": "msg_l2", "time": { "created": t + 1000.0, "completed": t + 40_000.0 }, "agent": "build", "finish": "stop", "content": [
            tool("call_l1", "read", "completed", json!({ "filePath": "api/src/middleware/auth.ts" })),
            tool("call_l2", "glob", "completed", json!({ "pattern": "api/src/**/*.ts" })),
            { "type": "text", "text": "There are two places this could live:\n\n1. **In the auth middleware**, where the key is already read. Simple, but each server counts on its own.\n2. **In Redis**, shared by every server, with a sliding window.\n\nYou run three servers behind the load balancer, so only the second gives a real 100 a minute. Should I add Redis for it?" }
        ] }),
        json!({ "type": "idle", "id": "msg_l3", "time": { "created": t + 40_000.0 }, "outcome": "succeeded" }),
    ]
}

fn recipes(now: f64) -> Vec<Value> {
    let t = now - 5.0 * HOUR;
    vec![
        user("msg_r1", t, "Three dinner ideas for Saturday, vegetarian, under an hour.", None),
        json!({ "type": "assistant", "id": "msg_r2", "time": { "created": t + 1000.0, "completed": t + 9000.0 }, "agent": "build", "finish": "stop", "content": [
            { "type": "text", "text": "- **Mushroom risotto** with lemon and thyme (45 min)\n- **Chickpea and spinach curry** with rice (35 min)\n- **Sheet-pan gnocchi** with peppers and feta (30 min)" }
        ] }),
        json!({ "type": "idle", "id": "msg_r3", "time": { "created": t + 9000.0 }, "outcome": "succeeded" }),
    ]
}

/// A long conversation, more than one page.
fn long_history(now: f64) -> Vec<Value> {
    let start = now - 4.0 * DAY;
    let audits = ["the images", "the fonts", "the scripts", "the CSS", "the caching", "the third-party tags"];
    let mut messages = Vec::new();
    for turn in 0..70 {
        let t = start + turn as f64 * 10.0 * MINUTE;
        let what = audits[turn % audits.len()];
        messages.push(user(&format!("msg_h{turn:03}a"), t, &format!("Look at {what} next (pass {}).", turn / audits.len() + 1), None));
        messages.push(json!({ "type": "assistant", "id": format!("msg_h{turn:03}b"), "time": { "created": t + 1000.0, "completed": t + 20_000.0 }, "agent": "build", "finish": "stop", "content": [
            { "type": "text", "text": format!("Checked {what}. The score went from {} to {}.", 60 + turn / 3, 61 + turn / 3) }
        ] }));
        messages.push(json!({ "type": "idle", "id": format!("msg_h{turn:03}c"), "time": { "created": t + 20_000.0 }, "outcome": "succeeded" }));
    }
    messages
}

fn user(id: &str, at: f64, words: &str, keyword: Option<&str>) -> Value {
    let mut parts = json!({ "words": words });
    if let Some(keyword) = keyword {
        parts["keyword"] = json!(keyword);
    }
    json!({ "type": "user", "id": id, "time": { "created": at }, "text": words, "metadata": { "kuvo": { "parts": parts } } })
}

fn tool(id: &str, name: &str, status: &str, input: Value) -> Value {
    json!({ "type": "tool", "id": id, "name": name, "state": { "status": status, "input": input } })
}

/// A tool step with more to its state: what it printed (`content`), what it changed (`metadata`).
fn tool_with(id: &str, name: &str, status: &str, input: Value, more: Value) -> Value {
    let mut step = tool(id, name, status, input);
    if let (Some(state), Some(more)) = (step["state"].as_object_mut(), more.as_object()) {
        state.extend(more.clone());
    }
    step
}

/// The sign-up form's fix, as the engine keeps an edit's changes.
const SIGNUP_PATCH: &str = "Index: web/src/signup/Form.tsx\n===================================================================\n--- web/src/signup/Form.tsx\n+++ web/src/signup/Form.tsx\n@@ -44,9 +44,11 @@ export function SignupForm() {\n   async function save(values: Values) {\n     try {\n       await api.post(\"/accounts\", values);\n+      reset();\n     } catch (error) {\n-      reset();\n-      setError(error.message);\n+      if (error.status === 409) {\n+        setError(\"email\", { message: \"That email already has an account.\" });\n+      }\n     }\n   }\n \n";

/// What the sign-up tests printed: long enough to fold.
fn test_output() -> String {
    let mut lines = vec!["> web@2.4.0 test".to_owned(), "> vitest run signup".to_owned(), String::new(), " RUN  v3.2.4 /Users/sam/Projects/website/web".to_owned(), String::new()];
    let cases = ["keeps what was typed when the email is taken", "says which field is wrong", "clears the form once the account is made", "shows the server's message for other errors", "doesn't send twice on a double click", "trims spaces around the email", "accepts a plus in the email", "asks for a longer password", "remembers the plan picked", "focuses the first field with an error"];
    for (n, case) in cases.iter().enumerate() {
        lines.push(format!(" ✓ signup/Form.test.tsx > SignupForm > {case} {}ms", 12 + n * 7));
    }
    lines.extend([String::new(), " Test Files  1 passed (1)".to_owned(), "      Tests  10 passed (10)".to_owned(), "   Start at  10:42:17".to_owned(), "   Duration  1.84s (transform 210ms, setup 0ms, collect 640ms, tests 96ms)".to_owned()]);
    lines.join("\n")
}

impl State {
    fn line(&self, full: bool) -> Value {
        json!({ "at": self.at.to_string(), "full": full, "sessions": self.sessions, "projects": self.projects })
    }

    fn list_changed(&mut self) {
        self.at += 1;
        let line = self.line(true).to_string();
        self.lists.retain(|_, sender| sender.send(line.clone()).is_ok());
    }

    fn emit(&mut self, kind: &str, data: Value) {
        let event = json!({ "id": format!("evt_{}", self.next), "type": kind, "created": now_ms(), "data": data }).to_string();
        self.next += 1;
        self.events.retain(|_, sender| sender.send(event.clone()).is_ok());
    }

    fn id(&mut self, prefix: &str) -> String {
        self.next += 1;
        format!("{prefix}_{:06}", self.next)
    }
}

/// A followed answer read as it comes: each string sent is a piece of it; it ends once its sender's
/// gone (the stand-in let it go, or what followed it closed it).
struct Pieces {
    receiver: Receiver<String>,
    piece: Vec<u8>,
    at: usize,
    sse: bool,
}

impl Read for Pieces {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let available = self.fill_buf()?;
        let count = available.len().min(out.len());
        out[..count].copy_from_slice(&available[..count]);
        self.consume(count);
        Ok(count)
    }
}

impl BufRead for Pieces {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.at >= self.piece.len() {
            match self.receiver.recv() {
                Ok(next) => {
                    self.piece = if self.sse { format!("data: {next}\n\n") } else { format!("{next}\n") }.into_bytes();
                    self.at = 0;
                }
                Err(_) => return Ok(&[]),
            }
        }
        Ok(&self.piece[self.at..])
    }

    fn consume(&mut self, count: usize) {
        self.at += count;
    }
}

fn answer(status: u16, body: Value) -> Result<Response> {
    Ok(Response { status, content_type: Some("application/json".into()), body: body.to_string().into_bytes() })
}

fn query<'a>(path: &'a str, name: &str) -> Option<&'a str> {
    path.split_once('?')?.1.split('&').find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
}

fn decoded(value: &str) -> String {
    percent_decode(value)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Some(byte) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|hex| u8::from_str_radix(hex, 16).ok())
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The models offered here, and their efforts.
fn models() -> Vec<(Value, Vec<&'static str>)> {
    vec![
        (json!({ "providerID": "anthropic", "id": "claude-opus-5-5", "name": "Claude Opus 5.5" }), vec!["low", "medium", "high", "max"]),
        (json!({ "providerID": "anthropic", "id": "claude-sonnet-5-5", "name": "Claude Sonnet 5.5" }), vec!["low", "medium", "high"]),
        (json!({ "providerID": "openai", "id": "gpt-6", "name": "GPT-6" }), vec!["low", "medium", "high", "xhigh"]),
        (json!({ "providerID": "google", "id": "gemini-3-pro", "name": "Gemini 3 Pro" }), vec![]),
    ]
}

/// The coding agents' models, as their bridge lists them.
fn agents_models() -> Vec<(Value, Vec<&'static str>)> {
    vec![(json!({ "providerID": "claude-code", "id": "opus", "name": "Claude Code · Opus", "aliases": ["default"] }), vec!["low", "medium", "high"])]
}

fn model_name(model: &Value) -> Option<String> {
    models().into_iter().chain(agents_models()).find(|(each, _)| each["providerID"] == model["providerID"] && each["id"] == model["id"]).and_then(|(each, _)| each["name"].as_str().map(str::to_owned))
}

/// The keywords and commands "/" offers.
fn offers() -> Value {
    json!({
        "keywords": [
            { "name": "plan", "title": "Plan", "summary": "Plan before changing anything", "argument": "what to plan" },
            { "name": "goal", "title": "Goal", "summary": "Keep working until a goal is met", "argument": "the goal" },
            { "name": "loop", "title": "Loop", "summary": "Do something again on a schedule", "argument": "how often, then what" },
            { "name": "review", "title": "Review", "summary": "Have another model review the changes", "argument": "with a model, or what to look at" },
            { "name": "autopilot", "title": "Autopilot", "summary": "Work without stopping to ask" },
            { "name": "btw", "title": "By the way", "summary": "Ask aside without interrupting", "argument": "your question" },
            { "name": "handoff", "title": "Hand off", "summary": "Carry on in a fresh session" },
            { "name": "compact", "title": "Compact", "summary": "Summarise the conversation to free up room" }
        ],
        "commands": [
            { "name": "init", "description": "Write an AGENTS.md for this project" },
            { "name": "test", "description": "Run the project's tests and fix what fails" }
        ]
    })
}

/// What the box makes of a typed text, for the few the stand-in knows: as `typed/decide.ts` would.
fn decide(text: &str) -> Value {
    let trimmed = text.trim();
    if let Some(shell) = trimmed.strip_prefix('!') {
        return json!({ "shell": shell.trim() });
    }
    let rest = trimmed.trim_start_matches('/');
    let (name, words) = rest.split_once(char::is_whitespace).map_or((rest, ""), |(name, words)| (name, words.trim()));
    match name.to_lowercase().as_str() {
        "plan" if words.is_empty() => json!({ "keyword": "plan", "agent": "plan" }),
        "plan" => json!({ "keyword": "plan", "agent": "plan", "send": { "text": words, "typed": "/plan" } }),
        "compact" => json!({ "keyword": "compact", "compact": true }),
        "loop" if !words.starts_with("every") => json!({ "keyword": "loop", "restore": { "text": text, "beside": "" }, "error": "Can’t tell how often from that. Start with one like “every 30 min” or “weekdays at 9”, or pick one from the list after /loop." }),
        "init" | "test" => json!({ "command": { "name": name, "arguments": words } }),
        _ => json!({ "send": { "text": text, "quoted": true } }),
    }
}

impl StandIn {
    fn route(&self, request: &Request) -> Result<Response> {
        let path = request.path.as_str();
        let route = request.route();
        let method = request.method.as_str();
        let mut state = self.state();
        state.seen.push(Seen { method: method.into(), path: path.into(), body: request.body.clone() });
        let segments: Vec<&str> = route.split('/').collect();
        match (method, segments.as_slice()) {
            ("GET", ["kuvo", "info"]) => {
                let mut features: Vec<&str> = kuvo_box::gate::REQUIRED.to_vec();
                features.extend(["queue", "work-queue", "asks"]);
                answer(200, json!({ "kind": "mac", "name": NAME, "app": "1.0.0", "engine": "2.3.0", "features": features, "agents": true, "started": 1.0, "chats": format!("{HOME}/.kuvo-code/chats") }))
            }
            ("GET", ["kuvo", "sessions", "list"]) => answer(200, state.line(true)),
            ("GET", ["kuvo", "search"]) => {
                let Some(query) = query(path, "q").map(decoded).map(|q| q.replace('+', " ")).filter(|q| !q.trim().is_empty()) else {
                    return answer(400, json!({ "message": "Say what to search for: q=<words>." }));
                };
                let wanted = query.trim().to_lowercase();
                // The latest first, each with the words around where they were found.
                let mut results: Vec<(f64, Value)> = Vec::new();
                for (session, messages) in &state.messages {
                    let said = messages.iter().flat_map(said_in).find(|text| text.to_lowercase().contains(&wanted));
                    if let Some(text) = said {
                        let updated = state.sessions.get(session).and_then(|facts| facts["updated"].as_f64()).unwrap_or(0.0);
                        results.push((updated, json!({ "session": session, "snippet": snippet(&text, &wanted), "info": { "id": session } })));
                    }
                }
                results.sort_by(|a, b| b.0.total_cmp(&a.0));
                answer(200, json!({ "results": results.into_iter().map(|(_, result)| result).collect::<Vec<_>>() }))
            }
            ("GET", ["kuvo", "sessions", "models"]) if state.models_fail => answer(503, json!({ "message": "The engine isn't answering." })),
            ("GET", ["kuvo", "sessions", "models"]) => {
                let asked = query(path, "sessions").map(decoded).unwrap_or_default();
                let mut told = serde_json::Map::new();
                for session in asked.split(',') {
                    if let Some(said) = state.model_states.get(session) {
                        // (Null: left out, as the box leaves out one it can't say about yet.)
                        if !said.is_null() {
                            told.insert(session.into(), said.clone());
                        }
                    } else if let Some(model) = state.models.get(session) {
                        told.insert(session.into(), json!({ "model": model, "name": model_name(model), "runs": true }));
                    }
                }
                answer(200, json!({ "sessions": told }))
            }
            ("GET", ["kuvo", "models", "offered"]) => {
                if state.nothing_runs {
                    return answer(200, json!({ "models": [], "known": { "engine": true, "agents": true }, "starting": null }));
                }
                // Each with its side and its efforts, as the box says them.
                let with = |side: &'static str, (mut model, efforts): (Value, Vec<&str>)| -> Value {
                    model["side"] = json!(side);
                    model["efforts"] = json!(efforts);
                    if model.get("aliases").is_none() {
                        model["aliases"] = json!([]);
                    }
                    model
                };
                let mut listed: Vec<Value> = models().into_iter().map(|model| with("engine", model)).collect();
                if !state.agents_unknown {
                    listed.extend(agents_models().into_iter().map(|model| with("agents", model)));
                }
                answer(200, json!({ "models": listed, "known": { "engine": true, "agents": !state.agents_unknown }, "starting": { "providerID": "anthropic", "id": "claude-opus-5-5", "variant": "high" } }))
            }
            ("POST", ["kuvo", "messages", "parts"]) => {
                let texts = request.body.as_ref().and_then(|body| body["texts"].as_array().cloned()).unwrap_or_default();
                answer(200, json!({ "parts": texts.iter().map(|text| json!({ "words": text })).collect::<Vec<_>>() }))
            }
            ("POST", ["kuvo", "sessions"]) => {
                let body = request.body.clone().unwrap_or(Value::Null);
                let id = state.id("ses_new");
                let now = now_ms();
                let (kind, folder, project) = match body["project"].as_str() {
                    Some(project) => ("project", project.to_owned(), Some(project.to_owned())),
                    None => ("chat", format!("{HOME}/.kuvo-code/chats"), None),
                };
                let mut facts = json!({ "kind": kind, "directory": folder, "created": now, "updated": now });
                if let Some(project) = &project {
                    facts["project"] = json!(project);
                }
                state.sessions.insert(id.clone(), facts);
                let model = body.get("model").filter(|model| model.is_object()).cloned().unwrap_or(json!({ "providerID": "anthropic", "id": "claude-opus-5-5", "variant": "high" }));
                state.models.insert(id.clone(), model);
                state.messages.insert(id.clone(), Vec::new());
                state.list_changed();
                answer(200, json!({ "session": id, "title": null, "folder": folder, "project": project }))
            }
            ("POST", ["kuvo", "sessions", session, "stop"]) => {
                let session = (*session).to_owned();
                state.running.remove(&session);
                if let Some(facts) = state.sessions.get_mut(&session) {
                    facts["running"] = json!(false);
                }
                state.list_changed();
                state.emit("session.execution.interrupted", json!({ "sessionID": session }));
                answer(200, json!({}))
            }
            ("GET", ["kuvo", "sessions", session, "typed"]) if state.sessions.contains_key(*session) => answer(200, offers()),
            ("GET", ["kuvo", "sessions", session, "asks"]) if state.sessions.contains_key(*session) => answer(200, json!({ "asks": state.asks.get(*session).cloned().unwrap_or_default() })),
            ("POST", ["kuvo", "sessions", session, "asks", ask]) => {
                let Some(asks) = state.asks.get_mut(*session) else { return answer(404, json!({})) };
                let Some(at) = asks.iter().position(|each| each["id"] == json!(ask)) else { return answer(404, json!({})) };
                asks.remove(at);
                if asks.is_empty()
                    && let Some(facts) = state.sessions.get_mut(*session)
                {
                    facts.as_object_mut().map(|facts| facts.remove("asked"));
                }
                state.list_changed();
                answer(200, json!({}))
            }
            ("POST", ["kuvo", "sessions", session, "typed"]) if state.sessions.contains_key(*session) => {
                let text = request.body.as_ref().and_then(|body| body["text"].as_str()).unwrap_or("");
                answer(200, decide(text))
            }
            ("POST", ["kuvo", "sessions", session, "send"]) => {
                let session = (*session).to_owned();
                if !state.sessions.contains_key(&session) {
                    return answer(404, json!({ "message": "There's no such session." }));
                }
                if state.sends_fail {
                    return answer(503, json!({ "message": "The engine isn't answering. Try again in a moment." }));
                }
                let body = request.body.clone().unwrap_or(Value::Null);
                let words = body["words"].as_str().unwrap_or("").to_owned();
                let id = body["id"].as_str().map(str::to_owned).unwrap_or_else(|| state.id("msg"));
                let now = now_ms();
                let message = match body["command"].as_str() {
                    // A command's message is the prompt it sent, with no parts kept.
                    Some(command) => json!({ "type": "user", "id": id, "time": { "created": now }, "text": format!("Run the project's {command} command. {words}").trim().to_owned() }),
                    None => {
                        let keyword = body["keyword"].as_str();
                        let mut message = user(&id, now, &words, keyword);
                        // The files it brought, as the box keeps them with its parts.
                        let paths: Vec<String> = body["files"].as_array().into_iter().flatten().filter_map(|file| file["uri"].as_str()).map(|uri| decoded(uri.trim_start_matches("file://"))).collect();
                        if !paths.is_empty() {
                            message["metadata"]["kuvo"]["parts"]["paths"] = json!(paths);
                        }
                        message
                    }
                };
                state.messages.entry(session.clone()).or_default().push(message);
                if let Some(facts) = state.sessions.get_mut(&session) {
                    facts["updated"] = json!(now);
                    if facts["title"].is_null() {
                        facts["title"] = json!(title_from(&words));
                    }
                }
                state.list_changed();
                state.emit("session.inbox.delivered", json!({ "sessionID": session }));
                drop(state);
                if self.inner.replies == Replies::Live {
                    self.reply(session, words);
                }
                answer(200, json!({}))
            }
            ("POST", ["api", "session", session, "model"]) | ("POST", ["kuvo", "agents", "api", "session", session, "model"]) => {
                let session = (*session).to_owned();
                let model = request.body.as_ref().map(|body| body["model"].clone()).unwrap_or(Value::Null);
                state.models.insert(session.clone(), model);
                state.emit("session.model.selected", json!({ "sessionID": session }));
                answer(200, json!({}))
            }
            ("GET", ["api", "session", "active"]) => {
                let active: serde_json::Map<String, Value> = state.running.iter().map(|session| (session.clone(), json!({}))).collect();
                answer(200, json!({ "data": active }))
            }
            ("GET", ["api", "session", session]) if state.sessions.contains_key(*session) => answer(200, json!({ "id": session })),
            ("GET", ["api", "session", session, "message"]) if state.sessions.contains_key(*session) => {
                let all = state.messages.get(*session).cloned().unwrap_or_default();
                let limit: usize = query(path, "limit").and_then(|limit| limit.parse().ok()).unwrap_or(100);
                // Newest first; the cursor is how many of the newest are behind it.
                let skip: usize = query(path, "cursor").and_then(|cursor| cursor.parse().ok()).unwrap_or(0);
                let page: Vec<Value> = all.iter().rev().skip(skip).take(limit).cloned().collect();
                let next = (skip + page.len() < all.len()).then(|| (skip + page.len()).to_string());
                answer(200, json!({ "data": page, "cursor": { "next": next } }))
            }
            _ => answer(404, json!({})),
        }
    }

    /// An answer streamed back as an engine streams one: the run starts, a step reads a file, its
    /// words come a few at a time, the step and the run end.
    fn reply(&self, session: String, words: String) {
        let stand_in = self.clone();
        std::thread::spawn(move || {
            let pause = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
            let step = stand_in.state().id("msg");
            let reply = format!(
                "On it. I read through the code this touches first.\n\nHere's what I'll do for “{}”:\n\n- Find where it's handled today\n- Make the change, with a test that shows it working\n- Run the tests before I say it's done",
                title_from(&words)
            );
            {
                let mut state = stand_in.state();
                state.running.insert(session.clone());
                if let Some(facts) = state.sessions.get_mut(&session) {
                    facts["running"] = json!(true);
                }
                state.list_changed();
                let now = now_ms();
                state.messages.entry(session.clone()).or_default().push(json!({ "type": "assistant", "id": step, "time": { "created": now }, "agent": "build", "content": [] }));
                state.emit("session.execution.started", json!({ "sessionID": session }));
                state.emit("session.step.started", json!({ "sessionID": session, "assistantMessageID": step, "started": now }));
            }
            pause(600);
            {
                let mut state = stand_in.state();
                if let Some(found) = state.messages.get_mut(&session).and_then(|messages| messages.iter_mut().rev().find(|message| message["id"] == json!(step)))
                    && let Some(content) = found["content"].as_array_mut()
                {
                    content.push(tool("call_live", "read", "completed", json!({ "filePath": "README.md" })));
                }
                state.emit("session.tool.called", json!({ "sessionID": session, "assistantMessageID": step }));
                state.emit("session.text.started", json!({ "sessionID": session, "assistantMessageID": step, "ordinal": 0 }));
            }
            for piece in reply.split_inclusive(' ') {
                pause(45);
                if !stand_in.state().running.contains(&session) {
                    break;
                }
                stand_in.emit("session.text.delta", json!({ "sessionID": session, "assistantMessageID": step, "ordinal": 0, "delta": piece }));
            }
            let mut state = stand_in.state();
            let now = now_ms();
            if let Some(found) = state.messages.get_mut(&session).and_then(|messages| messages.iter_mut().rev().find(|message| message["id"] == json!(step))) {
                if let Some(content) = found["content"].as_array_mut() {
                    content.push(json!({ "type": "text", "text": reply }));
                }
                found["time"]["completed"] = json!(now);
                found["finish"] = json!("stop");
            }
            state.emit("session.text.ended", json!({ "sessionID": session, "assistantMessageID": step, "ordinal": 0, "text": reply }));
            state.emit("session.step.ended", json!({ "sessionID": session, "assistantMessageID": step, "finish": "stop" }));
            let idle = state.id("msg");
            state.messages.entry(session.clone()).or_default().push(json!({ "type": "idle", "id": idle, "time": { "created": now }, "outcome": "succeeded" }));
            state.running.remove(&session);
            if let Some(facts) = state.sessions.get_mut(&session) {
                facts["running"] = json!(false);
                facts["updated"] = json!(now);
            }
            state.list_changed();
            state.emit("session.execution.succeeded", json!({ "sessionID": session }));
        });
    }
}

/// What a message says, as the box's search reads it: your words, the agent's text.
fn said_in(message: &Value) -> Vec<String> {
    let mut said: Vec<String> = message["text"].as_str().map(str::to_owned).into_iter().collect();
    for block in message["content"].as_array().into_iter().flatten() {
        if block["type"] == "text"
            && let Some(text) = block["text"].as_str()
        {
            said.push(text.to_owned());
        }
    }
    said
}

/// A line's worth of `text` around where `wanted` is.
fn snippet(text: &str, wanted: &str) -> String {
    let flat = text.replace(['*', '`'], "").split_whitespace().collect::<Vec<_>>().join(" ");
    let at = flat.to_lowercase().find(wanted).unwrap_or(0);
    let start = flat.get(..at).unwrap_or("").char_indices().rev().nth(40).map_or(0, |(ix, _)| ix);
    let rest: String = flat[start..].chars().take(110).collect();
    if start > 0 { format!("…{rest}") } else { rest }
}

/// A new session's title, from its first words (the box asks a model for one; the stand-in cuts).
fn title_from(words: &str) -> String {
    let line = words.lines().next().unwrap_or("").trim();
    let mut title: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        title.push('…');
    }
    if title.is_empty() { "New session".into() } else { title }
}

impl Transport for StandIn {
    fn send(&self, request: &Request) -> Result<Response> {
        self.route(request)
    }

    fn open(&self, request: &Request, hold: &dyn Fn(Closer) -> bool) -> Result<Stream> {
        let route = request.route();
        let lists = route == "kuvo/sessions/list/events";
        if !lists && route != "api/event" {
            let response = self.route(request)?;
            return Ok(Stream { status: response.status, content_type: response.content_type, reader: Box::new(std::io::Cursor::new(response.body)), closer: Closer::nothing() });
        }
        let (sender, receiver) = channel();
        let id = {
            let mut state = self.state();
            state.seen.push(Seen { method: request.method.clone(), path: request.path.clone(), body: None });
            let id = state.next;
            state.next += 1;
            if lists {
                // The list now, then a line for each change.
                let _ = sender.send(state.line(true).to_string());
                state.lists.insert(id, sender);
            } else {
                state.events.insert(id, sender);
            }
            id
        };
        let inner = self.inner.clone();
        let closer = Closer::new(move || {
            let mut state = inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            state.lists.remove(&id);
            state.events.remove(&id);
        });
        if !hold(closer.clone()) {
            closer.close();
        }
        let content_type = if lists { "application/x-ndjson" } else { "text/event-stream" };
        Ok(Stream { status: 200, content_type: Some(content_type.into()), reader: Box::new(Pieces { receiver, piece: Vec::new(), at: 0, sse: !lists }), closer })
    }

    fn streams(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        NAME.into()
    }
}
