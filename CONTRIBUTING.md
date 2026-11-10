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

Before tagging one, try its update the way people will get it:

```sh
./scripts/try-update.sh            # the next beta after the newest tag, or name a version
```

It builds this checkout as that version, signed with your Developer ID and the update key from
your keychain, serves it from `127.0.0.1`, and points the Kuvo Code in /Applications at it. Choose
**Check for Updates…** there to go through the update window, the install, the restart and
What's New. Ctrl-C stops the server and puts the real feed back.

CI (`.github/workflows/ci.yml`) runs on GitHub's hosted runners, its jobs side by side: the
generated files and What's New on Linux, the box's and the bridge's tests on macOS and Linux, the
Swift packages' tests, and the app's. It doesn't build the app itself: only the release workflow
does, signed, for a tag or a dry run. So run a dry run from `main` (Actions › Release › Run
workflow) before tagging a release whose build changed. The release's signing job runs in the
`release` environment (Settings › Environments), which should allow only `main` and `v*` tags and
hold the signing, notarization and update keys.

A release also carries what remote machines run, for them to update themselves
with, once the `KUVO_BOX_SIGNING_KEY` secret (an Ed25519 key) is set
(`scripts/set-box-key.sh` makes it once, keeps it in your login keychain, uploads
it and prints the public key to pin): the app writes those files
(`"Kuvo Code" --write-box-files <folder>`), and `scripts/sign-box.mjs` signs
`boxes.json`, which names them. Machines take only
what a key pinned in the box's link (`UPDATE_KEYS`, in `Packages/Box/src`) signed; see
`Packages/KuvoLink/PROTOCOL.md`, "Updates".

Builds are signed ad hoc, so macOS treats every build as a new app and asks for
privacy permissions (like access to Desktop) again. To keep one identity
between builds, copy `Config/Signing.local.xcconfig.example` to
`Config/Signing.local.xcconfig` and set your team. That file is git-ignored.

The first launch downloads the pinned opencode engine. To use another build of
it, set `KUVO_OPENCODE_BINARY` to its path in the scheme's environment.

### Tests

The account running `scripts/test-app.sh` must own the Mac's screen. The screen can be
locked: a test's window never gets the real pointer or waits on a real frame. Where AppKit would
act on those (a window's tracking areas and cursor rectangles once the pointer comes in, a view's
drawing as Core Animation commits), the test does it itself: `WindowServer.appKitsTurn` and
`CATransaction.flush()` after `displayIfNeeded()`.

Run quick, targeted tests locally while working. Commit the changes to a work branch, then run
`scripts/ci-branch.sh --wait` to push it over SSH to `origin` as a `ci/` branch and run the full
CI suites on GitHub. Pass a local branch name to test a different branch. The script prints the run
URL, job conclusions and failed logs; it never pushes `main` or tags. Only committed changes run.
CI covers the Mac app, Swift packages, box and bridge; the phone has no CI, so run its tests locally
through `scripts/heavy.sh phone`. Use `scripts/heavy.sh` for other local builds or tests CI doesn't cover.

Run quick, targeted box and bridge tests with `scripts/test-box.sh [box|bridge|all] [extra test args]`. It queues under the box heavy slot, installs locked dependencies when needed, and summarizes results.

The runner uses `~/.bun/bin/bun` by default; set `KUVO_TEST_BUN` to another Bun or an engine (a machine's `~/.kuvo-code/engine/<version>/opencode`,
which they run as Bun). Run them on a Linux machine too, in a test folder of your own with
`TMPDIR` inside it, before calling a box change done:
`scripts/heavy.sh box scripts/test-linux.sh <ssh-host> sandbox.test.js …` does that on a machine
that has Kuvo Code's engine, with a Node of its own and the tools some tests need, all in a folder
in its `~/.kuvo-code-test` that it removes afterwards (tests that run the engine itself, like
`outside-asks-live.test.js`, run that machine's). Run it again with `--engine`: the tests then
run on the engine's own runner, so the boxes they start run on Bun, as a machine's does.

A home folder of a test's own doesn't keep a script from `crontab` or `launchctl`, which are the
account's. A test that runs a machine's scripts puts stand-ins for them first on its PATH, and its
suite takes the `AccountUntouched` trait; `scripts/test-app.sh` makes the same check around its run.

A bridge test file cleans up with `atEnd` and `removeAtEnd` from `Tests/Bridge/at-end.js`, never
node:test's `after` (a test's own `t.after` is fine). They stop what the file started, latest
first, and remove its folders last, even when a step fails. Then anything still open fails the
file, named, rather than keeping its process and the whole run going.

Every bridge test file starts with `import "./test-safety.js";`, and every box test file with
`import "./safety"` (or `"../safety"`), which loads it; a test fails if one doesn't. It keeps a run
away from the real Kuvo Code, whichever shell and folder start it: it drops the `KUVO_*`, `OPENCODE_*`
and `XDG_*` variables that an agent's shell hands down (not `KUVO_TEST_*` or `OPENCODE_TEST_*`, which
you set on purpose), the coding agents' folders and Kuvo Code's own commands on the `PATH`, gives the
run a home of its own in `~/.kuvo-code-test`, and throws on deleting or moving anything but a folder
the process made with `mkdtemp` or a path it named with `ownPath` (what a test has to make in a real
cache, under a name of its own). A test sets what it wants itself, for its own folders. A run removes
its home as it ends, and the next run clears what a killed one left.

`./scripts/test-app.sh` runs one at a time: a run started while another is going
waits for it, since they share the test copy's settings and temporary folders.

When running heavy builds or tests locally, start them with `scripts/heavy.sh <kind>`, which
waits for jobs of the same kind (they share build folders) and runs the other
kinds alongside:

```sh
scripts/heavy.sh mac scripts/test-app.sh
scripts/heavy.sh mac-build sh -c 'xcodebuild … -derivedDataPath "$(getconf DARWIN_USER_CACHE_DIR)KuvoShared-MacBuild$KUVO_HEAVY_BUILD_SUFFIX" …'
scripts/heavy.sh mac-build sh -c 'cd Packages/KuvoClient && swift test'
scripts/heavy.sh phone-build <phone-build-command>   # the phone's `scripts/build-app.sh` does this
scripts/heavy.sh phone <phone-test-command>          # only a run that boots a simulator
scripts/test-box.sh box <test-filter>
```

- `mac`: the Mac app's UI test suite, `scripts/test-app.sh` (`KuvoCodeTests-build`), which drives the
  real window and pointer, so one runs at a time and nothing else of this kind beside it. Older
  scripts also say `mac` for a plain build, which still works, under the same lock;
- `mac-build`: what doesn't drive the UI: the Mac's `xcodebuild` (builds, demo builds) and the
  packages' `swift build` and `swift test`. It has two slots, so two of these run at once, and
  beside the app suite, since it doesn't take `mac`'s lock. A job takes whichever slot is free first
  and finds it in `KUVO_HEAVY_SLOT` and `KUVO_HEAVY_BUILD_SUFFIX` (`-1` or `-2`): build in
  `KuvoShared-MacBuild$KUVO_HEAVY_BUILD_SUFFIX`, never in `KuvoShared-MacBuild` itself (older
  scripts' `mac` builds there) or `KuvoCodeTests-build` (the app suite's). Give `xcodebuild` a
  `-clonedSourcePackagesDirPath` in that folder too (`…/KuvoShared-MacBuild$KUVO_HEAVY_BUILD_SUFFIX/SourcePackages`),
  not the checkout's `build/SourcePackages` (the app suite's) or `build/DerivedData`, which two
  jobs in one checkout would share. A package's `.build` is its own to each checkout;
- `phone-build`: the iPhone app's builds, and anything of the phone's that boots no simulator. It is
  `mac-build`'s lane under another name (the same two slots, locks and 30-minute time limit, which
  `KUVO_HEAVY_LIMIT=60m` raises), not one of its own: a phone build and a Mac build are both `xcodebuild` compiles that compete for the same CPU and
  memory, so they count against each other, and neither waits for a simulator. Take the slot's
  folder from `KUVO_HEAVY_SLOT` and `KUVO_HEAVY_BUILD_SUFFIX` (`-1` or `-2`) and build in
  `KuvoShared-PhoneLane$KUVO_HEAVY_BUILD_SUFFIX`, a folder of its own (not `KuvoShared-PhoneBuild-2`,
  which phone's slot 2 builds in). The phone's `scripts/build-app.sh` does all of it. A build never
  takes a `phone` slot: those are for test runs, which each need a simulator, and a build that held
  one only made the test runs queue behind it;
- `phone`: **only the phone's test runs that boot a simulator** (`KuvoShared-PhoneBuild`,
  `KuvoCodeMobileTests-build`; the phone's `scripts/test-app.sh`). It has two
  slots, so two phone test runs go at once, each on a simulator of its own: "Kuvo Code Tests" in
  slot 1 and "Kuvo Code Tests 2" in slot 2, both fixed (the phone's `scripts/test-app.sh` makes each
  once, on the same runtime and device, and keeps it; nothing makes or deletes one per run). A
  caller that handles slots sets `KUVO_HEAVY_SLOTS=2` and takes whichever slot is free first (slot 1
  before slot 2; with both busy it waits for the first to free). Its job finds its slot in
  `KUVO_TEST_SIMULATOR` (the simulator's name), `KUVO_HEAVY_SLOT` and `KUVO_HEAVY_BUILD_SUFFIX`
  (`""` or `-2`: put it on a build folder, since two builds in one folder break). Without
  `KUVO_HEAVY_SLOTS=2` a job only ever takes slot 1, whose lock and simulator are what they always
  were, so an older script and a new one on slot 1 still exclude each other;
- `box`: the box's whole suites (`bun test`, `node --test`) and runs on a test machine.

A job also waits while the Mac is busy (its load over the last minute above 40;
`KUVO_HEAVY_LOAD` sets another). While the Mac app's suite waits there, new jobs of the other
kinds wait for it to start, 15 minutes at most (`KUVO_HEAVY_MAC_FIRST_FOR`), so the jobs that keep
starting can't keep it out. A new job also waits while the Mac is short of memory: swapping more than
10 MB a second (`KUVO_HEAVY_SWAP`), its memory pressure at warn or worse, or less than 20% of it
available as `memory_pressure -Q` says (`KUVO_HEAVY_MEMORY`; `0` turns the memory wait off). It
waits until two looks in a row find it isn't, 15 minutes at most from when any job found it short
(`KUVO_HEAVY_MEMORY_WAIT_FOR`): on this Mac memory runs out before CPU does. Both apps' `scripts/test-app.sh` take their turn
this way themselves. `python3 -m unittest discover -s scripts -p test_heavy.py`
tries the helper.

A job's command runs in a process group of its own, which ends with it: when the command is over,
and when the helper is stopped, whatever the command started that stays in that group is stopped too
(a process that starts a group or session of its own, like a daemon, isn't; and when the helper
runs in a terminal, the job stays in the terminal's group, as a Ctrl-C reaches it there). So nothing that stays in
the job's group is left behind to clean up. Never stop a process by name or pattern (`pkill`, `killall`,
`kill $(pgrep …)`): a pattern matches other people's apps and other sessions. Stop only a process
you started, by its PID (`$!`, a pid file) or by a process group you created, never the one you
were started in. On macOS every option goes before the pattern, in `pgrep` too.

Every job has a time limit, so a hung one can't hold its kind's turn for hours: `mac` and `phone`
45 minutes, `mac-build` 30, `box` 40, counted while it runs (not while it waits for its turn).
Past it, its group is stopped (TERM, then KILL), it says what was running, and the helper exits
124. `KUVO_HEAVY_LIMIT` gives one job another (`90m`, `600s`, `2h`; `0` for none). A job inside
one of its kind runs within that one's limit (one of another kind has its own too), and one in a
terminal has none.

`KuvoCodeTests` tries what the app does on its own code, scenario by scenario:
Discard in Changes on throwaway git repositories, say, checking what's on disk
after. The app hosting them starts nothing (no window, engine or menu bar item),
and the tests keep their repositories, data and Trash in the temporary folder.
Run them with the script: it builds a copy of the app of their own
(`run.kuvo.code.tests`), outside the checkout, and removes what that copy keeps
(its settings, caches and website data) before and after each run. The app itself refuses to host them,
as they'd use your settings, and a copy built under Desktop or Documents waits on a
privacy prompt while tests run. For the same reason the test copy keeps its Keychain
in memory (`KuvoCode/Stores/Keychain.swift`) and never asks to show notifications:
macOS would ask whether each new build may use what the last one kept, and the
tests would wait for your answer. Reach the Keychain only through `Keychain`; the
script won't run the tests otherwise.
`ONLY=KuvoCodeTests/ChangesDiscardTests` runs one suite. Test what people see
happen, with the app's real parts; leave out what only restates the code.
Some run the agents bridge the app ships for real (`RealBridge`, with a stand-in
engine that listens on a loopback port): the script gives them a Bun
(`KUVO_TEST_BUN`: `bun` on your PATH, else `~/.bun/bin/bun`, else the engine a demo,
perf or e2e copy downloaded). A Bun in your Desktop or Documents is skipped, and refused
when you name it: the test copy would wait on macOS's privacy prompt for those folders.

Nothing that starts a copy of the app or its engine for a test, a demo or a
measurement may use the real Kuvo Code: its bundle ID (`run.kuvo.code`), its
folder in Application Support (its engine, sessions and sign-ins) or the app in
Applications. The scripts check with `scripts/real-app-guard.sh` and stop, naming
themselves, and a debug build launched with any `KUVO_DEMO_*`, `KUVO_PERF_*` or
`KUVO_E2E` variable won't start under the real bundle ID or with the real
engine. `python3 -m unittest discover -s Tests/Guard` checks each of them.

Recorded engine responses in `Tests/OpenCodeKitTests/Fixtures` drive most of
OpenCodeKit's tests. `LiveServerTests` run against a real binary when
`OPENCODE_TEST_BINARY` points to one, and `LiveRemoteEngineTests` against a
Linux machine or a Mac when `KUVO_TEST_SSH_HOST` names one you reach with SSH
(they install the engine in its `~/.kuvo-code-test`, and remove it after).
`ThisMacAsAMachineTests`, with `KUVO_TEST_THIS_MAC=1`, runs a Mac machine's
scripts, engine, keeper, link and bridge for real on this Mac, in a home of its
own, without SSH.

#### Route scenarios

Every route a phone uses is answered twice: by this Mac (`PhoneLink`) and by a machine's bridge
(`kuvo-link.js`). The scenarios in `Packages/KuvoLink/Vectors/routes/*.json` are written once and
run against both: `RouteContractTests` (in `./scripts/test-app.sh`) drives the Mac's real
`PhoneLink` and stores, and `scripts/test-box.sh bridge contract.test.js` the
bridge's real handler. `Tests/Bridge/contract-mac.test.js` runs the scenarios of the areas that
have moved onto this Mac's box (`PhoneLink.boxRoutes`) against the bridge's handler as this Mac's
box, with the app's folders and kit, checking what's expected of a Mac. Only the engine is a
stand-in, the same small one on each. To add one:

- Add it to the area's file: a `name` and `steps`. A step is `{"given": {<fixture>: {…}}}` (one
  each: `session`, `bot`, `wake`, `watch`, `pause`, `skill`, `trashedSkill`, `settings`, `key`, `credential`,
  `file`, `repository`, `write`, `ask`, `agentsBridge`, `peers`; bots before anything else), a request
  `{"send": "PATCH kuvo/bots/bot_ada", "body": {…}, "expect": {"status", "json"?, "type"?,
  "text"?}, "save": {"name": "bot.id"}}`, or `{"engineGot": {"method", "path", "json"}}`.
  `{"agentsBridge": {"groups": true}}` runs the coding agents' bridge the app ships for real on
  the machine's side (with Bun: `KUVO_TEST_BUN`, or `bun` on your PATH), for its group chats;
  `{"peers": {"boxes", "bots"}}` then tells it who your other computers and their bots are, as the
  box's link does.
- `json` names only what matters. `"<string>"`, `"<number>"`, `"<bool>"`, `"<object>"`,
  `"<array>"`, `"<any>"`, `"<absent>"` stand for volatile values; lists match in order, or with
  `{"<includes>": […]}`, `{"<excludes>": […]}`, `{"<length>": n}`; `{"<contains>": "…"}` in a
  string. `"whole": true` beside `json` names the answer whole: a field it doesn't name fails it,
  so both boxes are held to the very same answer (`alike.json`). `null` matches null or left out.
  `{{name}}` fills in what was saved, the box's places
  (`chats`, `skills`, `work`, `keys`) and `{{now+3600}}`. Both runners match by
  `routes/match/cases.json`, and the bridge's checks each scenario's shape.
- Where the boxes differ on purpose, say so: `"only": "mac"` (or `"machine"`) on a scenario or a
  step, or `"expect": {"mac": {…}, "machine": {…}}`, each with a `"why"`.
- Every answer, whole, is also held to its route's shape: `Packages/Box/src/shared/routes`, one
  file an area, with each field an answer can have (one ending in `?` may be left out) and its
  type, which the box's code takes its types from too. A new route, or a new field in an answer,
  goes there first; `./scripts/route-shapes.sh` writes `routes/shapes/answers.json` for both
  runners (CI checks it's current), and both hold an answer to a shape by
  `routes/shapes/cases.json`. A field that can be null is sent as `null`, never left out (this
  Mac's encoder leaves a nil out, so its fields that can be null are `@SentAsNull`), and a refusal
  is JSON, `{}` at least.
- Run the runners. `./scripts/route-vectors.sh` writes `routes/box` (what a Mac leaves on a
  machine, and the kit this Mac's app gives its own box, which the bridge's runners use) after a
  change to the integrations, the MCP catalog, a bot's kit or how a conversation's rules are made
  from its approval and Settings › Permissions (`approval.json`, which the bridge's bots tests
  hold `refreshedRules` to). Bot templates, Kuvo Code's own
  personalities and what a bot is told are written once, in
  `Packages/KuvoLink/Sources/KuvoLink/Resources/bot-words.json`, which every box reads and the
  runners use as it is; kuvo-web's `src/lib/bots.ts` copies its templates.

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
| `Packages/KuvoClient/` | What the Mac app and the iPhone app share as code: `ClientText`, the rules for what a message says (its `README.md`) |
| `Packages/KuvoLink/` | The phone link: its protocol (`PROTOCOL.md`), the Swift side, and the box's link as built (`kuvo-link.js`) |
| `Packages/Box/` | The box (TypeScript): its link, built to `kuvo-link.js`, and the agents bridge (Claude Code, Codex, Cursor, Grok and Antigravity in the engine's API), built to `kuvo-agents.js` (its `README.md`) |
| `Config/App.xcconfig` | The app's name and bundle ID, and signing defaults |
| `Licenses/` | License texts for code copied into this repository |

### The browser on a machine

A machine's browser is Chrome for Testing, the full browser run in Chrome's own headless mode
(the separate headless shell is one sites take for a bot), with its libraries and fonts, in
`~/.kuvo-code/browser` there. The machine's box sets it up itself, with or without a Mac
(`Packages/Box/src/link/browser`, PROTOCOL.md's "The browser on a machine"): the build pinned in
`linux.json` and `mac.json` there (`scripts/browser-runtime.py` writes them; on a Mac machine,
Chrome for Testing as it comes, with a `chrome` launcher, as it won't run through a link),
downloaded only from Google's Chrome for Testing and Rocky Linux over HTTPS, each file checked
against its size and SHA-256 before it's unpacked (by the box itself: no `unzip`, `xz` or `rpm`
on the machine). The Mac only shows how it goes (`kuvo/browser`). Its tests serve stand-ins
(`Tests/Bridge/browser-source-stand-in.js`): never the real sources, never a real `~/.kuvo-code`.
One script,
`KuvoCode/Resources/kuvo-browser.js`, runs with the engine's own runtime in three ways:

- **host**, the keeper: it starts Chromium, holds it over a pipe, and serves the DevTools
  protocol to everyone else on a Unix socket in `~/.kuvo-code/run`, to each connection that
  first gives the box's socket key (`run/socket.key`, which an agent's command in the sandbox
  can't read; one that doesn't is told to update Kuvo Code and closed), with a few messages of its own (`Kuvo.*`): the page in use, who's browsing where, what agents ask you for, and which
  page each conversation works in. Only one runs at a time. When an update puts a newer build
  in `current`, it stops once nothing uses the browser, keeping the open pages, so the next
  start runs the new one.
- **mcp**, the agent's browser tools for the machine's engine, talking to the keeper.
- **connect**, the Mac's live view of the pages, over SSH, also through the keeper.

The first two, finding no browser, have the box set it up and wait for it (`kuvo-link.js browser
install`); a browser that doesn't start because its build isn't whole is set up again once.

What agents ask you for there also goes to `run/browser-asks.json`, for the machine's phone link,
which answers it for a phone with the Mac closed (`Kuvo.answer` on the keeper's socket).

On a Mac, Chrome's editing keys come from its window's key bindings, which a key sent over DevTools
never reaches: the keeper names what each does (`keyForHere`), so clients send the same keys to
every machine.

`KEEPER` at its top goes up with every change to the host side, so a newer copy replaces one
that's running; `BrowserAgent`'s page scripts are shared with this Mac's browser tools.

### The phone link

Kuvo Code for iPhone reaches this Mac's engine, and your machines', through a relay, encrypted
end to end ([Noise](https://noiseprotocol.org), `Packages/KuvoLink/PROTOCOL.md`). The Mac side
is `PhoneLink`; on a machine, `kuvo-link.js` (KuvoLink's resource, built from `Packages/Box/src`
with `./scripts/build-box.sh`, which you run and commit after changing them) runs with the engine's
runtime in `~/.kuvo-code/bin`, set up by the Mac with the phones you've paired. The Swift and
JavaScript sides check against the same vectors in `Packages/KuvoLink/Vectors`.

Group chats run in each computer's agents bridge (`Packages/Box/src/agents/groups`), this Mac's as a
machine's: the app shows them and sends what you do in them (`BoxGroups`), and holds none of
their rules. Their own tests are the bridge's (`scripts/test-box.sh box`). What the app still reads
the same way as a box (a bot's job from its memory, when a repeat comes back, what a message
quotes) is held to `Packages/Box/test/agents/box-vectors.json`: after changing one on either side, run
`./scripts/box-vectors.sh` (it writes the file from the Swift side), then the bridges' tests.
This Mac's box carries its group chats' mail to your machines on its own relay connection, as a
machine's bridge does (`kuvo-link.js`: `watchSeats`, `carrySeat`).

Code that's there only for released Macs (PROTOCOL.md's "For released Macs": Kuvo Code 0.5 to
0.7.2, and 0.8.0-beta.1) carries a marker where it is, on every side, `COMPAT(<version> <item>):
what it does. Goes …` (`#` in a shell script), whose item that section names. `scripts/compat.sh
[0.7 | beta.1]` lists them, so a version's paths go together, and `Tests/Bridge/compat.test.js`
fails on an item without a marker or a marker without an item. Mark what you add for them the same
way.

It's off until the iPhone app is out: `defaults write run.kuvo.code phoneLink -bool true` (or
`KUVO_DEMO_PHONE=1`) turns it on, with Settings › Phone, and `phoneLink.relay` points it at a
relay other than one on this Mac (`ws://127.0.0.1:8790`).

### Debug launch variables

Debug builds read these environment variables to open the app in a given state
without clicking, for trying a change or taking screenshots. What the window does
for them (tabs, the panel, prompts, bots, Settings) is in `KuvoCode/App/Demo`, and
the `KUVO_PERF_*` runs are in `DemoPerf` there.

A demo copy left to run on its own must never show a macOS prompt, because nobody is
there to answer it and the copy would wait for good. With `KUVO_DEMO_BACKGROUND`, or
`KUVO_DEMO_NO_PROMPTS=1`, it asks nothing, as the test copy doesn't: its notifications
show only if macOS allowed them for its bundle ID before; Keychain reads and writes
that would ask fail at once instead; Touch ID and Open at Login are skipped, and so is
the usage panel unless `KUVO_DEMO_USAGE` names one of its screens; and the engine leaves out
`~/.claude/skills`, where a link can lead into your Desktop. Each skip is in the log
with where it was asked from (`log show --predicate 'subsystem == "run.kuvo.code" AND
category == "prompts"'`). `KUVO_DEMO_NO_PROMPTS=0` lets a background copy ask after all,
when you're there to answer.

Those skips can't cover files: macOS asks when any process of the copy opens a file on your
Desktop or in Documents, and holds that process until it's answered. So keep the copy and what
it opens off them. Copy the app out of a checkout that's there, start it from an empty
environment (`open` hands it your shell's, `KUVO_*` included), and where its data lists a project
there, give it a home of its own, with the engine copied into it (`$scratch` is any folder off
them; delete it when you're done):

```sh
ditto "<build>/Kuvo Code.app" "$scratch/Kuvo Code.app"
ditto "$HOME/Library/Application Support/run.kuvo.code.demo/engine" "$scratch/home/Library/Application Support/run.kuvo.code.demo/engine"
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /usr/bin/open -g -n --env KUVO_DEMO_BACKGROUND=1 --env KUVO_DEMO_USAGE=off --env KUVO_DEMO_NAME=<name> \
  --env CFFIXED_USER_HOME="$scratch/home" --env HOME="$scratch/home" "$scratch/Kuvo Code.app"
```

| Variable | Effect |
| --- | --- |
| `KUVO_OPENCODE_BINARY` | Use this opencode binary instead of the pinned download |
| `KUVO_BOX_SCRIPT` | Run this Mac's box from this script (a checkout's `Packages/Box/src/link/main.ts`, or a built `kuvo-link.js`) instead of the app's |
| `KUVO_AGENTS_SCRIPT` | Run the agents bridge from this script (a checkout's `Packages/Box/src/agents/main.ts`) instead of the app's bundle |
| `KUVO_DEMO_FOLDER`, `KUVO_DEMO_PROMPT`, `KUVO_DEMO_MODEL` | Open a project and start a session with a prompt (`provider/model`) |
| `KUVO_DEMO_WORKTREE` | Start that session in a worktree of its own |
| `KUVO_DEMO_DRAFT` | With `KUVO_DEMO_FOLDER` and no prompt: a message typed, not sent, in the new session's composer; with `KUVO_DEMO_SESSION`, in that session's |
| `KUVO_DEMO_THEN`, `KUVO_DEMO_THEN_DRAFT` | With `KUVO_DEMO_PROMPT`: messages separated by `\|`, each sent once the turn before it ended (a keyword too, like `/btw what changed?`); then text left, not sent, in its composer |
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
| `KUVO_DEMO_SIDE_THREAD` | With `KUVO_DEMO_PROMPT`: a sample side thread of three questions over the composer, and an older one in its ⋯ (`answering` leaves its last one being answered), once the first turn ends |
| `KUVO_DEMO_GOAL` | With `KUVO_DEMO_PROMPT`: `met` or `working`, a sample goal over the composer once the first turn ends (no model checks it) |
| `KUVO_DEMO_OPEN_PART` | With a `KUVO_DEMO_PROMPT` of `/review …`: its first part, opened in the conversation's place once it reads in a session of its own |
| `KUVO_DEMO_REVIEW` | With `KUVO_DEMO_PROMPT`: `starting` (nothing found yet), `running`, `stopped` or `done`, a sample security review of the whole project in parts over the composer once the first turn ends (no model reads it) |
| `KUVO_DEMO_SIDE_THREAD_HOVER` | The side thread's Copy shown as with the pointer over it |
| `KUVO_DEMO_WAITING` | With `KUVO_DEMO_SESSION`: these messages shown waiting in its queue, separated by `\|`, without sending them; `<words>@<picture path>` attaches a picture |
| `KUVO_DEMO_WAITING_FROM` | With `KUVO_DEMO_SESSION`: after those, these as what came while it was stopped, waiting on its box, separated by `\|`, each `<sender>:<words>` (no sender: yours); the queue shows Paused |
| `KUVO_DEMO_NEW_PROJECT` | Open the New Project sheet with these comma-separated folders |
| `KUVO_DEMO_BACKGROUND` | Don't bring the window forward, so it doesn't take the keyboard while you work elsewhere; it also asks nothing of macOS (above) |
| `KUVO_DEMO_NO_PROMPTS` | `1`: never show a macOS prompt (above); `0`: a background copy may ask after all |
| `KUVO_DEMO_TAB_IDLE` | Seconds an agent's tab you haven't looked at stays once no agent works in it (an hour otherwise) |
| `KUVO_DEMO_FILES` | Comma-separated paths to attach to that prompt |
| `KUVO_DEMO_COMPOSER_FILES` | Comma-separated paths to show as attached in the composer |
| `KUVO_DEMO_PROVIDERS` | Open Accounts (on a provider's sign-in if it names one) |
| `KUVO_DEMO_CONNECT_METHOD` | With `KUVO_DEMO_PROVIDERS`: that way to sign in (its method ID, such as `oauth:claudeai`), started |
| `KUVO_DEMO_NO_BROWSER` | A sign-in waits as if its page had opened, without opening it in your browser |
| `KUVO_DEMO_APPEARANCE` | `light` or `dark` |
| `KUVO_DEMO_APPEARANCE_THEN` | `light` or `dark`: switched to it some seconds after launch, as the Mac does at sunset |
| `KUVO_DEMO_CHANGES` | Show the side panel |
| `KUVO_DEMO_PANEL` | Open tools in the panel, comma-separated: `terminal`, `browser=<address>`, `machine=<machine>` (its browser; a `KUVO_DEMO_MACHINE` stand-in's in a new session's draft there), `files`, `file=<path>`, `folder=<path>` (Files, open down to it), `changes`, `run`, `expand`, `toggle=<seconds>` (expands and collapses it a few times) |
| `KUVO_DEMO_WINDOW` | Window size, as `WIDTHxHEIGHT`, moved onto the screen if it was past its edge |
| `KUVO_DEMO_OFFSCREEN` | With `KUVO_DEMO_WINDOW`: the window past the screen's right edge, so the pointer can't hover over what you capture (`screencapture -l` still gets all of it) |
| `KUVO_DEMO_ACTIVE` | The window drawn as the one in front while it's behind (a background copy), for captures |
| `KUVO_DEMO_BOX` | The sidebar's box in view, `mac` or a machine's name, a few seconds after launch |
| `KUVO_DEMO_BOXES` | Stand-in machines in the sidebar by name, comma-separated (`devbox,staging,gpu-01`): how the name strip looks with many and with long names; their pages are empty |
| `KUVO_DEMO_UNFOLD` | Every session's branches (conversations branched or handed off from it) shown under it in the sidebar, for a look at them |
| `KUVO_DEMO_SHOW_ALL` | Every project's sessions shown, as after Show More, and every unfolded session's branches (with `KUVO_DEMO_UNFOLD`, all of them), for the sidebar with many rows |
| `KUVO_DEMO_STATES` | Stand-in states for the sidebar's rows and tabs, shared out by session as `kind=percent` (`working=25,needsYou=10,new=15,failed=5`; the kinds are `StatusMark.Kind`'s); `KUVO_DEMO_STATES_CHURN=<seconds>` deals them again that often. For seeing and measuring many marks without as many agents |
| `KUVO_DEMO_LOADERS` | A window, behind the others, with every state mark and loader in light and dark, moving and with Reduce Motion |
| `KUVO_DEMO_SEARCH` | Type this in the sidebar's search field |
| `KUVO_DEMO_BOX_FAILED` | This Mac's box as if it had stopped for good, with this reason: how the sidebar shows it |
| `KUVO_DEMO_KEYS_UNREAD` | The app's host interface not started as this Mac's box starts, so the box can't reach its keys: how Settings › Integrations shows it, until its Try Again starts it |
| `KUVO_DEMO_REMOVE_PROJECT` | Remove Project…'s dialog for the project of this name, open (nothing's removed unless you click) |
| `KUVO_DEMO_PALETTE` | Open the command palette with this typed in it (empty for none) |
| `KUVO_DEMO_MENU` | Open the `mode` menu, the `model` picker (`list` on the model list, `models` with every model shown), or `location` in the New Project sheet (`KUVO_DEMO_MENU_AFTER`: that many seconds after the window shows, for what's read from the box first) |
| `KUVO_DEMO_EFFORT` | With the model picker open, pick this effort level |
| `KUVO_DEMO_RAIL` | With the model picker open on its list: show this entry of its rail (`★`, `auto`, or a provider's ID such as `claude-code`) |
| `KUVO_DEMO_PICK` | With the model picker open: pick this model (`provider/model`) a moment later, as a click would |
| `KUVO_DEMO_USAGE` | Open the menu bar's usage panel on `dashboard`, `customize` or `settings`; `off` to leave the usage tracker out; `sample` to leave it out and give paired phones sample numbers |
| `KUVO_DEMO_ONBOARDING` | Show the first launch from a step: `loader`, `subscriptions` or `screenAccess` |
| `KUVO_DEMO_LOADER` | With `KUVO_DEMO_ONBOARDING=loader`: hold the bots' loader at a share of the way (`0.4`), or `failed` or `offline` |
| `KUVO_DEMO_SCREEN_ACCESS` | What macOS says of Screen Recording and Accessibility, for the first launch's last step: the allowed ones (`screenRecording,accessibility`), or `none` |
| `KUVO_DEMO_ENGINE_STOPPED` | Say the engine stopped over Settings › Accounts and the subscriptions step (`1`), or that it's starting again (`starting`); the engine itself runs on |
| `KUVO_DEMO_ADD_ANOTHER` | With `KUVO_DEMO_ONBOARDING=subscriptions`: Add Another open, on `plans` or `keys`; `KUVO_DEMO_SHOW_KEYS` opens the API keys found in place instead |
| `KUVO_DEMO_OPENCODE_AUTH` | An opencode `auth.json` of your own for the first launch to find, in place of `~/.local/share/opencode/auth.json` |
| `KUVO_DEMO_SETTINGS` | Open Settings on a page, by its `SettingsPage` name: `general`, `appearance`, `storage`, `accounts`, `agents`, `mcp`, `git`, `browser`, `vault` and so on; `permissions@<machine>` for a machine's |
| `KUVO_DEMO_VAULT` | This Mac's vault with sample items (made only where they aren't yet), for a look at its pages |
| `KUVO_DEMO_VAULT_ASK` | With `KUVO_DEMO_VAULT` and a bot: the first bot asks the vault for this, as `vault_ask` does, so its card shows over its composer and in Settings › Vault |
| `KUVO_DEMO_SANDBOX_STATE`, `KUVO_DEMO_SANDBOX_RULES` | With `KUVO_DEMO_SETTINGS=permissions`: how every box's sandbox says it is (`on`, `checkFailed`, `kernel`…), and with `1` its Also Allowed, a folder for the first project, one for the first bot and two for the chats (`empty`: none) |
| `KUVO_DEMO_VAULT_ITEM` | With `KUVO_DEMO_SETTINGS=vault`: the sheet of the item with this name, open |
| `KUVO_DEMO_SETTINGS_TABS` | With `KUVO_DEMO_SETTINGS` and the tab bar on: these pages too, comma-separated, each in a tab of its own (`page@<machine>` for a machine's) |
| `KUVO_DEMO_DISCONNECT` | Don't connect to this machine, as after Disconnect, so this copy reaches it only through the relay (set it up in an earlier launch) |
| `KUVO_DEMO_AWAY` | Disconnect this machine a few seconds after it connects, as Disconnect does, so its pages show it away, with what was last seen |
| `KUVO_DEMO_ADD_MACHINE` | The Add Machine sheet, open, with `KUVO_DEMO_SETTINGS=machines` or over `KUVO_DEMO_NEW_PROJECT` |
| `KUVO_DEMO_REMOVE_MACHINE` | With `KUVO_DEMO_SETTINGS=machines`: that machine's Remove dialog, open once it's connected (nothing's removed unless you click) |
| `KUVO_DEMO_ALSO_APPLY` | With `KUVO_DEMO_SETTINGS` and machines: the page's Also Apply to… bar, for a change noted but not made; `missing` applies one to an agent the machines don't have, `own` one to the shell (with Snapshots), once they're connected or couldn't be, for what the bar says stayed (nothing's written there) |
| `KUVO_DEMO_MCP_SERVER` | With `KUVO_DEMO_SETTINGS=mcp`: that server's editor, open (added, off, if it isn't there); `<name>\|web` switches it to On the web |
| `KUVO_DEMO_SETTINGS_SCROLL` | `bottom`: with `KUVO_DEMO_SETTINGS`, each page scrolled to its end a few seconds after it opens |
| `KUVO_DEMO_SKILLS_COLLECTION` | With `KUVO_DEMO_SETTINGS=skills`: that collection on GitHub (`owner/name`) opened, as if typed and opened; `owner/name\|skill` also adds that skill, as Add Skill does |
| `KUVO_DEMO_ADD_PLUGIN` | With `KUVO_DEMO_SETTINGS=engine`: Add a Plugin open, with this typed in its search field (empty for none) |
| `KUVO_DEMO_WORKTREES_FOLDER` | `browse`: with `KUVO_DEMO_SETTINGS=worktrees`, the folder browser a machine's page opens for Choose a Folder…, open |
| `KUVO_DEMO_SKILLS_DELETED` | With `KUVO_DEMO_SETTINGS=skills`: `open` opens Recently Deleted; `restore:<folder>` also restores that skill, as Restore does |
| `KUVO_DEMO_ACCOUNTS_MACHINE` | With `KUVO_DEMO_SETTINGS=accounts`: that machine's Accounts, in its own tab |
| `KUVO_DEMO_WELCOME` | No tabs, so the welcome card shows |
| `KUVO_DEMO_NEW_BOT` | The New Bot editor, open |
| `KUVO_DEMO_BOT`, `KUVO_DEMO_BOT_PROMPT` | Make the bot `<name>\|<job>\|<its details>[\|<machine>[\|<project folder>]]` unless one has that name (its job kept as the bot keeps it with set_job; leave it empty for a bot that asks for one, and the machine empty for this Mac), open it, and give it this task |
| `KUVO_DEMO_MADE` | What the conversation in view made, its popover open: `open`, `timeline` (a bot's Timeline), or a thing's file name, opened |
| `KUVO_DEMO_OPEN_STEPS` | Every step in the conversation shows its details, opened, and so does the thinking |
| `KUVO_DEMO_FOLDS` | Seconds: the conversation's lines of steps, and the bars over its composer and the usage panel's first bar, open and fold a few times, that far apart, to look at how they move (with `KUVO_DEMO_SLOW`) |
| `KUVO_DEMO_BARS` | Sample bars in the card over the composer of the session in view: `all` a goal, a handoff, a review that found three things and an answered side question (a full card); `two` the review and the side question |
| `KUVO_DEMO_TUCKED` | The bars in the card over the composer tucked into their line (with `KUVO_DEMO_BARS`); `new` marks the side question as changed |
| `KUVO_DEMO_UNDO` | Undo's lines in the card, held so they don't go: the goal put away and a message removed (with `KUVO_DEMO_BARS` and `KUVO_DEMO_WAITING`) |
| `KUVO_DEMO_BOT_MODEL` | With `KUVO_DEMO_BOT`: the model a new bot gets, `<provider>/<model>` (a coding agent's, like `claude-code/haiku`, makes it run with the agents) |
| `KUVO_DEMO_EDIT_BOT` | With `KUVO_DEMO_BOT`: that bot's editor, open (`bottom`: scrolled to its wake-ups and memory) |
| `KUVO_DEMO_BOT_WORK` | A bot's name: its work, a sample (three sessions at work, one asking, two done, two asks answered), in the bar over its composer (`KUVO_DEMO_BOT_WORK_ALL`: its All list open too) |
| `KUVO_DEMO_GOAL` (for a bot) | `<bot's name>:<kind>`: the bot's goal, a sample (Driftwood's landing page), its card (`proposed`; `cant`, from a box that can't work on it alone, with `KUVO_DEMO_SANDBOX=<reason>` naming why, `checkFailed` unless given, or `old`) or its steps (`running`, a few hours in; `month`, with phases and a deadline; `weekly`, two months of weekly summaries with long names; `done`; `sweep` and `sweepcard`, an iOS app's steps and card as a bot writes them: Markdown, long names, Apple's sites and no times yet) |
| `KUVO_DEMO_GOAL_OPEN` | With a bot's `KUVO_DEMO_GOAL` card: this many seconds after it shows, its first **Open** is clicked, as its button does |
| `KUVO_DEMO_GOAL_STATE` | With a bot's `KUVO_DEMO_GOAL`: `working`, or `paused:<you|limit|error|stalled>`, the conversation's own goal beside the sample, so its bar has Pause, or Resume and why it's paused |
| `KUVO_DEMO_BOT_ASK` | A bot's name: as its conversation opens, it asks to make a project, the first time on its computer (the asking card, with where projects go) |
| `KUVO_DEMO_MADE_BY` | A bot's name: as its conversation opens, your first project shows as one it made (its face on the folder) |
| `KUVO_DEMO_EDIT_BOT_SAVE` | With `KUVO_DEMO_EDIT_BOT`: its job in a few words changed to this, and saved, ten seconds on (with `KUVO_DEMO_BOX_FAILED`, to see what Save says while this Mac's box is down) |
| `KUVO_DEMO_MOVE_BOT` | With `KUVO_DEMO_BOT`: once that bot is done (and its prompt with it), it moves to this machine, or to this Mac when empty, as Move to Computer does |
| `KUVO_DEMO_MOVE_GROUP` | With `KUVO_DEMO_GROUP`: that group chat moves to this machine, or to this Mac when empty, as Move to Computer does, before its message goes |
| `KUVO_DEMO_MOVES` | Move to Computer without a second computer: the first bot, group chat and chat shown on their way (copying, getting ready, finishing), and every bot's menu listing lab and a Mac mini that needs a newer Kuvo Code; `waiting`: each coming to this Mac, waiting for devbox |
| `KUVO_DEMO_MOVE_MENU` | A bot's name: its Move to Computer list built as its menu is, before and after its box says where it can go, with what it shows each time printed |
| `KUVO_DEMO_ADD_WAKE` | With `KUVO_DEMO_EDIT_BOT`: adding a wake-up, every day, with this note (`KUVO_DEMO_ADD_WAKE_NOW`: and adds it) |
| `KUVO_DEMO_REPLY` | With `KUVO_DEMO_BOT`: sends this to the bot as a notification's Reply does |
| `KUVO_DEMO_IMPORT_BOT` | A shared bot's file: New Bot opens from it, as File › Import Bot… does |
| `KUVO_DEMO_TRY_WATCH` | With `KUVO_DEMO_EDIT_BOT`: Check Now on the bot's first watch |
| `KUVO_DEMO_FAILURE` | Over the composer of the session in view, as if something had just failed with this message |
| `KUVO_DEMO_QUESTIONS` | The agent asking three questions at once, over the composer of the session in view; a number opens that question (from 0) |
| `KUVO_DEMO_QUESTIONS_PICK` | With `KUVO_DEMO_QUESTIONS`: five seconds after the card shows, picks this choice (from 1), as its number key does (0 presses Next), and writes how the main thread kept up to `KUVO_PERF_LOG` (stalls to `KUVO_PERF_STALLS`) |
| `KUVO_DEMO_QUOTE` | Replying to this text (several, separated by `\|\|`), over the composer of the session in view |
| `KUVO_DEMO_QUOTE_ANSWER` | With `KUVO_DEMO_QUOTE`: the quotes before the last answered, and this typed into the last one's answer a few seconds after launch, a word at a time, each `\|` starting a new line |
| `KUVO_DEMO_SELECTION_MENU` | `<x>,<y>` in the window: the paragraph there in the conversation selected, with the menu over it (Add to Chat, Copy) |
| `KUVO_DEMO_SUBAGENT` | The first subagent of the session in view (or of the session with this ID or title) in its place, as its Open does, once its agent has started one; with `KUVO_DEMO_PROMPT`, of that prompt's session |
| `KUVO_DEMO_OPEN_QUICKLY` | Open Quickly, with this typed in it (empty for none) |
| `KUVO_DEMO_REPORT_PROBLEM` | Help › Report a Problem…'s sheet, with this typed in it (empty for none) |
| `KUVO_DEMO_CONTEXT` | `1`: the context gauge's details (in the title bar) open once the conversation shows |
| `KUVO_DEMO_CONTEXT_FULL` | A fraction, like `0.72`: the context window shows as that full, to see the gauge past half |
| `KUVO_DEMO_COMMIT` | With `KUVO_DEMO_PANEL=changes`: its Commit… form open, with this typed as the message (empty for none) |
| `KUVO_DEMO_BRANCH` | With `KUVO_DEMO_PANEL=changes` on a branch or worktree: what Merge or Create Pull Request says, as if it had just run (`merged`, `conflict`, `pushed` or `failed`; nothing is merged or pushed) |
| `KUVO_DEMO_POINTER` | With `KUVO_DEMO_PANEL=browser=<address>`: the agent's pointer over the page at `<x>,<y>` (its points), about to `click` (or `,type`, `,select`, `,hover`), held in view |
| `KUVO_DEMO_DRAG` | `<x1>,<y1>,<x2>,<y2>`: a drag over the conversation, as events (`KUVO_DEMO_DRAG_AT` seconds after it opens); `KUVO_DEMO_DRAG_DIRECT=1` hands them to the view itself, as a window in the background takes a first click only to come forward |
| `KUVO_DEMO_INTEGRATION_KEY` | `<id>\|<NAME>\|<value>`: saves an integration's key as Add Key… does, before the engine starts (no value removes it) |
| `KUVO_DEMO_ADD_INTEGRATION` | With Settings › Integrations open: adds those integrations (comma-separated), as Connect does |
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
| `KUVO_PERF_SWITCH` | Ten seconds after launch, go to the next session tab this many times, 1.5 s apart, and write how the main thread kept up to `KUVO_PERF_LOG` (stalls to `KUVO_PERF_STALLS`); `KUVO_PERF_SWITCH_BY=1,-1` goes by those steps in turn instead, `KUVO_PERF_SWITCH_PLAIN` switches without the animation, and `KUVO_PERF_SWITCH_CHECK` also gives each tab's session a draft and checks the composer shows it and takes typing after each switch |
| `KUVO_PERF_TOGGLE` | Ten seconds after launch, hide and show the sidebar this many times, then the panel, a second apart, and write how the main thread kept up with each to `KUVO_PERF_LOG` (stalls to `KUVO_PERF_STALLS`); for the panel, also how many times the sidebar and its rows were worked out again, which should be none. `KUVO_PERF_TOGGLE_ONLY=panel` measures the panel alone |
| `KUVO_PERF_TYPE` | Ten seconds after launch, type this many characters into the composer, one every 60 ms, and write how the main thread kept up (and the longest a character took) to `KUVO_PERF_LOG` |
| `KUVO_PERF_LAYERS` | A file: the window's layers drawn on the CPU that were drawn again between looks 1.5 s apart, four times from `KUVO_PERF_LAYERS_AT` seconds after launch (12), largest first |
| `KUVO_DEMO_REOPEN_WINDOW` | Close the window after this many seconds, and open it again |
| `KUVO_DEMO_NAME` | A name to use instead of yours, for the initials on review comments |
| `KUVO_DEMO_MACHINE_BROWSING` | As if an agent on this machine started browsing, as `<machine>\|<seconds after launch>` |
| `KUVO_DEMO_PASSKEY` | A site: the agent of the session in view asks for a step there, and the site asked for a passkey (the card's line about it) |
| `KUVO_DEMO_ASKING` | As if the agent of the session in view started asking you for something in its browser (call the browser's tools to make the ask); with a session's title, opens that session first |
| `KUVO_DEMO_ANSWER_ASKS` | Answers each sign-in, code or step the agent asks for, as `<username>\|<password>\|<code>[\|<seconds>]` |
| `KUVO_DEMO_LOG_FRAMES` | Log a machine's browser's live view: frames a second, their size and bytes, how long after a scroll its picture arrives and where each picture is scrolled to, and how long a page you go to takes to commit, load and show |
| `KUVO_DEMO_DOWNLOADS` | A folder for downloads instead of your Downloads folder (which macOS asks about the first time) |
| `KUVO_DEMO_SAVE_DOWNLOADS` | Save each download from a machine's browser to this Mac, as Save to Mac does |
| `KUVO_DEMO_PAGE_INPUT` | In a machine's browser tab, what you'd do on the page, steps separated by `;`: `wait:<s>`, `click:<x>,<y>`, `type:<text>`, `key:<code>`, `scroll:<x>,<y>,<dy>`, `selectAll`, `copy`, `paste`, `zoom:in`, `zoom:out`, `go:<address>`, `swipe:<x>,<y>,<dy>,<n>` (n scrolls 8 ms apart, as a trackpad sends them) |
| `KUVO_DEMO_PHONE` | Turns on the phone link and Settings › Phone |
| `KUVO_DEMO_PHONE_PAIR` | A file: once this Mac's box has taken the link's settings, a pairing code starts (no window needed) and its link is written there, for pairing a simulator or a test (launch the iPhone app with `KUVO_DEMO_PAIR` set to it) |
| `KUVO_DEMO_PHONE_REMOVING` | Settings › Phone as when a phone you removed waits for the background service to take it off |
| `KUVO_DEMO_MACHINE_SETUP_FAILED` | `<machine>`: Settings › Machines as when that machine couldn't be set up for your phones and other computers |
| `KUVO_DEMO_MACHINE_NOT_PEER` | `<machine>`, or `<machine>\|another`: Settings › Machines as when agents on your other computers can't reach that machine's (its bridge out of date, or another Mac runs its engine) |
| `KUVO_DEMO_MACHINE_HOME` | `<machine>\|<Mac>`: Settings › Machines shows that machine as run by that Mac, with Make This Mac Its Home… (nothing moves unless you click) |
| `KUVO_DEMO_MAKE_HOME` | `<machine>`, with `KUVO_DEMO_SETTINGS=machines`: once it's connected, makes this Mac its home, as Make This Mac Its Home… does (to try a move between two demo copies) |
| `KUVO_DEMO_MACHINE` | Stand-in machines, as `<name>=<status>,…`: `connected`, `reading`, `connecting`, `starting`, `downloading`, `copying`, `reconnecting`, `failed`, `notConnected` or `stopped`. Each is named under `.invalid` and never contacted (no SSH, install or keeper), nor saved with your machines; `KUVO_DEMO_MACHINE_FAILURE` is what a `failed` one says, and `KUVO_DEMO_MACHINE_BROWSER` how its browser shows (`installing`, `connecting` or `failed`) |
| `KUVO_DEMO_MACHINE_ROOT` | A folder of its own in machines' home folders (like `.kuvo-code-demo`), so the demo copy's engine and browser there never touch your own copy's. What it starts there stops when it quits, except in `.kuvo-code-demo` while its phone link is on, so a phone tried with it reaches its bots with the Mac shut |
| `KUVO_DEMO_COMMENT` | Add a review comment to the session in view, as `<path in the project>:<line>:<text>` |
| `KUVO_DEMO_VOICE` | With `KUVO_DEMO_SESSION`: voice input listening for it with sample words, `composer` (in the composer) or `field` (the voice field), without the microphone; `tip`, the one-time tip about more accurate voice input, from the mic |
| `KUVO_DEMO_WHISPER` | Whisper's download as if it were `downloading`, `paused`, `waiting`, `failed`, `space`, `preparing` or `ready`, without the network (the ring on the mic, Settings › General › Voice Input); `download` starts the real download, into the copy's own folder |
| `KUVO_DEMO_QUOTE_AFTER` | With `KUVO_DEMO_QUOTE`: the quotes added this many seconds after the session shows, as Add to Chat adds them, and removed as long after that, to watch the conversation move with the composer |
| `KUVO_DEMO_QUOTES` | With `KUVO_DEMO_SESSION`: that many quotes to answer in its composer (a session's or a group chat's, as `group:<id>`) |
| `KUVO_DEMO_FIND` | With `KUVO_DEMO_SESSION`: Find in it, looking for these words |
| `KUVO_DEMO_CONNECTED` | With `KUVO_DEMO_SETTINGS=integrations`: that integration's sign-in sheet, on its last step |
| `KUVO_DEMO_WIDGET_SNAPSHOTS` | A folder: each widget an agent made, once drawn, saved there as a picture, named with the look it was drawn in (a background copy's window draws no web pages) |
| `KUVO_DEMO_WHATS_NEW` | What's New's sheet over the window, with the newest highlights |
| `KUVO_PERF_STILL_BOTS` | Every bot holds still, to compare what their motion costs |
| `KUVO_ANALYTICS_URL` | Send anonymous usage to this collector, e.g. `http://127.0.0.1:8787/kuvo/code`; debug builds send none otherwise |
| `KUVO_DEMO_AGENTS_FAILED` | This Mac's coding agents' bridge (and its group chats) as if it had stopped for good, with that reason |
| `KUVO_DEMO_GROUP_REPLAY` | `setup`, then `run`: a three-bot group chat discussion measured (`Tests/Perf`, `groups`) |
| `KUVO_DEMO_BRANCH_BACKUPS` | `listed`, `gone`, `empty`, `none`, `failed`, `old`, `restored` or `gone-restored`: Branch Backups opens from the Changes panel with sample backups, the `restored` ones with the first taken back |
| `KUVO_DEMO_AUTO` | With `KUVO_DEMO_SESSION`: it in Auto with sample decisions and no box behind it: `held` (one held back over the composer), `paused`, `decisions` (Auto's Decisions open), `fullAccess` (Full Access asked for) or `unread` (Decisions with its computer out of reach) |
| `KUVO_PERF_PROVIDER` | The stand-in model that discussion talks on, an OpenAI-compatible URL (`kuvo_perf.py` serves it) |

### Rehearsing the group chats' upgrade

This Mac's group chats moved into its box from what 0.5 to 0.8.0-beta.1 kept (`GroupMigration`).
`scripts/groups-rehearsal.sh` rehearses it with the real released builds. They can only run as
Kuvo Code itself, so it saves your Kuvo Code's folder and settings first and puts them back at the
end (its Keychain items are shared too: an old build may ask for them). Have someone at the Mac:
each step but `check` asks you to type yes at the terminal first.

1. `./scripts/groups-rehearsal.sh prepare` downloads 0.5.22, 0.6.6, 0.7.2 and 0.8.0-beta.1 and
   builds this checkout as `run.kuvo.code`, then `save`.
2. For each version: `fresh`, then `open <version>`. Make two bots (one on a machine, if you have
   one) and a group chat of both with a weekday meeting, talk until a wrap-up splits the work, start
   it, and take one message back. For one version, quit while Move to Computer moves a chat.
3. `open this`: the chats show at once, as they were; write in one and see the bots answer.
   `check` says what moved, what was taken, the copy in Backups, and any seat left on a machine.
4. `open <version>` again (the rollback): its chats are there, as it left them. Make another chat,
   quit, `open this`: only the new one comes in, and one you deleted stays deleted.
5. `restore` when done.

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
as you. `Packages/Box/src/agents` is a small server, the agents bridge, that `OutsideAgents` starts with the
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
versions in the agents' files, and aren't part of the app. After changing `Packages/Box/src/agents`, run
`./scripts/build-agents.sh` and commit `KuvoCode/Resources/kuvo-agents.js`, the bundle the app
ships; CI fails when it isn't built from the sources as they are (`build-agents.sh --check`). In a
debug build, `KUVO_AGENTS_SCRIPT=<checkout>/Packages/Box/src/agents/main.ts` runs the source
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
     window. Something new people use (a keyword, a Settings page) can carry a
     "New" mark until it's used: add `<!-- new: keyword/goal -->` (or
     `settings/<page>`) after its line. A release with headline features lists
     a few under `### Highlights` at the top of its section, each
     `- **Title**: one line. <!-- symbol: <SF Symbol>; open: settings/<page> -->`,
     which What's New shows once after an update; then run
     `python3 scripts/whats-new.py` and commit `KuvoCode/Resources/whats-new.json`
     (CI checks it, and the release workflow writes it again).
     (`.gitattributes` merges `CHANGELOG.md` line by line, so branches that
     each add a line there merge without a conflict; if two edit the same line,
     both versions stay, so tidy that one by hand.)
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
