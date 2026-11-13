# Buttons

**Ours:** `kuvo_ui/src/button.rs`. Gallery page: `gallery/src/pages/buttons.rs`.
Shots: `shots/buttons-light.png`, `shots/buttons-dark.png`.

## What Zed does (studied, not copied)

Files read: `crates/ui/src/components/button/{button_like,button,icon_button,toggle_button,
copy_button}.rs` (GPL-3.0), and GPUI's `elements/div.rs` (Apache-2.0) for `hover`, `active`,
`focus_visible`, `tab_index` and keyboard clicks.

- One base does all interaction; labelled and icon buttons wrap it.
- Styles: subtle (ghost), filled, tinted, outlined, transparent. Hover and pressed are style
  refinements set only when enabled; disabled drops the handlers and greys the label.
- Keyboard focus uses `focus_visible`, so a click doesn't draw a ring but Tab does.
- Selected (toggle) swaps to another style; icon buttons carry a tooltip as their name.
- Mouse-down doesn't steal focus; a copy button turns into a check for two seconds.

## What we take as behaviour

- One `Button` with four styles: **Primary** (inverted neutral fill, the one thing to do),
  **Secondary** (outlined), **Ghost** (no fill until hovered) and **Accent** (filled with the
  accent, kept for sending). Any of them can be a **pill**, the shape for calls to action.
- Sizes 24 / 32 / 40 px tall; label 12 / 13 / 14 px medium; icons 14 px.
- Hover and pressed: translucent washes over outlined and ghost buttons, fill shifts for filled
  ones. Disabled: 40 % opacity, no handlers, no tab stop.
- Every button is a tab stop. Keyboard focus draws the accent edge, plus a halo outside when the
  button has a fill to hide it behind (a halo under a transparent ghost button would show
  through, so ghost buttons take the hover wash instead). Return and Space press the focused
  button (GPUI sends a keyboard click).
- Icon-only buttons are square (or round as pills) and always carry a tooltip.
- A keycap after the label shows the shortcut (↩, ⌘↩), as Capy's dialogs do.
- `shown(..)` draws hover, pressed or focus without a pointer, for the gallery and tests.
- Not yet: a loading state with a spinner (comes with block 10), split buttons.
