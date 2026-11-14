//! Kuvo's screens as someone uses them, against the stand-in box (nothing real is reached): the
//! sidebar listing the box's sessions and opening one, a conversation following a run and paging
//! back, the composer sending through the box (and putting back what the box says to), and a new
//! conversation started from the landing view.
//!
//! The follows that run on threads of their own in the app are left off here: what they'd hand
//! the screens is read at once from the stand-in and handed over the same way, so nothing waits on
//! a clock or another thread.

use gpui::{AppContext as _, Bounds, Entity, Focusable as _, Modifiers, Pixels, TestAppContext, VisualTestContext, px, size};
use kuvo::composer::{Composer, Models};
use kuvo::conversation::read_now;
use kuvo::entries::Entry;
use kuvo::stand_in::{Replies, StandIn};
use kuvo::workspace::Workspace;
use kuvo_box::models::{ModelState, StartIn};
use kuvo_box::messages::{Content, Message};
use kuvo_box::{BoxClient, ConversationUpdate, Where};
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
    cx.simulate_resize(size(px(1200.), px(800.)));
    workspace.update_in(cx, |workspace, _, cx| {
        workspace.set_now(NOW);
        workspace.read_at_once(cx);
    });
    cx.run_until_parked();
    (workspace, cx)
}

fn bounds(cx: &mut VisualTestContext, selector: &str) -> Option<Bounds<Pixels>> {
    cx.debug_bounds(Box::leak(selector.to_owned().into_boxed_str()))
}

/// Opens `session` and hands it what its follow would.
fn open_session(workspace: &Entity<Workspace>, session: &str, cx: &mut VisualTestContext) -> Entity<Composer> {
    workspace.update_in(cx, |workspace, window, cx| workspace.open_read_at_once(session, window, cx));
    cx.run_until_parked();
    let composer = workspace.read_with(cx, |workspace, cx| workspace.conversation().unwrap().read(cx).composer().clone());
    let field = composer.read_with(cx, |composer, _| composer.field().clone());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    composer
}

fn typed(composer: &Entity<Composer>, cx: &mut VisualTestContext) -> (String, Option<String>) {
    composer.read_with(cx, |composer, cx| {
        let field = composer.field().read(cx);
        (field.text().to_owned(), field.error().map(|error| error.to_string()))
    })
}

#[gpui::test]
fn the_sidebar_shows_the_boxs_sessions_by_project_and_opens_one(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in);

    // Projects newest first, each session under its own; chats after; a subagent's nowhere.
    let website = bounds(cx, "project-Website").expect("Website");
    let api = bounds(cx, "project-API").expect("API");
    let signup = bounds(cx, "session-project-ses_signup").expect("the session at work");
    let limits = bounds(cx, "session-project-ses_limits").expect("the session asking");
    let recipes = bounds(cx, "session-chat-ses_recipes").expect("a chat");
    assert!(website.top() < signup.top() && signup.top() < api.top() && api.top() < limits.top() && limits.top() < recipes.top());
    assert!(bounds(cx, "session-project-ses_sub").is_none());
    assert!(bounds(cx, "project-Infra").is_some(), "a project with no sessions still shows");

    // The landing view shows until one's opened; a click opens it.
    assert!(workspace.read_with(cx, |workspace, _| workspace.is_landing()));
    cx.simulate_click(limits.center(), Modifiers::default());
    cx.run_until_parked();
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)), Some("ses_limits".to_owned()));

    // Its conversation shows what its follow hands it.
    let view = workspace.read_with(cx, |workspace, _| workspace.conversation().unwrap().clone());
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    let conversation = read_now(&client, "ses_limits").unwrap();
    view.update(cx, |view, cx| view.take(ConversationUpdate::Conversation(conversation), cx));
    cx.run_until_parked();
    let asked = bounds(cx, "entry-msg_l1").expect("your message");
    let answered = bounds(cx, "entry-msg_l2").expect("its answer");
    assert!(asked.top() < answered.top());
}

#[gpui::test]
fn a_collapsed_project_hides_its_sessions(cx: &mut TestAppContext) {
    let (_workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let website = bounds(cx, "project-Website").unwrap();
    cx.simulate_click(website.center(), Modifiers::default());
    cx.run_until_parked();
    assert!(bounds(cx, "session-project-ses_signup").is_none());
    assert!(bounds(cx, "session-project-ses_limits").is_some());
    cx.simulate_click(website.center(), Modifiers::default());
    cx.run_until_parked();
    assert!(bounds(cx, "session-project-ses_signup").is_some());
}

#[gpui::test]
fn a_message_written_goes_to_the_box_as_its_fields(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let composer = open_session(&workspace, "ses_limits", cx);

    cx.simulate_input("Yes, use Redis");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("Keep the window at one minute.");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();

    let sent = stand_in.seen_at("POST", "kuvo/sessions/ses_limits/send");
    assert_eq!(sent.len(), 1);
    let body = sent[0].body.clone().unwrap();
    assert_eq!(body["words"], json!("Yes, use Redis\nKeep the window at one minute."));
    assert!(body["id"].as_str().is_some_and(|id| id.starts_with("msg_")));
    // A plain message isn't asked about first.
    assert!(stand_in.seen_at("POST", "kuvo/sessions/ses_limits/typed").is_empty());
    assert_eq!(typed(&composer, cx), (String::new(), None));
}

#[gpui::test]
fn a_typed_keyword_goes_to_the_box_first_and_what_it_says_is_shown(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let composer = open_session(&workspace, "ses_limits", cx);

    // "/plan sketch it": the box reads it, switches the mode, and says to send the words with it.
    cx.simulate_input("/plan sketch it");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    let asked = stand_in.seen_at("POST", "kuvo/sessions/ses_limits/typed");
    assert_eq!(asked.last().unwrap().body.as_ref().unwrap()["text"], json!("/plan sketch it"));
    let sent = stand_in.seen_at("POST", "kuvo/sessions/ses_limits/send");
    assert_eq!((sent[0].body.as_ref().unwrap()["words"].clone(), sent[0].body.as_ref().unwrap()["keyword"].clone()), (json!("sketch it"), json!("/plan")));
    assert_eq!(composer.read_with(cx, |composer, _| composer.note().map(|note| note.text.to_string())), Some("Switched to Plan.".to_owned()));

    // "/loop" with no schedule: the box says why, and puts it back to finish.
    cx.simulate_input("/loop now");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    let (text, error) = typed(&composer, cx);
    assert_eq!(text, "/loop now");
    assert!(error.unwrap().starts_with("Can’t tell how often"));
    assert_eq!(stand_in.seen_at("POST", "kuvo/sessions/ses_limits/send").len(), 1, "nothing more was sent");
}

#[gpui::test]
fn slash_offers_what_the_box_offers_as_its_typed(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let composer = open_session(&workspace, "ses_limits", cx);

    cx.simulate_input("/");
    let names = |composer: &Entity<Composer>, cx: &mut VisualTestContext| composer.read_with(cx, |composer, cx| composer.slash_offers(cx).into_iter().map(|offer| offer.name).collect::<Vec<_>>());
    // Everything it offers (the list scrolls past eight), by name, as KuvoClient's
    // `SlashCommands.matches` orders them.
    assert_eq!(names(&composer, cx), ["autopilot", "btw", "compact", "goal", "handoff", "init", "loop", "plan", "review", "test"]);
    cx.simulate_input("t");
    // Names starting with it first, then those with it inside, each by name.
    assert_eq!(names(&composer, cx), ["test", "autopilot", "btw", "compact", "init"]);
    cx.simulate_keystrokes("backspace v i e w");
    assert_eq!(names(&composer, cx), ["review"]);
    cx.simulate_keystrokes("backspace backspace backspace backspace");
    cx.simulate_input("t");
    assert_eq!(names(&composer, cx)[0], "test");
    cx.simulate_keystrokes("backspace r");
    assert_eq!(names(&composer, cx), ["review"]);
    // Tab (or Return) takes it, ready for what follows; the list goes.
    cx.simulate_keystrokes("tab");
    assert_eq!(typed(&composer, cx).0, "/review ");
    assert!(names(&composer, cx).is_empty());
    // Down then Return takes the second; Escape puts the list away.
    cx.simulate_keystrokes("cmd-a backspace");
    cx.simulate_input("/");
    cx.simulate_keystrokes("down enter");
    assert_eq!(typed(&composer, cx).0, "/btw ");
    cx.simulate_keystrokes("cmd-a backspace");
    cx.simulate_input("/c");
    cx.simulate_keystrokes("escape");
    assert!(names(&composer, cx).is_empty());
    assert_eq!(typed(&composer, cx).0, "/c");
}

#[gpui::test]
fn a_model_that_cant_run_keeps_the_message_saying_why(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let composer = open_session(&workspace, "ses_limits", cx);
    let state: ModelState = serde_json::from_value(json!({ "model": { "providerID": "anthropic", "id": "claude-opus-5-5" }, "name": "Claude Opus 5.5", "runs": false, "missing": "signIn", "account": { "id": "anthropic", "name": "Anthropic" } })).unwrap();
    composer.update(cx, |composer, cx| composer.take_models(Models { state: Some(state), ..Models::default() }, cx));

    cx.simulate_input("Use Redis");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(stand_in.seen_at("POST", "kuvo/sessions/ses_limits/send").is_empty());
    let (text, error) = typed(&composer, cx);
    assert_eq!(text, "Use Redis");
    assert_eq!(error.as_deref(), Some("Claude Opus 5.5 needs a sign-in: sign in to Anthropic in Kuvo Code on your Mac or iPhone, or choose another model."));
}

#[gpui::test]
fn a_new_session_starts_in_the_project_picked_and_opens(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    // It starts in the newest project until another's picked.
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.landing_place()), StartIn::Project("/Users/sam/Projects/website".into()));
    workspace.update(cx, |workspace, cx| workspace.pick_place(StartIn::Project("/Users/sam/Projects/api".into()), cx));
    let field = workspace.read_with(cx, |workspace, cx| workspace.landing().read(cx).field().clone());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.simulate_input("Add a health check route");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();

    let started = stand_in.seen_at("POST", "kuvo/sessions");
    assert_eq!(started.len(), 1);
    let body = started[0].body.clone().unwrap();
    assert_eq!(body["project"], json!("/Users/sam/Projects/api"));
    assert_eq!(body["model"], json!({ "providerID": "anthropic", "id": "claude-opus-5-5", "variant": "high" }), "on the model the box starts new ones on");
    let opened = workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)).expect("the new session opens");
    let sent = stand_in.seen_at("POST", &format!("kuvo/sessions/{opened}/send"));
    assert_eq!(sent[0].body.as_ref().unwrap()["words"], json!("Add a health check route"));
}

#[gpui::test]
fn earlier_messages_go_above_without_moving_what_youre_reading(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    open_session(&workspace, "ses_lighthouse", cx);
    let view = workspace.read_with(cx, |workspace, _| workspace.conversation().unwrap().clone());
    let entries = view.read_with(cx, |view, _| view.entries().to_vec());
    assert!(matches!(entries[0], Entry::Earlier), "more than a page: the way back is first");

    // Scrolled back to the top: the way back shows, with the oldest read under it.
    for _ in 0..200 {
        if view.read_with(cx, |view, _| view.list().list_state().logical_scroll_top().item_ix) == 0 {
            break;
        }
        view.read_with(cx, |view, _| view.list().scroll_by(px(-600.)));
        cx.update(|window, _| window.refresh());
        cx.run_until_parked();
    }
    let first = entries[1].key().to_owned();
    let before = bounds(cx, &format!("entry-{first}")).expect("the oldest read shows");
    assert!(bounds(cx, "entry-earlier").is_some());

    // The page before comes, as the follow hands it: put above, and what was read stays put.
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    let mut conversation = read_now(&client, "ses_lighthouse").unwrap();
    let cursor = conversation.earlier.clone().unwrap();
    let (older, earlier) = client.earlier_messages("ses_lighthouse", Where::Engine, &cursor, 100).unwrap();
    conversation.take_earlier(older, earlier);
    view.update(cx, |view, cx| view.take(ConversationUpdate::Conversation(conversation.clone()), cx));
    cx.run_until_parked();
    // Not pushed a page down, nor jumped to the newest: where it was, give or take the way back's row.
    let after = bounds(cx, &format!("entry-{first}")).expect("still shows");
    // (GPUI's list keeps its place by an item, and the rows put above aren't measured yet, so what
    // was under the way back moves up by that row's height.)
    let way_back = px(64.);
    assert!(after.top() <= before.top() && after.top() >= before.top() - way_back, "{before:?} → {after:?}");
    let (entries, items) = view.read_with(cx, |view, _| (view.entries().to_vec(), view.list().item_count()));
    assert_eq!(entries.len(), items);
    // A page more, and still more before it (the way back stays first).
    assert!(entries.iter().any(|entry| entry.key() == "msg_h010a"));
    assert!(matches!(entries[0], Entry::Earlier));
}

#[gpui::test]
fn a_run_streams_into_the_conversation_and_its_end_shows(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    open_session(&workspace, "ses_signup", cx);
    let view = workspace.read_with(cx, |workspace, _| workspace.conversation().unwrap().clone());
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    assert!(bounds(cx, "entry-working").is_some(), "at work: it says so at the end");

    // Words stream in: the step grows, and the list keeps following it.
    let mut conversation = read_now(&client, "ses_signup").unwrap();
    conversation.apply(&json!({ "type": "session.text.delta", "data": { "sessionID": "ses_signup", "assistantMessageID": "msg_s5", "ordinal": 0, "delta": " now. All 14 pass." } }));
    view.update(cx, |view, cx| view.take(ConversationUpdate::Conversation(conversation.clone()), cx));
    cx.run_until_parked();
    let streamed = view.read_with(cx, |view, _| {
        view.entries().iter().find_map(|entry| match entry {
            Entry::Message(message) => match message.as_ref() {
                Message::Assistant(step) if step.id == "msg_s5" => step.content.iter().find_map(|content| match content {
                    Content::Text(text) => Some(text.clone()),
                    _ => None,
                }),
                _ => None,
            },
            _ => None,
        })
    });
    assert!(streamed.unwrap().ends_with("checking the lint now. All 14 pass."));
    assert!(view.read_with(cx, |view, _| view.list().is_following()));
    let step = bounds(cx, "entry-msg_s5").unwrap();
    let working = bounds(cx, "entry-working").unwrap();
    assert!(step.bottom() <= working.top());

    // The run ends: Working goes, and the composer's Send is back.
    conversation.apply(&json!({ "type": "session.execution.succeeded", "data": { "sessionID": "ses_signup" } }));
    view.update(cx, |view, cx| view.take(ConversationUpdate::Conversation(conversation), cx));
    cx.run_until_parked();
    assert!(bounds(cx, "entry-working").is_none());
    let items = view.read_with(cx, |view, _| (view.entries().len(), view.list().item_count()));
    assert_eq!(items.0, items.1);
}

#[gpui::test]
fn a_conversation_that_isnt_there_says_so(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    workspace.update_in(cx, |workspace, window, cx| workspace.open_read_at_once("ses_missing", window, cx));
    cx.run_until_parked();
    let problem = workspace.read_with(cx, |workspace, cx| workspace.conversation().unwrap().read(cx).problem().cloned());
    assert_eq!(problem, Some(kuvo::conversation::Problem::Gone("This conversation isn’t on Stand-in Mac any more.".into())));
}


#[gpui::test]
fn a_step_this_app_cant_take_yet_keeps_what_was_written(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let composer = open_session(&workspace, "ses_limits", cx);
    // The box says "!ls" is the client's to run: this one can't yet, so it stays, saying so.
    cx.simulate_input("!ls -la");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(typed(&composer, cx).0, "!ls -la");
    let note = composer.read_with(cx, |composer, _| composer.note().cloned()).expect("a note");
    assert!(note.warning && note.text.contains("isn’t in this app yet"));
}

#[gpui::test]
fn a_draft_stays_with_its_conversation(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let limits = open_session(&workspace, "ses_limits", cx);
    cx.simulate_input("Half a thought");
    open_session(&workspace, "ses_recipes", cx);
    let again = open_session(&workspace, "ses_limits", cx);
    assert_eq!(again, limits);
    assert_eq!(typed(&again, cx).0, "Half a thought");
}

#[gpui::test]
fn a_new_session_whose_message_didnt_go_opens_with_it_and_why(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    stand_in.fail_sends();
    let field = workspace.read_with(cx, |workspace, cx| workspace.landing().read(cx).field().clone());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.simulate_input("Add a health check route");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    let opened = workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)).expect("the new session opens");
    assert!(opened.starts_with("ses_new"));
    let composer = workspace.read_with(cx, |workspace, cx| workspace.conversation().unwrap().read(cx).composer().clone());
    assert_eq!(typed(&composer, cx), ("Add a health check route".to_owned(), Some("The engine isn't answering. Try again in a moment.".to_owned())));
}

#[gpui::test]
fn with_no_model_to_run_a_new_session_waits_for_one(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    stand_in.nothing_runs();
    let (workspace, cx) = open(cx, stand_in.clone());
    let landing = workspace.read_with(cx, |workspace, _| workspace.landing().clone());
    assert!(landing.read_with(cx, |composer, _| composer.needs_model()));
    let field = landing.read_with(cx, |composer, _| composer.field().clone());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.simulate_input("Anything");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(stand_in.seen_at("POST", "kuvo/sessions").is_empty(), "nothing started");
    assert_eq!(typed(&landing, cx).0, "Anything");
}

#[gpui::test]
fn a_conversations_model_menu_offers_its_own_sides_models(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    // An engine conversation: the coding agents' models (another side) aren't offered in place.
    let composer = open_session(&workspace, "ses_limits", cx);
    let (offered, left_out, efforts) = composer.read_with(cx, |composer, _| {
        (composer.menu_models().iter().map(|model| model.id.clone()).collect::<Vec<_>>(), composer.left_out(), composer.efforts())
    });
    assert_eq!(offered, ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6", "gemini-3-pro"]);
    assert!(left_out);
    // Its efforts, as the box offers them with it.
    assert_eq!(efforts, ["low", "medium", "high", "max"]);
    // A new one may start on any, the agents' too.
    let landing = workspace.read_with(cx, |workspace, _| workspace.landing().clone());
    assert!(landing.read_with(cx, |composer, _| composer.menu_models().iter().any(|model| model.provider_id == "claude-code")));
}

#[gpui::test]
fn what_a_side_couldnt_say_is_kept_and_the_chip_stays(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let composer = open_session(&workspace, "ses_limits", cx);
    let landing = workspace.read_with(cx, |workspace, _| workspace.landing().clone());
    // The bridge starts again and its models can't be said; the session's model can't be read.
    stand_in.agents_known(false);
    stand_in.models_readable(false);
    composer.update(cx, |composer, cx| composer.read_models(cx));
    landing.update(cx, |composer, cx| composer.read_models(cx));
    cx.run_until_parked();
    // What was said before stays: the agents' models, the conversation's model and its chip.
    assert!(landing.read_with(cx, |composer, _| composer.menu_models().iter().any(|model| model.provider_id == "claude-code")));
    assert_eq!(composer.read_with(cx, |composer, _| composer.chip_label()), Some("Claude Opus 5.5".to_owned()));
    assert_eq!(composer.read_with(cx, |composer, _| composer.efforts()).len(), 4);
}

#[gpui::test]
fn a_model_that_changed_elsewhere_is_read_again(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let composer = open_session(&workspace, "ses_limits", cx);
    let view = workspace.read_with(cx, |workspace, _| workspace.conversation().unwrap().clone());
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    // Its account was signed out on another computer: the box hears its accounts changed.
    stand_in.set_model_state("ses_limits", json!({ "model": { "providerID": "anthropic", "id": "claude-opus-5-5" }, "name": "Claude Opus 5.5", "runs": false, "missing": "signIn", "account": { "id": "anthropic", "name": "Anthropic" } }));
    let mut conversation = read_now(&client, "ses_limits").unwrap();
    conversation.apply(&json!({ "type": "integration.updated", "data": {} }));
    view.update(cx, |view, cx| view.take(ConversationUpdate::Conversation(conversation), cx));
    cx.run_until_parked();
    // Read again: a message on it is kept, saying what to do.
    cx.simulate_input("Use Redis");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(stand_in.seen_at("POST", "kuvo/sessions/ses_limits/send").is_empty());
    assert_eq!(typed(&composer, cx).1.as_deref(), Some("Claude Opus 5.5 needs a sign-in: sign in to Anthropic in Kuvo Code on your Mac or iPhone, or choose another model."));
}

#[gpui::test]
fn what_the_box_says_of_a_landing_send_goes_with_the_new_conversation(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let landing = workspace.read_with(cx, |workspace, _| workspace.landing().clone());
    let field = landing.read_with(cx, |composer, _| composer.field().clone());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.simulate_input("/loop now and then");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    // The session started; the box's answer (put back, and why) is in its own composer.
    let composer = workspace.read_with(cx, |workspace, cx| workspace.conversation().expect("opened").read(cx).composer().clone());
    let (text, error) = typed(&composer, cx);
    assert_eq!(text, "/loop now and then");
    assert!(error.unwrap().starts_with("Can’t tell how often"));
    // The landing composer is left empty for the next one.
    assert_eq!(typed(&landing, cx), (String::new(), None));
}

#[gpui::test]
fn the_landing_project_doesnt_move_while_you_write(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let website = StartIn::Project("/Users/sam/Projects/website".into());
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.landing_place()), website);
    // A session in API works on: API is now the newest project.
    stand_in.set_facts("ses_webhook", |facts| facts["updated"] = json!(NOW + 60_000.0));
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    let mut listing = kuvo_box::Listing::new();
    listing.take(client.session_list(None).unwrap());
    workspace.update(cx, |workspace, cx| workspace.take_list(kuvo_box::ListUpdate::Listing(listing), cx));
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.landing_place()), website, "it stays while you write");
    // Opened again, it starts in the newest.
    workspace.update_in(cx, |workspace, window, cx| workspace.new_session(None, window, cx));
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.landing_place()), StartIn::Project("/Users/sam/Projects/api".into()));
}

#[gpui::test]
fn a_permission_shows_in_the_composers_place_and_is_answered_through_the_box(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    stand_in.set_asks("ses_limits", vec![kuvo::stand_in::redis_permission()]);
    let (workspace, cx) = open(cx, stand_in.clone());
    open_session(&workspace, "ses_limits", cx);

    // The card, as the box words it, in the composer's place; the keyboard's on it.
    assert!(bounds(cx, "ask-card").is_some());
    assert!(bounds(cx, "composer-card").is_none());
    assert!(bounds(cx, "ask-choice-always").is_some());
    let view = workspace.read_with(cx, |workspace, _| workspace.conversation().unwrap().clone());
    let card = view.read_with(cx, |view, _| view.asks().clone());
    let card_focus = card.read_with(cx, |card, cx| card.focus_handle(cx));
    cx.update(|window, cx| window.focus(&card_focus, cx));

    // Escape opens the line for your words; what's written goes as Don't Allow, with them.
    cx.simulate_keystrokes("escape");
    assert!(bounds(cx, "ask-instead").is_some());
    cx.simulate_input("Use the redis package we already have");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    let answered = stand_in.seen_at("POST", "kuvo/sessions/ses_limits/asks/per_redis");
    assert_eq!(answered.last().and_then(|seen| seen.body.clone()), Some(json!({ "answer": "instead", "message": "Use the redis package we already have" })));

    // Answered: the composer is back.
    assert!(bounds(cx, "ask-card").is_none());
    assert!(bounds(cx, "composer-card").is_some());
}

#[gpui::test]
fn a_number_key_picks_a_permissions_answer_and_more_than_one_ask_pages(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let mut second = kuvo::stand_in::redis_permission();
    second["id"] = json!("per_push");
    second["command"] = json!("git push origin rate-limits");
    stand_in.set_asks("ses_limits", vec![kuvo::stand_in::redis_permission(), second]);
    let (workspace, cx) = open(cx, stand_in.clone());
    open_session(&workspace, "ses_limits", cx);
    let card = workspace.read_with(cx, |workspace, cx| workspace.conversation().unwrap().read(cx).asks().clone());
    assert_eq!(card.read_with(cx, |card, _| card.place().words()), Some("1 of 2".into()));
    let card_focus = card.read_with(cx, |card, cx| card.focus_handle(cx));
    cx.update(|window, cx| window.focus(&card_focus, cx));

    // 2: Always Allow, for the first; the second shows next.
    cx.simulate_keystrokes("2");
    cx.run_until_parked();
    let answered = stand_in.seen_at("POST", "kuvo/sessions/ses_limits/asks/per_redis");
    assert_eq!(answered.last().and_then(|seen| seen.body.clone()), Some(json!({ "answer": "always" })));
    assert_eq!(card.read_with(cx, |card, _| card.place().shown().map(str::to_owned)), Some("per_push".into()));
    assert_eq!(card.read_with(cx, |card, _| card.place().words()), None);
}

#[gpui::test]
fn the_agents_question_takes_a_choice_or_your_own_words(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    open_session(&workspace, "ses_cms", cx);
    assert!(bounds(cx, "ask-option-0").is_some());
    assert!(bounds(cx, "ask-words").is_some(), "it takes words of your own too");

    // A click on a choice answers a question that takes one.
    let redirect = bounds(cx, "ask-option-0").unwrap();
    cx.simulate_click(redirect.center(), Modifiers::default());
    cx.run_until_parked();
    let answered = stand_in.seen_at("POST", "kuvo/sessions/ses_cms/asks/frm_cms");
    assert_eq!(answered.last().and_then(|seen| seen.body.clone()), Some(json!({ "answers": { "q0": "redirect" } })));
    assert!(bounds(cx, "ask-card").is_none());
}

#[gpui::test]
fn a_page_that_couldnt_be_read_isnt_asked_again_as_words_stream(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    open_session(&workspace, "ses_lighthouse", cx);
    let view = workspace.read_with(cx, |workspace, _| workspace.conversation().unwrap().clone());
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    view.update(cx, |view, cx| view.take(ConversationUpdate::EarlierFailed(kuvo_box::Error::Unreachable("The box didn’t answer.".into())), cx));
    // Another read of the newest (words streaming): still said, not asked again.
    let conversation = read_now(&client, "ses_lighthouse").unwrap();
    view.update(cx, |view, cx| view.take(ConversationUpdate::Conversation(conversation), cx));
    assert_eq!(view.read_with(cx, |view, _| view.earlier_failed().map(str::to_owned)), Some("The box didn’t answer.".to_owned()));
}

#[gpui::test]
fn a_side_the_box_cant_say_now_is_asked_again_until_it_can(cx: &mut TestAppContext) {
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        kuvo::bind_keys(cx);
    });
    let stand_in = StandIn::at(Replies::Never, NOW);
    let client = BoxClient::new(stand_in.clone());
    // A composer that reads the box itself, as the app's does.
    let composer = cx.new(|cx| Composer::new(client, kuvo::composer::Target::Session { id: "ses_limits".into(), place: Where::Engine }, true, cx));
    cx.run_until_parked();
    let asked = || stand_in.seen_at("GET", "kuvo/models/offered").len();
    assert_eq!(asked(), 1);
    // The bridge starts again: its side isn't said, though what it said before is kept.
    stand_in.agents_known(false);
    composer.update(cx, |composer, cx| composer.read_models(cx));
    cx.run_until_parked();
    assert_eq!(asked(), 2);
    // Asked again in a while, and again (longer each time) while it still can't say.
    cx.executor().advance_clock(std::time::Duration::from_secs(1));
    cx.run_until_parked();
    assert_eq!(asked(), 3);
    cx.executor().advance_clock(std::time::Duration::from_secs(1));
    cx.run_until_parked();
    assert_eq!(asked(), 3, "the second wait is longer");
    cx.executor().advance_clock(std::time::Duration::from_secs(1));
    cx.run_until_parked();
    assert_eq!(asked(), 4);
    // It can say again: no more asking.
    stand_in.agents_known(true);
    cx.executor().advance_clock(std::time::Duration::from_secs(4));
    cx.run_until_parked();
    assert_eq!(asked(), 5);
    cx.executor().advance_clock(std::time::Duration::from_secs(60));
    cx.run_until_parked();
    assert_eq!(asked(), 5);
}

#[gpui::test]
fn a_model_named_by_another_id_is_the_one_offered(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    // A coding agent's conversation on Claude Code's `default`, which it lists as `opus`.
    stand_in.set_model_state("ses_limits", json!({ "model": { "providerID": "claude-code", "id": "default" }, "name": "Opus", "runs": true }));
    let (workspace, cx) = open(cx, stand_in);
    let composer = open_session(&workspace, "ses_limits", cx);
    assert_eq!(composer.read_with(cx, |composer, _| composer.efforts()), ["low", "medium", "high"]);
}

#[gpui::test]
fn a_session_its_box_leaves_out_is_refused_nothing(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    stand_in.set_model_state("ses_limits", json!({ "model": { "providerID": "claude-code", "id": "opus" }, "name": "Opus", "runs": false, "missing": "signIn", "account": { "id": "claude-code", "name": "Claude Code" } }));
    let (workspace, cx) = open(cx, stand_in.clone());
    let composer = open_session(&workspace, "ses_limits", cx);
    // Signed in elsewhere; its list still being read, so the box leaves the session out for now.
    stand_in.set_model_state("ses_limits", serde_json::Value::Null);
    composer.update(cx, |composer, cx| composer.read_models(cx));
    cx.run_until_parked();
    // Its model is still named, and nothing's refused on what was said before.
    assert_eq!(composer.read_with(cx, |composer, _| composer.chip_label()), Some("Opus".to_owned()));
    cx.simulate_input("Go on");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(stand_in.seen_at("POST", "kuvo/sessions/ses_limits/send").len(), 1);
}

#[gpui::test]
fn the_landing_view_reads_whats_offered_each_time_it_opens(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    stand_in.agents_known(false);
    let (workspace, cx) = open(cx, stand_in.clone());
    let landing = workspace.read_with(cx, |workspace, _| workspace.landing().clone());
    let offers_agents = |cx: &mut VisualTestContext| landing.read_with(cx, |composer, _| composer.menu_models().iter().any(|model| model.provider_id == "claude-code"));
    assert!(!offers_agents(cx));
    // The coding agents' bridge is back; New Session again: they're offered.
    stand_in.agents_known(true);
    open_session(&workspace, "ses_recipes", cx);
    workspace.update_in(cx, |workspace, window, cx| workspace.new_session(None, window, cx));
    cx.run_until_parked();
    assert!(offers_agents(cx));
}

#[gpui::test]
fn a_conversations_model_waits_to_be_changed_until_its_known_where_it_runs(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    workspace.update_in(cx, |workspace, window, cx| workspace.open_session("ses_limits", window, cx));
    let view = workspace.read_with(cx, |workspace, _| workspace.conversation().unwrap().clone());
    let composer = view.read_with(cx, |view, _| view.composer().clone());
    assert!(!composer.read_with(cx, |composer, _| composer.can_pick()));
    // Its follow finds it on the engine.
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    let conversation = read_now(&client, "ses_limits").unwrap();
    view.update(cx, |view, cx| view.take(ConversationUpdate::Conversation(conversation), cx));
    assert!(composer.read_with(cx, |composer, _| composer.can_pick()));
}

#[gpui::test]
fn a_new_session_whose_message_didnt_go_while_you_were_elsewhere_is_marked(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    stand_in.fail_sends();
    let landing = workspace.read_with(cx, |workspace, _| workspace.landing().clone());
    let field = landing.read_with(cx, |composer, _| composer.field().clone());
    field.update(cx, |field, cx| field.set_text("Add a health check route", cx));
    // Sent, and before it's done, another conversation opened.
    landing.update(cx, |composer, cx| composer.send(cx));
    workspace.update_in(cx, |workspace, window, cx| workspace.open_session("ses_recipes", window, cx));
    cx.run_until_parked();
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)), Some("ses_recipes".to_owned()), "you stay where you went");
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    let started = client.session_list(None).unwrap().sessions.into_keys().find(|id| id.starts_with("ses_new")).expect("it was started");
    assert!(workspace.read_with(cx, |workspace, _| workspace.is_unsent(&started)));
    // Opened, what didn't go is there, with why; the mark goes.
    let composer = open_session(&workspace, &started, cx);
    assert!(!workspace.read_with(cx, |workspace, _| workspace.is_unsent(&started)));
    assert_eq!(typed(&composer, cx), ("Add a health check route".to_owned(), Some("The engine isn't answering. Try again in a moment.".to_owned())));
}

#[gpui::test]
fn what_is_said_of_the_model_before_a_pick_comes_back_is_left(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let composer = open_session(&workspace, "ses_limits", cx);
    let sonnet = kuvo_box::typed::ModelRef { provider_id: "anthropic".into(), id: "claude-sonnet-5-5".into(), variant: None };
    let opus: ModelState = serde_json::from_value(json!({ "model": { "providerID": "anthropic", "id": "claude-opus-5-5", "variant": "high" }, "name": "Claude Opus 5.5", "runs": true })).unwrap();
    // Sonnet picked; before its change comes back, a read still says Opus: left.
    composer.update(cx, |composer, cx| {
        composer.pick(sonnet.clone(), cx);
        composer.take_state(opus.clone(), cx);
    });
    assert_eq!(composer.read_with(cx, |composer, _| composer.chip_label()), Some("Claude Sonnet 5.5".to_owned()));
    // Once it's come back, what the box says goes.
    cx.run_until_parked();
    composer.update(cx, |composer, cx| composer.take_state(opus, cx));
    assert_eq!(composer.read_with(cx, |composer, _| composer.chip_label()), Some("Claude Opus 5.5".to_owned()));
}

#[gpui::test]
fn a_tool_step_opens_to_what_it_printed_and_long_output_unfolds(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in);
    open_session(&workspace, "ses_signup", cx);

    // Closed, a step is one line; a click opens it to the command and what it printed, folded.
    assert!(bounds(cx, "output-msg_s5:1").is_none());
    let row = bounds(cx, "tool-msg_s5:1").expect("the test run's row");
    cx.simulate_click(row.center(), Modifiers::default());
    cx.run_until_parked();
    let folded = bounds(cx, "output-msg_s5:1").expect("its output, under it");

    // Show all: the rest of it, then folded again.
    let fold = bounds(cx, "output-msg_s5:1-fold").expect("the fold's button");
    cx.simulate_click(fold.center(), Modifiers::default());
    cx.run_until_parked();
    let whole = bounds(cx, "output-msg_s5:1").expect("its output, whole");
    assert!(whole.size.height > folded.size.height + px(100.), "{whole:?} vs {folded:?}");
    let fold = bounds(cx, "output-msg_s5:1-fold").expect("Show less");
    cx.simulate_click(fold.center(), Modifiers::default());
    cx.run_until_parked();
    assert_eq!(bounds(cx, "output-msg_s5:1").map(|b| b.size.height), Some(folded.size.height));

    // An edit opens to its changes; a step still running has nothing to open.
    let edit = bounds(cx, "tool-msg_s5:0").expect("the edit's row");
    cx.simulate_click(edit.center(), Modifiers::default());
    cx.run_until_parked();
    assert!(bounds(cx, "diff-msg_s5:0-0").is_some());
    let running = bounds(cx, "tool-msg_s5:3").expect("the lint running");
    cx.simulate_click(running.center(), Modifiers::default());
    cx.run_until_parked();
    assert!(bounds(cx, "output-msg_s5:3").is_none());
}

fn type_in(field: &Entity<kuvo_ui::TextField>, text: &str, cx: &mut VisualTestContext) {
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.simulate_input(text);
    cx.run_until_parked();
}

#[gpui::test]
fn the_sidebar_search_finds_sessions_by_name_and_by_what_was_said(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    let search = workspace.read_with(cx, |workspace, _| workspace.search().clone());

    // By name as you type: only the sessions whose titles have it.
    type_in(&search, "fo", cx);
    assert!(bounds(cx, "session-found-ses_signup").is_some(), "“Fix the sign-up form…”");
    assert!(bounds(cx, "session-project-ses_dark").is_none(), "the rest of the list goes");
    assert!(bounds(cx, "header-In Conversations").is_none(), "two characters: names only");

    // From three, what was said too: the box searches conversations, less those found by name.
    search.update(cx, |field, cx| field.set_text("", cx));
    type_in(&search, "redis", cx);
    assert!(bounds(cx, "found-ses_limits").is_some(), "the rate limits conversation mentions Redis");
    assert!(bounds(cx, "session-found-ses_signup").is_none());
    assert!(bounds(cx, "header-In Conversations").is_some());

    // Nothing anywhere: said so.
    search.update(cx, |field, cx| field.set_text("", cx));
    type_in(&search, "zzzz", cx);
    assert!(workspace.read_with(cx, |workspace, cx| kuvo::sidebar::lines(workspace, cx).contains(&kuvo::sidebar::Line::Quiet("Nothing matches.".into()))));

    // Escape clears it, and the list is back.
    cx.simulate_keystrokes("escape");
    assert!(bounds(cx, "session-project-ses_dark").is_some());
}

#[gpui::test]
fn the_keyboard_walks_the_sidebar_and_opens_what_its_on(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    workspace.update_in(cx, |workspace, window, cx| workspace.focus_search(window, cx));

    // ↓ from the search steps into the list: the first project, then its first session.
    cx.simulate_keystrokes("down");
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.walked().map(str::to_owned)), Some(format!("project:{}", "/Users/sam/Projects/website")));
    cx.simulate_keystrokes("down down");
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.walked().map(str::to_owned)), Some("session-project:ses_dark".into()));

    // Return opens it, and the keyboard goes to its composer.
    cx.simulate_keystrokes("enter");
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)), Some("ses_dark".into()));
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.walked().map(str::to_owned)), None);

    // Return on a project folds it; ↑ from the first row goes back to the search.
    workspace.update_in(cx, |workspace, window, cx| workspace.focus_search(window, cx));
    cx.simulate_keystrokes("down enter");
    assert!(workspace.read_with(cx, |workspace, _| workspace.is_collapsed("/Users/sam/Projects/website")));
    assert!(bounds(cx, "session-project-ses_signup").is_none());
    cx.simulate_keystrokes("up");
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.walked().map(str::to_owned)), None);
    let search = workspace.read_with(cx, |workspace, _| workspace.search().clone());
    assert!(cx.update(|window, cx| search.focus_handle(cx).is_focused(window)));

    // From the search, Return opens the first that's found.
    cx.simulate_input("lifetimes");
    cx.simulate_keystrokes("enter");
    assert_eq!(workspace.read_with(cx, |workspace, _| workspace.opened().map(str::to_owned)), Some("ses_lifetimes".into()));
}

#[gpui::test]
fn files_attached_go_with_the_message_and_show_on_it(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone());
    let composer = open_session(&workspace, "ses_recipes", cx);
    let folder = std::env::temp_dir().join(format!("kuvo-attach-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let (note, picture) = (folder.join("shopping list.txt"), folder.join("fridge.png"));
    std::fs::write(&note, "rice").unwrap();
    std::fs::write(&picture, b"not really a png").unwrap();

    // Attached (as the picker or a drop hands them), each shows; a folder isn't a file to send.
    composer.update(cx, |composer, cx| composer.attach([note.clone(), picture.clone(), folder.clone(), note.clone()], cx));
    cx.run_until_parked();
    assert_eq!(composer.read_with(cx, |composer, _| composer.attached().to_vec()), [note.clone(), picture.clone()]);
    assert!(bounds(cx, "attachments").is_some());

    // × takes one away; Send takes them with what's written, as files on this Mac's box.
    composer.update(cx, |composer, cx| composer.detach(1, cx));
    cx.simulate_input("What can I make with these?");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    let sent = stand_in.seen_at("POST", "kuvo/sessions/ses_recipes/send");
    let body = sent.last().and_then(|seen| seen.body.clone()).expect("sent");
    let uri = format!("file://{}", note.to_string_lossy().replace(' ', "%20"));
    assert_eq!(body["files"], json!([{ "uri": uri, "name": "shopping list.txt" }]));
    assert!(composer.read_with(cx, |composer, _| composer.attached().is_empty()));

    // Files alone can be sent.
    composer.update(cx, |composer, cx| composer.attach([picture.clone()], cx));
    cx.run_until_parked();
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(stand_in.seen_at("POST", "kuvo/sessions/ses_recipes/send").len(), 2);
    std::fs::remove_dir_all(&folder).ok();
}
