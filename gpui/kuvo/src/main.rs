//! Opens Kuvo. `cargo run -p kuvo` reaches this Mac's own box; `cargo run -p kuvo -- --stand-in`
//! runs against a made-up one, touching nothing real.

use std::path::PathBuf;

use gpui::{
    App, AppContext as _, Bounds, Context, Focusable, IntoElement, ParentElement, Render, Styled, TitlebarOptions, Window,
    WindowBounds, WindowOptions, div, point, px, size,
};
use kuvo::stand_in::{Replies, StandIn};
use kuvo::{Workspace, bind_keys};
use kuvo_box::BoxClient;
use kuvo_ui::{ActiveTheme, Appearance, Assets, StyledType, Theme, TypeSize};

fn main() {
    let stand_in = std::env::args().any(|argument| argument == "--stand-in");
    let client = if stand_in {
        Ok(BoxClient::new(StandIn::new(Replies::Live)))
    } else {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        BoxClient::this_mac(&home).map_err(|error| error.to_string())
    };
    gpui_platform::application().with_assets(Assets).run(move |cx: &mut App| {
        bind_keys(cx);
        let bounds = Bounds::centered(None, size(px(1240.), px(820.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("Kuvo".into()), appears_transparent: true, traffic_light_position: Some(point(px(16.), px(16.))) }),
            window_min_size: Some(size(px(720.), px(480.))),
            ..Default::default()
        };
        let opened = match client.clone() {
            Ok(client) => cx
                .open_window(options, |window, cx| {
                    Theme::init(Appearance::of(window), cx);
                    cx.new(|cx| Workspace::new(client, true, window, cx))
                })
                .map(|window| {
                    window
                        .update(cx, |workspace, window, cx| {
                            window.focus(&workspace.landing().focus_handle(cx), cx);
                        })
                        .ok();
                }),
            Err(why) => cx
                .open_window(options, |window, cx| {
                    Theme::init(Appearance::of(window), cx);
                    cx.new(|_| Missing(why))
                })
                .map(|_| ()),
        };
        opened.expect("open Kuvo's window");
        cx.activate(true);
    });
}

/// What the window says when there's no box to reach.
struct Missing(String);

impl Render for Missing {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = &cx.theme().colors;
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(6.))
            .bg(c.background)
            .child(div().text_ui(TypeSize::Body).text_color(c.text).child(self.0.clone()))
            .child(div().text_ui(TypeSize::Small).text_color(c.text_muted).child("Open Kuvo Code on this Mac, then open Kuvo again."))
    }
}
