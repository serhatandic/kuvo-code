//! Kuvo, the desktop client of a Kuvo box, drawn with GPUI: a window with the box's sessions in a
//! sidebar, a conversation followed live, and the composer. It decides nothing the box decides: it
//! reads the box's facts through `kuvo_box`, changes them through its routes, and draws.
//!
//! `main.rs` opens it; `bin/shots.rs` renders its screens offscreen; `stand_in` (the `stand-in`
//! feature) is a made-up box it runs against without touching a real one.

pub mod composer;
pub mod conversation;
pub mod entries;
mod landing;
pub mod sidebar;
#[cfg(feature = "stand-in")]
pub mod stand_in;
pub mod time;
pub mod workspace;

use gpui::{App, KeyBinding, actions};

pub use workspace::Workspace;

actions!(kuvo, [NewSession, ToggleAppearance, Quit]);

/// Binds the app's keys, after the blocks' (so "/"'s list takes its keys ahead of the field's).
pub fn bind_keys(cx: &mut App) {
    kuvo_ui::bind_keys(cx);
    composer::bind_keys(cx);
    cx.bind_keys([
        KeyBinding::new("cmd-n", NewSession, Some("Workspace")),
        KeyBinding::new("cmd-shift-l", ToggleAppearance, Some("Workspace")),
        KeyBinding::new("cmd-q", Quit, None),
    ]);
}
