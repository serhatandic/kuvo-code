//! What each Settings page lists, as rows worked out from the box's facts: their names and lines,
//! and the control each has. Drawing is in `mod.rs`; nothing here reaches the box.
//!
//! The words are this app's (the Mac's, where it has them); every fact is the box's. Where the box
//! doesn't say something a row needs, it's marked `BOX-NEEDED` and drawn plainly.

use kuvo_box::accounts::{AccountEntry, Accounts, Side};
use kuvo_box::areas::Account;
use kuvo_box::models::Offered;
use kuvo_box::settings::{Allowed, Approval, BrowserSettings, Config, Sandbox, UsageSettings};
use kuvo_ui::IconName;

use crate::areas::Reading;

/// The sections this app has pages for, in the sidebar's order, with their icons.
pub const BUILT: &[(&str, IconName)] = &[
    ("General", IconName::Settings),
    ("Accounts", IconName::User),
    ("Usage", IconName::Clock),
    ("Models", IconName::Sparkle),
    ("Permissions", IconName::Shield),
    ("Notifications", IconName::Bell),
    ("Browser", IconName::Globe),
];

/// The Mac's other sections, listed under their own heading: each opens a page saying it isn't in
/// this app yet.
pub const ELSEWHERE: &[(&str, IconName)] = &[
    ("Custom Auto", IconName::Sliders),
    ("Agents", IconName::Bot),
    ("Commands", IconName::Terminal),
    ("Skills", IconName::Sparkle),
    ("Integrations", IconName::Link),
    ("Vault", IconName::Shield),
    ("MCP Servers", IconName::Computer),
    ("Engine", IconName::Computer),
    ("Git", IconName::Branch),
    ("Worktrees", IconName::Branch),
    ("Machines", IconName::Computer),
    ("Keyboard Shortcuts", IconName::Return),
    ("Phone", IconName::Message),
    ("Panel", IconName::PanelRight),
    ("Privacy", IconName::Shield),
    ("Storage", IconName::Folder),
    ("Archived Sessions", IconName::Clock),
];

pub fn is_built(section: &str) -> bool {
    BUILT.iter().any(|(name, _)| *name == section)
}

/// What a change asks of the box (or, for the theme, of this window).
#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    SignIn { side: Side, account: String, name: String },
    Install { account: String, name: String },
    Disconnect { account: String, name: String },
    SignOut { account: String },
    RemoveAgent { account: String, name: String },
    /// A model setting at a path in the engine's settings, from what was read there.
    SetModel { path: &'static [&'static str], model: Option<String>, was: Option<String> },
    SetOtherComputers(bool),
    /// The sandbox's button, at the route the box named.
    SandboxAction { method: String, path: String },
    RemoveAllowed(String),
    SetSearchEngine(String),
    SetTidies(bool),
    SetOffersToSave(bool),
    OfferAgain(String),
    SetNotice(Notice, bool),
    SetDark(bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Notice {
    AlmostOut,
    CuttingItClose,
    WillRunOut,
}

/// A row's control, on its right.
#[derive(Clone, Debug, PartialEq)]
pub enum Control {
    None,
    /// Plain words (a state that's read, not set here).
    Text(String),
    /// A switch, and what flipping it does; `held` while another change in its group is under
    /// way (each is sent whole, from what the box last said, so two at once would undo one).
    Switch { on: bool, act: Act, held: bool },
    /// A button that can't be used until another change in its group is answered.
    HeldButton(String),
    /// A menu: what it shows now, and its choices (words, what picking one does, whether it's it).
    Menu { shown: String, choices: Vec<(String, Act, bool)> },
    /// Buttons, the first the main one.
    Buttons(Vec<(String, Act)>),
    /// A change on its way.
    Busy(String),
    /// A plan's windows, each with its share and when it starts over.
    Windows(Account),
}

/// How a row's line reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Quiet,
    Warning,
}

/// What a row shows before its name.
#[derive(Clone, Debug, PartialEq)]
pub enum Leading {
    None,
    /// A service's mark, by the box's service id.
    Mark(String),
    /// The name's first letter, in a round tile.
    Initial(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// Its debug selector, unique on the page.
    pub key: String,
    pub leading: Leading,
    pub title: String,
    pub detail: String,
    pub tone: Tone,
    pub control: Control,
}

impl Row {
    fn new(key: impl Into<String>, title: impl Into<String>, detail: impl Into<String>, control: Control) -> Row {
        Row { key: key.into(), leading: Leading::None, title: title.into(), detail: detail.into(), tone: Tone::Quiet, control }
    }

    fn leading(mut self, leading: Leading) -> Row {
        self.leading = leading;
        self
    }

    fn warning(mut self, warning: bool) -> Row {
        if warning {
            self.tone = Tone::Warning;
        }
        self
    }

    /// Whether `query` (lowercase) is in its name or its line.
    pub fn matches(&self, query: &str) -> bool {
        self.title.to_lowercase().contains(query) || self.detail.to_lowercase().contains(query)
    }
}

/// A page's piece: a group of rows in one card, or a line of its own.
#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    /// A quiet label over a card, and the card's rows.
    Group(String, Vec<Row>),
    /// A quiet line on the page: loading, a reason, what isn't here yet.
    Note { key: String, words: String, busy: bool },
}

fn note(key: &str, words: impl Into<String>, busy: bool) -> Block {
    Block::Note { key: key.into(), words: words.into(), busy }
}

/// Everything a page is drawn from, as read from the box.
pub struct Facts<'a> {
    pub accounts: &'a Reading<Accounts>,
    pub limits: &'a Reading<Vec<Account>>,
    pub config: &'a Reading<Config>,
    pub offered: &'a Reading<Offered>,
    pub approval: &'a Reading<Approval>,
    pub sandbox: &'a Reading<Sandbox>,
    pub allowed: &'a Reading<Vec<Allowed>>,
    pub browser: &'a Reading<BrowserSettings>,
    pub usage: &'a Reading<UsageSettings>,
    /// Rows with a change on its way, by key, and what they say meanwhile.
    pub busy: &'a [(String, String)],
    pub dark: bool,
    pub this_box: &'a str,
}

impl Facts<'_> {
    fn busy(&self, key: &str) -> Option<Control> {
        self.busy.iter().find(|(busy, _)| busy == key).map(|(_, words)| Control::Busy(words.clone()))
    }

    /// Whether a change to a row whose key starts with `group` is under way.
    fn group_busy(&self, group: &str) -> bool {
        self.busy.iter().any(|(busy, _)| busy.starts_with(group))
    }
}

/// A reading's state as a note: loading, or why it couldn't be read.
fn unread<T>(reading: &Reading<T>, key: &str, what: &str) -> Option<Block> {
    match reading {
        Reading::NotYet => Some(note(key, format!("Reading {what}…"), true)),
        Reading::Failed(why) => Some(note(key, format!("{} couldn’t be read: {why}", capitalized(what)), false)),
        Reading::Ready(_) => None,
    }
}

fn capitalized(words: &str) -> String {
    let mut chars = words.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// A section's page, as blocks.
pub fn page(section: &str, facts: &Facts) -> Vec<Block> {
    match section {
        "General" => general(facts),
        "Accounts" => accounts(facts),
        "Usage" => usage(facts),
        "Models" => models(facts),
        "Permissions" => permissions(facts),
        "Notifications" => notifications(facts),
        "Browser" => browser(facts),
        _ => Vec::new(),
    }
}

fn general(facts: &Facts) -> Vec<Block> {
    let theme = Row::new(
        "row-theme",
        "Theme",
        "Light or dark colours for this app. ⌘⇧L switches them too.",
        Control::Menu { shown: if facts.dark { "Dark".into() } else { "Light".into() }, choices: vec![("Light".into(), Act::SetDark(false), !facts.dark), ("Dark".into(), Act::SetDark(true), facts.dark)] },
    );
    vec![
        Block::Group("Appearance".into(), vec![theme]),
        // The Mac's own General settings (its window, voice, staying awake, updates) are the Mac
        // app's, not a computer's: none is served by the box.
        note("note-general", "The Mac app’s window, voice and update settings are its own, and stay there.", false),
    ]
}

// MARK: Accounts

/// The line under an account's name, from what the engine or the agent says of it.
fn account_line(entry: &AccountEntry) -> (String, bool) {
    let integration = &entry.integration;
    if integration.needs_install() {
        return ("Not installed on this computer".into(), false);
    }
    if entry.sign_in_ended() {
        return ("Sign-in ended".into(), true);
    }
    if let Some(connection) = integration.connections.first() {
        if let Some(status) = connection.status.as_ref().filter(|status| !status.message.is_empty() && status.status != "ok") {
            return (status.message.clone(), true);
        }
        if connection.kind == "env" {
            return (format!("From {}", connection.name.clone().unwrap_or_default()), false);
        }
        let who = connection.label.clone().filter(|label| !label.trim().is_empty());
        let how = match connection.method.as_deref() {
            Some("key") => "API key",
            Some("external") => "Credentials on this computer",
            _ => "Signed in",
        };
        let more = integration.connections.len().saturating_sub(1);
        let line = match who {
            Some(who) if how == "Signed in" => format!("Signed in as {who}"),
            Some(who) => format!("{how} · {who}"),
            None => how.into(),
        };
        return (if more > 0 { format!("{line} · {} accounts", more + 1) } else { line }, false);
    }
    if integration.unchecked() {
        return ("Couldn’t check just now".into(), false);
    }
    if entry.ways.methods.is_empty() && !entry.ways.environment.is_empty() {
        return (format!("Set {} in your shell profile", entry.ways.environment.join(" or ")), false);
    }
    (if entry.ways.hint.is_empty() { "Not signed in".into() } else { entry.ways.hint.clone() }, false)
}

fn agent_row(entry: &AccountEntry, facts: &Facts) -> Row {
    let integration = &entry.integration;
    let (account, name) = (integration.id.clone(), integration.name.clone());
    let key = format!("account-{account}");
    let (mut line, warning) = account_line(entry);
    // An agent's hint only names its way in ("Sign in"): one signed out says so instead.
    if !integration.connected() && !integration.needs_install() && !entry.sign_in_ended() && !integration.unchecked() {
        line = "Not signed in".into();
    }
    let sign_in = Act::SignIn { side: Side::Agents, account: account.clone(), name: name.clone() };
    let control = facts.busy(&key).unwrap_or_else(|| {
        if integration.needs_install() {
            return Control::Buttons(vec![("Install".into(), Act::Install { account: account.clone(), name: name.clone() })]);
        }
        if !integration.connected() || entry.sign_in_ended() {
            let words = if entry.sign_in_ended() { "Sign In Again" } else { "Sign In" };
            return if entry.offers_sign_in() { Control::Buttons(vec![(words.into(), sign_in.clone())]) } else { Control::None };
        }
        let mut choices = Vec::new();
        if entry.offers_sign_in() {
            choices.push(("Sign In Again…".into(), sign_in.clone(), false));
        }
        if integration.signs_out() {
            choices.push(("Sign Out".into(), Act::SignOut { account: account.clone() }, false));
        }
        if integration.added() {
            choices.push(("Remove Account…".into(), Act::RemoveAgent { account: account.clone(), name: name.clone() }, false));
        }
        if choices.is_empty() { Control::None } else { Control::Menu { shown: String::new(), choices } }
    });
    // The agent's mark, by the bridge's `metadata.agent`.
    let leading = integration.agent().map_or_else(|| Leading::Initial(name.clone()), |agent| Leading::Mark(agent.to_owned()));
    Row::new(key, name, line, control).leading(leading).warning(warning)
}

fn provider_row(entry: &AccountEntry, facts: &Facts) -> Row {
    let integration = &entry.integration;
    let (account, name) = (integration.id.clone(), integration.name.clone());
    let key = format!("account-{account}");
    let (line, warning) = account_line(entry);
    let sign_in = Act::SignIn { side: Side::Engine, account: account.clone(), name: name.clone() };
    let control = facts.busy(&key).unwrap_or_else(|| {
        let mut buttons = Vec::new();
        if !integration.connected() {
            if entry.offers_sign_in() {
                buttons.push(("Connect".into(), sign_in.clone()));
            }
            return Control::Buttons(buttons);
        }
        if entry.sign_in_ended() && entry.offers_sign_in() {
            buttons.push(("Sign In Again".into(), sign_in.clone()));
        }
        // A key or sign-in this box keeps can be forgotten; one from the shell's environment can't.
        if integration.connections.iter().any(|connection| connection.kind == "credential") {
            buttons.push(("Disconnect".into(), Act::Disconnect { account: account.clone(), name: name.clone() }));
        }
        Control::Buttons(buttons)
    });
    // BOX-NEEDED: each account's mark, `service` (the limits' ids: `copilot`, `openrouter`…) on each account in `GET kuvo/sign-in/accounts`: until then the engine's providers show their first letter, never a mark matched by id here.
    Row::new(key, name.clone(), line, control).leading(Leading::Initial(name)).warning(warning)
}

fn accounts(facts: &Facts) -> Vec<Block> {
    if let Some(note) = unread(facts.accounts, "note-accounts", "accounts") {
        return vec![note];
    }
    let Reading::Ready(accounts) = facts.accounts else { return Vec::new() };
    let mut blocks = Vec::new();
    if let Some(why) = &accounts.agents_down {
        blocks.push(note("note-agents-down", format!("The coding agents aren’t running on {}: {why}", facts.this_box), false));
    } else if !accounts.agents.is_empty() {
        blocks.push(Block::Group("Coding Agents".into(), accounts.agents.iter().map(|entry| agent_row(entry, facts)).collect()));
    }
    if let Some(why) = &accounts.engine_down {
        blocks.push(note("note-engine-down", format!("The engine isn’t running on {}: {why}", facts.this_box), false));
    }
    // Signed in (or once signed in, now ended), then the rest to add, each in the engine's order.
    let (connected, others): (Vec<&AccountEntry>, Vec<&AccountEntry>) = accounts.engine.iter().partition(|entry| entry.integration.connected() || entry.sign_in_ended());
    if !connected.is_empty() {
        blocks.push(Block::Group("Providers".into(), connected.into_iter().map(|entry| provider_row(entry, facts)).collect()));
    }
    if !others.is_empty() {
        blocks.push(Block::Group("Add a Provider".into(), others.into_iter().map(|entry| provider_row(entry, facts)).collect()));
    }
    blocks
}

// MARK: Usage

fn usage(facts: &Facts) -> Vec<Block> {
    if let Some(note) = unread(facts.limits, "note-usage", "your accounts’ limits") {
        return vec![note];
    }
    let Reading::Ready(limits) = facts.limits else { return Vec::new() };
    if limits.is_empty() {
        return vec![note("note-usage-none", "No account’s limits to show yet. Sign in under Accounts, and each plan’s limits show here.", false)];
    }
    let rows = limits
        .iter()
        .enumerate()
        .map(|(ix, account)| {
            let detail = account.plan.clone().map(|plan| format!("{plan} plan")).unwrap_or_default();
            Row::new(format!("usage-{ix}"), account.title(), detail, Control::Windows(account.clone())).leading(Leading::Mark(account.service.clone()))
        })
        .collect();
    vec![Block::Group("Limits".into(), rows)]
}

// MARK: Models

/// A model setting: where it is, its name and line, and what none means.
const MODEL_SETTINGS: &[(&[&str], &str, &str, &str)] = &[
    (&["model"], "Model for new sessions", "New sessions use the model you picked last; this one is for when there’s none.", "The engine’s choice"),
    (&["agents", "title", "model"], "Model for session titles", "A small, fast model is enough for titles.", "The session’s model"),
    (&["subagent_model"], "Subagents use", "For the parts of a task an agent hands off, in every session here.", "Same as the conversation"),
];

fn models(facts: &Facts) -> Vec<Block> {
    if let Some(note) = unread(facts.config, "note-config", "this computer’s settings") {
        return vec![note];
    }
    let Reading::Ready(config) = facts.config else { return Vec::new() };
    // The engine's settings name an engine model as `provider/model`: its models offered are the
    // ones these can be.
    let offered: Vec<(String, String)> = match facts.offered {
        Reading::Ready(offered) => offered.models.iter().filter(|model| model.side == kuvo_box::models::Side::Engine && model.is_offered()).map(|model| (format!("{}/{}", model.provider_id, model.id), model.name.clone())).collect(),
        _ => Vec::new(),
    };
    let rows = MODEL_SETTINGS
        .iter()
        .enumerate()
        .map(|(ix, (path, title, detail, none))| {
            let key = format!("model-{ix}");
            let now = config.model_at(path);
            let control = facts.busy(&key).unwrap_or_else(|| {
                let shown = now.as_ref().map(|now| offered.iter().find(|(id, _)| id == now).map_or_else(|| now.clone(), |(_, name)| name.clone())).unwrap_or_else(|| (*none).to_owned());
                let mut choices = vec![((*none).to_owned(), Act::SetModel { path, model: None, was: now.clone() }, now.is_none())];
                choices.extend(offered.iter().map(|(id, name)| (name.clone(), Act::SetModel { path, model: Some(id.clone()), was: now.clone() }, now.as_deref() == Some(id))));
                Control::Menu { shown, choices }
            });
            Row::new(key, *title, *detail, control)
        })
        .collect();
    let mut blocks = vec![Block::Group("Defaults".into(), rows)];
    if let Reading::Failed(why) = facts.offered {
        blocks.push(note("note-offered", format!("The models offered couldn’t be read: {why}"), false));
    }
    blocks
}

// MARK: Permissions

/// A mode's name, as every client says it (KuvoClient's `ApprovalWords`).
fn mode_name(mode: &str) -> String {
    match mode {
        "askFirst" => "Ask First".into(),
        "acceptEdits" => "Accept Edits".into(),
        "auto" => "Auto".into(),
        "fullAccess" => "Full Access".into(),
        other => other.to_owned(),
    }
}

fn permissions(facts: &Facts) -> Vec<Block> {
    let mut blocks = Vec::new();
    match facts.approval {
        Reading::Ready(approval) => {
            let mut rows = vec![
                Row::new("row-default-mode", "New sessions start in", "The mode you picked last on this computer. Change it in a conversation’s mode menu.", Control::Text(mode_name(&approval.default))),
                Row::new(
                    "row-full-access",
                    "Full Access",
                    "Asked the first time you pick it in a conversation on this computer.",
                    Control::Text(if approval.full_access { "Allowed".into() } else { "Not allowed yet".into() }),
                ),
            ];
            for (side, held) in [("the engine", &approval.auto.engine.held), ("the coding agents", &approval.auto.agents.held)] {
                if let Some(held) = held {
                    let why = held.why.clone().unwrap_or_else(|| held.reason.clone());
                    rows.push(Row::new(format!("row-auto-held-{}", side.len()), format!("Auto, for {side}"), why, Control::Text("Held".into())).warning(true));
                }
            }
            if let Some(allowed) = approval.other_computers {
                rows.push(facts.busy("row-other-computers").map_or_else(
                    || Row::new("row-other-computers", "Let your other computers start work here", format!("Their bots and agents can start sessions on {}.", facts.this_box), Control::Switch { on: allowed, act: Act::SetOtherComputers(!allowed), held: false }),
                    |busy| Row::new("row-other-computers", "Let your other computers start work here", format!("Their bots and agents can start sessions on {}.", facts.this_box), busy),
                ));
            }
            blocks.push(Block::Group("Approval".into(), rows));
        }
        reading => blocks.extend(unread(reading, "note-approval", "approval")),
    }
    match facts.sandbox {
        Reading::Ready(sandbox) => {
            // BOX-NEEDED: why it's off and what to do, as sentences in `GET kuvo/sandbox` (`why` for every `reason`, and `actionLabel` for its button): drawn only as the box words them; otherwise one neutral line, and no button.
            let detail = if sandbox.on { String::new() } else { sandbox.why.clone().filter(|why| !why.trim().is_empty()).unwrap_or_else(|| "This needs your OK.".into()) };
            let control = facts.busy("row-sandbox").unwrap_or_else(|| match sandbox.button() {
                Some((label, method, path)) if !sandbox.on => Control::Buttons(vec![(label, Act::SandboxAction { method, path })]),
                _ => Control::Text(if sandbox.on { "On".into() } else { "Off".into() }),
            });
            let state = Row::new("row-sandbox", "Sandbox", detail, control).warning(!sandbox.on);
            blocks.push(Block::Group("Sandbox".into(), vec![state]));
        }
        reading => blocks.extend(unread(reading, "note-sandbox", "the sandbox")),
    }
    match facts.allowed {
        Reading::Ready(allowed) if allowed.is_empty() => {
            blocks.push(note("note-allowed", "Nothing else is allowed yet. When you choose Always on a stopped command’s card, its folder shows here.", false));
        }
        Reading::Ready(allowed) => {
            let rows = allowed
                .iter()
                .map(|rule| {
                    let key = format!("allowed-{}", rule.id);
                    let whose = rule.owner.as_ref().map(|owner| format!(" · for {}", owner.name)).unwrap_or_default();
                    let detail = if rule.gone { format!("Gone from this computer{whose}") } else { format!("Can write{whose}") };
                    let control = facts.busy(&key).unwrap_or(Control::Buttons(vec![("Remove".into(), Act::RemoveAllowed(rule.id.clone()))]));
                    Row::new(key, rule.path.clone(), detail, control)
                })
                .collect();
            blocks.push(Block::Group("Also Allowed".into(), rows));
        }
        reading => blocks.extend(unread(reading, "note-allowed", "the folders also allowed")),
    }
    blocks.push(note("note-rules", "Rules for what agents may do, and what’s always allowed, aren’t in this app yet: open Settings › Permissions in Kuvo Code on your Mac or iPhone.", false));
    blocks
}

// MARK: Notifications

fn notifications(facts: &Facts) -> Vec<Block> {
    let mut blocks = Vec::new();
    match facts.usage {
        Reading::Ready(usage) => {
            let notices = usage.notices;
            let row = |key: &str, title: &str, detail: &str, on: bool, act: fn(bool) -> Act| {
                Row::new(key, title, detail, facts.busy(key).unwrap_or(Control::Switch { on, act: act(!on), held: facts.group_busy("notice-") }))
            };
            let rows = vec![
                row("notice-almost-out", "Almost Out", "When a limit drops below 10% left.", notices.under_ten_percent, |on| Act::SetNotice(Notice::AlmostOut, on)),
                row("notice-close", "Cutting It Close", "When a limit is on pace to end with little left.", notices.healthy_to_close, |on| Act::SetNotice(Notice::CuttingItClose, on)),
                row("notice-run-out", "Will Run Out", "When a limit is on pace to run out before it starts over.", notices.close_to_running_out, |on| Act::SetNotice(Notice::WillRunOut, on)),
            ];
            blocks.push(Block::Group("Usage".into(), rows));
            for (ix, unavailable) in usage.unavailable.iter().enumerate() {
                blocks.push(note(&format!("note-unavailable-{ix}"), unavailable.message.clone(), false));
            }
        }
        reading => blocks.extend(unread(reading, "note-usage-settings", "the usage notices")),
    }
    // The Mac's own notifications (a session finished, one waits on you) are the Mac app's: this
    // app sends none yet.
    blocks.push(note("note-sessions-notices", "Notifications when a session finishes or waits on you aren’t in this app yet.", false));
    blocks
}

// MARK: Browser

fn browser(facts: &Facts) -> Vec<Block> {
    if let Some(note) = unread(facts.browser, "note-browser", "the browser’s settings") {
        return vec![note];
    }
    let Reading::Ready(settings) = facts.browser else { return Vec::new() };
    let shown = settings.search_engines.iter().find(|engine| engine.id == settings.search_engine).map_or_else(|| settings.search_engine.clone(), |engine| engine.title.clone());
    let choices = settings.search_engines.iter().map(|engine| (engine.title.clone(), Act::SetSearchEngine(engine.id.clone()), engine.id == settings.search_engine)).collect();
    let rows = vec![
        Row::new("row-search-engine", "Search engine", "For anything typed in the address field that isn’t an address.", facts.busy("row-search-engine").unwrap_or(Control::Menu { shown, choices })),
        Row::new(
            "row-tidies",
            "Close agents’ tabs you haven’t looked at",
            "An hour after an agent last used one, so tabs don’t pile up.",
            facts.busy("row-tidies").unwrap_or(Control::Switch { on: settings.tidies_agent_tabs, act: Act::SetTidies(!settings.tidies_agent_tabs), held: false }),
        ),
        Row::new(
            "row-offers",
            "Offer to save sign-ins",
            "When you sign in to a site in the browser.",
            facts.busy("row-offers").unwrap_or(Control::Switch { on: settings.offers_to_save, act: Act::SetOffersToSave(!settings.offers_to_save), held: false }),
        ),
    ];
    let mut blocks = vec![Block::Group("Browser".into(), rows)];
    if !settings.never.is_empty() {
        let rows = settings
            .never
            .iter()
            .map(|host| {
                let key = format!("never-{host}");
                let control = facts.busy(&key).unwrap_or_else(|| {
                    if facts.group_busy("never-") { Control::HeldButton("Offer Again".into()) } else { Control::Buttons(vec![("Offer Again".into(), Act::OfferAgain(host.clone()))]) }
                });
                Row::new(key.clone(), host.clone(), "Never offered to save a sign-in", control)
            })
            .collect();
        blocks.push(Block::Group("Never Offered".into(), rows));
    }
    blocks
}

/// A page's blocks with only the rows `query` (lowercase) finds; every row where the section's
/// own name matches, and none where nothing does.
pub fn found(section: &str, blocks: Vec<Block>, query: &str) -> Vec<Block> {
    if query.is_empty() || section.to_lowercase().contains(query) {
        return blocks;
    }
    blocks
        .into_iter()
        .filter_map(|block| match block {
            Block::Group(label, rows) if label.to_lowercase().contains(query) => Some(Block::Group(label, rows)),
            Block::Group(label, rows) => {
                let rows: Vec<Row> = rows.into_iter().filter(|row| row.matches(query)).collect();
                (!rows.is_empty()).then_some(Block::Group(label, rows))
            }
            Block::Note { .. } => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_keeps_the_rows_it_finds_and_whole_sections_it_names() {
        let blocks = vec![Block::Group("Browser".into(), vec![Row::new("a", "Search engine", "For the address field", Control::None), Row::new("b", "Offer to save sign-ins", "", Control::None)]), note("n", "words", false)];
        let found_rows = found("Browser", blocks.clone(), "engine");
        assert_eq!(found_rows.len(), 1);
        let Block::Group(_, rows) = &found_rows[0] else { panic!() };
        assert_eq!(rows.len(), 1);
        assert_eq!(found("Browser", blocks.clone(), "browser").len(), 2, "the section's name keeps it whole");
        assert!(found("Browser", blocks, "nothing like it").is_empty());
    }
}
