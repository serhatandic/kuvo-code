# Small pieces

**Ours:** `kuvo_ui/src/small.rs` (`Switch`, `Checkbox`, `Chip`, `Avatar`, `count_badge`,
`status_dot`, `spinner`). Gallery page: `gallery/src/pages/small.rs`.
Shots: `shots/small-pieces-{light,dark}.png`.

## What Zed does (studied, not copied)

Files read: `crates/ui/src/components/{toggle,chip,avatar,indicator}.rs`,
`crates/ui/src/components/label/{spinner_label,loading_label}.rs`, and the button's loading
icon in `crates/ui/src/components/button/button.rs` (all GPL-3.0); GPUI's
`src/elements/animation.rs` and `svg.rs` (Apache-2.0).

- Toggles are stateless: the caller owns the value; a click hands back the opposite. Switch:
  a pill track with a round thumb that jumps sides, accent when on, a focus ring with
  `focus_visible`. Checkbox: a small rounded box with a check, an indeterminate dash.
- Chips: small bordered tags with an optional icon. Avatars: round, with an indicator dot
  overhanging the corner, a person icon while loading.
- Spinners: an arc icon rotated by a repeating animation; animations hold still when the system
  asks for reduced motion.

## What we take as behaviour

- `Switch` (30 × 18 track, 14 px thumb, accent when on) and `Checkbox` (16 px, 5 px radius,
  accent with a white check), stateless like Zed's, clickable on the label too, tab stops with
  the focus halo, 40 % when disabled. Switches for settings that apply at once, checkboxes for
  choices confirmed later (Apple's rule).
- `Chip`: 22 px, 6 px radius, sunken fill; tones (success, warning, danger, accent) tint the
  fill and border lightly, as Capy's "● Detected"; a selected filter chip in the accent; an
  optional × to remove (a file in the composer's context).
- `Avatar`: initials (first letters of two words) on one of six soft fills picked by name, so a
  person keeps theirs; an optional status dot ringed in the surface colour.
- `count_badge`: an accent pill, "99+" past 99. `status_dot`: a 7 px light.
- `spinner`: our own arc SVG turning every 900 ms, at either icon size.

## Not yet

Pictures in avatars (GPUI's `img`), an indeterminate checkbox, a sliding thumb animation on the
switch, and a progress bar.
