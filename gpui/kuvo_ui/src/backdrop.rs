//! The dotted backdrop behind empty pages, onboarding and the gallery: a fine grid of square
//! dots whose density drifts slowly across the page, so a large empty area feels calm rather
//! than blank. The pattern is the same on every run.

use gpui::{App, Bounds, Hsla, IntoElement, Pixels, Styled, Window, canvas, fill, point, px, size};

use crate::theme::ActiveTheme;

/// How far apart the dots are, and how big each one is.
const PITCH: f32 = 6.;
const DOT: f32 = 1.5;

/// A dotted backdrop filling its parent. Put it first, absolutely positioned, under content.
pub fn backdrop() -> impl IntoElement {
    canvas(
        |_bounds, _window, cx: &mut App| cx.theme().colors.backdrop_dot,
        |bounds, dot_color, window, _cx| paint_dots(bounds, dot_color, window),
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full()
}

fn paint_dots(bounds: Bounds<Pixels>, color: Hsla, window: &mut Window) {
    let width = f32::from(bounds.size.width);
    let height = f32::from(bounds.size.height);
    if width <= 0. || height <= 0. {
        return;
    }
    let columns = (width / PITCH) as i32 + 1;
    let rows = (height / PITCH) as i32 + 1;
    for row in 0..rows {
        let y = row as f32 * PITCH;
        for column in 0..columns {
            let x = column as f32 * PITCH;
            let strength = density(x / width, y / height, x, y);
            if strength < 0.06 {
                continue;
            }
            let origin = point(bounds.origin.x + px(x), bounds.origin.y + px(y));
            window.paint_quad(fill(
                Bounds::new(origin, size(px(DOT), px(DOT))),
                color.opacity(strength),
            ));
        }
    }
}

/// How strong the dots are at a point: a soft glow rising from the bottom and the far corner,
/// broken up by slow noise so it never looks like a gradient.
fn density(u: f32, v: f32, x: f32, y: f32) -> f32 {
    let bottom = smoothstep(0.35, 1.0, v) * (1.0 - (u - 0.5).abs() * 1.1).clamp(0., 1.);
    let corner = smoothstep(0.55, 1.0, u) * smoothstep(0.6, 0.0, v) * 0.8;
    let glow = (bottom + corner).min(1.);
    let noise = value_noise(x / 140., y / 140.) * 0.6 + value_noise(x / 37., y / 37.) * 0.4;
    // Most of the page holds a faint even field; the glow and noise lift some of it.
    (0.12 + glow * 0.65 + (noise - 0.5) * 0.55).clamp(0., 1.)
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0., 1.);
    t * t * (3. - 2. * t)
}

fn hash(x: i32, y: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd816_3841);
    h ^= h >> 13;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 16;
    (h & 0xffff) as f32 / 65535.
}

fn value_noise(x: f32, y: f32) -> f32 {
    let (x0, y0) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let (sx, sy) = (fx * fx * (3. - 2. * fx), fy * fy * (3. - 2. * fy));
    let top = hash(x0, y0) * (1. - sx) + hash(x0 + 1, y0) * sx;
    let bottom = hash(x0, y0 + 1) * (1. - sx) + hash(x0 + 1, y0 + 1) * sx;
    top * (1. - sy) + bottom * sy
}
