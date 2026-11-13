# Kuvo's GPUI client: building blocks

Phase 0 of the desktop client Kuvo will ship on GPUI (Mac first, then Linux and Windows): the
building blocks every screen is made from, and a gallery that shows each one in light and dark.
The box holds the logic; these blocks only draw. Phase 1 adds `kuvo_box`, the client of a box
the screens will read from.

- `kuvo_box/`: a client of a Kuvo box, with no GPUI ("Talking to a box", below).
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

`kuvo_box`'s tests (`cargo test -p kuvo_box`) hold it to the shared vectors in
`Packages/KuvoLink/Vectors` (`tests/vectors.rs`), and run its scenarios against a stand-in box on
127.0.0.1 (`tests/stand_in.rs`) and a stand-in `ssh` with a machine's home in a test folder
(`tests/ssh.rs`). None reaches a real box, and none reads a `KUVO_*` variable.

## Talking to a box

`kuvo_box` is how a Rust client reaches a Kuvo box (`Packages/KuvoLink/PROTOCOL.md`): it finds
the box, holds one that's older than it needs, and reads and changes the box's state through its
routes. It decides nothing the box decides: it orders the sidebar as every client does, from the
box's facts.

```rust
use kuvo_box::{BoxClient, Draft, SshBox, Timing, follow::ListUpdate, parts::File};

// This Mac's own box: found by its server's record (`run/serve.json`), whose process is checked
// to be the box's server before its password is sent. A machine's: over SSH, through
// `kuvo-link.js box route` there.
let client = BoxClient::this_mac(&home)?; // or BoxClient::machine(SshBox::new("me@devbox"))
let info = client.connect()?;             // kuvo/info, and the update gate
// A box lacking a name in `kuvo_box::gate::REQUIRED` is held: everything but what keeps work
// going there fails with `Error::NeedsUpdating { missing }`, without reaching it.

// The session lists, live: the list now, then each change.
let lists = client.follow_sessions(Timing::default());
while let Some(update) = lists.next_blocking() {       // a GPUI view awaits lists.updates() instead
    if let ListUpdate::Listing(listing) = update {
        let sidebar = listing.sidebar();                // pinned, projects in order, chats
    }
}

// One conversation, live: its messages, the words it streams as they come, and whether it runs.
let conversation = client.follow_conversation("ses_…", Timing::default());
conversation.load_earlier();                            // the page before, as you scroll up
// Each message is drawn by its parts (what was written, its keyword, comments, files, agents named):
// `conversation.parts_of(&user)`, as the box kept them or read them; no client parses the text.

// What the composer sends: its text and what goes with it, as fields; the box writes what the agent
// reads. "/…" and "!…" go to the box first, which says what they mean.
let mut draft = Draft::new(BoxClient::new_id(), "/plan sketch it");
draft.files = vec![File { uri: "file:///Users/me/shot.png".into(), name: None }];
client.send_draft("ses_…", &draft, None)?;              // `None`: it replies to nothing
```

What it uses of the box: `kuvo/info`; `kuvo/sessions/list` and `…/events` (with `since`);
`api/session/<id>`, `…/message` and `api/event` on the engine, and the same under
`kuvo/agents/` for a coding agent's conversation; `kuvo/sessions/<id>/typed` (`GET` and `POST`);
`api/session/active` (whether a run is under way); `kuvo/sessions/<id>/send` (a message's fields,
#668 item 3) and `kuvo/messages/parts` (the parts of messages from before); and
`kuvo/work-queue?owner=all&glance=1` and `kuvo/asks` for the counts. A message's parts and fields
are held to `Packages/KuvoLink/Vectors/message-parts.json`.

Over a box's own server, what's followed streams. Its record is read again for each request, so
a server that started again (a new port and password each time) is found, its `kuvo/info` read
again, and a port a stopped server left is never sent anything. A machine over SSH answers each
request once, so its lists are read again every half minute and an open conversation every few
seconds, over one shared connection (`/tmp/kuvo-ssh-<uid>`, as the Mac app shares it). A follow
hands on only the latest of what it sees, so a view that reads late gets the state now.

Not done yet, for phase 2:
- Following a machine as it streams. The plan is in `notes/kuvo-box-machines.md`.
- One event stream shared by every conversation followed on a box.
- Which messages ran a command, so they show as typed (KuvoClient's `CommandMessages`).
- A machine's box attached in place on this Mac (`x-kuvo-from: mac`).

To see it list sessions without touching a real box:

```sh
cargo run -p kuvo_box --example list_sessions -- --stand-in
cargo run -p kuvo_box --example list_sessions                 # this Mac's own box
cargo run -p kuvo_box --example list_sessions -- --ssh me@devbox
```
