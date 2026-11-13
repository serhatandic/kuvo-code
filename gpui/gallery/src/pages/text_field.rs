use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, ParentElement, Styled, Window,
    div, px,
};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, IconName, StyledType, TextField, TypeSize,
    theme::{radius, space},
};

use crate::{Gallery, page as frame, section};

/// The fields on the page, kept between frames so they can be typed in.
pub struct Fields {
    pub name: Entity<TextField>,
    pub search: Entity<TextField>,
    pub selected: Entity<TextField>,
    pub disabled: Entity<TextField>,
    pub composer: Entity<TextField>,
    pub empty_composer: Entity<TextField>,
    pub japanese: Entity<TextField>,
}

impl Fields {
    pub fn new(cx: &mut Context<Gallery>) -> Self {
        let name = cx.new(|cx| {
            let mut f = TextField::new(cx).placeholder("Name");
            f.set_text("Research bot", cx);
            f
        });
        let search = cx.new(|cx| TextField::new(cx).placeholder("Search sessions"));
        let selected = cx.new(|cx| {
            let mut f = TextField::new(cx);
            f.set_text("Fix the sign-up form wiping on a taken email", cx);
            f.select_range(8..20, cx);
            f
        });
        let disabled = cx.new(|cx| {
            let mut f = TextField::new(cx);
            f.set_text("~/Projects/kuvo", cx);
            f.set_disabled(true, cx);
            f
        });
        let composer = cx.new(|cx| {
            let mut f = TextField::new(cx)
                .multi_line(1, 8)
                .bare()
                .placeholder("Ask anything, / for commands, @ for files");
            f.set_text(
                "The sign-up form wipes everything when the email is already taken.\n\nKeep what was typed, show the error under the email field, and add a test for it.",
                cx,
            );
            f
        });
        let empty_composer = cx.new(|cx| {
            TextField::new(cx)
                .multi_line(1, 8)
                .bare()
                .placeholder("Ask anything, / for commands, @ for files")
        });
        let japanese = cx.new(|cx| {
            let mut f = TextField::new(cx).placeholder("Message");
            f.set_text("東京の天気を", cx);
            f
        });
        Self { name, search, selected, disabled, composer, empty_composer, japanese }
    }
}

pub fn page(fields: &Fields, _window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    frame(
        "Text field",
        "One line, or many lines that grow like a composer. Selection, the clipboard, undo, and input methods for Japanese and Chinese all work as on a Mac.",
        vec![
            section("One line, in each state", single(fields, cx), cx),
            section("A composer: grows from one line to eight, then scrolls", composers(fields, cx), cx),
            section("Typing Japanese: the composition is underlined until it's committed", japanese(fields, cx), cx),
        ],
        cx,
    )
}

fn labelled(label: &'static str, hint: &'static str, field: &Entity<TextField>, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .flex_col()
        .flex_1()
        .gap(space::S1_5)
        .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child(label))
        .child(field.clone())
        .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(hint))
}

fn single(fields: &Fields, cx: &App) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(space::S5)
        .child(
            div()
                .flex()
                .gap(space::S5)
                .child(labelled("Name", "Filled in", &fields.name, cx))
                .child(labelled("Search", "Empty, showing its placeholder", &fields.search, cx)),
        )
        .child(
            div()
                .flex()
                .gap(space::S5)
                .child(labelled("Title", "A selection, kept grey while another field has focus", &fields.selected, cx))
                .child(labelled("Folder", "Disabled", &fields.disabled, cx)),
        )
}

fn composer(field: &Entity<TextField>, id: &'static str, sending: bool, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let c = &theme.colors;
    div()
        .flex()
        .flex_col()
        .flex_1()
        .gap(space::S2)
        .p(space::S3)
        .pl(space::S4)
        .rounded(radius::CARD)
        .bg(c.surface)
        .border_1()
        .border_color(c.border_strong)
        .shadow(theme.card_shadow())
        .child(div().pt(space::S1).pr(space::S1).child(field.clone()))
        .child(
            div()
                .flex()
                .items_center()
                .gap(space::S1)
                .ml(-space::S2)
                .child(Button::icon_only((id, 0usize), IconName::Plus, "Attach files"))
                .child(
                    Button::new((id, 1usize), "Claude Opus 5.5")
                        .ghost()
                        .size(ButtonSize::Small)
                        .icon_after(IconName::ChevronDown),
                )
                .child(Button::new((id, 2usize), "Medium").ghost().size(ButtonSize::Small).icon_after(IconName::ChevronDown))
                .child(div().flex_1())
                .child(
                    Button::icon_only((id, 3usize), IconName::ArrowUp, "Send")
                        .accent()
                        .pill()
                        .disabled(!sending),
                ),
        )
}

fn composers(fields: &Fields, cx: &App) -> impl IntoElement {
    div()
        .flex()
        .gap(space::S5)
        .items_start()
        .child(composer(&fields.composer, "composer-full", true, cx))
        .child(composer(&fields.empty_composer, "composer-empty", false, cx))
}

fn japanese(fields: &Fields, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .gap(space::S5)
        .items_center()
        .child(div().w(px(380.)).child(fields.japanese.clone()))
        .child(
            div()
                .flex_1()
                .text_ui(TypeSize::Small)
                .text_color(c.text_muted)
                .child("Kotoeri marks しらべて while it's being typed; Return commits it. Chinese pinyin works the same way."),
        )
}
