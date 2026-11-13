use gpui::{AnyElement, App, Context, IntoElement, ParentElement, Styled, Window, div, px};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, ButtonStyle, IconName, ShownState, StyledType, TypeSize,
    theme::{radius, space},
};

use crate::{Gallery, page as frame, section};

pub fn page(_window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    frame(
        "Buttons",
        "Primary for the one thing to do, secondary for real alternatives, ghost for quiet actions. Calls to action are pills.",
        vec![
            section("Every style in every state", states(cx), cx),
            section("Sizes, icons and shortcuts", sizes(cx), cx),
            section("Icon-only", icon_only(cx), cx),
            section("In a dialog", dialog(cx), cx),
        ],
        cx,
    )
}

fn header(text: &'static str, cx: &App) -> impl IntoElement {
    div()
        .text_ui(TypeSize::Caption)
        .text_color(cx.theme().colors.text_faint)
        .child(text)
}

fn states(cx: &App) -> impl IntoElement {
    let columns: [(&str, Option<ShownState>, bool); 5] = [
        ("Rest", None, false),
        ("Hover", Some(ShownState::Hovered), false),
        ("Pressed", Some(ShownState::Pressed), false),
        ("Keyboard focus", Some(ShownState::Focused), false),
        ("Disabled", None, true),
    ];
    let styles: [(&str, ButtonStyle, bool, &str); 5] = [
        ("Primary pill", ButtonStyle::Primary, true, "Connect device"),
        ("Primary", ButtonStyle::Primary, false, "Create bot"),
        ("Secondary", ButtonStyle::Secondary, false, "Connect"),
        ("Ghost", ButtonStyle::Ghost, false, "Skip"),
        ("Accent", ButtonStyle::Accent, false, "Send"),
    ];
    let label_w = px(112.);
    let col_w = px(150.);
    div()
        .flex()
        .flex_col()
        .gap(space::S4)
        .child(
            div()
                .flex()
                .child(div().w(label_w))
                .children(columns.iter().map(|(name, _, _)| div().w(col_w).child(header(name, cx)))),
        )
        .children(styles.iter().enumerate().map(|(row, (name, style, pill, label))| {
            div()
                .flex()
                .items_center()
                .child(
                    div()
                        .w(label_w)
                        .text_ui(TypeSize::Small)
                        .text_color(cx.theme().colors.text_muted)
                        .child(*name),
                )
                .children(columns.iter().enumerate().map(|(col, (_, shown, disabled))| {
                    let mut button = Button::new(("state", row * 10 + col), *label)
                        .style(*style)
                        .disabled(*disabled);
                    if *pill {
                        button = button.pill();
                    }
                    if let Some(shown) = shown {
                        button = button.shown(*shown);
                    }
                    div().w(col_w).flex().child(button)
                }))
        }))
}

fn sizes(cx: &App) -> impl IntoElement {
    let _ = cx;
    div()
        .flex()
        .flex_col()
        .gap(space::S5)
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S3)
                .child(Button::new("s-small", "Small").size(ButtonSize::Small))
                .child(Button::new("s-medium", "Medium"))
                .child(Button::new("s-large", "Large").size(ButtonSize::Large))
                .child(Button::new("s-large-pill", "Get started").primary().pill().size(ButtonSize::Large)),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S3)
                .child(Button::new("i-new", "New session").icon(IconName::Plus))
                .child(Button::new("i-model", "Claude Opus 5.5").ghost().icon_after(IconName::ChevronDown))
                .child(Button::new("i-open", "Open in browser").icon_after(IconName::External))
                .child(Button::new("i-continue", "Continue").primary().shortcut("↩"))
                .child(Button::new("i-continue-2", "Continue").shortcut("⌘↩")),
        )
        .child(
            div()
                .flex()
                .items_center()
                .self_start()
                .gap(space::S1)
                .p(space::S1)
                .rounded(radius::NAV + px(4.))
                .bg(cx.theme().colors.sunken)
                .child(Button::new("seg-1", "Monthly").ghost().selected(true).size(ButtonSize::Small))
                .child(Button::new("seg-2", "Annual").ghost().size(ButtonSize::Small))
                .child(Button::new("seg-3", "Custom").ghost().size(ButtonSize::Small)),
        )
}

fn icon_only(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_center()
        .gap(space::S6)
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S1)
                .child(Button::icon_only("io-sidebar", IconName::Sidebar, "Show sidebar"))
                .child(Button::icon_only("io-back", IconName::ChevronLeft, "Back"))
                .child(Button::icon_only("io-fwd", IconName::ChevronRight, "Forward").disabled(true))
                .child(Button::icon_only("io-search", IconName::Search, "Search").shown(ShownState::Hovered))
                .child(Button::icon_only("io-more", IconName::More, "More")),
        )
        .child(div().w(px(1.)).h(px(24.)).bg(c.border))
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S2)
                .child(Button::icon_only("io-plus", IconName::Plus, "Attach").style(ButtonStyle::Secondary).pill())
                .child(Button::icon_only("io-mic", IconName::Mic, "Dictate").style(ButtonStyle::Secondary).pill())
                .child(Button::icon_only("io-send", IconName::ArrowUp, "Send").accent().pill())
                .child(Button::icon_only("io-stop", IconName::Stop, "Stop").primary().pill())
                .child(Button::icon_only("io-send-off", IconName::ArrowUp, "Send").accent().pill().disabled(true)),
        )
}

fn dialog(cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let c = &theme.colors;
    div().flex().justify_center().child(
        div()
            .flex()
            .flex_col()
            .w(px(460.))
            .gap(space::S5)
            .p(space::S6)
            .rounded(radius::CARD)
            .bg(c.elevated)
            .border_1()
            .border_color(c.border)
            .shadow(theme.elevated_shadow())
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S1)
                    .child(div().text_ui(TypeSize::Body).medium().text_color(c.text).child("Stop this session?"))
                    .child(
                        div()
                            .text_ui(TypeSize::Small)
                            .text_color(c.text_muted)
                            .child("The agent stops after its current step. Its changes stay in the worktree."),
                    ),
            )
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(space::S2)
                    .child(Button::new("d-cancel", "Cancel").ghost())
                    .child(Button::new("d-stop", "Stop session").primary().shortcut("↩")),
            ),
    )
}
