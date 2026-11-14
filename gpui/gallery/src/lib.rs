//! The gallery: one page per building block, with realistic sample content, in light and dark.
//!
//! `main.rs` opens it in a window; `bin/shots.rs` renders each page offscreen to a PNG.

pub mod drafts;
mod pages;

use gpui::{
    AnyElement, App, AppContext, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    KeyBinding, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    actions, div, px,
};
use kuvo_ui::{
    ActiveTheme, Appearance, Button, IconName, StyledType, Theme, TypeSize,
    backdrop::backdrop,
    theme::{radius, space},
};

pub use pages::Demos;

actions!(gallery, [ToggleAppearance, NextBlock, PreviousBlock]);

/// The blocks, in the order they're built.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    Theme,
    Icons,
    Buttons,
    TextField,
    ChatList,
    Markdown,
    CodeBlocks,
    Menus,
    Rows,
    SmallPieces,
    /// Drafts of the two-level sidebar, for the user to pick from.
    SidebarDrafts,
}

impl Block {
    pub const ALL: &'static [Block] = &[
        Block::Theme,
        Block::Icons,
        Block::Buttons,
        Block::TextField,
        Block::ChatList,
        Block::Markdown,
        Block::CodeBlocks,
        Block::Menus,
        Block::Rows,
        Block::SmallPieces,
        Block::SidebarDrafts,
    ];

    pub fn title(self) -> &'static str {
        match self {
            Block::Theme => "Theme",
            Block::Icons => "Icons",
            Block::Buttons => "Buttons",
            Block::TextField => "Text field",
            Block::ChatList => "Chat list",
            Block::Markdown => "Markdown",
            Block::CodeBlocks => "Code blocks",
            Block::Menus => "Menus and popovers",
            Block::Rows => "Rows and lists",
            Block::SmallPieces => "Small pieces",
            Block::SidebarDrafts => "Sidebar drafts",
        }
    }

    /// The file name the shots use: `shots/<slug>-light.png`.
    pub fn slug(self) -> &'static str {
        match self {
            Block::Theme => "theme",
            Block::Icons => "icons",
            Block::Buttons => "buttons",
            Block::TextField => "text-field",
            Block::ChatList => "chat-list",
            Block::Markdown => "markdown",
            Block::CodeBlocks => "code-blocks",
            Block::Menus => "menus",
            Block::Rows => "rows",
            Block::SmallPieces => "small-pieces",
            Block::SidebarDrafts => "sidebar",
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            Block::Theme => IconName::Sun,
            Block::Icons => IconName::Sparkle,
            Block::Buttons => IconName::Plus,
            Block::TextField => IconName::Compose,
            Block::ChatList => IconName::Message,
            Block::Markdown => IconName::File,
            Block::CodeBlocks => IconName::Terminal,
            Block::Menus => IconName::More,
            Block::Rows => IconName::Sidebar,
            Block::SmallPieces => IconName::Sliders,
            Block::SidebarDrafts => IconName::Sidebar,
        }
    }

    /// Whether the block is built yet; later blocks show in the sidebar, dimmed.
    pub fn is_built(self) -> bool {
        pages::is_built(self)
    }

    /// Whether the shots draw the block as one page (the drafts draw each option and scene).
    pub fn is_page_shot(self) -> bool {
        self != Block::SidebarDrafts
    }

    /// The height of the block's page in its shot.
    pub fn shot_height(self) -> f32 {
        pages::shot_height(self)
    }
}

/// The gallery window's root view.
pub struct Gallery {
    block: Block,
    /// Shots draw the page alone, without the sidebar.
    chrome: bool,
    demos: Demos,
    focus: FocusHandle,
}

impl Gallery {
    pub fn new(block: Block, chrome: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self { block, chrome, demos: Demos::new(window, cx), focus: cx.focus_handle() }
    }

    pub fn demos(&self) -> &Demos {
        &self.demos
    }

    pub fn show(&mut self, block: Block, cx: &mut Context<Self>) {
        self.block = block;
        cx.notify();
    }

    fn step(&mut self, by: isize, cx: &mut Context<Self>) {
        let built: Vec<Block> = Block::ALL.iter().copied().filter(|b| b.is_built()).collect();
        let at = built.iter().position(|b| *b == self.block).unwrap_or(0) as isize;
        let next = (at + by).rem_euclid(built.len() as isize) as usize;
        self.show(built[next], cx);
    }

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let c = &theme.colors;
        let appearance = theme.appearance;
        div()
            .flex()
            .flex_col()
            .w(px(232.))
            .h_full()
            .flex_none()
            .px(space::S2)
            .pt(space::S4)
            .gap(space::S0_5)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(space::S2)
                    .pb(space::S4)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .child(div().text_ui(TypeSize::Body).medium().text_color(c.text).child("Kuvo"))
                            .child(
                                div()
                                    .text_ui(TypeSize::Caption)
                                    .text_color(c.text_faint)
                                    .child("Building blocks"),
                            ),
                    )
                    .child(
                        Button::icon_only(
                            "appearance",
                            if appearance.is_dark() { IconName::Sun } else { IconName::Moon },
                            if appearance.is_dark() { "Light appearance" } else { "Dark appearance" },
                        )
                        .on_click(|_, window, cx| window.dispatch_action(Box::new(ToggleAppearance), cx)),
                    ),
            )
            .child(
                div()
                    .px(space::S2)
                    .pb(space::S1)
                    .text_ui(TypeSize::Caption)
                    .text_color(c.text_faint)
                    .child("Blocks"),
            )
            .children(Block::ALL.iter().map(|&block| {
                kuvo_ui::row::NavRow::new(SharedString::from(block.slug()), block.title())
                    .icon(block.icon())
                    .selected(block == self.block)
                    .disabled(!block.is_built())
                    .on_click(cx.listener(move |this, _, _, cx| this.show(block, cx)))
            }))
    }
}

impl Focusable for Gallery {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Gallery {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = pages::render(self.block, &self.demos, window, cx);
        let theme = cx.theme().clone();
        let c = &theme.colors;
        let content = div()
            .id("page")
            .relative()
            .flex_1()
            .h_full()
            .overflow_y_scroll()
            .bg(c.background)
            .child(backdrop())
            .child(page);

        let root = div()
            .key_context("Gallery")
            .track_focus(&self.focus)
            .on_action(cx.listener(|_, _: &ToggleAppearance, _, cx| {
                let next = cx.theme().appearance.toggled();
                Theme::set_appearance(next, cx);
            }))
            .on_action(cx.listener(|this, _: &NextBlock, _, cx| this.step(1, cx)))
            .on_action(cx.listener(|this, _: &PreviousBlock, _, cx| this.step(-1, cx)))
            .flex()
            .size_full()
            .bg(c.background)
            .text_ui(TypeSize::Small)
            .text_color(c.text);

        if self.chrome {
            root.child(self.sidebar(cx)).child(
                div()
                    .flex_1()
                    .h_full()
                    .py(space::S2)
                    .pr(space::S2)
                    .child(
                        div()
                            .size_full()
                            .rounded(radius::CARD - px(4.))
                            .overflow_hidden()
                            .border_1()
                            .border_color(c.border)
                            .child(content),
                    ),
            )
        } else {
            root.child(content)
        }
    }
}

/// Key bindings for the gallery itself.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-shift-l", ToggleAppearance, Some("Gallery")),
        KeyBinding::new("cmd-]", NextBlock, Some("Gallery")),
        KeyBinding::new("cmd-[", PreviousBlock, Some("Gallery")),
    ]);
    kuvo_ui::bind_keys(cx);
}

/// Opens a gallery view showing one block.
pub fn new_gallery(block: Block, chrome: bool, window: &mut Window, cx: &mut App) -> Entity<Gallery> {
    cx.new(|cx| Gallery::new(block, chrome, window, cx))
}

pub fn current_appearance(cx: &App) -> Appearance {
    cx.theme().appearance
}

/// A page: a title and a line under it, then sections, centred like a settings page.
pub(crate) fn page(
    title: &'static str,
    subtitle: &'static str,
    sections: impl IntoIterator<Item = AnyElement>,
    cx: &App,
) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .relative()
        .flex()
        .flex_col()
        .items_center()
        .w_full()
        .px(space::S10)
        .py(space::S10)
        .child(
            div()
                .flex()
                .flex_col()
                .w_full()
                .max_w(px(880.))
                .gap(space::S6)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(space::S1)
                        .child(div().text_ui(TypeSize::Title).medium().text_color(c.text).child(title))
                        .child(div().text_ui(TypeSize::Body).text_color(c.text_muted).child(subtitle)),
                )
                .children(sections),
        )
        .into_any_element()
}

/// A section of a page: a small label over a card holding the samples.
pub(crate) fn section(label: &'static str, content: impl IntoElement, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let c = &theme.colors;
    div()
        .flex()
        .flex_col()
        .gap(space::S2)
        .child(div().px(space::S1).text_ui(TypeSize::Caption).medium().text_color(c.text_faint).child(label))
        .child(
            div()
                .p(space::S6)
                .rounded(radius::CARD)
                .bg(c.surface)
                .border_1()
                .border_color(c.border)
                .shadow(theme.card_shadow())
                .child(content),
        )
        .into_any_element()
}

/// Gets a block's page into the state its shot shows (text typed, a menu open), offscreen.
#[cfg(feature = "shots")]
pub fn prepare_shot(
    cx: &mut gpui::HeadlessAppContext,
    window: gpui::AnyWindowHandle,
    block: Block,
) -> anyhow::Result<()> {
    cx.run_until_parked();
    pages::prepare_shot(cx, window, block)
}
