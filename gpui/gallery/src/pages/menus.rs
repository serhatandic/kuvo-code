use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, ParentElement, Styled, Window,
    div, px,
};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, IconName, StyledType, TypeSize,
    menu::{ContextMenuArea, HoverCard, Menu, MenuEntry, PopoverMenu, PopoverMenuHandle, hover_card_frame, tooltip_frame},
    row::NavRow,
    small::Avatar,
    theme::space,
};

use crate::{Gallery, page as frame, section};

pub fn model_menu(cx: &mut App) -> Entity<Menu> {
    cx.new(|cx| {
        Menu::new(cx)
            .width(px(260.))
            .header("Anthropic")
            .entry(MenuEntry::new("Claude Opus 5.5").detail("Most capable").checked(true))
            .entry(MenuEntry::new("Claude Sonnet 5.5").detail("Faster"))
            .entry(MenuEntry::new("Claude Haiku 5.5").detail("Fastest"))
            .header("OpenAI")
            .entry(MenuEntry::new("GPT-6").detail("Signed out").disabled(true))
            .separator()
            .entry(MenuEntry::new("Manage models…").icon(IconName::Sliders))
    })
}

pub fn session_menu(cx: &mut App) -> Entity<Menu> {
    cx.new(|cx| {
        Menu::new(cx)
            .width(px(220.))
            .entry(MenuEntry::new("Rename").icon(IconName::Compose).shortcut("⌘R"))
            .entry(MenuEntry::new("Pin to top").icon(IconName::Pin))
            .entry(MenuEntry::new("Open in new window").icon(IconName::External))
            .entry(MenuEntry::new("Copy link").icon(IconName::Link).shortcut("⇧⌘C"))
            .separator()
            .entry(MenuEntry::new("Delete session").icon(IconName::Trash).shortcut("⌘⌫").destructive())
    })
}

/// The menus on the page that the shot opens, or shows in place.
pub struct Menus {
    pub model: PopoverMenuHandle,
    pub context: Entity<Menu>,
}

impl Menus {
    pub fn new(cx: &mut Context<Gallery>) -> Self {
        Self { model: PopoverMenuHandle::default(), context: session_menu(cx) }
    }
}

pub fn page(menus: &Menus, _window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    frame(
        "Menus and popovers",
        "A dropdown from a button, a menu where you right-click, and cards and tooltips that appear when the pointer rests. Menus take the keyboard: arrows to move, Return to choose, Escape to close.",
        vec![
            section("Dropdown and context menu", menus_row(menus, cx), cx),
            section("Hover card and tooltips", hovers(cx), cx),
        ],
        cx,
    )
}

fn menus_row(menus: &Menus, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let caption = |text: &'static str| div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(text);
    div()
        .flex()
        .gap(space::S10)
        .h(px(330.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(space::S3)
                .w(px(300.))
                .child(caption("Click to choose a model"))
                .child(
                    PopoverMenu::new(
                        "model-picker",
                        Button::new("model-trigger", "Claude Opus 5.5")
                            .ghost()
                            .size(ButtonSize::Small)
                            .icon(IconName::Sparkle)
                            .icon_after(IconName::ChevronDown)
                            .selected(menus.model.is_open()),
                        |_, cx| model_menu(cx),
                    )
                    .with_handle(menus.model.clone()),
                ),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(space::S3)
                .flex_1()
                .child(caption("Right-click a session"))
                .child(
                    div()
                        .relative()
                        .child(ContextMenuArea::new(
                            "sessions",
                            div()
                                .flex()
                                .flex_col()
                                .w(px(260.))
                                .gap(space::S0_5)
                                .child(NavRow::new("cm-1", "Fix the sign-up form").icon(IconName::Message))
                                .child(NavRow::new("cm-2", "Add a duplicate-email test").icon(IconName::Message).selected(true))
                                .child(NavRow::new("cm-3", "Check the other forms").icon(IconName::Message)),
                            |_, cx| session_menu(cx),
                        ))
                        // As it looks just after a right-click at the end of the second session.
                        .child(div().absolute().top(px(44.)).left(px(268.)).child(menus.context.clone())),
                ),
        )
}

fn hovers(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let person = |cx: &App| {
        let c = &cx.theme().colors;
        div()
            .flex()
            .flex_col()
            .gap(space::S3)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S3)
                    .child(Avatar::new("Mira").size(px(36.)))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child("Mira"))
                            .child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child("Research bot · on this Mac")),
                    ),
            )
            .child(
                div()
                    .text_ui(TypeSize::Small)
                    .text_color(c.text_muted)
                    .child("Reads the morning's issues and drafts a summary for the team at 8:00."),
            )
            .child(
                div()
                    .flex()
                    .gap(space::S2)
                    .child(Button::new("hc-open", "Open").size(ButtonSize::Small))
                    .child(Button::new("hc-msg", "Message").ghost().size(ButtonSize::Small)),
            )
            .into_any_element()
    };
    let shown_card = hover_card_frame(person(cx), cx);
    div()
        .flex()
        .gap(space::S10)
        .h(px(250.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(space::S1)
                .child(
                    div()
                        .id("mira")
                        .flex()
                        .items_center()
                        .gap(space::S2)
                        .text_ui(TypeSize::Small)
                        .text_color(c.text)
                        .child(Avatar::new("Mira").size(px(20.)))
                        .child("@Mira")
                        .hoverable_tooltip(move |_, cx| HoverCard::new(move |_, cx| person(cx)).build(cx)),
                )
                .child(shown_card),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(space::S6)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(Button::icon_only("tt-sidebar", IconName::Sidebar, "Hide sidebar"))
                        .child(tooltip_frame("Hide sidebar".into(), Some("⌘S".into()), cx)),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(Button::icon_only("tt-new", IconName::Compose, "New session"))
                        .child(tooltip_frame("New session".into(), Some("⌘N".into()), cx)),
                ),
        )
}

use gpui::{InteractiveElement as _, StatefulInteractiveElement as _};
