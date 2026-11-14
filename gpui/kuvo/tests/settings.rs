//! Settings as someone uses it, against the stand-in box (nothing real is reached, no key is
//! real): its sections and their pages, the search, each change going to the box's route, and
//! signing in each way the box offers (in the browser, with a device code, a code pasted back, a
//! key, credentials with a form, an agent installed first), failing, giving up, and signing out.
//! Clicks and keys go through the window; a sign-in is followed on the test's own clock.

use gpui::{Bounds, Entity, Modifiers, Pixels, TestAppContext, VisualTestContext, px, size};
use kuvo::area::Area;
use kuvo::settings::SettingsView;
use kuvo::settings::sign_in::{POLL, Step};
use kuvo::stand_in::settings::Ending;
use kuvo::stand_in::{Replies, StandIn};
use kuvo::workspace::Workspace;
use kuvo_box::BoxClient;
use kuvo_ui::{Appearance, Theme};
use serde_json::json;

const NOW: f64 = 1_794_650_000_000.0;

fn open(cx: &mut TestAppContext, stand_in: StandIn) -> (Entity<Workspace>, &mut VisualTestContext) {
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        kuvo::bind_keys(cx);
    });
    let client = BoxClient::new(stand_in);
    let window = cx.add_window(move |window, cx| Workspace::new(client, false, window, cx));
    let workspace = window.root(cx).unwrap();
    let cx = VisualTestContext::from_window(window.into(), cx).into_mut();
    cx.simulate_resize(size(px(1280.), px(1800.)));
    workspace.update_in(cx, |workspace, _, cx| {
        workspace.set_now(NOW, cx);
        workspace.read_at_once(cx);
    });
    cx.run_until_parked();
    (workspace, cx)
}

fn bounds(cx: &mut VisualTestContext, selector: &str) -> Option<Bounds<Pixels>> {
    cx.debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
}

fn click(cx: &mut VisualTestContext, selector: &str) {
    let at = bounds(cx, selector).unwrap_or_else(|| panic!("{selector} isn't on screen"));
    cx.simulate_click(at.center(), Modifiers::default());
    cx.run_until_parked();
}

fn shown(cx: &mut VisualTestContext, selector: &str) -> bool {
    bounds(cx, selector).is_some()
}

fn settings(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Entity<SettingsView> {
    workspace.read_with(cx, |workspace, cx| workspace.area_view(Area::Settings).and_then(|view| view.read(cx).settings().cloned()).expect("Settings"))
}

/// Settings, on `section`, picked in its sidebar.
fn section(workspace: &Entity<Workspace>, cx: &mut VisualTestContext, name: &str) -> Entity<SettingsView> {
    if workspace.read_with(cx, |workspace, _| workspace.area()) != Area::Settings {
        click(cx, "rail-settings");
    }
    click(cx, &format!("setting-{name}"));
    settings(workspace, cx)
}

fn step(view: &Entity<SettingsView>, cx: &mut VisualTestContext) -> Option<Step> {
    view.read_with(cx, |view, cx| view.sign_in().map(|sheet| sheet.read(cx).step().clone()))
}

/// The sign-in's clock moves on: the box is asked how it goes.
fn tick(cx: &mut VisualTestContext) {
    cx.executor().advance_clock(POLL);
    cx.run_until_parked();
}

fn bodies(stand_in: &StandIn, method: &str, route: &str) -> Vec<serde_json::Value> {
    stand_in.seen_at(method, route).into_iter().filter_map(|seen| seen.body).collect()
}

#[gpui::test]
fn the_sidebar_lists_the_sections_and_each_opens_its_page(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    click(cx, "rail-settings");
    assert!(shown(cx, "settings-search"));
    assert!(shown(cx, "row-theme"), "General first");
    // Only the page on screen asks the box anything.
    assert!(stand_in.seen_at("GET", "kuvo/browser/settings").is_empty());
    for (name, row) in [("Accounts", "account-claude-code"), ("Usage", "usage-0"), ("Models", "model-0"), ("Permissions", "row-sandbox"), ("Notifications", "notice-almost-out"), ("Browser", "row-search-engine")] {
        section(&workspace, cx, name);
        assert!(shown(cx, row), "{name} shows {row}");
        assert_eq!(workspace.read_with(cx, |workspace, cx| workspace.title(cx).0.map(|title| title.to_string())).as_deref(), Some(name));
    }
    // A section the box serves no page for here says so.
    section(&workspace, cx, "Git");
    assert!(shown(cx, "placeholder"));
    // Back goes to the section before.
    cx.simulate_keystrokes("cmd-[");
    cx.run_until_parked();
    assert!(shown(cx, "row-search-engine"));
}

#[gpui::test]
fn the_search_finds_sections_and_rows(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    section(&workspace, cx, "Models");
    click(cx, "settings-search");
    cx.simulate_input("search engine");
    cx.run_until_parked();
    assert!(shown(cx, "setting-Browser"));
    assert!(!shown(cx, "setting-Models") && !shown(cx, "setting-Accounts"), "sections with nothing found leave");
    // The page open had nothing: the first that has is shown, with only what was found.
    assert!(shown(cx, "row-search-engine"));
    assert!(!shown(cx, "row-tidies"));
    // An account's name finds it too.
    cx.simulate_keystrokes("cmd-a backspace");
    cx.simulate_input("copilot");
    cx.run_until_parked();
    assert!(shown(cx, "setting-Accounts"));
    assert!(shown(cx, "account-github-copilot") && !shown(cx, "account-openrouter"));
    // Escape clears it: every section again.
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(shown(cx, "setting-Models") && shown(cx, "setting-Git"));
}

// MARK: Accounts

#[gpui::test]
fn accounts_lists_the_agents_and_providers_as_the_box_says_them(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    section(&workspace, cx, "Accounts");
    for row in ["account-claude-code", "account-claude-code@w0rk1a2b", "account-codex-cli", "account-cursor", "account-grok-cli", "account-github-copilot", "account-anthropic", "account-groq"] {
        assert!(shown(cx, row), "{row}");
    }
    assert!(!shown(cx, "account-tavily") && !shown(cx, "account-linear"), "a search service and an MCP server's sign-in aren't accounts");
    // Signed in, ended, never: each says so, with the box's ways.
    assert!(shown(cx, "account-antigravity-sign-in-again"), "an agent whose sign-in ended");
    assert!(shown(cx, "account-gitlab-sign-in-again") && shown(cx, "account-gitlab-disconnect"), "an engine plan the box says ended");
    assert!(shown(cx, "account-cursor-sign-in"));
    assert!(shown(cx, "account-grok-cli-install"));
    assert!(shown(cx, "account-anthropic-connect"));
    assert!(!shown(cx, "account-groq-connect"), "no way in to offer: only its variable");
    // The coding agents not running: the box's words, and the engine's accounts still.
    stand_in.agents_running(false);
    section(&workspace, cx, "Usage");
    section(&workspace, cx, "Accounts");
    assert!(shown(cx, "note-agents-down"));
    assert!(shown(cx, "account-github-copilot"));
}

#[gpui::test]
fn signing_in_in_the_browser_follows_the_box_until_it_goes_through(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let view = section(&workspace, cx, "Accounts");
    click(cx, "account-gitlab-sign-in-again");
    // Its one way starts at once: the page opens, and it waits.
    assert!(matches!(step(&view, cx), Some(Step::Waiting { .. })));
    assert_eq!(bodies(&stand_in, "POST", "api/integration/gitlab/connect/oauth"), vec![json!({ "methodID": "browser" })]);
    assert!(cx.opened_url().is_some_and(|url| url.starts_with("https://sign-in.stand-in.invalid/gitlab")));
    assert!(shown(cx, "sign-in-waiting"));
    tick(cx);
    assert!(stand_in.seen_at("GET", "kuvo/sign-in/status").len() == 1, "asked how it goes");
    assert!(matches!(step(&view, cx), Some(Step::Waiting { .. })));
    stand_in.end_sign_ins(Ending::Complete, None);
    tick(cx);
    assert_eq!(step(&view, cx), Some(Step::Done));
    click(cx, "sign-in-done");
    assert!(!shown(cx, "sign-in"));
    // Read again: signed in, no longer ended.
    assert!(!shown(cx, "account-gitlab-sign-in-again"));
    assert!(shown(cx, "account-gitlab-disconnect"));
}

#[gpui::test]
fn a_device_code_is_shown_and_copied_after_disconnecting(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    section(&workspace, cx, "Accounts");
    // Disconnect is asked first, then goes to the box's route.
    click(cx, "account-github-copilot-disconnect");
    assert!(shown(cx, "settings-confirm"));
    assert!(stand_in.seen_at("POST", "kuvo/accounts/github-copilot/forget").is_empty());
    click(cx, "confirm-go");
    assert_eq!(stand_in.seen_at("POST", "kuvo/accounts/github-copilot/forget").len(), 1);
    // Now under Add a Provider: Connect, and its device code.
    click(cx, "account-github-copilot-connect");
    assert!(shown(cx, "sign-in-user-code"));
    assert_eq!(cx.read_from_clipboard().and_then(|item| item.text()).as_deref(), Some("WDJB-MJHT"), "copied for the page");
}

#[gpui::test]
fn a_code_pasted_back_finishes_an_agents_sign_in(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let view = section(&workspace, cx, "Accounts");
    click(cx, "account-claude-code-menu");
    click(cx, "menu-item-Sign In Again…");
    assert!(matches!(step(&view, cx), Some(Step::Waiting { .. })));
    assert_eq!(bodies(&stand_in, "POST", "kuvo/agents/api/integration/claude-code/connect/oauth").len(), 1, "through the agents' bridge");
    click(cx, "sign-in-paste");
    cx.simulate_input("wrong-code");
    click(cx, "sign-in-send-code");
    assert!(shown(cx, "sign-in-code-error"), "turned down, in the box's words");
    assert!(matches!(step(&view, cx), Some(Step::Waiting { .. })));
    click(cx, "sign-in-code");
    cx.simulate_keystrokes("cmd-a backspace");
    cx.simulate_input("stand-in-code");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(step(&view, cx), Some(Step::Done));
}

#[gpui::test]
fn a_key_turned_down_stays_with_why_and_a_good_one_connects(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let view = section(&workspace, cx, "Accounts");
    click(cx, "account-openai-connect");
    assert!(matches!(step(&view, cx), Some(Step::Key(_))), "its only way is a key");
    cx.simulate_input("not-a-real-key");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(matches!(step(&view, cx), Some(Step::Key(_))));
    let sheet = view.read_with(cx, |view, _| view.sign_in().cloned().unwrap());
    let error = sheet.read_with(cx, |sheet, cx| sheet.key_field().read(cx).error().map(|error| error.to_string()));
    assert_eq!(error.as_deref(), Some("That key wasn’t accepted (401 Unauthorized)."));
    cx.simulate_keystrokes("cmd-a backspace");
    cx.simulate_input("sk-stand-in-key");
    click(cx, "sign-in-connect");
    assert_eq!(step(&view, cx), Some(Step::Done));
    assert_eq!(bodies(&stand_in, "POST", "api/integration/openai/connect/key").last(), Some(&json!({ "key": "sk-stand-in-key" })));
}

#[gpui::test]
fn credentials_on_the_computer_take_their_forms_answer(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let view = section(&workspace, cx, "Accounts");
    click(cx, "account-amazon-bedrock-connect");
    assert_eq!(step(&view, cx), Some(Step::Choose), "two ways: chosen");
    assert!(shown(cx, "sign-in-way-0") && shown(cx, "sign-in-way-1"));
    click(cx, "sign-in-way-0");
    assert!(matches!(step(&view, cx), Some(Step::Form(_))), "its region first");
    cx.simulate_keystrokes("cmd-a backspace");
    cx.simulate_input("eu-west-1");
    click(cx, "sign-in-continue");
    assert_eq!(step(&view, cx), Some(Step::Done));
    assert_eq!(bodies(&stand_in, "POST", "api/integration/amazon-bedrock/connect/external"), vec![json!({ "methodID": "aws", "answer": { "region": "eu-west-1" } })]);
}

#[gpui::test]
fn the_ways_in_come_in_the_boxs_order_with_legacy_ones_apart(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let view = section(&workspace, cx, "Accounts");
    click(cx, "account-anthropic-connect");
    let labels = view.read_with(cx, |view, cx| view.sign_in().unwrap().read(cx).ways().primary().map(|way| way.label.clone()).collect::<Vec<_>>());
    assert_eq!(labels, ["Claude Pro/Max", "Create an API Key", "Manually enter API Key"]);
    assert!(!shown(cx, "sign-in-way-3"), "the legacy way waits under Other ways");
    click(cx, "sign-in-others");
    assert!(shown(cx, "sign-in-way-3"));
}

#[gpui::test]
fn a_sign_in_turned_down_says_why_in_the_boxs_words(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let view = section(&workspace, cx, "Accounts");
    click(cx, "account-poe-connect");
    tick(cx);
    assert_eq!(step(&view, cx), Some(Step::Failed("The sign-in was turned down on its page. Try again to sign in.".into())));
    assert!(shown(cx, "sign-in-failure"));
    // Try Again starts over from its ways.
    click(cx, "sign-in-again");
    assert!(matches!(step(&view, cx), Some(Step::Waiting { .. })));
}

#[gpui::test]
fn cancelling_a_sign_in_gives_it_up_on_the_engine(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let view = section(&workspace, cx, "Accounts");
    click(cx, "account-cursor-sign-in");
    click(cx, "sign-in-way-0");
    assert!(matches!(step(&view, cx), Some(Step::Waiting { .. })));
    click(cx, "sign-in-cancel");
    assert_eq!(stand_in.seen_at("DELETE", "kuvo/agents/api/integration/cursor/connect/oauth/att_1").len(), 1);
    assert_eq!(step(&view, cx), Some(Step::Choose));
    // Closed: no more asking.
    click(cx, "sign-in-x");
    let asked = stand_in.seen_at("GET", "kuvo/sign-in/status").len();
    tick(cx);
    assert_eq!(stand_in.seen_at("GET", "kuvo/sign-in/status").len(), asked);
}

#[gpui::test]
fn an_agent_not_installed_is_installed_then_signed_in(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let view = section(&workspace, cx, "Accounts");
    click(cx, "account-grok-cli-install");
    assert_eq!(stand_in.seen_at("POST", "kuvo/agents/api/integration/grok-cli/install").len(), 1);
    assert!(matches!(step(&view, cx), Some(Step::Waiting { .. })), "on to signing in");
}

#[gpui::test]
fn an_agent_signs_out_and_an_added_account_is_removed_asked_first(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    section(&workspace, cx, "Accounts");
    click(cx, "account-codex-cli-menu");
    click(cx, "menu-item-Sign Out");
    assert_eq!(stand_in.seen_at("POST", "kuvo/agents/api/integration/codex-cli/disconnect").len(), 1);
    assert!(shown(cx, "account-codex-cli-sign-in"));
    click(cx, "account-claude-code@w0rk1a2b-menu");
    click(cx, "menu-item-Remove Account…");
    assert!(shown(cx, "settings-confirm"));
    click(cx, "confirm-go");
    assert_eq!(stand_in.seen_at("DELETE", "kuvo/agents/api/kuvo/accounts/claude-code%40w0rk1a2b").len(), 1);
    assert!(!shown(cx, "account-claude-code@w0rk1a2b"));
}

// MARK: The other sections

#[gpui::test]
fn models_are_set_in_this_computers_settings_from_what_was_read(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    section(&workspace, cx, "Models");
    click(cx, "model-2-menu");
    click(cx, "menu-item-GPT-6");
    assert_eq!(bodies(&stand_in, "PATCH", "kuvo/config"), vec![json!({ "changes": [{ "path": ["subagent_model"], "value": "openai/gpt-6", "was": null }] })]);
    // The box's answer is shown: the menu names it.
    click(cx, "model-2-menu");
    click(cx, "menu-item-Same as the conversation");
    assert_eq!(bodies(&stand_in, "PATCH", "kuvo/config").last(), Some(&json!({ "changes": [{ "path": ["subagent_model"], "value": null, "was": "openai/gpt-6" }] })));
}

#[gpui::test]
fn permissions_show_the_boxs_approval_and_sandbox_and_change_through_it(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    section(&workspace, cx, "Permissions");
    assert!(shown(cx, "row-default-mode") && shown(cx, "row-full-access"));
    click(cx, "row-other-computers-switch");
    assert_eq!(bodies(&stand_in, "PATCH", "kuvo/approval"), vec![json!({ "otherComputers": true })]);
    click(cx, "row-sandbox-check-again");
    assert_eq!(stand_in.seen_at("POST", "kuvo/sandbox/check").len(), 1);
    click(cx, "allowed-alw_1-remove");
    assert_eq!(stand_in.seen_at("DELETE", "kuvo/sandbox/allowed/alw_1").len(), 1);
    assert!(!shown(cx, "allowed-alw_1") && shown(cx, "allowed-alw_2"));
}

#[gpui::test]
fn usage_notices_change_as_one_part_from_the_version_read(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    section(&workspace, cx, "Notifications");
    assert!(shown(cx, "note-unavailable-0"), "a provider that can't send them, in the box's words");
    click(cx, "notice-close-switch");
    assert_eq!(
        bodies(&stand_in, "PUT", "kuvo/agents/api/kuvo/usage/settings"),
        vec![json!({ "notifications": { "underTenPercent": true, "healthyToClose": true, "closeToRunningOut": true }, "based": { "notifications": "3/mac" } })]
    );
    // The next change is based on the version the box answered.
    click(cx, "notice-almost-out-switch");
    assert_eq!(bodies(&stand_in, "PUT", "kuvo/agents/api/kuvo/usage/settings").last().and_then(|body| body.pointer("/based/notifications").cloned()), Some(json!("4/mac")));
}

#[gpui::test]
fn the_browsers_settings_change_through_the_box(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    section(&workspace, cx, "Browser");
    click(cx, "row-search-engine-menu");
    click(cx, "menu-item-Kagi");
    click(cx, "row-tidies-switch");
    click(cx, "never-bank.example-offer-again");
    assert_eq!(
        bodies(&stand_in, "PATCH", "kuvo/browser/settings"),
        vec![json!({ "searchEngine": "kagi" }), json!({ "tidiesAgentTabs": false }), json!({ "never": ["intranet.example"] })]
    );
    assert!(!shown(cx, "never-bank.example"));
}

#[gpui::test]
fn the_theme_row_switches_light_and_dark(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    section(&workspace, cx, "General");
    click(cx, "row-theme-menu");
    click(cx, "menu-item-Dark");
    assert!(cx.update(|_, cx| kuvo_ui::ActiveTheme::theme(cx).appearance.is_dark()));
}

#[gpui::test]
fn usage_lists_each_accounts_windows_as_the_rings_do(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let view = section(&workspace, cx, "Usage");
    for row in ["usage-0", "usage-1", "usage-2", "usage-3", "usage-4", "usage-5"] {
        assert!(shown(cx, row), "{row}");
    }
    let _ = view;
}

#[gpui::test]
fn usage_on_a_first_run_says_theres_nothing_yet(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::empty(Replies::Never));
    section(&workspace, cx, "Usage");
    assert!(shown(cx, "note-usage-none"));
}

#[gpui::test]
fn a_change_the_box_turns_down_is_said_over_the_page(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    section(&workspace, cx, "Models");
    // Changed on its computer meanwhile: refused, and read again.
    stand_in.set_config_value(&["model"], json!("google/gemini-3-pro"));
    click(cx, "model-0-menu");
    click(cx, "menu-item-GPT-6");
    assert!(shown(cx, "settings-problem"));
    assert_eq!(stand_in.seen_at("GET", "kuvo/config").len(), 2);
    click(cx, "settings-problem-close");
    assert!(!shown(cx, "settings-problem"));
}
