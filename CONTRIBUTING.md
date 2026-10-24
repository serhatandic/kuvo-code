# Contributing to Kuvo Code

Thanks for helping improve Kuvo Code. It's a native Mac interface for the
opencode engine, so the best changes keep it that way:

- **Native first.** SwiftUI and AppKit. A web view only where the web is the
  content, like the browser tab.
- **The engine stays opencode, unmodified.** Kuvo Code changes how working with
  an agent looks and feels. Changes to how the agent itself behaves (its tools,
  prompts or providers) belong in [opencode](https://github.com/anomalyco/opencode).
- **Few dependencies.** Lean on the system frameworks.

## Before opening a change

- Search existing issues and pull requests first.
- Open an issue before starting a large feature, a new dependency, or a change
  to how the app runs the engine. Small fixes don't need prior approval.
- Keep pull requests focused. Separate mechanical moves from behavior changes.
- If the change is user-facing, say what the docs at
  [kuvo.run/code/docs](https://kuvo.run/code/docs/) need to cover.

## Development setup

You need a Mac with Apple silicon, macOS 26 or later, and Xcode 27 or later.

```sh
git clone https://github.com/serhatandic/kuvo-code.git
cd kuvo-code
open KuvoCode.xcodeproj
```

Run the **KuvoCode** scheme. To build from Terminal instead:

```sh
xcodebuild -project KuvoCode.xcodeproj -scheme KuvoCode -configuration Debug -derivedDataPath build/DerivedData build
open "build/DerivedData/Build/Products/Debug/Kuvo Code.app"
```

To build the release app and its disk image the way CI does:

```sh
./scripts/build-app.sh
./scripts/build-dmg.sh
open "build/Kuvo Code.app"
```

Only these builds update themselves; debug builds have no update feed and hide
the update controls.

Releases come from the release workflow: an annotated `vX.Y.Z` tag on `main`,
with that version's section of `CHANGELOG.md` as its notes. A beta, for trying
what's next before it's released, is a `vX.Y.Z-beta.N` tag (the version it
leads up to), with the Unreleased notes as they are: it's published as a
prerelease, and only copies with **Settings › General › Get beta updates** on
are offered it. Its build version is `X.Y.ZbN` (`scripts/build-version.sh`),
which Sparkle orders before the release.

A release also carries what remote machines run, for them to update themselves
with, once the `KUVO_BOX_SIGNING_KEY` secret (an Ed25519 key) is set
(`scripts/set-box-key.sh` makes it once, keeps it in your login keychain, uploads
it and prints the public key to pin): the app writes those files
(`"Kuvo Code" --write-box-files <folder>`), and `scripts/sign-box.mjs` signs
`boxes.json`, which names them. Machines take only
what a key pinned in `kuvo-link.js` (`UPDATE_KEYS`) signed; see
`Packages/KuvoLink/PROTOCOL.md`, "Updates".

Builds are signed ad hoc, so macOS treats every build as a new app and asks for
privacy permissions (like access to Desktop) again. To keep one identity
between builds, copy `Config/Signing.local.xcconfig.example` to
`Config/Signing.local.xcconfig` and set your team. That file is git-ignored.

The first launch downloads the pinned opencode engine. To use another build of
it, set `KUVO_OPENCODE_BINARY` to its path in the scheme's environment.

### Tests

The app, the engine client and the usage tracker have tests:

```sh
./scripts/test-app.sh
cd Packages/OpenCodeKit && swift test
cd Packages/UsageKit && swift test
cd Packages/KuvoLink && swift test && node --test Tests/Bridge/*.test.js
cd Agents && bun install && bun test && bunx tsc --noEmit
```

`KuvoCodeTests` tries what the app does on its own code, scenario by scenario:
Discard in Changes on throwaway git repositories, say, checking what's on disk
after. The app hosting them starts nothing (no window, engine or menu bar item),
and the tests keep their repositories, data and Trash in the temporary folder.
Run them with the script: it builds a copy of the app of their own
(`run.kuvo.code.tests`), outside the checkout, and removes what that copy keeps
(its settings, caches and website data) before and after each run. The app itself refuses to host them,
as they'd use your settings, and a copy built under Desktop or Documents waits on a
privacy prompt while tests run.
`ONLY=KuvoCodeTests/ChangesDiscardTests` runs one suite. Test what people see
happen, with the app's real parts; leave out what only restates the code.
Some run the agents bridge the app ships for real (`RealBridge`, with a stand-in
engine that listens on a loopback port): the script gives them a Bun
(`KUVO_TEST_BUN`: `bun` on your PATH, else the engine Kuvo Code downloaded).

Recorded engine responses in `Tests/OpenCodeKitTests/Fixtures` drive most of
OpenCodeKit's tests. `LiveServerTests` run against a real binary when
`OPENCODE_TEST_BINARY` points to one, and `LiveRemoteEngineTests` against a
Linux machine when `KUVO_TEST_SSH_HOST` names one you reach with SSH (they
install the engine in its `~/.kuvo-code-test`, and remove it after).

#### Route scenarios

Every route a phone uses is answered twice: by this Mac (`PhoneLink`) and by a machine's bridge
(`kuvo-link.js`). The scenarios in `Packages/KuvoLink/Vectors/routes/*.json` are written once and
run against both: `RouteContractTests` (in `./scripts/test-app.sh`) drives the Mac's real
`PhoneLink` and stores, and `node --test Tests/Bridge/contract.test.js` in `Packages/KuvoLink` the
bridge's real handler. Only the engine is a stand-in, the same small one on both. To add one:

- Add it to the area's file: a `name` and `steps`. A step is `{"given": {<fixture>: {…}}}` (one
  each: `session`, `bot`, `wake`, `watch`, `pause`, `skill`, `settings`, `key`, `credential`,
  `file`, `repository`, `write`, `ask`, `agentsBridge`; bots before anything else), a request
  `{"send": "PATCH kuvo/bots/bot_ada", "body": {…}, "expect": {"status", "json"?, "type"?,
  "text"?}, "save": {"name": "bot.id"}}`, or `{"engineGot": {"method", "path", "json"}}`.
  `{"agentsBridge": {"groups": true}}` runs the coding agents' bridge the app ships for real on
  the machine's side (with Bun: `KUVO_TEST_BUN`, or `bun` on your PATH), for its group chats.
- `json` names only what matters. `"<string>"`, `"<number>"`, `"<bool>"`, `"<object>"`,
  `"<array>"`, `"<any>"`, `"<absent>"` stand for volatile values; lists match in order, or with
  `{"<includes>": […]}`, `{"<excludes>": […]}`, `{"<length>": n}`; `{"<contains>": "…"}` in a
  string. `null` matches null or left out. `{{name}}` fills in what was saved, the box's places
  (`chats`, `skills`, `work`, `keys`) and `{{now+3600}}`. Both runners match by
  `routes/match/cases.json`, and the bridge's checks each scenario's shape.
- Where the boxes differ on purpose, say so: `"only": "mac"` (or `"machine"`) on a scenario or a
  step, or `"expect": {"mac": {…}, "machine": {…}}`, each with a `"why"`.
- Run both runners. `./scripts/route-vectors.sh` writes `routes/box` (what a Mac leaves on a
  machine, which the bridge's runner uses) after a change to the integrations, the MCP catalog or
  bot templates.

`Tests/E2E` tries the whole app the way people use it: a separate copy
(`run.kuvo.code.e2e`) driven in the background through Accessibility, with
OpenCode's free models, on real projects. Its README says how to run it, and
`SCENARIOS.md` lists the cases and where each stands.

`Tests/Perf` measures how smoothly a conversation streams and scrolls: a real run recorded once
from a separate copy (`run.kuvo.code.perf`), played back into debug builds to compare them. Its
README says how.

### Project layout

| Path | What's there |
| --- | --- |
| `KuvoCode/` | The app: views, stores and the design system |
| `Packages/OpenCodeKit/` | The engine client: API, models, event stream, transcript reducer, engine installer |
| `Packages/UsageKit/` | The usage tracker in the menu bar, a fork of [OpenUsage](https://github.com/robinebers/openusage) |
| `Packages/KuvoLink/` | The phone link: its protocol (`PROTOCOL.md`), the Swift side and the machines' bridge |
| `Agents/` | The agents bridge (TypeScript): Claude Code, Codex, Cursor, Grok and Antigravity in the engine's API |
| `Config/App.xcconfig` | The app's name and bundle ID, and signing defaults |
| `Licenses/` | License texts for code copied into this repository |

### The browser on a machine

A machine's browser is Chrome for Testing, the full browser run in Chrome's own headless mode
(the separate headless shell is one sites take for a bot), with its libraries and fonts, in
`~/.kuvo-code/browser` there (`scripts/browser-runtime.py` lists what it brings). One script,
`KuvoCode/Resources/kuvo-browser.js`, runs with the engine's own runtime in three ways:

- **host**, the keeper: it starts Chromium, holds it over a pipe, and serves the DevTools
  protocol to everyone else on a Unix socket in `~/.kuvo-code/run`, with a few messages of its
  own (`Kuvo.*`): the page in use, who's browsing where, what agents ask you for, and which
  page each conversation works in. Only one runs at a time. When an update puts a newer build
  in `current`, it stops once nothing uses the browser, keeping the open pages, so the next
  start runs the new one.
- **mcp**, the agent's browser tools for the machine's engine, talking to the keeper.
- **connect**, the Mac's live view of the pages, over SSH, also through the keeper.

What agents ask you for there also goes to `run/browser-asks.json`, for the machine's phone link,
which answers it for a phone with the Mac closed (`Kuvo.answer` on the keeper's socket).

`KEEPER` at its top goes up with every change to the host side, so a newer copy replaces one
that's running; `BrowserAgent`'s page scripts are shared with this Mac's browser tools.

### The phone link

Kuvo Code for iPhone reaches this Mac's engine, and your machines', through a relay, encrypted
end to end ([Noise](https://noiseprotocol.org), `Packages/KuvoLink/PROTOCOL.md`). The Mac side
is `PhoneLink`; on a machine, `kuvo-link.js` (KuvoLink's resource) runs with the engine's
runtime in `~/.kuvo-code/bin`, set up by the Mac with the phones you've paired. The Swift and
JavaScript sides check against the same vectors in `Packages/KuvoLink/Vectors`.

Group chats that live on a machine run in the agents bridge there (`Agents/src/groups`), by the
same rules as the Mac's `BotGroups`. After changing those rules on either side, run
`./scripts/group-vectors.sh` (it writes `Agents/test/groups-vectors.json` from the Swift side),
then `cd Agents && bun test`.

It's off until the iPhone app is out: `defaults write run.kuvo.code phoneLink -bool true` (or
`KUVO_DEMO_PHONE=1`) turns it on, with Settings › Phone, and `phoneLink.relay` points it at a
relay other than one on this Mac (`ws://127.0.0.1:8790`).

### Debug launch variables

Debug builds read these environment variables to open the app in a given state
without clicking, for trying a change or taking screenshots. What the window does
for them (tabs, the panel, prompts, bots, Settings) is in `KuvoCode/App/Demo`, and
the `KUVO_PERF_*` runs are in `DemoPerf` there:

| Variable | Effect |
| --- | --- |
| `KUVO_OPENCODE_BINARY` | Use this opencode binary instead of the pinned download |
| `KUVO_AGENTS_SCRIPT` | Run the agents bridge from this script (a checkout's `Agents/src/main.ts`) instead of the app's bundle |
| `KUVO_DEMO_FOLDER`, `KUVO_DEMO_PROMPT`, `KUVO_DEMO_MODEL` | Open a project and start a session with a prompt (`provider/model`) |
| `KUVO_DEMO_WORKTREE` | Start that session in a worktree of its own |
| `KUVO_DEMO_DRAFT` | With `KUVO_DEMO_FOLDER` and no prompt: a message typed, not sent, in the new session's composer |
| `KUVO_DEMO_DRAFT_FILES` | With `KUVO_DEMO_FOLDER` and no prompt: comma-separated paths attached, not sent, in the new session's composer |
| `KUVO_DEMO_SHOW_IN_PANEL` | `<path>\|folder` or `<path>\|file`: as if the agent of the session in view showed that in the panel |
| `KUVO_DEMO_SCROLL` | Seconds after the conversation in view opens: it scrolls up through it in steps and writes how long that took to `KUVO_PERF_LOG` (a file); `KUVO_PERF_NO_GLASS`, `KUVO_PERF_PLAIN`, `KUVO_PERF_NO_EDGE` and `KUVO_PERF_NO_ANIM` turn parts of the transcript off to compare. A window behind others draws less often, so compare runs alike. Debug builds also log real dropped frames as you scroll (`log show --predicate 'subsystem == "run.kuvo.code" AND category == "scroll"'`) |
| `KUVO_DEMO_REPLAY` | With `KUVO_DEMO_FOLDER`: a run recorded from the engine (see `Tests/Perf`) played into a new session there at the pace it came, and how the app kept up written to `KUVO_PERF_LOG`; `KUVO_DEMO_REPLAY_SPEED` plays it that many times faster, `KUVO_DEMO_REPLAY_UNTIL` stops it that many milliseconds in, to look at it there, and `KUVO_DEMO_REPLAY_HOLD` measures that many seconds after it ends instead |
| `KUVO_DEMO_WANDER` | Seconds after the conversation in view opens: it scrolls up and down a screen or two from the end, as a trackpad does, for `KUVO_DEMO_WANDER_FOR` seconds |
| `KUVO_DEMO_TABS` | Open the project's sessions as tabs (`KUVO_DEMO_TAB_COUNT=<n>`: its latest n) |
| `KUVO_DEMO_SESSION` | Open the session with this ID in a tab (one on a machine shows its conversation as last seen until the machine connects) |
| `KUVO_DEMO_BESIDE` | Open the session with this ID or title beside the tab in view, as Open Beside does (`KUVO_DEMO_SWAP_BESIDE=<seconds>`: the two trade places that long after) |
| `KUVO_DEMO_MOVE_TO_AGENTS` | `<provider>/<model>\|<seconds>`: the session in view carries on with the coding agents that long after launch, as picking their model does |
| `KUVO_DEMO_QUEUE` | Messages to queue once that session's agent is working, separated by `\|` |
| `KUVO_DEMO_WAITING` | With `KUVO_DEMO_SESSION`: these messages shown waiting in its queue, separated by `\|`, without sending them; `<words>@<picture path>` attaches a picture |
| `KUVO_DEMO_NEW_PROJECT` | Open the New Project sheet with these comma-separated folders |
| `KUVO_DEMO_BACKGROUND` | Don't bring the window forward, so it doesn't take the keyboard while you work elsewhere |
| `KUVO_DEMO_TAB_IDLE` | Seconds an agent's tab you haven't looked at stays once no agent works in it (an hour otherwise) |
| `KUVO_DEMO_FILES` | Comma-separated paths to attach to that prompt |
| `KUVO_DEMO_COMPOSER_FILES` | Comma-separated paths to show as attached in the composer |
| `KUVO_DEMO_PROVIDERS` | Open Accounts (on a provider's sign-in if it names one) |
| `KUVO_DEMO_APPEARANCE` | `light` or `dark` |
| `KUVO_DEMO_CHANGES` | Show the side panel |
| `KUVO_DEMO_PANEL` | Open tools in the panel, comma-separated: `terminal`, `browser=<address>`, `machine=<machine>` (its browser), `files`, `file=<path>`, `changes`, `run`, `expand`, `toggle=<seconds>` (expands and collapses it a few times) |
| `KUVO_DEMO_WINDOW` | Window size, as `WIDTHxHEIGHT` |
| `KUVO_DEMO_OFFSCREEN` | With `KUVO_DEMO_WINDOW`: the window past the screen's right edge, so the pointer can't hover over what you capture (`screencapture -l` still gets all of it) |
| `KUVO_DEMO_BOX` | The sidebar's box in view, `mac` or a machine's name, a few seconds after launch |
| `KUVO_DEMO_SEARCH` | Type this in the sidebar's search field |
| `KUVO_DEMO_REMOVE_PROJECT` | Remove Project…'s dialog for the project of this name, open (nothing's removed unless you click) |
| `KUVO_DEMO_PALETTE` | Open the command palette with this typed in it (empty for none) |
| `KUVO_DEMO_MENU` | Open the `mode` menu, the `model` picker (`list` on the model list, `models` with every model shown), or `location` in the New Project sheet |
| `KUVO_DEMO_EFFORT` | With the model picker open, pick this effort level |
| `KUVO_DEMO_RAIL` | With the model picker open on its list: show this entry of its rail (`★`, `auto`, or a provider's ID such as `claude-code`) |
| `KUVO_DEMO_PICK` | With the model picker open: pick this model (`provider/model`) a moment later, as a click would |
| `KUVO_DEMO_USAGE` | Open the menu bar's usage panel on `dashboard`, `customize` or `settings`; `off` to leave the usage tracker out; `sample` to leave it out and give paired phones sample numbers |
| `KUVO_DEMO_SETTINGS` | Open Settings on a page, by its `SettingsPage` name: `general`, `appearance`, `storage`, `accounts`, `agents`, `mcp`, `git`, `browser`, `passwords` and so on; `permissions@<machine>` for a machine's |
| `KUVO_DEMO_SETTINGS_TABS` | With `KUVO_DEMO_SETTINGS` and the tab bar on: these pages too, comma-separated, each in a tab of its own (`page@<machine>` for a machine's) |
| `KUVO_DEMO_DISCONNECT` | Don't connect to this machine, as after Disconnect, so this copy reaches it only through the relay (set it up in an earlier launch) |
| `KUVO_DEMO_ADD_MACHINE` | The Add Machine sheet, open, with `KUVO_DEMO_SETTINGS=machines` or over `KUVO_DEMO_NEW_PROJECT` |
| `KUVO_DEMO_REMOVE_MACHINE` | With `KUVO_DEMO_SETTINGS=machines`: that machine's Remove dialog, open (nothing's removed unless you click) |
| `KUVO_DEMO_ALSO_APPLY` | With `KUVO_DEMO_SETTINGS` and machines: the page's Also Apply to… bar, for a change noted but not made; `missing` applies one to an agent the machines don't have, `own` one to the shell (with Snapshots), once they're connected or couldn't be, for what the bar says stayed (nothing's written there) |
| `KUVO_DEMO_MCP_SERVER` | With `KUVO_DEMO_SETTINGS=mcp`: that server's editor, open (added, off, if it isn't there); `<name>\|web` switches it to On the web |
| `KUVO_DEMO_ACCOUNTS_MACHINE` | With `KUVO_DEMO_SETTINGS=accounts`: that machine's Accounts, in its own tab |
| `KUVO_DEMO_WELCOME` | No tabs, so the welcome card shows |
| `KUVO_DEMO_NEW_BOT` | The New Bot editor, open |
| `KUVO_DEMO_BOT`, `KUVO_DEMO_BOT_PROMPT` | Make the bot `<name>\|<job>\|<its details>[\|<machine>[\|<project folder>]]` unless one has that name (the job written in its memory, as the bot would; leave it empty for a bot that asks for one, and the machine empty for this Mac), open it, and give it this task |
| `KUVO_DEMO_OPEN_STEPS` | Every step in the conversation shows its details, opened, and so does the thinking |
| `KUVO_DEMO_BOT_MODEL` | With `KUVO_DEMO_BOT`: the model a new bot gets, `<provider>/<model>` (a coding agent's, like `claude-code/haiku`, makes it run with the agents) |
| `KUVO_DEMO_EDIT_BOT` | With `KUVO_DEMO_BOT`: that bot's editor, open (`bottom`: scrolled to its wake-ups and memory) |
| `KUVO_DEMO_MOVE_BOT` | With `KUVO_DEMO_BOT`: once that bot is done (and its prompt with it), it moves to this machine, or to this Mac when empty, as Move to Computer does |
| `KUVO_DEMO_MOVE_GROUP` | With `KUVO_DEMO_GROUP`: that group chat moves to this machine, or to this Mac when empty, as Move to Computer does, before its message goes |
| `KUVO_DEMO_ADD_WAKE` | With `KUVO_DEMO_EDIT_BOT`: adding a wake-up, every day, with this note (`KUVO_DEMO_ADD_WAKE_NOW`: and adds it) |
| `KUVO_DEMO_REPLY` | With `KUVO_DEMO_BOT`: sends this to the bot as a notification's Reply does |
| `KUVO_DEMO_IMPORT_BOT` | A shared bot's file: New Bot opens from it, as File › Import Bot… does |
| `KUVO_DEMO_TRY_WATCH` | With `KUVO_DEMO_EDIT_BOT`: Check Now on the bot's first watch |
| `KUVO_DEMO_FAILURE` | Over the composer of the session in view, as if something had just failed with this message |
| `KUVO_DEMO_QUESTIONS` | The agent asking three questions at once, over the composer of the session in view; a number opens that question (from 0) |
| `KUVO_DEMO_QUOTE` | Replying to this text (several, separated by `\|\|`), over the composer of the session in view |
| `KUVO_DEMO_SELECTION_MENU` | `<x>,<y>`: the menu over selected text (Add to Chat, Copy), shown there in the conversation |
| `KUVO_DEMO_DRAG` | `<x1>,<y1>,<x2>,<y2>`: a drag over the conversation, as events (`KUVO_DEMO_DRAG_AT` seconds after it opens); `KUVO_DEMO_DRAG_DIRECT=1` hands them to the view itself, as a window in the background takes a first click only to come forward |
| `KUVO_DEMO_INTEGRATION_KEY` | `<id>\|<NAME>\|<value>`: saves an integration's key as Add Key… does, before the engine starts (no value removes it) |
| `KUVO_DEMO_ADD_INTEGRATION` | With Settings › Integrations open: adds that integration, as Connect does |
| `KUVO_DEMO_SIGN_IN_SITE` | With Settings › Integrations open: signing in to that service on its site (`x`, `discord`…), in the sheet |
| `KUVO_DEMO_INTEGRATION_KINDS` | Settings › Integrations shows only these kinds, comma-separated (`mail`, `chat`, `social`, `code`), to get a row in view |
| `KUVO_DEMO_TAKE_OVER` | Seconds: the panel's browser is taken over from the agent once it starts browsing, and handed back after that long |
| `KUVO_DEMO_NEW_GROUP` | The New Group Chat editor, open |
| `KUVO_DEMO_GROUP` | Make the group chat `<name>\|<bot>,<bot>,…` unless one has that name, open it, and send it `\|<message>` if one follows |
| `KUVO_DEMO_GROUP_LATER` | With a message in `KUVO_DEMO_GROUP`: another one, sent while they talk, as `<seconds>\|<message>` |
| `KUVO_DEMO_GROUP_UNDO` | With `KUVO_DEMO_GROUP`: undo from your last message there after this many seconds |
| `KUVO_DEMO_EDIT_GROUP` | With `KUVO_DEMO_GROUP`: its editor, open |
| `KUVO_DEMO_BOT_MOODS` | Show bots in a mood, as `<name>=<mood>,…` with `working`, `waiting`, `news`, `sleeping`, `watching` or `idle` |
| `KUVO_DEMO_VIEW_IMAGE` | Show these comma-separated pictures in the image viewer |
| `KUVO_DEMO_SLOW` | Slow the app's animations down this many times, to look at one frame by frame |
| `KUVO_DEMO_TOGGLE_PANEL` | Show and hide the side panel every this many seconds, a few times |
| `KUVO_DEMO_CHAT` | Start a chat with this message |
| `KUVO_DEMO_MOVE_CHAT` | Move the newest chat into the project at this folder |
| `KUVO_DEMO_UNDO_RESEND` | In the session in view, undo its last message and send it again this many seconds later |
| `KUVO_DEMO_LOG_EVENTS` | Log each session event from the engine, to see the order they come in (`log show --predicate 'subsystem == "run.kuvo.code"'`) |
| `KUVO_DEMO_SHOW_HOVER` | Show group chat messages' buttons as if under the pointer |
| `KUVO_DEMO_CYCLE_TABS` | Go to the next session tab every this many seconds, a few times |
| `KUVO_PERF_SWITCH` | Ten seconds after launch, go to the next session tab this many times, 1.5 s apart, and write how the main thread kept up to `KUVO_PERF_LOG` (stalls to `KUVO_PERF_STALLS`); `KUVO_PERF_SWITCH_CHECK` also gives each tab's session a draft and checks the composer shows it and takes typing after each switch |
| `KUVO_PERF_TYPE` | Ten seconds after launch, type this many characters into the composer, one every 60 ms, and write how the main thread kept up (and the longest a character took) to `KUVO_PERF_LOG` |
| `KUVO_PERF_LAYERS` | A file: the window's layers drawn on the CPU that were drawn again between looks 1.5 s apart, four times from `KUVO_PERF_LAYERS_AT` seconds after launch (12), largest first |
| `KUVO_DEMO_REOPEN_WINDOW` | Close the window after this many seconds, and open it again |
| `KUVO_DEMO_NAME` | A name to use instead of yours, for the initials on review comments |
| `KUVO_DEMO_MACHINE_BROWSING` | As if an agent on this machine started browsing, as `<machine>\|<seconds after launch>` |
| `KUVO_DEMO_ASKING` | As if the agent of the session in view started asking you for something in its browser (call the browser's tools to make the ask); with a session's title, opens that session first |
| `KUVO_DEMO_ANSWER_ASKS` | Answers each sign-in, code or step the agent asks for, as `<username>\|<password>\|<code>[\|<seconds>]` |
| `KUVO_DEMO_LOG_FRAMES` | Log a machine's browser's live view: frames a second, their size and bytes, how long after a scroll its picture arrives and where each picture is scrolled to, and how long a page you go to takes to commit, load and show |
| `KUVO_DEMO_DOWNLOADS` | A folder for downloads instead of your Downloads folder (which macOS asks about the first time) |
| `KUVO_DEMO_SAVE_DOWNLOADS` | Save each download from a machine's browser to this Mac, as Save to Mac does |
| `KUVO_DEMO_PAGE_INPUT` | In a machine's browser tab, what you'd do on the page, steps separated by `;`: `wait:<s>`, `click:<x>,<y>`, `type:<text>`, `key:<code>`, `scroll:<x>,<y>,<dy>`, `selectAll`, `copy`, `paste`, `zoom:in`, `zoom:out`, `go:<address>`, `swipe:<x>,<y>,<dy>,<n>` (n scrolls 8 ms apart, as a trackpad sends them) |
| `KUVO_DEMO_PHONE` | Turns on the phone link and Settings › Phone |
| `KUVO_DEMO_PHONE_PAIR` | A file: once the relay answers, a pairing code starts (no window needed) and its link is written there, for pairing a simulator or a test (launch the iPhone app with `KUVO_DEMO_PAIR` set to it) |
| `KUVO_DEMO_MACHINE_ROOT` | A folder of its own in machines' home folders (like `.kuvo-code-demo`), so the demo copy's engine and browser there never touch your own copy's. What it starts there stops when it quits, except in `.kuvo-code-demo` while its phone link is on, so a phone tried with it reaches its bots with the Mac shut |
| `KUVO_DEMO_COMMENT` | Add a review comment to the session in view, as `<path in the project>:<line>:<text>` |
| `KUVO_DEMO_QUOTES` | With `KUVO_DEMO_SESSION`: that many quotes to answer in its composer (a session's or a group chat's, as `group:<id>`) |
| `KUVO_DEMO_FIND` | With `KUVO_DEMO_SESSION`: Find in it, looking for these words |
| `KUVO_DEMO_CONNECTED` | With `KUVO_DEMO_SETTINGS=integrations`: that integration's sign-in sheet, on its last step |
| `KUVO_DEMO_WIDGET_SNAPSHOTS` | A folder: each widget an agent made, once drawn, saved there as a picture (a background copy's window draws no web pages) |
| `KUVO_DEMO_WIDGET_LARGE` | The first widget shown opens larger, as Open Larger does |
| `KUVO_PERF_STILL_BOTS` | Every bot holds still, to compare what their motion costs |
| `KUVO_ANALYTICS_URL` | Send anonymous usage to this collector, e.g. `http://127.0.0.1:8787/kuvo/code`; debug builds send none otherwise |

### The icon

The icon is two pictures, `KuvoCode/AppIcon.icon/Assets/artwork-light.png` and
`artwork-dark.png`, and the Mac shows the one that matches its appearance.
`scripts/icon.py` makes the Icon Composer file in `KuvoCode/AppIcon.icon` from
them, which Xcode compiles with the app, and the README's `docs/images/icon.png`.
To change the icon, give it pictures of the new one with `--light` and `--dark`:
it trims any background, lines the two up and makes them square. With `--phone`
and `--web` it also writes the iPhone app's copy and the website's `icon.png`,
`icon-dark.png` and `apple-touch-icon.png`. It needs numpy, OpenCV and Xcode.

### The coding agents

Claude Code, Codex, Cursor, Grok and Antigravity run beside the engine, the way
[T3 Code](https://github.com/pingdotgg/t3code) runs them: each as its maker built it, signed in
as you. `Agents/src` is a small server, the agents bridge, that `OutsideAgents` starts with the
engine's Bun as it starts the engine (it prints `{"url": …}`, takes the password in
`OPENCODE_PASSWORD` and stops when its stdin closes). It answers the app in the engine's own API
(sessions, messages, events, permissions, questions, models, sign-in), so their sessions use
the app's usual views; `Workspace` sends a session to it when its metadata names an agent
(`kuvoAgent`), and the phone reaches it at `kuvo/agents/api/…`.

- **Claude Code**: the Claude Agent SDK, with your `claude` and its sign-in.
- **Codex**: `codex app-server`, JSON-RPC over stdio.
- **Cursor**: Cursor's SDK, signed in through it; its sign-in and agents in `agents/cursor`.
- **Grok** and **Antigravity**: the Agent Client Protocol (`acp.ts`); Antigravity's agent is
  downloaded from Google, checked against its pinned SHA-256, into `agents/antigravity`.

The SDKs are installed from npm the first time each is needed (`runtime/<agent>`), at the
versions in the agents' files, and aren't part of the app. After changing `Agents/src`, run
`./scripts/build-agents.sh` and commit `KuvoCode/Resources/kuvo-agents.js`, the bundle the app
ships; CI fails when it isn't built from the sources as they are (`build-agents.sh --check`). In a
debug build, `KUVO_AGENTS_SCRIPT=<checkout>/Agents/src/main.ts` runs the source
instead.

### Dependencies

Kuvo Code depends on Textual, SwiftUIMath (which Textual uses too; replies'
math is drawn with it directly), SwiftTerm, Sparkle and, through UsageKit,
KeyboardShortcuts. SwiftTerm stays on 1.11, because 1.12 and later need the
Metal toolchain to build. Textual is a copy in `Packages/Textual`, changed so
replies are laid out in one pass (its README says what's different and how to
bring in upstream's changes).

If you add or update a package, or change code copied from another project
(`prism-bundle.js`, `mermaid.min.js`, `buildDomTree.js`, UsageKit, Textual), run
`./scripts/third-party-licenses.sh` and commit the updated
`THIRD_PARTY_LICENSES.txt`; CI checks that it's current.

## Workflow

Every change starts from an issue and lands on `main` through a pull request.

1. **Find or open an issue** for the change, and comment that you're working on
   it.
2. **Fork the repository** and create a branch named
   `type/issue-short-description`, for example `fix/42-sidebar-width` or
   `feat/57-session-search`. Use one of these types:

   | Type | For |
   | --- | --- |
   | `feat` | new behavior |
   | `fix` | bug fixes |
   | `perf` | speed, memory or battery improvements |
   | `refactor` | code changes that don't change behavior |
   | `docs` | documentation only |
   | `test` | tests only |
   | `ci` | workflows and build scripts |
   | `chore` | dependencies and other upkeep |

3. **Open a pull request** against `main`.
   - **The title becomes the commit message**, because pull requests are
     squash-merged into a single commit. Write it as one plain sentence that
     says what the change does, in the imperative: "Stop the sidebar from
     growing past its maximum width", not "Fixed sidebar" or "feat: sidebar".
   - **Start the description with `Fixes #42`** (your issue's number), so
     merging closes the issue.
   - Fill in the rest of the template: what changed, why, and how you verified
     it.
   - **If people using Kuvo Code would notice the change, add a line to
     `CHANGELOG.md`** under Unreleased, saying what they'll see. It becomes
     part of the next release's notes, on GitHub and in the app's update
     window.
4. **CI must pass**, and a maintainer reviews and approves the pull request.
   It's then squash-merged and the branch is deleted.

`main` only accepts changes through pull requests.

## Pull requests

Keep commit messages on your branch short and factual; they're combined when
the pull request is merged. Don't include generated build output, credentials,
personal paths, AI session metadata, or co-author trailers added by coding
tools. Screenshots and recordings are welcome for UI changes; make sure they
don't show your sessions, accounts or file paths.

## Contribution license

Kuvo Code is source-available for noncommercial use under the
[PolyForm Noncommercial License](LICENSE). To keep commercial licensing rights
coherent as the project accepts outside work, every contributor must accept
the [Contributor License Agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md).

You retain ownership of your contribution. The agreement grants the project
owner the additional rights needed to include it in both the public
noncommercial project and any separately licensed commercial version. A pull
request can't be merged until every contributor to it has accepted those
terms.
