//! Renders every built block's gallery page offscreen, in light and dark, to
//! `gpui/shots/<block>-{light,dark}.png`. No window opens and no screen capture is needed: GPUI
//! draws the page with Metal into a texture, which is read back.
//!
//! `cargo run -p kuvo_gallery --features shots --bin shots [-- <block-slug>...]`

use std::{path::PathBuf, sync::Arc};

use gpui::{HeadlessAppContext, px, size};
use kuvo_gallery::{Block, bind_keys, new_gallery};
use kuvo_ui::{Appearance, Assets, Theme};

const WIDTH: f32 = 1200.;

fn main() -> anyhow::Result<()> {
    let only: Vec<String> = std::env::args().skip(1).collect();
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../shots");
    std::fs::create_dir_all(&out)?;

    let text_system = gpui_platform::current_platform(true).text_system();
    let mut cx = HeadlessAppContext::with_platform(text_system, Arc::new(Assets), || {
        gpui_platform::current_headless_renderer()
    });
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        bind_keys(cx);
    });

    for &block in Block::ALL {
        if !block.is_built() || (!only.is_empty() && !only.iter().any(|s| s == block.slug())) {
            continue;
        }
        for appearance in [Appearance::Light, Appearance::Dark] {
            cx.update(|cx| Theme::set_appearance(appearance, cx));
            let window = cx.open_window(size(px(WIDTH), px(block.shot_height())), |window, cx| {
                new_gallery(block, false, window, cx)
            })?;
            kuvo_gallery::prepare_shot(&mut cx, window.into(), block)?;
            let any = window.into();
            cx.update_window(any, |_, window, _| window.refresh())?;
            cx.run_until_parked();
            let image = cx.capture_screenshot(any)?;
            let name = format!(
                "{}-{}.png",
                block.slug(),
                if appearance.is_dark() { "dark" } else { "light" }
            );
            image.save(out.join(&name))?;
            println!("{name}: {}x{}", image.width(), image.height());
            cx.update_window(any, |_, window, _| window.remove_window())?;
            cx.run_until_parked();
        }
    }
    Ok(())
}
