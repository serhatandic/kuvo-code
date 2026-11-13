# Kuvo's GPUI client: building blocks

Phase 0 of the desktop client Kuvo will ship on GPUI (Mac first, then Linux and Windows): the
building blocks every screen is made from, and a gallery that shows each one in light and dark.
The box holds the logic; these blocks only draw.

- `kuvo_ui/`: the blocks, one module each: `theme`, `icon`, `button`, `text_field`,
  `chat_list`, `markdown`, `code_block`, `menu`, `row`, `small`, plus the dotted `backdrop`.
- `gallery/`: the gallery app (`kuvo_gallery`) and the `shots` binary.
- `notes/<block>.md`: for each block, what Zed does (and which of its files were read), and
  what we take as behaviour. Zed's application code is GPL-3.0 and is never copied.
- `shots/<block>-{light,dark}.png`: each gallery page, rendered offscreen.
- `LICENSES-DEPS.md`: every dependency and its licence.

## Setting up

Rust lives in Kuvo's own folders, never in `~/.cargo` or your shell profile:

```sh
export RUSTUP_HOME=$HOME/.kuvo-code/tools/rustup CARGO_HOME=$HOME/.kuvo-code/tools/cargo
export PATH=$CARGO_HOME/bin:$PATH
# Once: curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
```

`rust-toolchain.toml` pins the toolchain (1.98.1, the one GPUI's pinned revision is built with);
rustup fetches it on first use. Xcode is needed. GPUI compiles its Metal shaders when the app
starts (`runtime_shaders`), so the separate Metal toolchain isn't needed.

## Running the gallery

```sh
cd gpui
cargo run -p kuvo_gallery
```

Pick a block in the sidebar. ⌘⇧L switches light and dark (or the sun and moon button); ⌘[ and
⌘] step through the blocks. Everything is live: type in the fields, open the menus, right-click
the sessions, press "Stream a reply into both" on the chat list and scroll one side back.

## Shots

```sh
cargo run -p kuvo_gallery --features shots --bin shots            # every block
cargo run -p kuvo_gallery --features shots --bin shots -- menus   # just one
```

GPUI renders each page with Metal into a texture that's read back, so no window opens and no
screen-recording permission is needed. Output goes to `gpui/shots/`.

## Tests

```sh
cargo test
```

Scenario tests drive the blocks through a window with real keystrokes, clicks and scrolling:
the text field (`kuvo_ui/tests/text_field.rs`), the chat list (`tests/chat_list.rs`) and menus
(`tests/menu.rs`), plus unit tests for markdown parsing, highlighting, icons and the theme's
contrast.
