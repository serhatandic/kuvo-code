//! One page per block.

mod buttons;
mod icons;
mod text_field;
mod theme;

use gpui::{AnyElement, Context, Window};

use crate::{Block, Gallery};

/// The live pieces some pages need (fields people type in, lists that stream).
pub struct Demos {
    pub fields: text_field::Fields,
}

impl Demos {
    pub fn new(_window: &mut Window, cx: &mut Context<Gallery>) -> Self {
        Self { fields: text_field::Fields::new(cx) }
    }
}

pub(crate) fn is_built(block: Block) -> bool {
    matches!(block, Block::Theme | Block::Icons | Block::Buttons | Block::TextField)
}

pub(crate) fn shot_height(block: Block) -> f32 {
    match block {
        Block::Theme => 1640.,
        Block::Icons => 1420.,
        Block::Buttons => 1100.,
        Block::TextField => 900.,
        _ => 900.,
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
        _ => crate::page(block.title(), "Not built yet.", [], cx),
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
    cx.run_until_parked();
    Ok(())
}
