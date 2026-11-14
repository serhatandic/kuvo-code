//! Settings: its sidebar (a title, a search, the sections) and each section's page, for this box.
//! Every page reads its facts from the box as it opens, and every change goes through the box's
//! routes and comes back as the box answers it; the app decides nothing but what it draws.
//!
//! A page is drawn as Zed's settings are: its rows worked out once each time what they're drawn from
//! changes (the box's facts, the search, a change on its way), then a virtual list that lays out
//! only the rows on screen. Each group of rows is one card.

mod page;
mod rows;
pub mod sign_in;

use std::collections::HashMap;

use gpui::{App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, ListAlignment, ListState, Subscription, Task, px};
use kuvo_box::BoxClient;
use kuvo_box::accounts::{Accounts, Side, said};
use kuvo_box::areas::Account;
use kuvo_box::models::Offered;
use kuvo_box::settings::{Allowed, Approval, BrowserSettings, Config, Sandbox, UsageSettings};
use kuvo_ui::{ActiveTheme, Appearance, TextField, TextFieldEvent, Theme};
use serde_json::json;

use crate::areas::Reading;

pub use rows::{Act, Block, Control, Leading, Notice, Row, Tone};
use sign_in::SignIn;

/// The widest a page's cards grow.
const PAGE_WIDTH: f32 = 720.;

/// A section picked in the sidebar (`record`: by a click, so back and forward go to it), or by the
/// search finding nothing on the one open.
pub struct Pick {
    pub section: String,
    pub record: bool,
}

/// What a confirm asks before it does it.
#[derive(Clone, Debug, PartialEq)]
struct Confirm {
    title: String,
    body: String,
    button: String,
    act: Act,
}

/// The Settings area: its sidebar and its pages.
pub struct SettingsView {
    client: BoxClient,
    live: bool,
    section: String,
    search: Entity<TextField>,
    query: String,
    accounts: Reading<Accounts>,
    limits: Reading<Vec<Account>>,
    config: Reading<Config>,
    offered: Reading<Offered>,
    approval: Reading<Approval>,
    sandbox: Reading<Sandbox>,
    allowed: Reading<Vec<Allowed>>,
    browser: Reading<BrowserSettings>,
    usage: Reading<UsageSettings>,
    /// Rows with a change on its way, and what they say meanwhile.
    busy: Vec<(String, String)>,
    /// What the box last refused, shown over the page until it's closed or the page changes.
    problem: Option<String>,
    confirm: Option<Confirm>,
    sign_in: Option<Entity<SignIn>>,
    sign_in_closed: Option<Subscription>,
    /// The confirm asks for the keyboard as it opens (Escape cancels it).
    confirm_focus: FocusHandle,
    focus_confirm: bool,
    /// Drawn in dark (the Theme row says which is on).
    dark: bool,
    this_box: String,
    now: Option<f64>,
    /// The page as drawn: its blocks, flattened into the list's items.
    items: Vec<Item>,
    list: ListState,
    focus: FocusHandle,
    tasks: HashMap<String, Task<()>>,
    _subscriptions: Vec<Subscription>,
}

/// One of the page list's items.
#[derive(Clone, Debug, PartialEq)]
enum Item {
    Title(String),
    Group(String),
    Row { row: Box<Row>, first: bool, last: bool },
    Note { key: String, words: String, busy: bool },
    Placeholder,
    Nothing(String),
    End,
}

impl EventEmitter<Pick> for SettingsView {}

impl Focusable for SettingsView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl SettingsView {
    pub fn new(client: BoxClient, live: bool, cx: &mut Context<Self>) -> SettingsView {
        let search = cx.new(|cx| TextField::new(cx).bare().placeholder("Search settings…"));
        let subscription = cx.subscribe(&search, |this: &mut SettingsView, field, event: &TextFieldEvent, cx| match event {
            TextFieldEvent::Changed => {
                let query = field.read(cx).text().trim().to_lowercase();
                this.searched(query, cx);
            }
            TextFieldEvent::Cancel => field.update(cx, |field, cx| field.set_text("", cx)),
            TextFieldEvent::Submit(_) => {}
        });
        let mut view = SettingsView {
            client,
            live,
            section: "General".into(),
            search,
            query: String::new(),
            accounts: Reading::NotYet,
            limits: Reading::NotYet,
            config: Reading::NotYet,
            offered: Reading::NotYet,
            approval: Reading::NotYet,
            sandbox: Reading::NotYet,
            allowed: Reading::NotYet,
            browser: Reading::NotYet,
            usage: Reading::NotYet,
            busy: Vec::new(),
            problem: None,
            confirm: None,
            sign_in: None,
            sign_in_closed: None,
            confirm_focus: cx.focus_handle(),
            focus_confirm: false,
            dark: cx.theme().appearance.is_dark(),
            this_box: "this Mac".into(),
            now: None,
            items: Vec::new(),
            list: ListState::new(0, ListAlignment::Top, px(400.)),
            focus: cx.focus_handle(),
            tasks: HashMap::new(),
            _subscriptions: vec![subscription],
        };
        view.rebuild(cx);
        view
    }

    pub fn section(&self) -> &str {
        &self.section
    }

    pub fn search_field(&self) -> &Entity<TextField> {
        &self.search
    }

    /// The sign-in under way, if its sheet is open.
    pub fn sign_in(&self) -> Option<&Entity<SignIn>> {
        self.sign_in.as_ref()
    }

    pub fn set_now(&mut self, now: f64) {
        self.now = Some(now);
    }

    pub fn set_this_box(&mut self, name: &str, cx: &mut Context<Self>) {
        if self.this_box != name {
            self.this_box = name.to_owned();
            self.rebuild(cx);
        }
    }

    /// Shows `section`'s page, reading what it's drawn from.
    pub fn set_section(&mut self, section: &str, cx: &mut Context<Self>) {
        if self.section != section {
            self.section = section.to_owned();
            self.problem = None;
            self.list.scroll_to(gpui::ListOffset::default());
        }
        self.read_section(section, cx);
        self.rebuild(cx);
    }

    /// The area came on screen: the page open is read again.
    pub fn shown(&mut self, cx: &mut Context<Self>) {
        let section = self.section.clone();
        self.read_section(&section, cx);
    }

    fn searched(&mut self, query: String, cx: &mut Context<Self>) {
        if query == self.query {
            return;
        }
        // The first search reads every page, so what it finds on any can be listed.
        if self.query.is_empty() && !query.is_empty() {
            for (section, _) in rows::BUILT {
                if *section != self.section {
                    self.read_section(section, cx);
                }
            }
        }
        self.query = query;
        self.rebuild(cx);
    }

    /// While searching, the page open has nothing found: the first section that has (again as
    /// each page's reading comes in, so a search typed before they came finds them).
    fn follow_search(&mut self, cx: &mut Context<Self>) {
        if self.query.is_empty() {
            return;
        }
        let sections = self.sections_found();
        if !sections.iter().any(|section| *section == self.section)
            && let Some(first) = sections.first()
        {
            cx.emit(Pick { section: (*first).to_owned(), record: false });
        }
    }

    /// The sections the search finds something on (all of them without one).
    pub fn sections_found(&self) -> Vec<&'static str> {
        rows::BUILT
            .iter()
            .chain(rows::ELSEWHERE)
            .map(|(section, _)| *section)
            .filter(|section| self.query.is_empty() || section.to_lowercase().contains(&self.query) || !rows::found(section, rows::page(section, &self.facts()), &self.query).is_empty())
            .collect()
    }

    fn facts(&self) -> rows::Facts<'_> {
        rows::Facts {
            accounts: &self.accounts,
            limits: &self.limits,
            config: &self.config,
            offered: &self.offered,
            approval: &self.approval,
            sandbox: &self.sandbox,
            allowed: &self.allowed,
            browser: &self.browser,
            usage: &self.usage,
            busy: &self.busy,
            dark: self.dark,
            this_box: &self.this_box,
        }
    }

    /// Works the page's items out again, from what it's drawn from now.
    fn rebuild(&mut self, cx: &mut Context<Self>) {
        self.dark = cx.theme().appearance.is_dark();
        // A page not in this app is the placeholder alone: it names the section itself.
        let mut items = if rows::is_built(&self.section) { vec![Item::Title(self.section.clone())] } else { Vec::new() };
        if rows::is_built(&self.section) {
            let blocks = rows::found(&self.section, rows::page(&self.section, &self.facts()), &self.query);
            if blocks.is_empty() && !self.query.is_empty() {
                items.push(Item::Nothing(self.query.clone()));
            }
            for block in blocks {
                match block {
                    Block::Group(label, rows) => {
                        items.push(Item::Group(label));
                        let count = rows.len();
                        items.extend(rows.into_iter().enumerate().map(|(ix, row)| Item::Row { row: Box::new(row), first: ix == 0, last: ix + 1 == count }));
                    }
                    Block::Note { key, words, busy } => items.push(Item::Note { key, words, busy }),
                }
            }
        } else {
            items.push(Item::Placeholder);
        }
        items.push(Item::End);
        // Only the items that changed are laid out again; the rest keep their places and the
        // page keeps its scroll (a reset would take it back to the top).
        if items != self.items {
            let start = self.items.iter().zip(&items).take_while(|(old, new)| old == new).count();
            let tail = self.items[start..].iter().rev().zip(items[start..].iter().rev()).take_while(|(old, new)| old == new).count();
            self.list.splice(start..self.items.len() - tail, items.len() - tail - start);
            self.items = items;
        }
        self.follow_search(cx);
        cx.notify();
    }

    // MARK: Reading

    /// Runs `work` against the box, in the app off this thread, in tests and shots at once, and
    /// hands what it came to to `then`. A newer one under the same name replaces an older.
    fn run<T: Send + 'static>(
        &mut self,
        name: impl Into<String>,
        work: impl FnOnce(&BoxClient) -> T + Send + 'static,
        then: impl FnOnce(&mut SettingsView, T, &mut Context<SettingsView>) + 'static,
        cx: &mut Context<Self>,
    ) {
        let client = self.client.clone();
        if !self.live {
            let done = work(&client);
            then(self, done, cx);
            self.rebuild(cx);
            return;
        }
        let task = cx.spawn(async move |this, cx| {
            let done = cx.background_executor().spawn(async move { work(&client) }).await;
            this.update(cx, |this, cx| {
                then(this, done, cx);
                this.rebuild(cx);
            })
            .ok();
        });
        self.tasks.insert(name.into(), task);
    }

    fn read_section(&mut self, section: &str, cx: &mut Context<Self>) {
        match section {
            "Accounts" => self.run("read-accounts", |client| client.sign_in_accounts(), |this, read, _| this.accounts = accounts_reading(read, &this.accounts), cx),
            "Usage" => self.run("read-limits", |client| client.accounts(), |this, read, _| this.limits = reading(read, &this.limits), cx),
            "Models" => {
                self.run("read-config", |client| client.config(), |this, read, _| this.config = reading(read, &this.config), cx);
                self.run("read-offered", |client| client.offered_models(None, None), |this, read, _| this.offered = reading(read, &this.offered), cx);
            }
            "Permissions" => {
                self.run("read-approval", |client| client.approval(), |this, read, _| this.approval = reading(read, &this.approval), cx);
                self.run("read-sandbox", |client| client.sandbox(), |this, read, _| this.sandbox = reading(read, &this.sandbox), cx);
                self.run("read-allowed", |client| client.also_allowed(), |this, read, _| this.allowed = reading(read, &this.allowed), cx);
            }
            "Notifications" => self.run("read-usage", |client| client.usage_settings(), |this, read, _| this.usage = reading(read, &this.usage), cx),
            "Browser" => self.run("read-browser", |client| client.browser_settings(), |this, read, _| this.browser = reading(read, &this.browser), cx),
            _ => {}
        }
    }

    // MARK: Changes

    fn set_busy(&mut self, key: &str, words: &str) {
        self.busy.retain(|(busy, _)| busy != key);
        self.busy.push((key.to_owned(), words.to_owned()));
    }

    fn done(&mut self, key: &str) {
        self.busy.retain(|(busy, _)| busy != key);
    }

    /// What a row's control asked for.
    pub fn act(&mut self, act: Act, cx: &mut Context<Self>) {
        self.problem = None;
        match act {
            Act::SignIn { side, account, name } => self.open_sign_in(side, &account, &name, cx),
            Act::Install { account, name } => {
                let key = format!("account-{account}");
                self.set_busy(&key, "Installing…");
                let installing = account.clone();
                self.run(
                    key.clone(),
                    move |client| client.install_agent(&installing),
                    move |this, done, cx| {
                        this.done(&key);
                        match done {
                            Ok(installed) if installed.installed => {
                                this.run("read-accounts", |client| client.sign_in_accounts(), |this, read, _| this.accounts = accounts_reading(read, &this.accounts), cx);
                                // Installed: on to signing in, as the Mac does.
                                if this.offers_sign_in(Side::Agents, &account) {
                                    this.open_sign_in(Side::Agents, &account, &name, cx);
                                }
                            }
                            Ok(installed) => this.problem = Some(format!("{name} couldn’t be installed. {}", installed.message.unwrap_or_else(|| "It isn’t installed.".into()))),
                            Err(error) => this.problem = Some(format!("{name} couldn’t be installed. {}", said(&error))),
                        }
                    },
                    cx,
                );
            }
            Act::Disconnect { account, name } => {
                self.focus_confirm = true;
                self.confirm = Some(Confirm {
                    title: format!("Disconnect {name}?"),
                    body: format!("{} forgets its sign-ins and keys for {name}. Sessions on its models stop until you sign in again.", capitalized(&self.this_box)),
                    button: "Disconnect".into(),
                    act: Act::Disconnect { account, name },
                });
            }
            Act::RemoveAgent { account, name } => {
                self.focus_confirm = true;
                self.confirm = Some(Confirm {
                    title: format!("Remove {name}?"),
                    body: "Kuvo Code signs it out and forgets it. Sessions on its models go on when you pick another model.".into(),
                    button: "Remove".into(),
                    act: Act::RemoveAgent { account, name },
                });
            }
            Act::SignOut { account } => self.account_change(account.clone(), move |client| client.sign_out_agent(&account), "Signing out…", cx),
            Act::SetModel { path, model, was } => {
                let key = rows_model_key(path);
                self.set_busy(&key, "Saving…");
                self.run(
                    key.clone(),
                    move |client| client.set_config(path, model.as_deref(), was.as_deref()),
                    move |this, done, cx| {
                        this.done(&key);
                        match done {
                            Ok(config) => this.config = Reading::Ready(config),
                            Err(error) => {
                                // Refused (changed meanwhile, or unreadable): what's there now.
                                this.problem = Some(said(&error));
                                this.read_section("Models", cx);
                            }
                        }
                    },
                    cx,
                );
            }
            Act::SetOtherComputers(allowed) => self.change(
                "row-other-computers",
                move |client| client.set_other_computers(allowed),
                |this, approval| this.approval = Reading::Ready(approval),
                cx,
            ),
            Act::CheckSandbox => {
                self.set_busy("row-sandbox", "Checking…");
                self.run(
                    "row-sandbox",
                    |client| client.check_sandbox().and_then(|_| client.sandbox()),
                    |this, done, _| {
                        this.done("row-sandbox");
                        match done {
                            Ok(sandbox) => this.sandbox = Reading::Ready(sandbox),
                            Err(error) => this.problem = Some(said(&error)),
                        }
                    },
                    cx,
                );
            }
            Act::RemoveAllowed(id) => {
                let key = format!("allowed-{id}");
                self.change(&key, move |client| client.remove_allowed(&id).and_then(|_| client.also_allowed()), |this, allowed| this.allowed = Reading::Ready(allowed), cx)
            }
            Act::SetSearchEngine(engine) => self.change("row-search-engine", move |client| client.set_browser_settings(json!({ "searchEngine": engine })), |this, settings| this.browser = Reading::Ready(settings), cx),
            Act::SetTidies(on) => self.change("row-tidies", move |client| client.set_browser_settings(json!({ "tidiesAgentTabs": on })), |this, settings| this.browser = Reading::Ready(settings), cx),
            Act::SetOffersToSave(on) => self.change("row-offers", move |client| client.set_browser_settings(json!({ "offersToSave": on })), |this, settings| this.browser = Reading::Ready(settings), cx),
            Act::OfferAgain(host) => {
                let never: Vec<String> = match &self.browser {
                    Reading::Ready(settings) => settings.never.iter().filter(|each| **each != host).cloned().collect(),
                    _ => return,
                };
                self.change(&format!("never-{host}"), move |client| client.set_browser_settings(json!({ "never": never })), |this, settings| this.browser = Reading::Ready(settings), cx)
            }
            Act::SetNotice(notice, on) => {
                let Reading::Ready(usage) = &self.usage else { return };
                let mut notices = usage.notices;
                let key = match notice {
                    Notice::AlmostOut => {
                        notices.under_ten_percent = on;
                        "notice-almost-out"
                    }
                    Notice::CuttingItClose => {
                        notices.healthy_to_close = on;
                        "notice-close"
                    }
                    Notice::WillRunOut => {
                        notices.close_to_running_out = on;
                        "notice-run-out"
                    }
                };
                let based = usage.version.clone();
                // A part changed on another computer meanwhile is turned away: the box's is shown.
                self.change(key, move |client| client.set_usage_notices(notices, based.as_deref()), |this, usage| this.usage = Reading::Ready(usage), cx)
            }
            Act::SetDark(dark) => {
                Theme::set_appearance(if dark { Appearance::Dark } else { Appearance::Light }, cx);
                self.rebuild(cx);
            }
        }
        self.rebuild(cx);
    }

    /// A change to a row: busy while it goes, then the box's answer, or its refusal over the page.
    fn change<T: Send + 'static>(
        &mut self,
        key: &str,
        work: impl FnOnce(&BoxClient) -> kuvo_box::Result<T> + Send + 'static,
        take: impl FnOnce(&mut SettingsView, T) + 'static,
        cx: &mut Context<Self>,
    ) {
        let key = key.to_owned();
        self.set_busy(&key, "Saving…");
        let done_key = key.clone();
        self.run(
            key,
            work,
            move |this, done, _| {
                this.done(&done_key);
                match done {
                    Ok(value) => take(this, value),
                    Err(error) => this.problem = Some(said(&error)),
                }
            },
            cx,
        );
    }

    /// A change to an account, then the accounts read again.
    fn account_change(&mut self, account: String, work: impl FnOnce(&BoxClient) -> kuvo_box::Result<()> + Send + 'static, words: &str, cx: &mut Context<Self>) {
        let key = format!("account-{account}");
        self.set_busy(&key, words);
        let done_key = key.clone();
        self.run(
            key,
            move |client| work(client).and_then(|_| client.sign_in_accounts()),
            move |this, done, _| {
                this.done(&done_key);
                match done {
                    Ok(accounts) => this.accounts = accounts_reading(Ok(accounts), &this.accounts),
                    Err(error) => this.problem = Some(said(&error)),
                }
            },
            cx,
        );
    }

    fn confirmed(&mut self, cx: &mut Context<Self>) {
        let Some(confirm) = self.confirm.take() else { return };
        match confirm.act {
            Act::Disconnect { account, .. } => {
                let forgetting = account.clone();
                self.account_change(account, move |client| client.forget_account(&forgetting), "Disconnecting…", cx)
            }
            Act::RemoveAgent { account, .. } => {
                let removing = account.clone();
                self.account_change(account, move |client| client.remove_agent_account(&removing), "Removing…", cx)
            }
            _ => {}
        }
        self.rebuild(cx);
    }

    // MARK: Signing in

    fn offers_sign_in(&self, side: Side, account: &str) -> bool {
        let Reading::Ready(accounts) = &self.accounts else { return false };
        let list = if side == Side::Agents { &accounts.agents } else { &accounts.engine };
        list.iter().any(|entry| entry.integration.id == account && entry.offers_sign_in())
    }

    pub fn open_sign_in(&mut self, side: Side, account: &str, name: &str, cx: &mut Context<Self>) {
        let sheet = cx.new(|cx| SignIn::new(self.client.clone(), self.live, side, account, name, cx));
        // Closed, however it ended (a key may have gone in as it closed): Accounts read again.
        self.sign_in_closed = Some(cx.subscribe(&sheet, |this: &mut SettingsView, _, _: &sign_in::Closed, cx| {
            this.sign_in = None;
            this.sign_in_closed = None;
            this.run("read-accounts", |client| client.sign_in_accounts(), |this, read, _| this.accounts = accounts_reading(read, &this.accounts), cx);
            cx.notify();
        }));
        sheet.update(cx, |sheet, cx| sheet.start(cx));
        self.sign_in = Some(sheet);
        cx.notify();
    }
}

/// The key of a model setting's row.
fn rows_model_key(path: &[&str]) -> String {
    let ix = ["model", "agents", "subagent_model"].iter().position(|first| path.first() == Some(first)).unwrap_or(0);
    format!("model-{ix}")
}

fn capitalized(words: &str) -> String {
    let mut chars = words.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// Accounts as read, where the box couldn't say which sign-ins ended just now keeping what it
/// said before (PROTOCOL.md: `kuvo/accounts/ended` answers 503 then, and a client keeps it).
fn accounts_reading(read: kuvo_box::Result<Accounts>, before: &Reading<Accounts>) -> Reading<Accounts> {
    let read = read.map(|mut accounts| {
        if accounts.ended_unknown
            && let Reading::Ready(before) = before
        {
            for entry in accounts.engine.iter_mut().chain(accounts.agents.iter_mut()) {
                entry.ended = before.engine.iter().chain(&before.agents).any(|was| was.integration.id == entry.integration.id && was.ended);
            }
        }
        accounts
    });
    reading(read, before)
}

/// What a read makes of what's shown: what it read, or (failing) what was there, else why.
fn reading<T: Clone>(read: kuvo_box::Result<T>, before: &Reading<T>) -> Reading<T> {
    match (read, before) {
        (Ok(value), _) => Reading::Ready(value),
        (Err(_), Reading::Ready(value)) => Reading::Ready(value.clone()),
        (Err(error), _) => Reading::Failed(said(&error)),
    }
}
