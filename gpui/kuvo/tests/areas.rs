//! The rail and its areas as someone uses them, against the stand-in box (nothing real is
//! reached): switching areas by the rail and by ⌃1 to ⌃5, folding the area's sidebar by its
//! button and in a narrow window, "Needs you" on top of Sessions, back and forward, and the rings.
//! Clicks and keys go through the window as AppKit hands them on.

use gpui::{Bounds, Entity, Modifiers, Pixels, TestAppContext, VisualTestContext, px, size};
use kuvo::area::Area;
use kuvo::stand_in::{Replies, StandIn};
use kuvo::workspace::Workspace;
use kuvo_box::BoxClient;
use kuvo_ui::{Appearance, Theme};

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
    cx.simulate_resize(size(px(1200.), px(800.)));
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

fn area(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Area {
    workspace.read_with(cx, |workspace, _| workspace.area())
}

fn title(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Option<String> {
    workspace.read_with(cx, |workspace, cx| workspace.title(cx).0.map(|title| title.to_string()))
}

#[gpui::test]
fn the_rail_switches_areas_and_sessions_comes_back_to_what_was_open(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    click(cx, "session-project-ses_signup");
    assert_eq!(title(&workspace, cx).as_deref(), Some("Fix the sign-up form wiping on a taken email"));

    // Bots: its sidebar lists the box's bots, and its page isn't in the app yet.
    click(cx, "rail-bots");
    assert_eq!(area(&workspace, cx), Area::Bots);
    assert!(bounds(cx, "bot-bot_mira").is_some());
    assert!(bounds(cx, "group-grp_launch").is_some(), "group chats under the bots");
    assert!(bounds(cx, "session-project-ses_signup").is_none(), "only the open area's sidebar shows");
    assert!(bounds(cx, "placeholder").is_some());
    click(cx, "bot-bot_mira");
    assert_eq!(title(&workspace, cx).as_deref(), Some("Mira"));

    // Back to Sessions: the conversation that was open.

    click(cx, "rail-sessions");
    assert_eq!(area(&workspace, cx), Area::Sessions);
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)), Some("ses_signup".into()));
    assert!(bounds(cx, "placeholder").is_none());
    assert!(bounds(cx, "session-project-ses_signup").is_some());
}

#[gpui::test]
fn only_the_area_on_screen_asks_the_box(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (_workspace, cx) = open(cx, stand_in.clone());
    assert!(stand_in.seen_at("GET", "kuvo/bots").is_empty());
    assert!(stand_in.seen_at("GET", "kuvo/work-queue/categories").is_empty());
    assert!(stand_in.seen_at("GET", "kuvo/machines").is_empty());
    click(cx, "rail-queue");
    assert_eq!(stand_in.seen_at("GET", "kuvo/work-queue/categories").len(), 1);
    assert!(stand_in.seen_at("GET", "kuvo/bots").is_empty());
}

#[gpui::test]
fn control_one_to_five_switch_areas_from_anywhere_in_the_window(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    // From the composer of a conversation, as from anywhere.
    click(cx, "session-project-ses_limits");
    for (keys, expected, shown) in [
        ("ctrl-2", Area::Bots, "bot-bot_inbox"),
        ("ctrl-3", Area::Queue, "category-next"),
        ("ctrl-4", Area::Computers, "computer-machine-devbox"),
        ("ctrl-5", Area::Settings, "setting-General"),
        ("ctrl-1", Area::Sessions, "session-project-ses_limits"),
    ] {
        cx.simulate_keystrokes(keys);
        cx.run_until_parked();
        assert_eq!(area(&workspace, cx), expected, "{keys}");
        assert!(bounds(cx, shown).is_some(), "{keys} shows {shown}");
    }
    // Back in Sessions, the keyboard is back in its conversation: typing goes to its composer.
    cx.simulate_input("ok");
    let composer = workspace.read_with(cx, |workspace, cx| workspace.conversation().unwrap().read(cx).composer().clone());
    assert_eq!(composer.read_with(cx, |composer, cx| composer.field().read(cx).text().to_owned()), "ok");
}

#[gpui::test]
fn the_open_areas_button_folds_its_sidebar_away_and_brings_it_back(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    assert!(bounds(cx, "area-sidebar").is_some());
    click(cx, "rail-sessions");
    assert!(bounds(cx, "area-sidebar").is_none());
    assert_eq!(area(&workspace, cx), Area::Sessions);
    click(cx, "rail-sessions");
    assert!(bounds(cx, "session-project-ses_signup").is_some());
    // Another area's button opens that area with its sidebar, even from folded.
    click(cx, "rail-sessions");
    click(cx, "rail-computers");
    assert!(bounds(cx, "computer-this").is_some());
}

#[gpui::test]
fn a_narrow_window_folds_the_areas_sidebar_away_and_the_rail_brings_it_out(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    cx.simulate_resize(size(px(760.), px(800.)));
    cx.run_until_parked();
    assert!(bounds(cx, "area-sidebar").is_none(), "folded in a narrow window");
    assert!(bounds(cx, "rail-sessions").is_some(), "the rail stays");

    // Its area's button brings it out, beside the conversation; again, it folds.
    click(cx, "rail-sessions");
    assert!(bounds(cx, "session-project-ses_signup").is_some());
    click(cx, "session-project-ses_signup");
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)), Some("ses_signup".into()));
    click(cx, "rail-sessions");
    assert!(bounds(cx, "area-sidebar").is_none());

    // ⌘⇧F needs the sidebar: it comes out with the search.
    cx.simulate_keystrokes("cmd-shift-f");
    cx.run_until_parked();
    assert!(bounds(cx, "sidebar-search").is_some());

    // A wide window shows it again, and narrowing again folds it.
    cx.simulate_resize(size(px(1200.), px(800.)));
    cx.run_until_parked();
    assert!(bounds(cx, "area-sidebar").is_some());
    cx.simulate_resize(size(px(760.), px(800.)));
    cx.run_until_parked();
    assert!(bounds(cx, "area-sidebar").is_none());
}

#[gpui::test]
fn switching_areas_in_a_wide_window_still_folds_the_sidebar_when_it_narrows(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    click(cx, "session-project-ses_signup");
    cx.simulate_keystrokes("ctrl-2");
    assert_eq!(area(&workspace, cx), Area::Bots);
    cx.simulate_keystrokes("ctrl-1 cmd-shift-f");
    cx.run_until_parked();
    assert_eq!(area(&workspace, cx), Area::Sessions);
    cx.simulate_resize(size(px(760.), px(800.)));
    cx.run_until_parked();
    assert!(bounds(cx, "area-sidebar").is_none());
}

#[gpui::test]
fn a_short_window_keeps_help_and_settings_in_reach(cx: &mut TestAppContext) {
    let (_workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    cx.simulate_resize(size(px(1000.), px(480.)));
    cx.run_until_parked();
    let settings = bounds(cx, "rail-settings").expect("Settings");
    assert!(settings.bottom() <= px(480.), "Settings at {:?}", settings);
    let more = bounds(cx, "more-rings").expect("the rest behind +N");
    assert!(more.bottom() <= bounds(cx, "rail-help").unwrap().top());
    assert!(bounds(cx, "ring-3").is_none(), "fewer rings where there's less room");
}

#[gpui::test]
fn needs_you_lists_whats_waiting_on_you_across_projects_with_what_each_asks(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    // On top, in the box's order (the newest ask first), each with its project and what it asks.
    let header = bounds(cx, "header-Needs you").expect("Needs you");
    let limits = bounds(cx, "needs-ses_limits").expect("the rate limits ask");
    let cms = bounds(cx, "needs-ses_cms").expect("the CMS question");
    let website = bounds(cx, "project-Website").unwrap();
    assert!(header.top() < limits.top() && limits.top() < cms.top() && cms.top() < website.top());
    assert!(bounds(cx, "needs-ses_signup").is_none(), "one at work isn't waiting on you");
    // The rail counts them on Sessions' icon.
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.waiting().map(|waiting| waiting.sessions)), Some(2));

    // A click opens it, from wherever the window was.
    click(cx, "rail-bots");
    click(cx, "rail-sessions");
    click(cx, "needs-ses_cms");
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)), Some("ses_cms".into()));
}

#[gpui::test]
fn an_answered_ask_leaves_needs_you_as_the_box_says(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    assert!(bounds(cx, "needs-ses_cms").is_some());
    stand_in.set_facts("ses_cms", |facts| {
        facts.as_object_mut().unwrap().remove("asked");
    });
    workspace.update_in(cx, |workspace, _, cx| workspace.read_at_once(cx));
    cx.run_until_parked();
    assert!(bounds(cx, "needs-ses_cms").is_none());
    assert!(bounds(cx, "needs-ses_limits").is_some());
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.waiting().map(|waiting| waiting.sessions)), Some(1));
}

#[gpui::test]
fn a_box_from_before_711_shows_no_needs_you_and_draws_no_counts(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    stand_in.before_711();
    let (workspace, cx) = open(cx, stand_in.clone());
    assert!(bounds(cx, "header-Needs you").is_none());
    assert!(workspace.read_with(cx, |workspace, _| workspace.waiting().is_none()));
    // It isn't asked again with each list (only once the box is reached again).
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    let mut listing = kuvo_box::Listing::new();
    listing.take(client.session_list(None).unwrap());
    workspace.update(cx, |workspace, cx| workspace.take_list(kuvo_box::ListUpdate::Listing(listing), cx));
    assert_eq!(stand_in.seen_at("GET", "kuvo/waiting").len(), 1);
    // The project's own count, as before, still shows who waits.
    assert!(bounds(cx, "session-project-ses_limits").is_some());
    // Its bots show their jobs, not what they're doing.
    click(cx, "rail-bots");
    let bots = workspace.read_with(cx, |workspace, cx| workspace.area_view(Area::Bots).unwrap().read(cx).bots().clone());
    match bots {
        kuvo::areas::Reading::Ready(bots) => assert!(bots.bots.iter().all(|bot| bot.now.is_none())),
        other => panic!("bots not read: {other:?}"),
    }
}

#[gpui::test]
fn back_and_forward_go_where_the_window_has_been(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let opened = |workspace: &Entity<Workspace>, cx: &mut VisualTestContext| workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned));
    assert!(!workspace.read_with(cx, |workspace, _| workspace.can_go_back()));
    click(cx, "session-project-ses_signup");
    click(cx, "session-project-ses_dark");
    click(cx, "rail-queue");
    click(cx, "category-later");

    cx.simulate_keystrokes("cmd-[");
    assert_eq!((area(&workspace, cx), title(&workspace, cx).as_deref()), (Area::Queue, Some("Work Queue")));
    click(cx, "back");
    assert_eq!((area(&workspace, cx), opened(&workspace, cx).as_deref()), (Area::Sessions, Some("ses_dark")));
    // Back in the conversation still open, the keyboard is in it.
    cx.simulate_input("ok");
    let composer = workspace.read_with(cx, |workspace, cx| workspace.conversation().unwrap().read(cx).composer().clone());
    assert_eq!(composer.read_with(cx, |composer, cx| composer.field().read(cx).text().to_owned()), "ok");
    click(cx, "back");
    assert_eq!(opened(&workspace, cx).as_deref(), Some("ses_signup"));
    cx.simulate_keystrokes("cmd-] cmd-] cmd-]");
    assert_eq!((area(&workspace, cx), title(&workspace, cx).as_deref()), (Area::Queue, Some("Later")));
    assert!(!workspace.read_with(cx, |workspace, _| workspace.can_go_forward()));

    // Going somewhere new drops what was ahead.
    click(cx, "back");
    click(cx, "rail-bots");
    assert!(!workspace.read_with(cx, |workspace, _| workspace.can_go_forward()));
}

#[gpui::test]
fn the_rings_show_each_account_and_the_rest_wait_behind_more(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    for ring in ["ring-0", "ring-1", "ring-2", "ring-3"] {
        assert!(bounds(cx, ring).is_some(), "{ring}");
    }
    assert!(bounds(cx, "ring-4").is_none(), "four at most");
    // "+2" opens Settings › Usage.
    click(cx, "more-rings");
    assert_eq!(area(&workspace, cx), Area::Settings);
    assert_eq!(title(&workspace, cx).as_deref(), Some("Usage"));
}

#[gpui::test]
fn with_no_account_an_empty_ring_goes_to_sign_in(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::empty(Replies::Never));
    assert!(bounds(cx, "ring-0").is_none());
    click(cx, "no-accounts");
    assert_eq!(title(&workspace, cx).as_deref(), Some("Accounts"));
}

#[gpui::test]
fn back_passes_over_a_session_gone_since(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    click(cx, "session-project-ses_signup");
    click(cx, "session-project-ses_webhook");
    click(cx, "rail-bots");
    // The webhook session is archived elsewhere, and the list says so.
    stand_in.set_facts("ses_webhook", |facts| facts["archived"] = serde_json::json!(true));
    workspace.update_in(cx, |workspace, _, cx| workspace.read_at_once(cx));
    cx.run_until_parked();
    click(cx, "back");
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)), Some("ses_signup".into()));
    assert_eq!(area(&workspace, cx), Area::Sessions);
}
