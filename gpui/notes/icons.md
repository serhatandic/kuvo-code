# Icons

**Ours:** `kuvo_ui/src/icon.rs`, SVGs in `assets/icons/`. Gallery page: `gallery/src/pages/icons.rs`.
Shots: `shots/icons-light.png`, `shots/icons-dark.png`.

## What Zed does (studied, not copied)

Files read: `crates/icons/src/icons.rs`, `crates/ui/src/components/icon.rs`,
`crates/assets/src/assets.rs` (GPL-3.0), and GPUI's `elements/svg.rs` and `assets.rs`
(Apache-2.0). Zed's SVGs are Lucide-derived (ISC); we use none of them.

- A typed enum of icon names, each mapped to `icons/<name>.svg`; tests check every name has a
  file and no file is orphaned.
- 16×16 line icons, one stroke weight, round caps and joins.
- Sizes from 10 to 48 px; a "square" size adds padding for hit areas.
- GPUI draws an SVG as an alpha mask filled with the element's text colour, so the colour
  comes from the caller, never from the file.
- The app's `AssetSource` serves them; spinning icons use a timed rotation.

## What we take as behaviour

- A typed `IconName` enum, generated with the file table by one macro, so a name without a
  file can't compile. The SVGs are embedded with `include_bytes!`, so nothing loads from disk.
- Our own 40 icons, drawn for this project on a 16-unit grid with a 1.3 stroke and round caps
  and joins. Filled details (dots, the stop square) are fills, not strokes.
- Only the brief's two sizes: 14 px (`Nav`) and 20 px (`Card`).
- Tinted by the caller; muted text colour by default.
- A test loads every icon through the asset source GPUI uses.

## Next

More icons as screens need them (status rings, providers' logos are a brand question).
