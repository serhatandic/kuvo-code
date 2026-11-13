use gpui::{AnyElement, App, Context, IntoElement, ParentElement, Styled, Window, div, px};
use kuvo_ui::{
    ActiveTheme, Icon, IconName, IconSize, StyledType, TypeSize,
    row::NavRow,
    theme::{radius, space},
};

use crate::{Gallery, page as frame, section};

pub fn page(_window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    frame(
        "Icons",
        "Kuvo's own line icons, drawn on a 16-unit grid: 14 px in navigation, 20 px on cards. They take the colour of the text around them.",
        vec![
            section("Every icon at 14 px, the navigation size", grid(IconSize::Nav, cx), cx),
            section("At 20 px, the card size", grid(IconSize::Card, cx), cx),
            section("In use", in_use(cx), cx),
        ],
        cx,
    )
}

fn grid(size: IconSize, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let cell = if size == IconSize::Nav { 96. } else { 104. };
    div().flex().flex_wrap().gap(space::S1).children(IconName::ALL.iter().map(|&icon| {
        div()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(space::S2)
            .w(px(cell))
            .h(px(if size == IconSize::Nav { 60. } else { 72. }))
            .rounded(radius::NAV)
            .child(Icon::new(icon).size(size).color(c.text))
            .child(
                div()
                    .text_ui(TypeSize::Caption)
                    .text_color(c.text_faint)
                    .whitespace_nowrap()
                    .child(icon.name()),
            )
    }))
}

fn in_use(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let tile = |icon: IconName, title: &'static str, body: &'static str| {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap(space::S3)
            .p(space::S4)
            .rounded(radius::CARD)
            .border_1()
            .border_color(c.border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(36.))
                    .rounded(radius::NAV)
                    .bg(c.sunken)
                    .child(Icon::new(icon).size(IconSize::Card).color(c.text_muted)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child(title))
                    .child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(body)),
            )
    };
    div()
        .flex()
        .items_start()
        .gap(space::S8)
        .child(
            div()
                .flex()
                .flex_col()
                .w(px(220.))
                .flex_none()
                .gap(space::S0_5)
                .child(NavRow::new("i-new", "New session").icon(IconName::Compose))
                .child(NavRow::new("i-search", "Search").icon(IconName::Search))
                .child(NavRow::new("i-bots", "Bots").icon(IconName::Bot).selected(true))
                .child(NavRow::new("i-machines", "Machines").icon(IconName::Computer))
                .child(NavRow::new("i-files", "Files").icon(IconName::Folder))
                .child(NavRow::new("i-terminal", "Terminal").icon(IconName::Terminal)),
        )
        .child(
            div()
                .flex()
                .flex_1()
                .gap(space::S3)
                .child(tile(IconName::Computer, "This Mac", "Sessions run here"))
                .child(tile(IconName::Globe, "Browser", "The agent can browse"))
                .child(tile(IconName::Branch, "Changes", "Review before you merge")),
        )
}
