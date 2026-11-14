//! The main view beside the sidebars, kept simple: the drafts are about the sidebars, so this
//! only has to read as the right page for the area (a conversation, a bot, a queue, a computer,
//! a settings page).

use gpui::{AnyElement, App, IntoElement, ParentElement, SharedString, Styled, Window, div, prelude::FluentBuilder as _, px};
use kuvo_ui::{
    ActiveTheme, Button, Icon, IconName, IconSize, StyledType, TypeSize,
    row::{ListRow, row_card},
    small::spinner,
    theme::{radius, space},
};

use super::{
    Area, Ctx, Scene,
    data::{ACCOUNTS, BOTS, COMPUTERS, NEXT_ITEMS, WORK_NEAR_LIMIT},
    ring,
};

/// The main view's title, and what's beside it (the project).
pub fn title(d: &Ctx) -> (&'static str, Option<&'static str>) {
    match d.scene {
        Scene::Waiting => ("Move the blog to the new CMS", Some("Website")),
        Scene::Working | Scene::Limit | Scene::Narrow => ("Fix the sign-up form wiping on a taken email", Some("Website")),
        Scene::Empty => ("New Session", None),
        Scene::Bots => ("Mira", Some("Bot")),
        Scene::Queue => ("Next", Some("Work Queue")),
        Scene::Computers => ("devbox", Some("Machine")),
        Scene::Settings => ("Usage", Some("Settings")),
    }
}

pub fn render(d: &Ctx, _window: &mut Window, cx: &mut App) -> AnyElement {
    let c = cx.theme().colors.clone();
    let body: AnyElement = match d.scene {
        Scene::Waiting => conversation(false, cx),
        Scene::Working | Scene::Limit | Scene::Narrow => conversation(true, cx),
        Scene::Empty => landing(cx),
        _ => match d.scene.area() {
            Area::Bots => bot_page(cx),
            Area::Queue => queue_page(cx),
            Area::Computers => computer_page(cx),
            _ => usage_page(d, cx),
        },
    };
    let (t, detail) = title(d);
    div()
        .size_full()
        .flex()
        .flex_col()
        // Over a conversation only: a page (a bot, a computer, Settings) has its own title.
        .when(!d.look.title_in_bar && d.scene.area() == Area::Sessions && d.scene != Scene::Empty, |m| {
            m.child(
                div()
                    .h(px(44.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .px(space::S5)
                    .border_b_1()
                    .border_color(c.border)
                    .child(div().flex_none().text_ui(TypeSize::Small).medium().text_color(c.text).child(t))
                    .children(detail.map(|detail| div().min_w_0().truncate().text_ui(TypeSize::Small).text_color(c.text_faint).child(detail))),
            )
        })
        .child(div().flex_1().min_h_0().overflow_hidden().child(body))
        .into_any_element()
}

fn column(content: impl IntoElement) -> impl IntoElement {
    div().size_full().flex().flex_col().items_center().px(space::S6).child(div().w_full().max_w(px(680.)).h_full().flex().flex_col().child(content))
}

fn user_bubble(text: &'static str, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div().flex().justify_end().child(
        div()
            .max_w(gpui::relative(0.8))
            .px(space::S4)
            .py(space::S2)
            .rounded(radius::CARD)
            .bg(c.sunken)
            .border_1()
            .border_color(c.border)
            .text_ui(TypeSize::Body)
            .text_color(c.text)
            .child(text),
    )
}

fn prose(text: &'static str, cx: &App) -> impl IntoElement {
    div().text_ui(TypeSize::Body).text_color(cx.theme().colors.text).child(text)
}

fn step(icon: IconName, verb: &'static str, what: &'static str, extra: Option<(&'static str, &'static str)>, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_center()
        .gap(space::S2)
        .text_ui(TypeSize::Small)
        .child(Icon::new(icon).color(c.text_faint))
        .child(div().text_color(c.text_muted).child(verb))
        .child(div().text_mono(TypeSize::Small).text_color(c.text_faint).child(what))
        .children(extra.map(|(add, remove)| {
            div()
                .flex()
                .gap(space::S1)
                .text_ui(TypeSize::Caption)
                .child(div().text_color(c.diff_added).child(add))
                .child(div().text_color(c.diff_removed).child(remove))
        }))
}

fn working_line(id: &'static str, verb: &'static str, what: Option<&'static str>, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_center()
        .gap(space::S2)
        .text_ui(TypeSize::Small)
        .child(spinner(id, IconSize::Nav, c.text_muted))
        .child(div().text_color(c.text_muted).child(verb))
        .children(what.map(|w| div().text_mono(TypeSize::Small).text_color(c.text_faint).child(w)))
}

fn composer(working: bool, placeholder: &'static str, cx: &App) -> impl IntoElement {
    // Nothing signed in on the first run: no model to pick yet.
    let first_run = !working && placeholder.starts_with("Describe");
    let c = &cx.theme().colors;
    let theme = cx.theme();
    div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .p(space::S4)
        .rounded(radius::CARD)
        .bg(c.surface)
        .border_1()
        .border_color(c.border_strong)
        .shadow(theme.card_shadow())
        .child(div().text_ui(TypeSize::Body).text_color(c.text_faint).child(placeholder))
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S3)
                .child(Icon::new(IconName::Paperclip).color(c.text_muted))
                .child(picker(if first_run { "Choose a Model" } else { "Claude Opus 5.5" }, cx))
                .when(!first_run, |r| r.child(picker("High", cx)))
                .child(div().flex_1())
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(px(32.))
                        .rounded(radius::PILL)
                        .when(working, |b| b.border_1().border_color(c.border_strong).child(Icon::new(IconName::Stop).color(c.text)))
                        .when(!working, |b| b.bg(c.primary).opacity(0.35).child(Icon::new(IconName::ArrowUp).color(c.text_on_primary))),
                ),
        )
}

fn picker(label: &'static str, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_center()
        .gap(space::S1)
        .text_ui(TypeSize::Small)
        .medium()
        .text_color(c.text)
        .child(label)
        .child(Icon::new(IconName::ChevronDown).color(c.text_faint))
}

fn conversation(working: bool, cx: &App) -> AnyElement {
    let c = cx.theme().colors.clone();
    let messages = if working {
        div()
            .flex()
            .flex_col()
            .gap(space::S4)
            .child(user_bubble("People say the sign-up form gets wiped when the email is already taken", cx))
            .child(prose("The form calls reset() before it checks the answer, so a 409 clears every field. I'll keep what was typed and put the error under the email field.", cx))
            .child(step(IconName::Pencil, "Edited", "signup/Form.tsx", Some(("+4", "−2")), cx))
            .child(step(IconName::Terminal, "Ran", "npm test -- signup", None, cx))
            .child(prose("The sign-up tests pass; checking the lint.", cx))
            .child(working_line("main-running", "Running", Some("npm run lint"), cx))
            .child(working_line("main-working", "Working…", None, cx))
            .into_any_element()
    } else {
        div()
            .flex()
            .flex_col()
            .gap(space::S4)
            .child(user_bubble("Move the blog's posts over to the new CMS, keeping their links", cx))
            .child(step(IconName::Terminal, "Ran", "npm run export-posts", None, cx))
            .child(prose("All 42 posts are exported with their slugs. The import writes to the live CMS, so I'd like your word before it runs.", cx))
            .into_any_element()
    };
    let bottom = if working { composer(true, "Ask anything, / for commands", cx).into_any_element() } else { ask_card(cx) };
    column(
        div()
            .size_full()
            .flex()
            .flex_col()
            .pt(space::S6)
            .pb(space::S5)
            .child(div().flex_1().min_h_0().overflow_hidden().child(messages))
            .child(div().pt(space::S4).bg(c.surface).child(bottom)),
    )
    .into_any_element()
}

/// A permission in the composer's place (phase 3's ask card, simplified).
fn ask_card(cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let theme = cx.theme();
    let answer = |n: &'static str, label: &'static str, first: bool| {
        div()
            .flex()
            .items_center()
            .gap(space::S3)
            .h(px(32.))
            .px(space::S3)
            .rounded(radius::NAV)
            .when(first, |a| a.bg(c.selected))
            .text_ui(TypeSize::Small)
            .child(div().w(px(12.)).text_color(c.text_faint).child(n))
            .child(div().text_color(c.text).when(first, |t| t.medium()).child(label))
    };
    div()
        .flex()
        .flex_col()
        .gap(space::S2)
        .p(space::S4)
        .rounded(radius::CARD)
        .bg(c.surface)
        .border_1()
        .border_color(c.accent)
        .shadow(theme.card_shadow())
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S2)
                .child(Icon::new(IconName::Shield).color(c.accent))
                .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child("Run this command?")),
        )
        .child(
            div()
                .px(space::S3)
                .py(space::S2)
                .rounded(radius::NAV)
                .bg(c.sunken)
                .text_mono(TypeSize::Small)
                .text_color(c.text)
                .child("npm run import-posts -- --target=production"),
        )
        .child(answer("1", "Allow Once", true))
        .child(answer("2", "Always Allow in This Project", false))
        .child(answer("3", "Tell It What to Do Instead…", false))
        .into_any_element()
}

fn landing(cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .px(space::S8)
        .child(
            div()
                .w_full()
                .max_w(px(620.))
                .flex()
                .flex_col()
                .gap(space::S3)
                .child(div().text_ui(TypeSize::Title).medium().text_color(c.text).child("What should we work on?"))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(space::S4)
                        .child(div().flex().items_center().gap(space::S1_5).child(Icon::new(IconName::Folder).color(c.text_muted)).child(picker("Choose a Folder", cx)))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(space::S1_5)
                                .text_ui(TypeSize::Small)
                                .text_color(c.text_muted)
                                .child(Icon::new(IconName::Computer).color(c.text_muted))
                                .child("This Mac"),
                        ),
                )
                .child(composer(false, "Describe a task, or just chat", cx)),
        )
        .into_any_element()
}

fn page(title: &'static str, subtitle: &'static str, lead: Option<AnyElement>, actions: Option<AnyElement>, content: Vec<AnyElement>, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .px(space::S8)
        .pt(space::S8)
        .child(
            div()
                .w_full()
                .max_w(px(680.))
                .flex()
                .flex_col()
                .gap(space::S5)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(space::S4)
                        .children(lead)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().text_ui(TypeSize::Title).medium().text_color(c.text).child(title))
                                .child(div().text_ui(TypeSize::Body).text_color(c.text_muted).child(subtitle)),
                        )
                        .children(actions),
                )
                .children(content),
        )
        .into_any_element()
}

fn label(text: &'static str, cx: &App) -> AnyElement {
    div().px(space::S1).text_ui(TypeSize::Caption).medium().text_color(cx.theme().colors.text_faint).child(text).into_any_element()
}

fn bot_page(cx: &App) -> AnyElement {
    let c = cx.theme().colors.clone();
    let bot = &BOTS[0];
    let working = |id: &'static str| spinner(id, IconSize::Nav, c.text_muted).into_any_element();
    page(
        bot.name,
        bot.job,
        Some(super::lists::bot_face(bot, px(48.), cx)),
        Some(
            div()
                .flex()
                .gap(space::S2)
                .child(Button::new("edit-bot", "Edit Bot").pill())
                .child(Button::new("message-bot", "Message").primary().pill())
                .into_any_element(),
        ),
        vec![
            label("Now", cx),
            row_card(
                [
                    ListRow::new("b1", "Fix the sign-up form wiping on a taken email").detail("Website · started 2m ago").trailing(working("bs1")).into_any_element(),
                    ListRow::new("b2", "Move the blog to the new CMS").detail("Website · waiting on you since yesterday").trailing(kuvo_ui::small::status_dot(c.accent)).into_any_element(),
                ],
                cx,
            )
            .into_any_element(),
            label("Earlier", cx),
            row_card(
                [
                    ListRow::new("b3", "Dark mode for the settings page").detail("Website · finished 2h ago").into_any_element(),
                    ListRow::new("b4", "Weekly check of broken links").detail("Website · finished Mon").into_any_element(),
                ],
                cx,
            )
            .into_any_element(),
        ],
        cx,
    )
}

fn queue_page(cx: &App) -> AnyElement {
    let c = cx.theme().colors.clone();
    let rows = NEXT_ITEMS.iter().enumerate().map(|(ix, item)| {
        let mut row = ListRow::new(SharedString::from(format!("item-{ix}")), item.title)
            .detail(item.owner)
            .leading(div().w(px(36.)).text_mono(TypeSize::Small).text_color(c.text_faint).child(format!("#{}", item.number)));
        if item.working {
            row = row.trailing(spinner(SharedString::from(format!("item-spin-{ix}")), IconSize::Nav, c.text_muted));
        }
        row.into_any_element()
    });
    page(
        "Next",
        "6 items, across your computers",
        None,
        Some(Button::new("new-item", "New Item").icon(IconName::Plus).pill().into_any_element()),
        vec![row_card(rows, cx).into_any_element()],
        cx,
    )
}

fn computer_page(cx: &App) -> AnyElement {
    let c = cx.theme().colors.clone();
    let computer = &COMPUTERS[1];
    let fact = |id: &'static str, title: &'static str, detail: &'static str, icon: IconName| {
        ListRow::new(id, title).detail(detail).icon(icon, cx).into_any_element()
    };
    page(
        computer.name,
        computer.detail,
        Some(
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(px(48.))
                .rounded(radius::CARD)
                .bg(c.sunken)
                .border_1()
                .border_color(c.border)
                .child(Icon::new(IconName::Terminal).size(IconSize::Card).color(c.text_muted))
                .into_any_element(),
        ),
        // Opening a computer here shows its page; the title bar's switcher is what changes whose
        // box the window shows, so the page offers that.
        Some(
            div()
                .flex()
                .gap(space::S2)
                .child(Button::new("open-terminal", "Terminal").icon(IconName::Terminal).pill())
                .child(Button::new("switch-to", "Switch to devbox").primary().pill())
                .into_any_element(),
        ),
        vec![
            // BOX-NEEDED: a computer's facts: reach, Kuvo Code's and the engine's versions, its sessions at work, and which services' limits it reads (`GET kuvo/computers`, below in lists.rs).
            row_card(
                [
                    fact("c1", "Connected", "Kuvo Code 1.42 · engine 1.19", IconName::Check),
                    fact("c2", "1 session at work", "Mobile · Push notifications on Android", IconName::Message),
                    fact("c3", "Reads the limits of", "Claude, Codex", IconName::Clock),
                ],
                cx,
            )
            .into_any_element(),
        ],
        cx,
    )
}

fn usage_page(d: &Ctx, cx: &App) -> AnyElement {
    let c = cx.theme().colors.clone();
    let theme = cx.theme().clone();
    let accounts = std::iter::once(if d.scene == Scene::Limit { &WORK_NEAR_LIMIT } else { &ACCOUNTS[0] }).chain(ACCOUNTS.iter().skip(1));
    let cards = accounts.map(|account| {
        div()
            .w(px(332.))
            .p(space::S4)
            .rounded(radius::CARD)
            .bg(c.surface)
            .border_1()
            .border_color(c.border)
            .shadow(theme.card_shadow())
            .child(ring::account_card(account, d.look.calm, false, cx))
            .into_any_element()
    });
    page(
        "Usage",
        "Your plans' limits, read by each computer that runs them.",
        None,
        None,
        vec![div().flex().flex_wrap().gap(space::S4).children(cards).into_any_element()],
        cx,
    )
}
