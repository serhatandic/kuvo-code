//! The sidebar: New Session and the search, then the box's sessions as its list says them: pinned,
//! each project with its sessions nested under it (newest first), and chats. A session at work shows
//! a spinner; one waiting on you, a dot, and its project counts them. Under it all, the box it's on.
//!
//! Searching shows sessions whose names have the words as you type, then, from three characters,
//! the conversations the box finds them in (`kuvo/search`). The arrows walk the list (from the
//! search, ↓ steps into it, and ↑ from its first row back out), Return opens what's under the
//! cursor (a project folds), Escape leaves it.

use gpui::{
    AnyElement, App, Context, InteractiveElement, IntoElement, KeyBinding, MouseButton, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, actions, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::search::SEARCHED_FROM;
use kuvo_box::sessions::Facts;
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, Icon, IconName, IconSize, StyledType, TypeSize,
    row::{NavRow, SectionHeader},
    small::{count_badge, spinner, status_dot},
    theme::{radius, space},
};

use crate::time;
use crate::workspace::{BoxState, Lists, Workspace};

actions!(sidebar, [WalkNext, WalkPrevious, WalkOpen, WalkLeave, FocusSearch]);

/// How wide it is.
pub const WIDTH: f32 = 272.;
/// The room the window's buttons take above it (macOS's traffic lights).
pub const TOP: f32 = 44.;
/// How many of a project's sessions show before "Show more".
pub const SHOWN: usize = 6;
/// The key context of the list while the keyboard walks it, and of the search around its field.
pub const CONTEXT: &str = "Sidebar";
pub const SEARCH: &str = "SidebarSearch";

/// The keys the sidebar takes: the list's while it has the keyboard, and the search field's arrows,
/// Return and Escape ahead of the field's own.
pub fn bind_keys(cx: &mut App) {
    let list = Some(CONTEXT);
    let search = format!("{SEARCH} > {}", kuvo_ui::text_field::CONTEXT);
    let search = Some(search.as_str());
    cx.bind_keys([
        KeyBinding::new("down", WalkNext, list),
        KeyBinding::new("up", WalkPrevious, list),
        KeyBinding::new("enter", WalkOpen, list),
        KeyBinding::new("escape", WalkLeave, list),
        KeyBinding::new("down", WalkNext, search),
        KeyBinding::new("up", WalkPrevious, search),
        KeyBinding::new("enter", WalkOpen, search),
        KeyBinding::new("escape", WalkLeave, search),
        KeyBinding::new("cmd-shift-f", FocusSearch, Some("Workspace")),
    ]);
}

/// One line of the sidebar's list, in the order it shows: what the keyboard walks, and what's
/// between (headers, quiet words).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Line {
    Header(&'static str),
    /// Quiet words: nothing matches, why a search couldn't be made.
    Quiet(String),
    /// A project with no sessions yet, under it.
    Empty(String),
    Project(String),
    /// A session; `section` tells apart the rows of one that shows twice (pinned, and in its
    /// project), `nested`: under its project.
    Session { id: String, section: &'static str, nested: bool },
    /// "Show N more" (or fewer) under a project.
    More(String),
    /// A conversation whose words have the search, with the words around them.
    Found { id: String, snippet: String },
    /// The box is searching conversations.
    Searching,
}

impl Line {
    /// Whether the keyboard stops on it.
    pub fn walkable(&self) -> bool {
        matches!(self, Line::Project(_) | Line::Session { .. } | Line::More(_) | Line::Found { .. })
    }

    /// What it's known by while the list changes under it.
    pub fn key(&self) -> String {
        match self {
            Line::Project(directory) => format!("project:{directory}"),
            Line::Session { id, section, .. } => format!("session-{section}:{id}"),
            Line::More(directory) => format!("more:{directory}"),
            Line::Found { id, .. } => format!("found:{id}"),
            Line::Header(title) => format!("header:{title}"),
            Line::Quiet(words) => format!("quiet:{words}"),
            Line::Empty(directory) => format!("empty:{directory}"),
            Line::Searching => "searching".into(),
        }
    }
}

/// The list's lines as it shows them now: the box's sessions, or what a search finds.
pub fn lines(workspace: &Workspace, cx: &App) -> Vec<Line> {
    let query = workspace.search_text(cx);
    if !query.trim().is_empty() {
        return found_lines(workspace, query.trim());
    }
    let listing = workspace.listing();
    let sidebar = listing.sidebar();
    let mut lines = Vec::new();
    if !sidebar.pinned.is_empty() {
        lines.push(Line::Header("Pinned"));
        lines.extend(sidebar.pinned.iter().map(|id| Line::Session { id: id.clone(), section: "pinned", nested: false }));
    }
    if !sidebar.projects.is_empty() {
        lines.push(Line::Header("Projects"));
    }
    for group in &sidebar.projects {
        lines.push(Line::Project(group.directory.clone()));
        if workspace.is_collapsed(&group.directory) {
            continue;
        }
        if group.sessions.is_empty() {
            lines.push(Line::Empty(group.directory.clone()));
            continue;
        }
        let shown = if workspace.shows_all(&group.directory) { group.sessions.len() } else { group.sessions.len().min(SHOWN) };
        lines.extend(group.sessions[..shown].iter().map(|id| Line::Session { id: id.clone(), section: "project", nested: true }));
        if group.sessions.len() > SHOWN {
            lines.push(Line::More(group.directory.clone()));
        }
    }
    if !sidebar.chats.is_empty() {
        lines.push(Line::Header("Chats"));
        lines.extend(sidebar.chats.iter().map(|id| Line::Session { id: id.clone(), section: "chat", nested: false }));
    }
    lines
}

/// What a search finds: sessions by their names, then (from three characters) the conversations
/// the box found the words in, less those found by name.
fn found_lines(workspace: &Workspace, query: &str) -> Vec<Line> {
    let named = workspace.listing().named(query);
    let searched = query.chars().count() >= SEARCHED_FROM;
    let finds = workspace.finds();
    let in_conversations: Vec<Line> = finds
        .iter()
        .filter(|found| !named.contains(&found.session) && workspace.listing().facts(&found.session).is_some())
        .map(|found| Line::Found { id: found.session.clone(), snippet: found.snippet.clone() })
        .collect();
    let mut lines = Vec::new();
    if !named.is_empty() || in_conversations.is_empty() {
        lines.push(Line::Header("Results"));
    }
    if named.is_empty() && in_conversations.is_empty() && !workspace.is_finding() {
        lines.push(Line::Quiet("Nothing matches.".into()));
    }
    lines.extend(named.into_iter().map(|id| Line::Session { id, section: "found", nested: false }));
    let failed = workspace.find_failed();
    if searched && (workspace.is_finding() || !in_conversations.is_empty() || failed.is_some()) {
        lines.push(Line::Header("In Conversations"));
        if workspace.is_finding() {
            lines.push(Line::Searching);
        }
        lines.extend(in_conversations);
        if let Some(why) = failed {
            lines.push(Line::Quiet(format!("Conversations couldn’t be searched: {why}")));
        }
    }
    lines
}

pub fn render(workspace: &Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let landing = workspace.is_landing();
    let new_session = NavRow::new("new-session", "New Session")
        .icon(IconName::Compose)
        .selected(landing)
        .trailing(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child("⌘N"))
        .on_click(cx.listener(|this, _, window, cx| this.new_session(None, window, cx)));

    let lists: Vec<AnyElement> = match workspace.lists() {
        Lists::Loading => vec![quiet(Some("Loading sessions…"), true, cx)],
        Lists::Waiting(why) => vec![quiet(Some(&format!("Loading sessions… {why}")), true, cx)],
        Lists::Held => vec![quiet(Some("Kuvo Code here is updating. Its sessions show once it has."), false, cx)],
        Lists::Failed(why) if !workspace.listing().is_read() => vec![quiet(Some(why), false, cx)],
        _ => sessions(workspace, window, cx),
    };

    div()
        .id("sidebar")
        .on_action(cx.listener(|this, _: &WalkNext, window, cx| this.walk(1, window, cx)))
        .on_action(cx.listener(|this, _: &WalkPrevious, window, cx| this.walk(-1, window, cx)))
        .on_action(cx.listener(|this, _: &WalkOpen, window, cx| this.open_walked(window, cx)))
        .on_action(cx.listener(|this, _: &WalkLeave, window, cx| this.leave_walk(window, cx)))
        .flex()
        .flex_col()
        .w(px(WIDTH))
        .h_full()
        .flex_none()
        // The window's buttons sit here; dragging it moves the window.
        .child(
            div()
                .h(px(TOP))
                .flex_none()
                .on_mouse_down(MouseButton::Left, |event, window, _| {
                    if event.click_count == 1 {
                        window.start_window_move();
                    }
                }),
        )
        .child(div().px(space::S2).pb(space::S1).child(new_session))
        .child(div().px(space::S2).pb(space::S2).child(search_field(workspace, cx)))
        .child(
            div()
                .id("sidebar-lists")
                .key_context(CONTEXT)
                .track_focus(workspace.list_focus())
                .track_scroll(workspace.list_scroll())
                .flex_1()
                .min_h_0()
                .w_full()
                .overflow_y_scroll()
                .px(space::S2)
                .pb(space::S4)
                .children(lists),
        )
        .child(footer(workspace, cx))
        .into_any_element()
}

/// The search: a sunken field with its glass, and × to clear it while it has words.
fn search_field(workspace: &Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let has_words = !workspace.search_text(cx).is_empty();
    div()
        .key_context(SEARCH)
        .debug_selector(|| "sidebar-search".into())
        .flex()
        .items_center()
        .gap(space::S1_5)
        .h(px(30.))
        .pl(space::S2)
        .pr(space::S1)
        .rounded(radius::NAV)
        .bg(c.sunken)
        .child(Icon::new(IconName::Search).size(IconSize::Nav).color(c.text_faint))
        .child(div().flex_1().min_w_0().child(workspace.search().clone()))
        .when(has_words, |d| {
            d.child(Button::icon_only("clear-search", IconName::Close, "Clear the search").size(ButtonSize::Small).on_click(cx.listener(|this, _, window, cx| this.clear_search(window, cx))))
        })
        .into_any_element()
}

/// The list's rows, one for each of its lines, so the keyboard can bring any into view.
fn sessions(workspace: &Workspace, _window: &mut Window, cx: &mut Context<Workspace>) -> Vec<AnyElement> {
    let lines = lines(workspace, cx);
    if lines.is_empty() {
        return vec![quiet(Some("No sessions yet."), false, cx)];
    }
    let cursor = workspace.walked();
    lines.iter().map(|line| line_row(workspace, line, cursor == Some(line.key().as_str()), cx)).collect()
}

fn line_row(workspace: &Workspace, line: &Line, cursor: bool, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let listing = workspace.listing();
    let row: AnyElement = match line {
        Line::Header(title) => {
            let selector = format!("header-{title}");
            div().debug_selector(move || selector).child(SectionHeader::new(SharedString::from(format!("header-{title}")), *title)).into_any_element()
        }
        Line::Quiet(words) => div().px(space::S2).py(space::S1_5).text_ui(TypeSize::Small).text_color(c.text_muted).child(words.clone()).into_any_element(),
        Line::Searching => div()
            .flex()
            .items_center()
            .gap(space::S2)
            .px(space::S2)
            .py(space::S1_5)
            .text_ui(TypeSize::Small)
            .text_color(c.text_muted)
            .child(spinner("searching", IconSize::Nav, c.text_muted))
            .child("Searching conversations…")
            .into_any_element(),
        Line::Empty(_) => div().h(px(26.)).flex().items_center().pl(space::S2).text_ui(TypeSize::Caption).text_color(c.text_faint).child("No sessions yet").into_any_element(),
        Line::Project(directory) => {
            let sidebar = listing.sidebar();
            let Some(group) = sidebar.projects.iter().find(|group| &group.directory == directory) else { return div().into_any_element() };
            let collapsed = workspace.is_collapsed(directory);
            let asking = group.sessions.iter().filter(|id| listing.facts(id).is_some_and(|facts| facts.asked.is_some())).count();
            let running = group.sessions.iter().any(|id| listing.facts(id).is_some_and(Facts::is_running));
            let trailing: Option<AnyElement> = if asking > 0 {
                Some(count_badge(asking, cx).into_any_element())
            } else if collapsed && running {
                Some(spinner(SharedString::from(format!("project-spin-{directory}")), IconSize::Nav, c.text_muted).into_any_element())
            } else {
                None
            };
            let (toggle, start_in) = (directory.clone(), directory.clone());
            let mut header = NavRow::new(SharedString::from(format!("project-{directory}")), group.name.clone())
                .icon(if collapsed { IconName::ChevronRight } else { IconName::Folder })
                .cursor(cursor)
                .hover_trailing(
                    Button::icon_only(SharedString::from(format!("new-in-{directory}")), IconName::Plus, format!("New session in {}", group.name))
                        .size(ButtonSize::Small)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.new_session(Some(start_in.clone()), window, cx);
                        })),
                )
                .on_click(cx.listener(move |this, _, _, cx| this.toggle_project(&toggle, cx)));
            if let Some(trailing) = trailing {
                header = header.trailing(trailing);
            }
            let selector = format!("project-{}", group.name);
            div().debug_selector(move || selector).child(header).into_any_element()
        }
        Line::Session { id, section, .. } => session_row(workspace, id, section, cursor, cx),
        Line::More(directory) => {
            let sidebar = listing.sidebar();
            let count = sidebar.projects.iter().find(|group| &group.directory == directory).map_or(0, |group| group.sessions.len());
            let label = if workspace.shows_all(directory) { "Show fewer".to_owned() } else { format!("Show {} more", count.saturating_sub(SHOWN)) };
            let toggle = directory.clone();
            NavRow::new(SharedString::from(format!("more-{directory}")), label).muted(true).cursor(cursor).on_click(cx.listener(move |this, _, _, cx| this.toggle_all(&toggle, cx))).into_any_element()
        }
        Line::Found { id, snippet } => found_row(workspace, id, snippet, cursor, cx),
    };
    // A project's own rows hang off a thin line under it, unbroken from one to the next.
    let nested = matches!(line, Line::Session { nested: true, .. } | Line::More(_) | Line::Empty(_));
    div()
        .pb(space::S0_5)
        .when(nested, |d| d.ml(px(15.)).pl(space::S1).border_l_1().border_color(c.border))
        .child(row)
        .into_any_element()
}

fn session_row(workspace: &Workspace, id: &str, section: &str, cursor: bool, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let facts = workspace.listing().facts(id).cloned();
    let title = facts.as_ref().and_then(|facts| facts.title.clone()).filter(|title| !title.trim().is_empty()).unwrap_or_else(|| "New Session".into());
    let running = facts.as_ref().is_some_and(Facts::is_running);
    let asked = facts.as_ref().is_some_and(|facts| facts.asked.is_some());
    // What it's doing, before its title: at work, or waiting on you.
    // Started here, and what was written didn't go: waiting in it, with why.
    let unsent = workspace.is_unsent(id);
    let leading: AnyElement = if unsent {
        status_dot(c.danger).into_any_element()
    } else if running {
        spinner(SharedString::from(format!("spin-{section}-{id}")), IconSize::Nav, c.text_muted).into_any_element()
    } else if asked {
        status_dot(c.accent).into_any_element()
    } else {
        div().into_any_element()
    };
    let when = facts.as_ref().map(|facts| time::ago(facts.updated, workspace.now())).unwrap_or_default();
    // Waiting on you: its time in the accent, beside the dot.
    let trailing = div().text_ui(TypeSize::Caption).text_color(if asked { c.accent } else { c.text_faint }).child(when);
    let open = id.to_owned();
    let selector = format!("session-{section}-{id}");
    div()
        .debug_selector(move || selector)
        .child(
            NavRow::new(SharedString::from(format!("session-{section}-{id}")), title)
                .leading(leading)
                .trailing(trailing)
                .selected(workspace.opened() == Some(id))
                .cursor(cursor)
                .on_click(cx.listener(move |this, _, window, cx| this.open_session(&open, window, cx))),
        )
        .into_any_element()
}

/// A conversation the search found words in: its title, and the words around them under it.
fn found_row(workspace: &Workspace, id: &str, snippet: &str, cursor: bool, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let title = workspace.listing().facts(id).and_then(|facts| facts.title.clone()).filter(|title| !title.trim().is_empty()).unwrap_or_else(|| "New Session".into());
    let selected = workspace.opened() == Some(id);
    let open = id.to_owned();
    let selector = format!("found-{id}");
    let (hover, selected_bg) = (c.hover, c.selected);
    div()
        .id(SharedString::from(format!("found-{id}")))
        .debug_selector(move || selector)
        .flex()
        .flex_col()
        .gap(space::S0_5)
        .px(space::S2)
        .py(space::S1_5)
        .rounded(radius::NAV)
        .border_1()
        .border_color(if cursor { c.accent } else { gpui::transparent_black() })
        .when(selected, |d| d.bg(selected_bg))
        .when(cursor && !selected, |d| d.bg(hover))
        .cursor_pointer()
        .hover(move |s| s.bg(if selected { selected_bg } else { hover }))
        .on_click(cx.listener(move |this, _, window, cx| this.open_session(&open, window, cx)))
        .child(div().truncate().text_ui(TypeSize::Small).text_color(c.text).when(selected, |d| d.medium()).child(title))
        .child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).line_clamp(2).child(snippet.trim().to_owned()))
        .into_any_element()
}

/// Quiet words in the sidebar's place: loading, nothing yet, or what's wrong.
fn quiet(words: Option<&str>, busy: bool, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .w_full()
        .flex()
        .items_start()
        .gap(space::S2)
        .px(space::S2)
        .pt(space::S3)
        .text_ui(TypeSize::Small)
        .text_color(c.text_muted)
        .children(busy.then(|| div().pt(px(3.)).child(spinner("lists-loading", IconSize::Nav, c.text_muted))))
        .children(words.map(|words| div().flex_1().min_w_0().child(words.to_owned())))
        .into_any_element()
}

/// The box it's on, and how it's reached.
fn footer(workspace: &Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let (dot, said) = match workspace.box_state() {
        BoxState::Connecting => (c.text_faint, "Connecting…".to_owned()),
        BoxState::Connected => (c.success, String::new()),
        BoxState::Updating => (c.warning, kuvo_box::gate::UPDATING.to_owned()),
        BoxState::Unreachable(why) => (c.danger, why.clone()),
    };
    let appearance = cx.theme().appearance;
    div()
        .flex()
        .items_center()
        .gap(space::S2)
        .h(px(48.))
        .px(space::S4)
        .border_t_1()
        .border_color(c.border)
        .child(kuvo_ui::Icon::new(IconName::Computer).size(IconSize::Nav).color(c.text_muted))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().flex().items_center().gap(space::S1_5).text_ui(TypeSize::Small).text_color(c.text).child(workspace.box_name()).child(status_dot(dot)))
                .when(!said.is_empty(), |d| d.child(div().truncate().text_ui(TypeSize::Caption).text_color(c.text_faint).child(said))),
        )
        .child(
            Button::icon_only(
                "appearance",
                if appearance.is_dark() { IconName::Sun } else { IconName::Moon },
                if appearance.is_dark() { "Light Appearance" } else { "Dark Appearance" },
            )
            .size(ButtonSize::Small)
            .on_click(|_, window, cx| window.dispatch_action(Box::new(crate::ToggleAppearance), cx)),
        )
        .into_any_element()
}
