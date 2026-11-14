//! A usage ring: how much of an account's fullest window is gone, as an arc around its mark,
//! and the card that shows the account's windows.

use gpui::{
    AnyElement, App, Hsla, IntoElement, LineCap, ParentElement, PathBuilder, PathStyle, Pixels, StrokeOptions,
    Styled, canvas, div, point, prelude::FluentBuilder as _, px,
};
use kuvo_ui::{ActiveTheme, StyledType, TypeSize, theme::{radius, space}};

use super::data::Account;

/// How close a share is to its limit.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Calm,
    Near,
    Over,
}

impl Level {
    pub fn of(used: f32) -> Self {
        if used >= 0.9 {
            Self::Over
        } else if used >= 0.7 {
            Self::Near
        } else {
            Self::Calm
        }
    }
}

/// How the ring colours a calm share: the success green (OpenBot's), or a quiet grey.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CalmColor {
    Green,
    Grey,
}

pub fn level_color(used: f32, calm: CalmColor, cx: &App) -> Hsla {
    let c = &cx.theme().colors;
    // BOX-NEEDED: the level (near at 70%, over at 90% here) is the box's word, `level` in the ring above and in each window, so every client colours alike.
    match Level::of(used) {
        Level::Over => c.danger,
        Level::Near => c.warning,
        Level::Calm => match calm {
            CalmColor::Green => c.success,
            CalmColor::Grey => c.text_muted,
        },
    }
}

/// Paints a ring: a faint track, and an arc from the top, clockwise, for `used` (0 to 1).
fn arcs(size: Pixels, stroke: Pixels, used: f32, color: Hsla, track: Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let r = (size - stroke) / 2.;
            let center = point(bounds.origin.x + size / 2., bounds.origin.y + size / 2.);
            let style = || PathStyle::Stroke(StrokeOptions { line_width: f32::from(stroke), line_cap: LineCap::Round, ..Default::default() });
            let top = point(center.x, center.y - r);
            let bottom = point(center.x, center.y + r);

            let mut full = PathBuilder::stroke(stroke).with_style(style());
            full.move_to(top);
            full.arc_to(point(r, r), px(0.), false, true, bottom);
            full.arc_to(point(r, r), px(0.), false, true, top);
            if let Ok(path) = full.build() {
                window.paint_path(path, track);
            }

            let used = used.clamp(0., 1.);
            if used <= 0.005 {
                return;
            }
            let mut arc = PathBuilder::stroke(stroke).with_style(style());
            arc.move_to(top);
            if used >= 0.995 {
                arc.arc_to(point(r, r), px(0.), false, true, bottom);
                arc.arc_to(point(r, r), px(0.), false, true, top);
            } else {
                let angle = used * std::f32::consts::TAU;
                let end = point(center.x + r * angle.sin(), center.y - r * angle.cos());
                arc.arc_to(point(r, r), px(0.), used > 0.5, true, end);
            }
            if let Ok(path) = arc.build() {
                window.paint_path(path, color);
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size(size)
}

/// An account's ring, with its service's mark in the middle.
pub fn ring(account: &Account, size: Pixels, stroke: Pixels, calm: CalmColor, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    // BOX-NEEDED: the ring's share and level per account: `rows[].ring {used, window, level: calm|near|over}` in `GET kuvo/agents/api/kuvo/limits` (and `kuvo.limits.updated`), the fullest window that hasn't started over.
    let used = account.used;
    let color = level_color(used, calm, cx);
    div()
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(size)
        .child(arcs(size, stroke, used, color, c.border_strong))
        .child(div().text_ui(TypeSize::Caption).medium().text_color(c.text_muted).child(account.mark))
        .into_any_element()
}

/// A share as a meter: a thin bar, filled by how much is gone.
fn meter(used: f32, calm: CalmColor, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .h(px(4.))
        .w_full()
        .rounded(radius::PILL)
        .bg(c.border)
        .child(div().h_full().w(gpui::relative(used.clamp(0., 1.))).rounded(radius::PILL).bg(level_color(used, calm, cx)))
}

/// What hovering or clicking a ring shows: the account, its plan, and each window with when it
/// starts over.
pub fn account_card(account: &Account, calm: CalmColor, pointer: bool, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let windows = account.windows.iter().map(|w| {
        let level = Level::of(w.used);
        div()
            .flex()
            .flex_col()
            .gap(space::S1)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_ui(TypeSize::Small)
                    .child(div().text_color(c.text).child(w.name))
                    .child(
                        div()
                            .text_color(if level == Level::Calm { c.text_muted } else { level_color(w.used, calm, cx) })
                            .when(level != Level::Calm, |d| d.medium())
                            .child(format!("{}% used", (w.used * 100.).round() as u32)),
                    ),
            )
            .child(meter(w.used, calm, cx))
            .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(w.resets))
    });
    div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child(format!("{} · {}", account.service, account.label)))
                        .child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(format!("{} plan", account.plan))),
                )
                .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child("Read 1 min ago")),
        )
        .children(windows)
        .when(pointer, |card| {
            card.child(div().h(px(1.)).bg(c.border))
                .child(div().text_ui(TypeSize::Small).text_color(c.accent).child("Open Usage in Settings"))
        })
        .into_any_element()
}
