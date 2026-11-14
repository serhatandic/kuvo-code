//! Kuvo, the desktop client of a Kuvo box, drawn with GPUI: a window with a rail of areas (Sessions,
//! Bots, Work Queue, Computers, Settings), each area's sidebar beside it, the box's sessions, a
//! conversation followed live, and the composer. It decides nothing the box decides: it
//! reads the box's facts through `kuvo_box`, changes them through its routes, and draws.
//!
//! `main.rs` opens it; `bin/shots.rs` renders its screens offscreen; `stand_in` (the `stand-in`
//! feature) is a made-up box it runs against without touching a real one.

pub mod area;
pub mod areas;
pub mod ask_card;
pub mod composer;
pub mod conversation;
pub mod entries;
mod landing;
pub mod panel;
pub mod rail;
pub mod settings;
pub mod sidebar;
#[cfg(feature = "stand-in")]
pub mod stand_in;
pub mod time;
pub mod title_bar;
pub mod workspace;

use gpui::{App, KeyBinding, actions};

pub use workspace::Workspace;

actions!(kuvo, [NewSession, ToggleAppearance, Quit, TogglePanel, ShowChanges, ShowFiles]);

/// Binds the app's keys, after the blocks' (so "/"'s list takes its keys ahead of the field's).
pub fn bind_keys(cx: &mut App) {
    kuvo_ui::bind_keys(cx);
    composer::bind_keys(cx);
    sidebar::bind_keys(cx);
    area::bind_keys(cx);
    panel::changes::bind_keys(cx);
    panel::files::bind_keys(cx);
    cx.bind_keys([
        KeyBinding::new("cmd-n", NewSession, Some("Workspace")),
        // As the Mac app's: Show Panel, Show Changes, Show Files.
        KeyBinding::new("cmd-alt-0", TogglePanel, Some("Workspace")),
        KeyBinding::new("cmd-alt-i", ShowChanges, Some("Workspace")),
        KeyBinding::new("cmd-alt-f", ShowFiles, Some("Workspace")),
        KeyBinding::new("cmd-shift-l", ToggleAppearance, Some("Workspace")),
        KeyBinding::new("cmd-q", Quit, None),
    ]);
}
