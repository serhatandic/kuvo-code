//! One page per block.

mod buttons;
mod chat_list;
mod code_blocks;
mod icons;
mod markdown;
mod menus;
mod rows;
mod small;
mod text_field;
mod theme;

use gpui::{AnyElement, Context, Window};

use crate::{Block, Gallery};

/// The live pieces some pages need (fields people type in, lists that stream).
pub struct Demos {
    pub fields: text_field::Fields,
    pub chats: chat_list::Chats,
    pub menus: menus::Menus,
    pub settings: small::Settings,
}

impl Demos {
    pub fn new(_window: &mut Window, cx: &mut Context<Gallery>) -> Self {
        Self { fields: text_field::Fields::new(cx), chats: chat_list::Chats::new(cx), menus: menus::Menus::new(cx), settings: Default::default() }
    }
}

pub(crate) fn is_built(_block: Block) -> bool {
    true
}

pub(crate) fn shot_height(block: Block) -> f32 {
    match block {
        Block::Theme => 1640.,
        Block::Icons => 1420.,
        Block::Buttons => 1100.,
        Block::TextField => 1000.,
        Block::ChatList => 840.,
        Block::Markdown => 900.,
        Block::CodeBlocks => 1250.,
        Block::Menus => 900.,
        Block::Rows => 760.,
        Block::SmallPieces => 900.,
    }
}

pub(crate) fn render(
    block: Block,
    demos: &Demos,
    window: &mut Window,
    cx: &mut Context<Gallery>,
) -> AnyElement {
    match block {
        Block::Theme => theme::page(window, cx),
        Block::Icons => icons::page(window, cx),
        Block::Buttons => buttons::page(window, cx),
        Block::TextField => text_field::page(&demos.fields, window, cx),
        Block::ChatList => chat_list::page(&demos.chats, window, cx),
        Block::Markdown => markdown::page(window, cx),
        Block::CodeBlocks => code_blocks::page(window, cx),
        Block::Menus => menus::page(&demos.menus, window, cx),
        Block::Rows => rows::page(window, cx),
        Block::SmallPieces => small::page(&demos.settings, window, cx),
    }
}

#[cfg(feature = "shots")]
pub(crate) fn prepare_shot(
    cx: &mut gpui::HeadlessAppContext,
    window: gpui::AnyWindowHandle,
    block: Block,
) -> anyhow::Result<()> {
    use gpui::{EntityInputHandler as _, Focusable as _};
    let gallery = window.downcast::<Gallery>().expect("a gallery window");
    if block == Block::TextField {
        let (composer, japanese) = cx.update(|cx| {
            let f = &gallery.read(cx).expect("the gallery").demos().fields;
            (f.composer.clone(), f.japanese.clone())
        });
        cx.update_window(window, |_, window, cx| {
            // The Japanese field mid-composition, then focus in the composer.
            japanese.update(cx, |field, cx| {
                field.replace_and_mark_text_in_range(None, "しらべて", Some(12..12), window, cx);
            });
            window.focus(&composer.focus_handle(cx), cx);
        })?;
    }
    if block == Block::ChatList {
        let scrolled = cx.update(|cx| gallery.read(cx).expect("the gallery").demos().chats.scrolled.clone());
        // Draw once so the list knows its heights, then scroll back and let a reply arrive.
        cx.update_window(window, |_, window, _| window.refresh())?;
        cx.run_until_parked();
        cx.update(|cx| scrolled.update(cx, |c, _| c.list.scroll_by(gpui::px(-330.))));
        cx.update_window(window, |_, window, _| window.refresh())?;
        cx.run_until_parked();
        cx.update(|cx| scrolled.update(cx, |c, cx| c.add_exchange(cx)));
    }
    if block == Block::Menus {
        let handle = cx.update(|cx| gallery.read(cx).expect("the gallery").demos().menus.model.clone());
        cx.update_window(window, |_, window, cx| {
            let menu = menus::model_menu(cx);
            menu.update(cx, |menu, cx| menu.highlight_first(cx));
            handle.open(menu, window, cx);
        })?;
    }
    cx.run_until_parked();
    Ok(())
}
