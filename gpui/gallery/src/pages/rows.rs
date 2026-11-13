use gpui::{AnyElement, App, Context, IntoElement, ParentElement, Styled, Window, div, px};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, IconName, StyledType, TypeSize,
    row::{ListRow, NavRow, RowState, SectionHeader, row_card},
    small::{Avatar, Chip, ChipTone, count_badge, spinner, status_dot},
    theme::{radius, space},
    IconSize,
};

use crate::{Gallery, page as frame, section};

pub fn page(_window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    frame(
        "Rows and lists",
        "Sidebar rows wash under the pointer and fill when selected; badges, times and status sit at the end. Card lists divide rows with hairlines.",
        vec![section("A sidebar, and a card of accounts", body(cx), cx)],
        cx,
    )
}

fn time(text: &'static str, cx: &App) -> impl IntoElement {
    div().text_ui(TypeSize::Caption).text_color(cx.theme().colors.text_faint).child(text)
}

fn sidebar(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let more = || Button::icon_only("more", IconName::More, "More").size(ButtonSize::Small);
    div()
        .flex()
        .flex_col()
        .w(px(260.))
        .flex_none()
        .p(space::S2)
        .gap(space::S0_5)
        .rounded(radius::CARD)
        .bg(c.background)
        .border_1()
        .border_color(c.border)
        .child(NavRow::new("r-new", "New session").icon(IconName::Compose))
        .child(NavRow::new("r-search", "Search").icon(IconName::Search).trailing(time("⌘K", cx)))
        .child(NavRow::new("r-bots", "Bots").icon(IconName::Bot).trailing(count_badge(3, cx)))
        .child(NavRow::new("r-machines", "Machines").icon(IconName::Computer).shown(RowState::Hovered))
        .child(NavRow::new("r-usage", "Usage").icon(IconName::Clock).disabled(true).trailing(time("Soon", cx)))
        .child(
            SectionHeader::new("projects", "Projects")
                .action(Button::icon_only("p-add", IconName::Plus, "New project").size(ButtonSize::Small))
                .action(more()),
        )
        .child(
            NavRow::new("r-web", "Web")
                .leading(Avatar::new("Web").size(px(18.)))
                .trailing(count_badge(1, cx))
                .selected(true),
        )
        .child(
            NavRow::new("r-fix", "Fix sign-up form data persistence on taken emails")
                .indent(1)
                .leading(spinner("r-fix-spin", IconSize::Nav, c.text_muted))
                .trailing(time("now", cx)),
        )
        .child(
            NavRow::new("r-test", "Add a duplicate-email test")
                .indent(1)
                .leading(status_dot(c.success))
                .trailing(time("2m", cx)),
        )
        .child(
            NavRow::new("r-forms", "Check the other forms")
                .indent(1)
                .leading(status_dot(c.warning))
                .trailing(time("5m", cx))
                .hover_trailing(more()),
        )
        .child(NavRow::new("r-api", "API").leading(Avatar::new("API").size(px(18.))).trailing(time("1h", cx)))
        .child(NavRow::new("r-infra", "Infra").leading(Avatar::new("Infra").size(px(18.))).muted(true).trailing(time("2w", cx)))
}

fn accounts(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let connect = |id: &'static str| Button::new(id, "Connect").size(ButtonSize::Small);
    let value = |text: &'static str| {
        div()
            .flex()
            .items_center()
            .gap(space::S1)
            .text_ui(TypeSize::Small)
            .text_color(c.text_muted)
            .child(text)
            .child(kuvo_ui::Icon::new(IconName::ChevronRight).color(c.text_faint))
    };
    div().flex().flex_col().flex_1().gap(space::S2).child(row_card(
        [
            ListRow::new("a-claude", "Claude Code")
                .icon(IconName::Sparkle, cx)
                .title_extra(Chip::new("det-1", "Detected").dot().tone(ChipTone::Success))
                .detail("Max plan, signed in on this Mac")
                .trailing(connect("a-c1"))
                .into_any_element(),
            ListRow::new("a-codex", "Codex")
                .icon(IconName::Terminal, cx)
                .detail("Signed in on this Mac")
                .trailing(Chip::new("conn", "Connected").tone(ChipTone::Success))
                .shown(RowState::Hovered)
                .into_any_element(),
            ListRow::new("a-copilot", "GitHub Copilot")
                .icon(IconName::Branch, cx)
                .detail("Copilot Pro or Business")
                .trailing(connect("a-c3"))
                .into_any_element(),
            ListRow::new("a-sleep", "Keep working when this Mac sleeps")
                .icon(IconName::Computer, cx)
                .detail("A session can carry on on another of your computers")
                .trailing(value("On"))
                .on_click(|_, _, _| {})
                .into_any_element(),
        ],
        cx,
    ))
}

fn body(cx: &App) -> impl IntoElement {
    div().flex().gap(space::S8).items_start().child(sidebar(cx)).child(accounts(cx))
}
