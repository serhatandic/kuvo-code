use gpui::{
    AnyElement, App, Context, Hsla, IntoElement, ParentElement, Styled, Window, div, px,
};
use kuvo_ui::{
    ActiveTheme, Button, Icon, IconName, IconSize, StyledType, TypeSize,
    theme::{radius, space},
};

use crate::{Gallery, page as frame, section};

pub fn page_body(cx: &App) -> Vec<AnyElement> {
    vec![
        section("Type: SF Pro, regular and medium, at 12, 13, 14 and 24", type_scale(cx), cx),
        section("Text levels", text_levels(cx), cx),
        section("Surfaces, washes and accents", swatches(cx), cx),
        section("Radii and spacing", radii(cx), cx),
        section("Together", together(cx), cx),
    ]
}

pub fn page(_window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    frame(
        "Theme",
        "The tokens every block draws with: one type family, four sizes, three text levels, and radii for navigation, cards and calls to action.",
        page_body(cx),
        cx,
    )
}

fn type_scale(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let row = |size: TypeSize, name: &'static str, sample: &'static str| {
        div()
            .flex()
            .items_baseline()
            .gap(space::S6)
            .child(
                div()
                    .w(px(120.))
                    .flex_none()
                    .text_ui(TypeSize::Caption)
                    .text_color(c.text_faint)
                    .child(name),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S1)
                    .child(div().text_ui(size).text_color(c.text).child(sample))
                    .child(div().text_ui(size).medium().text_color(c.text).child(sample)),
            )
    };
    div()
        .flex()
        .flex_col()
        .gap(space::S5)
        .child(row(TypeSize::Title, "Title · 24 / 30", "Pair with your phone"))
        .child(row(TypeSize::Body, "Body · 14 / 20", "Keep working with Kuvo from your phone, or any other computer."))
        .child(row(TypeSize::Small, "Small · 13 / 18", "Refine memory retrieval · Rebuild orchestration layer"))
        .child(row(TypeSize::Caption, "Caption · 12 / 16", "Worked for 25s · 3 files changed · 2h ago"))
}

fn text_levels(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let level = |color: Hsla, name: &'static str, hex: &'static str, sample: &'static str| {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap(space::S2)
            .child(div().h(px(36.)).rounded(radius::NAV).bg(color))
            .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child(name))
            .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(hex))
            .child(div().text_ui(TypeSize::Small).text_color(color).child(sample))
    };
    let dark = cx.theme().appearance.is_dark();
    div()
        .flex()
        .gap(space::S5)
        .child(level(c.text, "Primary", if dark { "#ECECEC" } else { "#292929" }, "Titles, labels, what you read"))
        .child(level(c.text_muted, "Muted", if dark { "#A3A3A3" } else { "#5D5D5D" }, "Descriptions and icons at rest"))
        .child(level(c.text_faint, "Faint", if dark { "#6E6E6E" } else { "#9E9E9E" }, "Hints, placeholders, times"))
}

fn swatches(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let swatch = |color: Hsla, name: &'static str| {
        div()
            .flex()
            .flex_col()
            .gap(space::S1_5)
            .w(px(112.))
            .child(
                div()
                    .h(px(48.))
                    .rounded(radius::NAV)
                    .bg(color)
                    .border_1()
                    .border_color(c.border),
            )
            .child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(name))
    };
    div()
        .flex()
        .flex_wrap()
        .gap(space::S4)
        .child(swatch(c.background, "Background"))
        .child(swatch(c.surface, "Surface"))
        .child(swatch(c.elevated, "Elevated"))
        .child(swatch(c.sunken, "Sunken"))
        .child(swatch(c.surface.blend(c.hover), "Hover wash"))
        .child(swatch(c.surface.blend(c.selected), "Selected"))
        .child(swatch(c.primary, "Primary"))
        .child(swatch(c.accent, "Accent"))
        .child(swatch(c.success, "Success"))
        .child(swatch(c.warning, "Warning"))
        .child(swatch(c.danger, "Danger"))
        .child(swatch(c.border_strong, "Border"))
}

fn radii(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let shape = |r: gpui::Pixels, w: f32, name: &'static str| {
        div()
            .flex()
            .flex_col()
            .gap(space::S2)
            .child(
                div()
                    .w(px(w))
                    .h(px(56.))
                    .rounded(r)
                    .bg(c.sunken)
                    .border_1()
                    .border_color(c.border_strong),
            )
            .child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(name))
    };
    let step = |n: gpui::Pixels, name: &'static str| {
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(space::S1_5)
            .child(div().w(n).h(n).rounded(px(2.)).bg(c.accent.opacity(0.75)))
            .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(name))
    };
    div()
        .flex()
        .gap(space::S10)
        .items_end()
        .child(
            div()
                .flex()
                .gap(space::S5)
                .child(shape(radius::NAV, 96., "8 · navigation"))
                .child(shape(radius::CARD, 96., "16 · cards"))
                .child(shape(radius::PILL, 128., "Pill · calls to action")),
        )
        .child(
            div()
                .flex()
                .items_end()
                .gap(space::S3)
                .child(step(space::S1, "4"))
                .child(step(space::S2, "8"))
                .child(step(space::S3, "12"))
                .child(step(space::S4, "16"))
                .child(step(space::S6, "24"))
                .child(step(space::S8, "32")),
        )
}

/// A card made only from the tokens, like the pages the app will have.
fn together(cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let c = &theme.colors;
    let feature = |icon: IconName, title: &'static str, body: &'static str| {
        div()
            .flex()
            .items_center()
            .gap(space::S3)
            .px(space::S4)
            .py(space::S3)
            .child(
                div()
                    .flex()
                    .flex_none()
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
    let divider = || div().h(px(1.)).mx(space::S4).bg(c.border);
    div()
        .flex()
        .justify_center()
        .py(space::S4)
        .child(
            div()
                .flex()
                .flex_col()
                .w(px(440.))
                .gap(space::S4)
                .child(Icon::new(IconName::Computer).size(IconSize::Card).color(c.text))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(space::S1)
                        .child(div().text_ui(TypeSize::Title).medium().text_color(c.text).child("Pair with your phone"))
                        .child(
                            div()
                                .text_ui(TypeSize::Body)
                                .text_color(c.text_muted)
                                .child("Keep working with Kuvo from your phone, or any other computer."),
                        ),
                )
                .child(div().flex().child(Button::new("connect", "Connect a device").primary().pill()))
                .child(
                    div()
                        .mt(space::S4)
                        .flex()
                        .flex_col()
                        .rounded(radius::CARD)
                        .border_1()
                        .border_color(c.border)
                        .bg(c.surface)
                        .child(feature(IconName::Message, "Pick up where you left off", "Any session, on any of your computers"))
                        .child(divider())
                        .child(feature(IconName::Bell, "Hear when it's done", "A note when an agent finishes or needs you"))
                        .child(divider())
                        .child(feature(IconName::Sparkle, "Start from anywhere", "New sessions straight from your phone")),
                ),
        )
}
