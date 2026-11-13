//! Kuvo's building blocks, drawn with GPUI.
//!
//! Each module is one block. They read their look from [`theme`] and nothing else, and hold
//! no product logic: the box decides, these draw.

pub mod backdrop;
pub mod button;
pub mod icon;
pub mod menu;
pub mod row;
pub mod theme;

pub use button::{Button, ButtonSize, ButtonStyle, ShownState};
pub use icon::{Assets, Icon, IconName, IconSize};
pub use theme::{ActiveTheme, Appearance, StyledType, Theme, TypeSize};

/// Binds the keys the blocks use (text editing, menus). Call once at start-up.
pub fn bind_keys(_cx: &mut gpui::App) {}
