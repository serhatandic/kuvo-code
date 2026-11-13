//! Opens the gallery in a window. `cargo run -p kuvo_gallery`.

use gpui::{App, Bounds, Focusable, WindowBounds, WindowOptions, px, size};
use kuvo_gallery::{Block, bind_keys, new_gallery};
use kuvo_ui::{Appearance, Assets, Theme};

fn main() {
    gpui_platform::application().with_assets(Assets).run(|cx: &mut App| {
        bind_keys(cx);
        let bounds = Bounds::centered(None, size(px(1280.), px(860.)), cx);
        let window = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("Kuvo · Building blocks".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    Theme::init(Appearance::of(window), cx);
                    new_gallery(Block::Theme, true, window, cx)
                },
            )
            .expect("open the gallery window");
        window
            .update(cx, |gallery, window, cx| {
                window.focus(&gallery.focus_handle(cx), cx);
                cx.activate(true);
            })
            .ok();
    });
}
