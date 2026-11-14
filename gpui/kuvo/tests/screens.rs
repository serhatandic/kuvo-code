//! Kuvo's screens as someone uses them, against the stand-in box (nothing real is reached): the
//! sidebar listing the box's sessions and opening one, a conversation following a run and paging
//! back, the composer sending through the box (and putting back what the box says to), and a new
//! conversation started from the landing view.
//!
//! The follows that run on threads of their own in the app are left off here: what they'd hand
//! the screens is read at once from the stand-in and handed over the same way, so nothing waits on
//! a clock or another thread.

use gpui::{Bounds, Entity, Focusable as _, Modifiers, Pixels, TestAppContext, VisualTestContext, px, size};
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
    assert!(streamed.unwrap().ends_with("Running the sign-up tests now. All 14 pass."));
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
fn a_session_waiting_on_you_says_so_above_the_composer(cx: &mut TestAppContext) {
    let (workspace, cx) = open(cx, StandIn::at(Replies::Never, NOW));
    open_session(&workspace, "ses_limits", cx);
    assert!(bounds(cx, "asking").is_some());
    open_session(&workspace, "ses_recipes", cx);
    assert!(bounds(cx, "asking").is_none());
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
