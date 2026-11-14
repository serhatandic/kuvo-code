//! Each area's own sidebar, beside the rail: Search on top, then the area's navigation.

use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement, ParentElement, Pixels, SharedString,
    Styled, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, Icon, IconName, IconSize, StyledType, TypeSize,
    row::{NavRow, SectionHeader},
    small::{Avatar, count_badge, spinner, status_dot},
    theme::{radius, space},
};

use super::{
    Area, Ctx, Scene,
    data::{BOTS, CATEGORIES, CHATS, COMPUTERS, Doing, NEEDS_YOU, PROJECTS, Reach, SETTINGS, Session},
};

pub fn render(d: &Ctx, width: Pixels, _window: &mut Window, cx: &mut App) -> AnyElement {
    let area = d.scene.area();
    let rows: Vec<AnyElement> = match area {
        Area::Sessions if d.scene == Scene::Empty => first_run(cx),
        Area::Sessions => sessions(d, cx),
        Area::Bots => bots(cx),
        Area::Queue => queue(cx),
        Area::Computers => computers(cx),
        Area::Settings => settings(cx),
    };
    let placeholder = match area {
        Area::Settings => "Search settings",
        Area::Queue => "Search items",
        _ => "Search",
    };
    div()
        .w(width)
        .h_full()
        .flex()
        .flex_col()
        .pt(space::S2)
        .when(d.look.list_title, |l| l.child(area_header(area, cx)))
        .child(div().px(space::S2).pb(space::S2).child(search_field(placeholder, cx)))
        .child(div().flex_1().min_h_0().overflow_hidden().px(space::S2).pb(space::S4).children(rows))
        .into_any_element()
}

/// The compact option names the area over its sidebar, since its rail has no words.
fn area_header(area: Area, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let action = match area {
        Area::Sessions => Some(("New Session", IconName::Plus)),
        Area::Bots => Some(("New Bot", IconName::Plus)),
        Area::Queue => Some(("New Item", IconName::Plus)),
        Area::Computers => Some(("Add a Machine", IconName::Plus)),
        Area::Settings => None,
    };
    div()
        .flex()
        .items_center()
        .justify_between()
        .h(px(28.))
        .pl(space::S4)
        .pr(space::S2)
        .mb(space::S1)
        .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child(area.name()))
        .children(action.map(|(label, icon)| Button::icon_only("area-action", icon, label).size(ButtonSize::Small)))
}

fn search_field(placeholder: &'static str, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_center()
        .gap(space::S1_5)
        .h(px(30.))
        .px(space::S2)
        .rounded(radius::NAV)
        .bg(c.sunken)
        .border_1()
        .border_color(c.border)
        .child(Icon::new(IconName::Search).color(c.text_faint))
        .child(div().flex_1().text_ui(TypeSize::Small).text_color(c.text_faint).child(placeholder))
        .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child("⌘K"))
}

fn time(text: &'static str, accent: bool, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div().text_ui(TypeSize::Caption).text_color(if accent { c.accent } else { c.text_faint }).child(text)
}

fn session_row(d: &Ctx, s: &Session, section: &str, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let leading: AnyElement = match s.doing {
        Doing::Working => spinner(SharedString::from(format!("spin-{section}-{}", s.id)), IconSize::Nav, c.text_muted).into_any_element(),
        Doing::Asked => status_dot(c.accent).into_any_element(),
        Doing::Idle => div().into_any_element(),
    };
    NavRow::new(SharedString::from(format!("session-{section}-{}", s.id)), s.title)
        .leading(leading)
        .trailing(time(s.when, s.doing == Doing::Asked, cx))
        .selected(d.scene.open_session() == Some(s.id))
        .into_any_element()
}

/// A project's own rows hang off a thin line under it (phase 2's sidebar).
fn nested(row: impl IntoElement, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div().pb(space::S0_5).ml(px(15.)).pl(space::S1).border_l_1().border_color(c.border).child(row).into_any_element()
}

fn spaced(row: impl IntoElement) -> AnyElement {
    div().pb(space::S0_5).child(row).into_any_element()
}

fn sessions(d: &Ctx, cx: &App) -> Vec<AnyElement> {
    let c = cx.theme().colors.clone();
    let mut rows = Vec::new();

    if d.look.needs_you {
        // BOX-NEEDED: the sessions waiting on you across projects, newest first, each with what it asks in a few words: `needsYou: [{session, asks: {kind, summary}}]` in the sessions listing `Listing::sidebar()` reads (`GET kuvo/sessions`).
        rows.push(group_header("Needs you", NEEDS_YOU.len(), cx));
        for (id, title, what, when) in NEEDS_YOU {
            rows.push(needs_you_row(d, id, title, what, when, cx));
        }
        rows.push(div().h(space::S2).into_any_element());
    }

    rows.push(
        SectionHeader::new("projects", "Projects")
            .action(Button::icon_only("new-project", IconName::Plus, "New Project").size(ButtonSize::Small))
            .into_any_element(),
    );
    for project in PROJECTS {
        let folded = d.look.folding && project.folded_in_c;
        // BOX-NEEDED: a project's sums: `projects[].{asking, working}` in the same sessions listing (phase 2 counts them in the client today, left to move).
        let asking = project.sessions.iter().filter(|s| s.doing == Doing::Asked).count();
        let working = project.sessions.iter().any(|s| s.doing == Doing::Working);
        let trailing: Option<AnyElement> = if asking > 0 {
            Some(count_badge(asking, cx).into_any_element())
        } else if folded && working {
            Some(spinner(SharedString::from(format!("project-spin-{}", project.name)), IconSize::Nav, c.text_muted).into_any_element())
        } else {
            None
        };
        let mut header = NavRow::new(SharedString::from(format!("project-{}", project.name)), project.name)
            .icon(if folded { IconName::ChevronRight } else { IconName::Folder })
            .hover_trailing(Button::icon_only(SharedString::from(format!("new-in-{}", project.name)), IconName::Plus, format!("New Session in {}", project.name)).size(ButtonSize::Small));
        if let Some(trailing) = trailing {
            header = header.trailing(trailing);
        }
        rows.push(spaced(header));
        if folded {
            continue;
        }
        if project.sessions.is_empty() {
            rows.push(nested(
                div().h(px(26.)).flex().items_center().pl(space::S2).text_ui(TypeSize::Caption).text_color(c.text_faint).child("No sessions yet"),
                cx,
            ));
        }
        for s in project.sessions {
            rows.push(nested(session_row(d, s, "p", cx), cx));
        }
    }

    rows.push(SectionHeader::new("chats", "Chats").into_any_element());
    for s in CHATS {
        rows.push(spaced(session_row(d, s, "c", cx)));
    }
    rows
}

/// A group's header with its count (Capy's "Needs you 1").
fn group_header(label: &'static str, count: usize, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_center()
        .gap(space::S1_5)
        .h(px(28.))
        .pl(space::S2)
        .pt(space::S2)
        .text_ui(TypeSize::Caption)
        .child(div().text_color(c.text_muted).medium().child(label))
        .child(div().text_color(c.text_faint).child(count.to_string()))
        .into_any_element()
}

/// A session waiting on you, on top: its title, and its project and what it asks under it.
fn needs_you_row(d: &Ctx, id: &'static str, title: &'static str, what: &'static str, when: &'static str, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let selected = d.scene.open_session() == Some(id);
    let (hover, selected_bg) = (c.hover, c.selected);
    div()
        .id(SharedString::from(format!("needs-{id}")))
        .flex()
        .gap(space::S2)
        .px(space::S2)
        .py(space::S1_5)
        .mb(space::S0_5)
        .rounded(radius::NAV)
        .cursor_pointer()
        .when(selected, |r| r.bg(selected_bg))
        .hover(move |s| s.bg(if selected { selected_bg } else { hover }))
        .child(div().flex().flex_none().justify_center().w(IconSize::Nav.pixels()).pt(px(6.)).child(status_dot(c.accent)))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().truncate().text_ui(TypeSize::Small).text_color(c.text).when(selected, |t| t.medium()).child(title))
                .child(div().truncate().text_ui(TypeSize::Caption).text_color(c.text_muted).child(what)),
        )
        .child(div().flex_none().child(time(when, true, cx)))
        .into_any_element()
}

/// The first run: nothing yet, and the one thing to do (OpenBot's "Create your first agent").
fn first_run(cx: &App) -> Vec<AnyElement> {
    let c = &cx.theme().colors;
    let theme = cx.theme();
    vec![
        div()
            .id("first-session")
            .flex()
            .items_center()
            .gap(space::S3)
            .p(space::S3)
            .rounded(radius::CARD)
            .bg(c.surface)
            .border_1()
            .border_color(c.border)
            .shadow(theme.card_shadow())
            .cursor_pointer()
            .hover(|s| s.bg(c.hover))
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(32.))
                    .rounded(radius::PILL)
                    .bg(c.accent)
                    .child(Icon::new(IconName::Plus).color(c.text_on_accent)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child("Start your first session"))
                    .child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child("In a project folder, or just a chat")),
            )
            .into_any_element(),
        div()
            .px(space::S2)
            .pt(space::S4)
            .text_ui(TypeSize::Caption)
            .text_color(c.text_faint)
            .child("Your sessions show here, by project.")
            .into_any_element(),
    ]
}

fn bots(cx: &App) -> Vec<AnyElement> {
    let c = cx.theme().colors.clone();
    let mut rows = vec![div().h(space::S1).into_any_element()];
    for (ix, bot) in BOTS.iter().enumerate() {
        // BOX-NEEDED: what a bot is doing now: `now: {working, asking, finished?}` on each bot in `GET kuvo/bots` (and `kuvo/bots/events`); `wakes` is there already.
        let selected = ix == 0;
        let trailing: Option<AnyElement> = if bot.asking > 0 {
            Some(count_badge(bot.asking, cx).into_any_element())
        } else if bot.working {
            Some(spinner(SharedString::from(format!("bot-spin-{ix}")), IconSize::Nav, c.text_muted).into_any_element())
        } else {
            None
        };
        let (hover, selected_bg) = (c.hover, c.selected);
        rows.push(
            div()
                .id(SharedString::from(format!("bot-{ix}")))
                .flex()
                .items_center()
                .gap(space::S2)
                .px(space::S2)
                .py(space::S1_5)
                .mb(space::S0_5)
                .rounded(radius::NAV)
                .cursor_pointer()
                .when(selected, |r| r.bg(selected_bg))
                .hover(move |s| s.bg(if selected { selected_bg } else { hover }))
                // Still avatars: bots' own animated faces aren't brought over yet.
                .child(Avatar::new(bot.name).size(px(28.)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().truncate().text_ui(TypeSize::Small).text_color(c.text).when(selected, |t| t.medium()).child(bot.name))
                        .child(div().truncate().text_ui(TypeSize::Caption).text_color(if bot.asking > 0 { c.accent } else { c.text_muted }).child(bot.now)),
                )
                .children(trailing.map(|t| div().flex_none().child(t)))
                .into_any_element(),
        );
    }
    rows.push(spaced(NavRow::new("new-bot", "New Bot").icon(IconName::Plus).muted(true)));
    rows.push(SectionHeader::new("groups", "Group Chats").into_any_element());
    rows.push(spaced(NavRow::new("group-launch", "Launch crew").icon(IconName::Message).trailing(time("1h", false, cx))));
    rows.push(spaced(NavRow::new("group-design", "Design review").icon(IconName::Message).trailing(time("2d", false, cx))));
    rows
}

fn queue(cx: &App) -> Vec<AnyElement> {
    let c = cx.theme().colors.clone();
    let count = |n: usize| div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(n.to_string());
    // BOX-NEEDED: the Work Queue's counts across your computers: `GET kuvo/work-queue?owner=all&counts=1` → `{counts: {inProgress, categories: {<id>: n}, sources, computers: {<key>: n}, removed}}` (and on its events).
    let mut rows = vec![
        spaced(
            NavRow::new("q-progress", "In Progress")
                .leading(spinner("q-spin", IconSize::Nav, c.text_muted))
                .trailing(count(3)),
        ),
        SectionHeader::new("categories", "Categories")
            .action(Button::icon_only("new-category", IconName::Plus, "New Category").size(ButtonSize::Small))
            .into_any_element(),
    ];
    for (ix, cat) in CATEGORIES.iter().enumerate() {
        let icon = match cat.name {
            "Done" => IconName::Check,
            "Parked" => IconName::Clock,
            _ => IconName::Queue,
        };
        let row = NavRow::new(SharedString::from(format!("cat-{ix}")), cat.name).selected(ix == 0).trailing(count(cat.count));
        let row = if cat.custom {
            row.leading(div().size(px(8.)).rounded(radius::PILL).bg(c.syntax.type_name))
        } else {
            row.icon(icon)
        };
        rows.push(spaced(row));
    }
    rows.push(SectionHeader::new("filters", "Show Only").into_any_element());
    rows.push(spaced(NavRow::new("f-issues", "Issues and Pull Requests").icon(IconName::Branch).trailing(count(5))));
    rows.push(spaced(NavRow::new("f-mac", "On This Mac").icon(IconName::Computer)));
    rows.push(spaced(NavRow::new("f-devbox", "On devbox").icon(IconName::Computer)));
    rows.push(spaced(NavRow::new("f-deleted", "Deleted").icon(IconName::Trash).muted(true)));
    rows
}

fn computers(cx: &App) -> Vec<AnyElement> {
    let c = cx.theme().colors.clone();
    // BOX-NEEDED: your computers and shared machines as one list: `GET kuvo/computers` (and events) → `[{key, name, kind: mac|machine, shared, reach: connected|connecting|away, version, system, via, working, limits: [service]}]`; `kuvo/machines` names only a Mac's machines.
    let mut rows = vec![SectionHeader::new("computers", "Your Computers").into_any_element()];
    for (ix, computer) in COMPUTERS.iter().enumerate() {
        let selected = ix == 1;
        let (dot, detail_color) = match computer.reach {
            Reach::Connected => (c.success, c.text_muted),
            Reach::Unreachable => (c.danger, c.text_muted),
        };
        let (hover, selected_bg) = (c.hover, c.selected);
        let trailing: Option<AnyElement> = (computer.working > 0).then(|| {
            div()
                .flex()
                .items_center()
                .gap(space::S1)
                .child(spinner(SharedString::from(format!("computer-spin-{ix}")), IconSize::Nav, c.text_muted))
                .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(computer.working.to_string()))
                .into_any_element()
        });
        rows.push(
            div()
                .id(SharedString::from(format!("computer-{ix}")))
                .flex()
                .items_center()
                .gap(space::S2)
                .px(space::S2)
                .py(space::S1_5)
                .mb(space::S0_5)
                .rounded(radius::NAV)
                .cursor_pointer()
                .when(selected, |r| r.bg(selected_bg))
                .hover(move |s| s.bg(if selected { selected_bg } else { hover }))
                .child(
                    div()
                        .relative()
                        .flex()
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .size(px(28.))
                        .rounded(radius::NAV)
                        .bg(c.sunken)
                        .border_1()
                        .border_color(c.border)
                        .child(Icon::new(if computer.mac { IconName::Computer } else { IconName::Terminal }).color(c.text_muted))
                        .child(div().absolute().bottom(px(-2.)).right(px(-2.)).size(px(9.)).rounded(radius::PILL).border_2().border_color(c.background).bg(dot)),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(div().truncate().text_ui(TypeSize::Small).text_color(c.text).when(selected, |t| t.medium()).child(computer.name))
                        .child(div().truncate().text_ui(TypeSize::Caption).text_color(detail_color).child(computer.detail)),
                )
                .children(trailing)
                .into_any_element(),
        );
    }
    rows.push(spaced(NavRow::new("add-machine", "Add a Machine").icon(IconName::Plus).muted(true)));
    rows.push(SectionHeader::new("shared", "Shared Machines").into_any_element());
    rows.push(spaced(NavRow::new("shared-build", "build-box").icon(IconName::Terminal).trailing(time("Shared", false, cx))));
    rows
}

fn settings(_cx: &App) -> Vec<AnyElement> {
    let mut rows = Vec::new();
    for (group, sections) in SETTINGS {
        rows.push(SectionHeader::new(SharedString::from(format!("settings-{group}")), *group).into_any_element());
        for section in *sections {
            rows.push(spaced(NavRow::new(SharedString::from(format!("setting-{section}")), *section).selected(*section == "Usage")));
        }
    }
    rows
}
