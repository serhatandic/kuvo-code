//! `kuvo/info`: what a box is and runs (PROTOCOL.md, "Messages in a session", `kuvo/info`;
//! "Features"). A client checks `features` by name, never a version.

use serde::Deserialize;

/// A box's `kuvo/info`, the fields a client reads; anything else it says is left as it is.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BoxInfo {
    /// `mac` or `machine` (a kind this client doesn't know is kept as said).
    pub kind: String,
    pub name: String,
    /// A Mac's app version, to show, never to compare.
    #[serde(default)]
    pub app: Option<String>,
    /// A machine's bridge version (a hash after 0.9.211), to show, never to compare.
    #[serde(default)]
    pub bridge: Option<String>,
    /// The engine's version (null on a machine whose engine isn't running).
    #[serde(default)]
    pub engine: Option<String>,
    /// The routes it has, by name.
    #[serde(default)]
    pub features: Vec<String>,
    /// Whether its coding agents' bridge is up now.
    #[serde(default)]
    pub agents: bool,
    /// When the engine running now came up, seconds since 1970 (null while none runs).
    #[serde(default)]
    pub started: Option<f64>,
    /// The folder of chats, conversations of no project.
    #[serde(default)]
    pub chats: Option<String>,
    /// A machine's: whether its engine runs, and whether it's stopped on purpose.
    #[serde(default)]
    pub running: Option<bool>,
    #[serde(default)]
    pub stopped: Option<bool>,
}

impl BoxInfo {
    pub fn is_mac(&self) -> bool {
        self.kind == "mac"
    }

    pub fn has(&self, feature: &str) -> bool {
        self.features.iter().any(|name| name == feature)
    }
}
