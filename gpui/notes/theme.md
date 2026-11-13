# Theme

**Ours:** `kuvo_ui/src/theme.rs`, `kuvo_ui/src/backdrop.rs`. Gallery page: `gallery/src/pages/theme.rs`.
Shots: `shots/theme-light.png`, `shots/theme-dark.png`.

## What Zed does (studied, not copied)

Files read: `crates/ui/src/styles/{typography,spacing,units,elevation,color}.rs`,
`crates/theme/src/{theme.rs,ui_density.rs,styles/colors.rs}`, and the appearance observer in
`crates/workspace/src/workspace.rs`. All GPL-3.0: read for behaviour only.

- Sizes in rems off a 16 px base, so one setting scales the UI; four semantic text sizes.
- Spacing tokens with three densities; components never use raw pixels.
- Flat, semantic colour tokens: background / surface / elevated surface, border variants,
  element and "ghost element" hover / active / selected / disabled, three text levels plus
  placeholder and disabled, status colours in triples.
- Elevation levels decide fill, border and shadow (popovers: elevated fill, 1 px border, two
  soft shadows, lighter in light mode).
- Light and dark: a global seeded from the window's appearance, updated by
  `observe_window_appearance`, then `refresh_windows`.

## What we take as behaviour

- One global `Theme` (appearance + colours), read through `cx.theme()`. Switching appearance
  swaps the global and refreshes windows, as Zed does. Following the system appearance is
  `Appearance::of(window)`; the app will observe it the same way.
- Semantic tokens only; blocks never hold a colour literal. Washes (hover, pressed, selected)
  are translucent so they work on any surface.
- Our own scale from the brief rather than Zed's: SF Pro (`.SystemUIFont`) regular and medium;
  type at 12 / 13 / 14 / 24 px with 16 / 18 / 20 / 30 line heights; text #292929 / #5D5D5D /
  #9E9E9E in light and #ECECEC / #A3A3A3 / #6E6E6E in dark; radii 8 (navigation), 16 (cards),
  pill (calls to action), and 6 for small inline things; spacing on a 4 px grid.
- Dark surfaces step up with elevation: sunken wells #121212, the surface #181818, menus and
  popovers #242424; the selected wash (10 %) is clearly stronger than hover (4–5 %).
- The primary call to action is inverted neutral (dark on light, light on dark), as in the
  blueprint and OpenBot; the accent is kept for focus, links, the caret, switches and badges.
- The dotted backdrop (Capy and OpenBot's calm empty pages) is ours: a seeded value-noise field
  of 1.5 px square dots on a 6 px pitch, densest towards the bottom and a far corner.

## Gaps and findings

- **Letter spacing:** GPUI has no tracking control (no field in `TextStyle`, nothing in the
  text systems). The brief's -0.15 px is recorded as `LETTER_SPACING` and not applied. SF Pro
  already tightens at text sizes; adding real tracking means positioning glyphs ourselves
  after shaping, which isn't worth it for phase 0.
- **Medium weight:** GPUI reads SF's Medium instance as about weight 520, and CSS-style
  matching sends a request for 500 down to Regular. `MEDIUM` asks for 520 on macOS (500
  elsewhere). Found by probing `font_id` for each weight; worth upstreaming.
- **Monospace:** SF Mono is reachable as `.AppleSystemUIFontMonospaced` on macOS; elsewhere we
  ask for `monospace`. Linux needs checking when the client runs there.
- **Radii:** a fourth radius, 12 px for menus and popovers (`radius::POPOVER`), so their
  corners nest around 8 px rows; small things (chips, keycaps, checkboxes) use 6 px. Both are
  additions to the brief's 8 / 16 / pill, for the user to confirm.
- **Accent:** the macOS system blue, which is also the Mac app's accent by default. Picking
  Kuvo's accent is a brand decision for the user.
