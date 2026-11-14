# Kuvo's GPUI client

The desktop client Kuvo will ship on GPUI (Mac first, then Linux and Windows). Phase 0 made the
building blocks every screen is made from, with a gallery showing each in light and dark; phase 1,
`kuvo_box`, the client of a box; phase 2, the app, `kuvo`, with its first screens. The box holds
the logic; the app reads its facts, changes them through its routes, and draws.

- `kuvo/`: the app (binary `kuvo`, named Kuvo): the sidebar, a conversation, the composer and the
  landing view ("The app", below), and `shots`, its screens rendered offscreen.
- `kuvo_box/`: a client of a Kuvo box, with no GPUI ("Talking to a box", below).
- `kuvo_ui/`: the blocks, one module each: `theme`, `icon`, `button`, `text_field`,
  `chat_list`, `markdown`, `code_block`, `menu`, `row`, `small`, plus the dotted `backdrop`.
- `gallery/`: the gallery app (`kuvo_gallery`) and the `shots` binary.
- `notes/<block>.md` and `notes/screens-<screen>.md`: for each block and screen, what Zed does
  (and which of its files were read), and what we take as behaviour. Zed's application code is
  GPL-3.0 and is never copied.
- `shots/<block>-{light,dark}.png`: each gallery page; `shots/screens-*.png`: the app's screens
  against the stand-in box. Both rendered offscreen.
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

## The app

```sh
cd gpui
cargo run -p kuvo --features stand-in -- --stand-in   # against a made-up box: nothing real is reached
cargo run -p kuvo                                       # this Mac's own box (Kuvo Code running here)
```

- **The rail** (`notes/screens-rail.md`) switches between the areas, Sessions, Bots, Work Queue,
  Computers and Settings (⌃1 to ⌃5), each with its own sidebar beside it in one raised panel with
  the main view; what waits on you shows on an area's icon, and clicking the open area folds its
  sidebar away. At its foot, a usage ring per account (its service's mark; resting on one shows
  its windows), then Help and Settings. In a window under 820 px the area's sidebar folds away and
  its button brings it out. The other areas' pages aren't in the app yet: a row picked there shows
  a page saying so.
- **Settings** (⌃5, `notes/screens-settings.md`): "Search settings…" over its sections; General
  (the theme), Accounts (every coding agent and provider the box lists, signed in or not, and
  signing in each way the box offers: in the browser, a device code, a code pasted back, a key,
  credentials on the computer; installing an agent; signing out and Disconnect), Usage (each
  account's limits, as the rings), Models (this computer's default models), Permissions (approval,
  the sandbox, folders also allowed), Notifications (the usage notices) and Browser (#693). The
  Mac's other sections show a page saying where they are. Each page reads the box as it opens, and
  each change goes through the box's routes.
- **The title bar**: the computer switcher (this Mac's box; switching isn't in the app yet), back
  and forward (⌘[ and ⌘]), New Session (⌘N), then the conversation's title and project and the
  side panel's button.
- **The Sessions sidebar** lists what's waiting on you across projects first ("Needs you", with
  what each asks), then the box's sessions as its list says them: pinned, each project with its
  sessions nested under it, chats; a spinner on one at work, a dot on one waiting on you, a count
  on its project. ⌘N (or a project's "+") opens the landing view.
- **A conversation** follows the box live: your messages by their parts, the agent's words as
  Markdown with code, thinking and tool steps as quiet rows, how long each turn worked. Scrolling
  back reads earlier pages.
- **The composer** sends through `kuvo_box`'s typed send: "/" and "!" go to the box first, which
  says what they mean; "/" lists what the box offers. Model and effort chips are menus of what the
  box offers. Stop (or Esc) with nothing written while it works.
- **The landing view**: the composer in the middle with a project chip above it; Send starts the
  session on the box there and opens it.
- **The side panel** (⌥⌘0, or the button at the title bar's right) beside the
  conversation, resized by its edge: the session's folder's **Changes** as the box groups them
  (conflicts, staged, unstaged, new), followed live, each opening to its diff, with stage, unstage,
  discard (asked first) and commit; its **Files**, a folder at a time, one the box can't read saying
  why, each opening read-only; its **Branches**, switching and a new one, and a worktree's Merge
  into… and Create Pull Request. ⌥⌘I and ⌥⌘F open it on Changes and Files.
- ⌘⇧L switches light and dark.

`kuvo::stand_in` (the `stand-in` feature, left out of the app as shipped) is the made-up box: a Mac's box with sessions in a few projects and chats, one at
work, one waiting on you, one long enough to page through. It answers in this process, as a box
answers the routes the app uses; with `--stand-in`, a message sent gets a reply streamed back.

Shots (`gpui/shots/screens-*-{light,dark}.png`), from the stand-in at a fixed time:

```sh
cargo run -p kuvo --features shots --bin shots [-- conversation landing asking slash narrow empty]
```

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

The app's scenarios (`kuvo/tests/screens.rs`) run its screens in a window against the stand-in
box, with real clicks and keystrokes: the sidebar opening a session and folding a project, sending
a message and a typed keyword, "/"'s list, a model that can't run, a new session from the landing
view, a run streaming in and paging back. The rail and its areas' are `kuvo/tests/areas.rs` (switching areas by the rail and ⌃1 to ⌃5,
folding the sidebar by its button and in a narrow window, "Needs you", back and forward, the
rings), against the stand-in's sample bots, queue, machines and accounts, and as a box from before
#711. Settings' are `kuvo/tests/settings.rs` (each section, the search, each way of signing in, failing,
cancelling, installing, signing out, Disconnect), against the stand-in's made-up accounts and
settings (no key is real). The side panel's are `kuvo/tests/panel.rs`, against the
stand-in's made-up repositories (no git runs). The follows' threads are left off: what they'd hand the
screens is read from the stand-in at once and handed over the same way.

The blocks' scenario tests drive them through a window with real keystrokes, clicks and scrolling:
the text field (`kuvo_ui/tests/text_field.rs`), the chat list (`tests/chat_list.rs`) and menus
(`tests/menu.rs`), plus unit tests for markdown parsing, highlighting, icons and the theme's
contrast.

`kuvo_box`'s tests (`cargo test -p kuvo_box`) hold it to the shared vectors in
`protocol/vectors` (`tests/vectors.rs`), and run its scenarios against a stand-in box on
127.0.0.1 (`tests/stand_in.rs`) and a stand-in `ssh` with a machine's home in a test folder
(`tests/ssh.rs`). None reaches a real box, and none reads a `KUVO_*` variable.

## Talking to a box

`kuvo_box` is how a Rust client reaches a Kuvo box (`protocol/PROTOCOL.md`): it finds
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
// `user.parts()` on a `Message::User` of the conversation an update brings, as the box kept them or
// read them; no client parses the text.

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
`kuvo/work-queue?owner=all&glance=1` and `kuvo/asks` for the counts; for the rail's areas
(`kuvo_box::areas`), `kuvo/bots`, `kuvo/groups`, `kuvo/work-queue/categories`, `kuvo/machines` and `kuvo/agents/api/kuvo/limits`' rows, and `kuvo/waiting` once a box
has it (#711; a box without it is asked once). A message's parts and fields
are held to `protocol/vectors/message-parts.json`.

Over a box's own server, what's followed streams. Its record is read again for each request, so
a server that started again (a new port and password each time) is found, its `kuvo/info` read
again, and a port a stopped server left is never sent anything. A machine over SSH answers each
request once, so its lists are read again every half minute and an open conversation every few
seconds, over one shared connection (`/tmp/kuvo-ssh-<uid>`, as the Mac app shares it). A follow
hands on only the latest of what it sees, so a view that reads late gets the state now.

Also: a conversation's model and the models offered, a model's efforts, picking one, starting a
session and stopping one (`kuvo_box::models`); a folder's git as the box runs it, its changed files
grouped and followed, a file's diff, staging, committing, branches, Merge into… and pull requests
(`kuvo_box::git`); a folder as a Files panel lists it, and a file's bytes (`kuvo_box::folders`);
accounts and signing in (`kuvo_box::accounts`: `…/api/integration` on the engine and the agents'
bridge, `kuvo/sign-in/accounts`, `…/methods`, `…/status`, the engine's and bridge's connect routes,
install, `kuvo/accounts/ended` and `…/forget`; never `api/credential`, which carries secrets); and
this computer's settings (`kuvo_box::settings`: `kuvo/config`, `kuvo/approval`, `kuvo/sandbox`,
`kuvo/sandbox/allowed`, `kuvo/browser/settings`, the usage settings' notices).

Not done yet:
- Following a machine as it streams. The plan is in `notes/kuvo-box-machines.md`; the app shows
  this Mac's box only.
- One event stream shared by every conversation followed on a box.
- Which messages ran a command, so they show as typed. The box keeps no parts on a command's
  message (its `send` route gives a command `metadata: {}`, and the engine's command route takes
  none), and the Mac app's `CommandMessages` guesses by time in the client. So the app shows such a
  message as the engine wrote it, and guesses nothing; it shows as typed once the box keeps
  `{words, keyword}` on it, which is the box's to add.
- A machine's box attached in place on this Mac (`x-kuvo-from: mac`).

To see it list sessions without touching a real box:

```sh
cargo run -p kuvo_box --example list_sessions -- --stand-in
cargo run -p kuvo_box --example list_sessions                 # this Mac's own box
cargo run -p kuvo_box --example list_sessions -- --ssh me@devbox
```
