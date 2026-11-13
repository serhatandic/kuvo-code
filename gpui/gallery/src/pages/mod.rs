//! One page per block.

mod buttons;
mod icons;
mod theme;

use gpui::{AnyElement, Context, Window};

use crate::{Block, Gallery};

/// The live pieces some pages need (fields people type in, lists that stream).
pub struct Demos {}

impl Demos {
    pub fn new(_window: &mut Window, _cx: &mut Context<Gallery>) -> Self {
        Self {}
    }
}

pub(crate) fn is_built(block: Block) -> bool {
    matches!(block, Block::Theme | Block::Icons | Block::Buttons)
}

pub(crate) fn shot_height(block: Block) -> f32 {
    match block {
        Block::Theme => 1640.,
        Block::Icons => 1420.,
        Block::Buttons => 1100.,
        _ => 900.,
    }
}

pub(crate) fn render(
    block: Block,
    _demos: &Demos,
    window: &mut Window,
    cx: &mut Context<Gallery>,
) -> AnyElement {
    match block {
        Block::Theme => theme::page(window, cx),
        Block::Icons => icons::page(window, cx),
        Block::Buttons => buttons::page(window, cx),
        _ => crate::page(block.title(), "Not built yet.", [], cx),
    }
}

#[cfg(feature = "shots")]
pub(crate) fn prepare_shot(
    cx: &mut gpui::HeadlessAppContext,
    _window: gpui::AnyWindowHandle,
    block: Block,
) -> anyhow::Result<()> {
    match block {
        _ => {}
    }
    cx.run_until_parked();
    Ok(())
}
