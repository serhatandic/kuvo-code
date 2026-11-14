//! The side panel as someone uses it, against the stand-in box (nothing real is reached, no git is
//! run): opening it beside a conversation and dragging it wider, Changes as the box groups them, a
//! file's diff, staging and discarding (asked first), committing and the push that didn't go
//! through, the folder's files read a folder at a time with one that can't be read, and branches:
//! switching, a new one, a worktree's Merge into… and a pull request.
//!
//! The views read the box at once here, as the follows would hand them what it says.

use gpui::{Bounds, Entity, Focusable as _, Modifiers, MouseButton, Pixels, TestAppContext, VisualTestContext, point, px, size};
use kuvo::panel::Tab;
use kuvo::panel::changes::CommitSaid;
use kuvo::panel::files::Shown;
use kuvo::panel::{Load, branches::Said};
use kuvo::stand_in::{Replies, StandIn, git::website};
use kuvo::workspace::Workspace;
use kuvo_box::BoxClient;
use kuvo_ui::{Appearance, Theme};
use serde_json::json;

const NOW: f64 = 1_794_650_000_000.0;

fn open<'a>(cx: &'a mut TestAppContext, stand_in: StandIn, session: &str) -> (Entity<Workspace>, &'a mut VisualTestContext) {
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        kuvo::bind_keys(cx);
    });
    let client = BoxClient::new(stand_in);
    let window = cx.add_window(move |window, cx| Workspace::new(client, false, window, cx));
    let workspace = window.root(cx).unwrap();
    let cx = VisualTestContext::from_window(window.into(), cx).into_mut();
    cx.simulate_resize(size(px(1280.), px(820.)));
    workspace.update_in(cx, |workspace, window, cx| {
        workspace.set_now(NOW);
        workspace.read_at_once(cx);
        workspace.open_read_at_once(session, window, cx);
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

fn sent(stand_in: &StandIn, route: &str) -> Vec<serde_json::Value> {
    stand_in.seen_at("POST", route).into_iter().filter_map(|seen| seen.body).collect()
}

#[gpui::test]
fn the_panel_opens_beside_the_conversation_and_keeps_its_width(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone(), "ses_signup");
    assert!(bounds(cx, "side-panel").is_none(), "closed until it's asked for");

    // ⌥⌘0, as the Mac app's Show Panel: the session's folder's changes, as the box groups them.
    cx.simulate_keystrokes("cmd-alt-0");
    cx.run_until_parked();
    let panel = bounds(cx, "side-panel").expect("the panel");
    let staged = bounds(cx, "change-Staged:src/components/SignupForm.tsx").expect("the sign-up form, staged");
    let unstaged = bounds(cx, "change-Unstaged:src/components/SignupForm.tsx").expect("and its changes since, unstaged");
    let new = bounds(cx, "change-Untracked:src/components/SignupForm.test.tsx").expect("a new file");
    assert!(staged.top() < unstaged.top() && unstaged.top() < new.top());
    let asked = stand_in.seen_at("GET", "kuvo/git/files");
    assert!(asked.last().unwrap().path.contains("directory=%2FUsers%2Fsam%2FProjects%2Fwebsite"), "asked of the session's folder");

    // Dragged wider by its edge.
    let edge = bounds(cx, "panel-edge").unwrap().center();
    cx.simulate_mouse_down(edge, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(point(edge.x - px(100.), edge.y), Some(MouseButton::Left), Modifiers::default());
    cx.simulate_mouse_up(point(edge.x - px(100.), edge.y), MouseButton::Left, Modifiers::default());
    cx.run_until_parked();
    let wider = bounds(cx, "side-panel").unwrap();
    assert_eq!(wider.size.width, panel.size.width + px(100.));

    // Closed and opened again, as wide as it was; another conversation's folder in it.
    click(cx, "toggle-panel");
    assert!(bounds(cx, "side-panel").is_none());
    workspace.update_in(cx, |workspace, window, cx| workspace.open_read_at_once("ses_limits", window, cx));
    click(cx, "toggle-panel");
    assert_eq!(bounds(cx, "side-panel").unwrap().size.width, wider.size.width);
    let place = workspace.read_with(cx, |workspace, cx| workspace.panel().read(cx).place().cloned()).unwrap();
    assert_eq!(place.directory, "/Users/sam/Projects/api");
    assert!(bounds(cx, "change-Staged:src/components/SignupForm.tsx").is_none(), "the API has nothing changed");
}

#[gpui::test]
fn a_session_started_with_the_panel_open_shows_its_folder_once_the_box_lists_it(cx: &mut TestAppContext) {
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        kuvo::bind_keys(cx);
    });
    let stand_in = StandIn::at(Replies::Never, NOW);
    let client = BoxClient::new(stand_in.clone());
    let window = cx.add_window(move |window, cx| Workspace::new(client, false, window, cx));
    let workspace = window.root(cx).unwrap();
    let cx = VisualTestContext::from_window(window.into(), cx).into_mut();
    cx.simulate_resize(size(px(1280.), px(820.)));
    workspace.update(cx, |workspace, cx| {
        workspace.set_now(NOW);
        workspace.read_at_once(cx);
        workspace.toggle_panel(cx);
    });
    let place = |workspace: &Entity<Workspace>, cx: &mut VisualTestContext| workspace.read_with(cx, |workspace, cx| workspace.panel().read(cx).place().map(|place| place.directory.clone()));
    // On the landing view, the project a new one starts in; picking another moves it there.
    assert_eq!(place(&workspace, cx).as_deref(), Some("/Users/sam/Projects/website"));
    workspace.update(cx, |workspace, cx| workspace.pick_place(kuvo_box::models::StartIn::Project("/Users/sam/Projects/api".into()), cx));
    assert_eq!(place(&workspace, cx).as_deref(), Some("/Users/sam/Projects/api"));

    let field = workspace.read_with(cx, |workspace, cx| workspace.landing().read(cx).field().clone());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.simulate_input("Add a health check route");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert!(workspace.read_with(cx, |workspace, _| workspace.opened().is_some()), "it opens before the box lists it");
    // The box's list comes, with the new session in it: the panel shows its folder.
    workspace.update(cx, |workspace, cx| workspace.read_at_once(cx));
    cx.run_until_parked();
    assert_eq!(place(&workspace, cx).as_deref(), Some("/Users/sam/Projects/api"));
}

#[gpui::test]
fn a_file_opens_to_its_diff_as_the_box_sends_it(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (_workspace, cx) = open(cx, stand_in.clone(), "ses_signup");
    cx.simulate_keystrokes("cmd-alt-i");
    cx.run_until_parked();

    click(cx, "change-Staged:src/components/SignupForm.tsx");
    let asked = sent(&stand_in, "kuvo/git/changes");
    assert_eq!(asked.last().unwrap(), &json!({ "directory": website(), "scope": "staged", "path": "src/components/SignupForm.tsx" }), "in the scope the box listed it with");
    assert!(bounds(cx, "file-diff").is_some());
    // Its long unchanged stretch is folded; a click opens it.
    let fold = "file-diff-unchanged-34";
    assert!(bounds(cx, fold).is_some(), "the unchanged lines between its changes fold");
    click(cx, fold);
    assert!(bounds(cx, fold).is_none());

    // Back to the list: Escape, or the back button.
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(bounds(cx, "file-diff").is_none(), "Escape goes back");
    // Staged while open, it stays open as the staged file it became.
    click(cx, "change-Unstaged:src/lib/validate.ts");
    click(cx, "stage-Unstaged:src/lib/validate.ts");
    assert!(bounds(cx, "file-diff").is_some(), "still open");
    assert_eq!(sent(&stand_in, "kuvo/git/changes").last().unwrap()["scope"], json!("staged"), "read again in its new scope");
    click(cx, "changes-back");
    assert!(bounds(cx, "file-diff").is_none());
    assert!(bounds(cx, "change-Staged:src/components/SignupForm.tsx").is_some());
}

#[gpui::test]
fn staging_sends_back_what_the_box_listed_and_a_discard_is_asked_first(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (_workspace, cx) = open(cx, stand_in.clone(), "ses_signup");
    cx.simulate_keystrokes("cmd-alt-0");
    cx.run_until_parked();

    click(cx, "stage-Unstaged:src/lib/validate.ts");
    assert_eq!(sent(&stand_in, "kuvo/git/stage"), [json!({ "root": website(), "path": "src/lib/validate.ts", "status": "modified", "scope": "unstaged" })]);
    assert!(bounds(cx, "change-Staged:src/lib/validate.ts").is_some(), "the list read again shows it staged");
    assert!(bounds(cx, "change-Unstaged:src/lib/validate.ts").is_none());

    click(cx, "unstage-Staged:src/lib/validate.ts");
    assert_eq!(sent(&stand_in, "kuvo/git/unstage").len(), 1);
    assert!(bounds(cx, "change-Unstaged:src/lib/validate.ts").is_some());

    // Discard asks first; Cancel sends nothing.
    click(cx, "discard-Untracked:src/components/SignupForm.test.tsx");
    assert!(bounds(cx, "discard-confirm").is_some());
    click(cx, "discard-cancel");
    assert!(bounds(cx, "discard-confirm").is_none());
    assert!(sent(&stand_in, "kuvo/git/discard").is_empty());

    click(cx, "discard-Unstaged:src/styles/legacy.css");
    click(cx, "discard-confirmed");
    assert_eq!(sent(&stand_in, "kuvo/git/discard"), [json!({ "root": website(), "path": "src/styles/legacy.css", "status": "deleted", "scope": "unstaged" })]);
}

#[gpui::test]
fn a_commit_goes_with_its_message_and_a_push_that_didnt_go_offers_push(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone(), "ses_signup");
    cx.simulate_keystrokes("cmd-alt-0");
    cx.run_until_parked();
    let view = workspace.read_with(cx, |workspace, cx| workspace.panel().read(cx).changes().clone());
    let field = view.read_with(cx, |view, _| view.message().clone());

    // Nothing written: Commit does nothing.
    click(cx, "commit");
    assert!(sent(&stand_in, "kuvo/git/commit").is_empty());

    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.simulate_input("Keep the form when an email is taken");
    click(cx, "commit-push");
    stand_in.fail_next_push();
    click(cx, "commit");
    assert_eq!(sent(&stand_in, "kuvo/git/commit"), [json!({ "directory": website(), "message": "Keep the form when an email is taken", "push": true })]);
    // Committed (what was staged is gone from the list), but not pushed: Push, never the commit again.
    assert!(bounds(cx, "change-Staged:src/components/SignupForm.tsx").is_none());
    assert!(matches!(view.read_with(cx, |view, _| view.said().cloned()), Some(CommitSaid::NotPushed(_))));
    assert_eq!(field.read_with(cx, |field, _| field.text().to_owned()), "", "the message went with the commit");
    click(cx, "push-again");
    assert_eq!(sent(&stand_in, "kuvo/git/push"), [json!({ "directory": website() })]);
    assert_eq!(view.read_with(cx, |view, _| view.said().cloned()), Some(CommitSaid::Pushed));
}

#[gpui::test]
fn files_open_a_folder_at_a_time_and_one_that_cant_be_read_says_why(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone(), "ses_signup");
    cx.simulate_keystrokes("cmd-alt-f");
    cx.run_until_parked();
    let root = website();
    assert!(bounds(cx, &format!("tree-{root}/src")).is_some());
    assert!(bounds(cx, &format!("tree-{root}/README.md")).is_some());
    assert!(bounds(cx, &format!("tree-{root}/src/main.tsx")).is_none(), "a folder is read as it opens");

    click(cx, &format!("tree-{root}/src"));
    assert!(stand_in.seen_at("GET", "kuvo/folders").iter().any(|seen| seen.path.contains("%2Fsrc&files=1")));
    assert!(bounds(cx, &format!("tree-{root}/src/main.tsx")).is_some());

    click(cx, &format!("tree-{root}/secrets"));
    assert!(bounds(cx, &format!("unreadable-{root}/secrets")).is_some(), "never shown as empty");
    let rows = workspace.read_with(cx, |workspace, cx| workspace.panel().read(cx).files().read(cx).rows().to_vec());
    assert!(rows.iter().any(|row| matches!(row, kuvo::panel::files::Row::Note { read: kuvo::panel::files::Read::Unreadable(why), .. } if why.reason.as_deref() == Some("Permission denied"))));

    click(cx, &format!("tree-{root}/src/components"));
    click(cx, &format!("tree-{root}/src/components/SignupForm.tsx"));
    let opened = workspace.read_with(cx, |workspace, cx| workspace.panel().read(cx).files().read(cx).opened().cloned()).unwrap();
    assert!(matches!(opened.1, Load::Ready(Shown::Text { lines: 58, .. })));
    assert!(bounds(cx, "file-viewer").is_some());
    cx.simulate_keystrokes("escape");
    cx.run_until_parked();
    assert!(bounds(cx, "file-viewer").is_none(), "Escape goes back to the tree");
    click(cx, &format!("tree-{root}/README.md"));
    click(cx, "files-back");
    assert!(bounds(cx, "file-viewer").is_none());
}

#[gpui::test]
fn branches_switch_and_a_new_one_starts_where_this_one_is(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (_workspace, cx) = open(cx, stand_in.clone(), "ses_signup");
    cx.simulate_keystrokes("cmd-alt-0");
    cx.run_until_parked();
    click(cx, "panel-tab-Branches");
    assert!(bounds(cx, "branch-fix/signup-taken-email").is_some());
    assert!(bounds(cx, "branch-merge").is_none(), "Merge into… is a worktree's");

    click(cx, "branch-main");
    assert_eq!(sent(&stand_in, "kuvo/git/switch"), [json!({ "directory": website(), "branch": "main", "create": false })]);

    click(cx, "branch-new");
    cx.simulate_input("feature/password-hints");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    assert_eq!(sent(&stand_in, "kuvo/git/switch").last().unwrap(), &json!({ "directory": website(), "branch": "feature/password-hints", "create": true }));
    assert!(bounds(cx, "branch-feature/password-hints").is_some());
}

#[gpui::test]
fn a_worktrees_branch_merges_where_the_box_says_and_says_why_it_cant(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone(), "ses_dark");
    workspace.update(cx, |workspace, cx| workspace.show_panel(Tab::Branches, cx));
    cx.run_until_parked();
    let view = workspace.read_with(cx, |workspace, cx| workspace.panel().read(cx).branches().clone());

    stand_in.merges_conflict(&["src/styles/theme.css"]);
    click(cx, "branch-merge");
    let said = view.read_with(cx, |view, _| view.said().cloned());
    assert_eq!(said, Some(Said::Failed("main changed some of the same lines: src/styles/theme.css. Nothing was merged.".into())));

    stand_in.merges_conflict(&[]);
    click(cx, "branch-merge");
    assert_eq!(view.read_with(cx, |view, _| view.said().cloned()), Some(Said::Done("Merged into main.".into())));
    assert_eq!(sent(&stand_in, "kuvo/git/merge").len(), 2);
}

#[gpui::test]
fn a_pull_request_starts_from_the_boxs_draft_and_is_made_from_the_session(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone(), "ses_signup");
    workspace.update(cx, |workspace, cx| workspace.show_panel(Tab::Branches, cx));
    cx.run_until_parked();
    click(cx, "branch-pull-request");
    assert!(bounds(cx, "pull-request").is_some());
    let view = workspace.read_with(cx, |workspace, cx| workspace.panel().read(cx).branches().clone());
    let title = view.read_with(cx, |view, cx| view.writing().unwrap().title.read(cx).text().to_owned());
    assert_eq!(title, "Keep the sign-up form when an email is taken", "the box's draft");

    click(cx, "pull-request-create");
    assert_eq!(
        sent(&stand_in, "kuvo/git/pull-request"),
        [json!({ "directory": website(), "title": "Keep the sign-up form when an email is taken", "body": "- Keep what was typed when the email is taken\n- Say so beside the email field", "session": "ses_signup" })]
    );
    assert!(matches!(view.read_with(cx, |view, _| view.said().cloned()), Some(Said::PullRequest { url: Some(_), .. })));
}

#[gpui::test]
fn the_list_follows_the_box_as_it_changes(cx: &mut TestAppContext) {
    let stand_in = StandIn::at(Replies::Never, NOW);
    let (workspace, cx) = open(cx, stand_in.clone(), "ses_signup");
    cx.simulate_keystrokes("cmd-alt-0");
    cx.run_until_parked();
    // What a follow hands on (an agent's edit, staged elsewhere), taken as it would be.
    stand_in.set_git_files(&website(), vec![json!({ "path": "src/main.tsx", "group": "conflicted", "status": "modified", "scope": "uncommitted" })]);
    let client = workspace.read_with(cx, |workspace, _| workspace.client().clone());
    let view = workspace.read_with(cx, |workspace, cx| workspace.panel().read(cx).changes().clone());
    view.update(cx, |view, cx| view.take(client.git_files(&website()), cx));
    cx.run_until_parked();
    assert!(bounds(cx, "change-Conflicted:src/main.tsx").is_some());
    assert!(bounds(cx, "discard-Conflicted:src/main.tsx").is_none(), "a conflict is resolved, not discarded");
    assert!(bounds(cx, "stage-Conflicted:src/main.tsx").is_some(), "Mark as Resolved");
    assert!(bounds(cx, "change-Staged:src/components/SignupForm.tsx").is_none());
}
