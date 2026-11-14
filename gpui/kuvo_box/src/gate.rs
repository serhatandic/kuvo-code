//! The update gate (PROTOCOL.md, "The update gate", #679): what a box must have before this client
//! uses it. A client never keeps an older box's way of doing something: a box whose `kuvo/info`
//! `features` lack any of [`REQUIRED`] is held, sent nothing but what tells or brings about its
//! update and what keeps work already under way there going, until it has them.
//!
//! The same list and rules as KuvoClient's `BoxGate`, so every client holds the same boxes.

/// What this client uses with no way around it on a box that hasn't it.
pub const REQUIRED: &[&str] = &[
    "agent-tools.own",
    "folders.tree",
    "git.branches",
    "git.merge",
    "git.pull-request",
    "git.status",
    "messages.send",
    "models.offered",
    "models.offered.folder",
    "models.offered.sides",
    "models.readiness",
    "sessions.list",
    "sessions.models",
    "sessions.start.empty",
    "typed",
];

/// The state's title, wherever it shows.
pub const UPDATING: &str = "Updating…";

/// What `features` lack of [`REQUIRED`], in its order: none when the box is up to date.
pub fn missing<S: AsRef<str>>(features: &[S]) -> Vec<String> {
    REQUIRED
        .iter()
        .filter(|name| !features.iter().any(|has| has.as_ref() == **name))
        .map(|name| (*name).to_owned())
        .collect()
}

/// Whether a held box is still asked `path`: what it is (`kuvo/info`), its own update
/// (`kuvo/update`, `kuvo/box/update`), its Mac's app registering with it (`kuvo/box/app`) and the
/// keys it holds for that app (`kuvo/box/proof`, `kuvo/box/kept-keys`, as KuvoClient's gate), and
/// what keeps work under way going: its engine (`api/…`), its coding agents' bridge
/// (`kuvo/agents/…`), its agents' tool calls (`kuvo/agent-tools`), its asks and Auto's decisions.
pub fn is_allowed(path: &str) -> bool {
    let route = path.split('?').next().unwrap_or(path);
    if ["kuvo/info", "kuvo/update", "kuvo/box/update", "kuvo/box/app", "kuvo/box/proof", "kuvo/box/kept-keys", "kuvo/agent-tools"].contains(&route) {
        return true;
    }
    if route.starts_with("api/") || route.starts_with("kuvo/agents/") {
        return true;
    }
    for asks in ["kuvo/asks", "kuvo/sandbox/asks", "kuvo/vault/asks", "kuvo/work/asks"] {
        if route == asks || route.strip_prefix(asks).is_some_and(|rest| rest.starts_with('/')) {
            return true;
        }
    }
    let parts: Vec<&str> = route.split('/').filter(|part| !part.is_empty()).collect();
    parts.len() == 4 && parts[0] == "kuvo" && parts[1] == "sessions" && parts[3] == "decisions"
}

/// Where a box stands with this client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// Not asked yet: the first request reads `kuvo/info` before anything else.
    Unknown,
    /// It has everything this client needs.
    Open,
    /// It's older than this client needs, lacking these, and waits for its update.
    Held { missing: Vec<String> },
}

impl Gate {
    /// The gate for a box whose `kuvo/info` names `features` (none: a box from before it said any,
    /// or one that answers no `kuvo/info` at all, lacks them all).
    pub fn for_features<S: AsRef<str>>(features: Option<&[S]>) -> Gate {
        let missing = match features {
            Some(features) => missing(features),
            None => REQUIRED.iter().map(|name| (*name).to_owned()).collect(),
        };
        if missing.is_empty() { Gate::Open } else { Gate::Held { missing } }
    }

    pub fn is_held(&self) -> bool {
        matches!(self, Gate::Held { .. })
    }
}
