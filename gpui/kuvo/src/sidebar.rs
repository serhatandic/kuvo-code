//! The sidebar: New Session, then the box's sessions as its list says them: pinned, each project
//! with its sessions nested under it (newest first), and chats. A session at work shows a spinner;
//! one waiting on you, a dot, and its project counts them. Under it all, the box it's on.

use gpui::{
    AnyElement, App, Context, InteractiveElement, IntoElement, MouseButton, ParentElement, SharedString, StatefulInteractiveElement,
    Styled, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::sessions::Facts;
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, IconName, IconSize, StyledType, TypeSize,
    row::{NavRow, SectionHeader},
    small::{count_badge, spinner, status_dot},
    theme::space,
};

use crate::time;
use crate::workspace::{BoxState, Lists, Workspace};

/// How wide it is.
pub const WIDTH: f32 = 272.;
/// The room the window's buttons take above it (macOS's traffic lights).
pub const TOP: f32 = 44.;
/// How many of a project's sessions show before "Show more".
pub const SHOWN: usize = 6;

pub fn render(workspace: &Workspace, window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let landing = workspace.is_landing();
    let new_session = NavRow::new("new-session", "New Session")
        .icon(IconName::Compose)
        .selected(landing)
        .trailing(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child("⌘N"))
        .on_click(cx.listener(|this, _, window, cx| this.new_session(None, window, cx)));

    let lists: AnyElement = match workspace.lists() {
        Lists::Loading => quiet(Some("Loading sessions…"), true, cx),
        Lists::Waiting(why) => quiet(Some(&format!("Loading sessions… {why}")), true, cx),
        Lists::Held => quiet(Some("Kuvo Code here is updating. Its sessions show once it has."), false, cx),
        Lists::Failed(why) if !workspace.listing().is_read() => quiet(Some(why), false, cx),
        _ => sessions(workspace, window, cx),
    };

    div()
        .id("sidebar")
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
        .child(div().px(space::S2).pb(space::S2).child(new_session))
        .child(div().id("sidebar-lists").flex_1().min_h_0().w_full().overflow_y_scroll().px(space::S2).pb(space::S4).child(lists))
        .child(footer(workspace, cx))
        .into_any_element()
}

fn sessions(workspace: &Workspace, _window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let listing = workspace.listing();
    let sidebar = listing.sidebar();
    let mut column = div().flex().flex_col().gap(space::S0_5);
    if sidebar.pinned.is_empty() && sidebar.projects.is_empty() && sidebar.chats.is_empty() {
        return quiet(Some("No sessions yet."), false, cx);
    }
    if !sidebar.pinned.is_empty() {
        column = column.child(SectionHeader::new("pinned-header", "Pinned"));
        for id in &sidebar.pinned {
            column = column.child(session_row(workspace, id, "pinned", cx));
        }
    }
    if !sidebar.projects.is_empty() {
        column = column.child(SectionHeader::new("projects-header", "Projects"));
    }
    for group in &sidebar.projects {
        let directory = group.directory.clone();
        let collapsed = workspace.is_collapsed(&directory);
        let asking = group.sessions.iter().filter(|id| listing.facts(id).is_some_and(|facts| facts.asked.is_some())).count();
        let running = group.sessions.iter().any(|id| listing.facts(id).is_some_and(Facts::is_running));
        let c = cx.theme().colors.clone();
        let trailing: Option<AnyElement> = if asking > 0 {
            Some(count_badge(asking, cx).into_any_element())
        } else if collapsed && running {
            Some(spinner(SharedString::from(format!("project-spin-{directory}")), IconSize::Nav, c.text_muted).into_any_element())
        } else {
            None
        };
        let toggle = directory.clone();
        let start_in = directory.clone();
        let mut header = NavRow::new(SharedString::from(format!("project-{directory}")), group.name.clone())
            .icon(if collapsed { IconName::ChevronRight } else { IconName::Folder })
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
        column = column.child(div().debug_selector(move || selector).child(header));
        if collapsed {
            continue;
        }
        if group.sessions.is_empty() {
            column = column.child(nested(vec![div().h(px(26.)).flex().items_center().pl(space::S2).text_ui(TypeSize::Caption).text_color(c.text_faint).child("No sessions yet").into_any_element()], cx));
            continue;
        }
        let all = workspace.shows_all(&directory);
        let shown = if all { group.sessions.len() } else { group.sessions.len().min(SHOWN) };
        let mut rows: Vec<AnyElement> = group.sessions[..shown].iter().map(|id| session_row(workspace, id, "project", cx)).collect();
        if group.sessions.len() > SHOWN {
            let more = group.sessions.len() - SHOWN;
            let label = if all { "Show fewer".to_owned() } else { format!("Show {more} more") };
            let toggle = directory.clone();
            rows.push(NavRow::new(SharedString::from(format!("more-{directory}")), label).muted(true).on_click(cx.listener(move |this, _, _, cx| this.toggle_all(&toggle, cx))).into_any_element());
        }
        column = column.child(nested(rows, cx));
    }
    if !sidebar.chats.is_empty() {
        column = column.child(SectionHeader::new("chats-header", "Chats"));
        for id in &sidebar.chats {
            column = column.child(session_row(workspace, id, "chat", cx));
        }
    }
    column.into_any_element()
}

/// A project's sessions, hung off a thin line under it.
fn nested(rows: Vec<AnyElement>, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div().ml(px(15.)).pl(space::S1).border_l_1().border_color(c.border).flex().flex_col().gap(space::S0_5).children(rows).into_any_element()
}

fn session_row(workspace: &Workspace, id: &str, section: &str, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let facts = workspace.listing().facts(id).cloned();
    let title = facts.as_ref().and_then(|facts| facts.title.clone()).filter(|title| !title.trim().is_empty()).unwrap_or_else(|| "New Session".into());
    let running = facts.as_ref().is_some_and(Facts::is_running);
    let asked = facts.as_ref().is_some_and(|facts| facts.asked.is_some());
    // What it's doing, before its title: at work, or waiting on you.
    let leading: AnyElement = if running {
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
                .on_click(cx.listener(move |this, _, window, cx| this.open_session(&open, window, cx))),
        )
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
