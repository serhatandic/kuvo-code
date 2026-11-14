# #713 The desktop app and this Mac's box: design

Status: design only, written 2026-11-14 against main at `98adca21f` (after the layout move, before
#712), revised after one reviewer pass (§10). Nothing here is built. Read with
`333-own-box-independent.md` and `333-piece-0-results.md` (main checkout's `.claude/notes`,
untracked), `693-own-box-browser.md`, and `protocol/PROTOCOL.md` ("Updates" :2203, "The update
gate" :2428, "The keeper" :6057, "A home of its own" :6156, "Moving this Mac's box" :6199, "This
Mac's box: its helper" :6655, "For released Macs" :8579). Swift paths are under `swift/`, which
stays in the repo as read-only reference (the lead, 11-14).

## 0. In short

- **The box keeps itself, as a machine's does. On a Mac its launchd program is #333's helper, Kuvo
  Code Box.** That's the user's leaning ("a login item that starts the box and keeps it running,
  even with the app closed; the desktop app installs it once"), and I recommend it, with two
  refinements:
  1. **The box installs the helper, not the app.** The desktop app runs one box command from the
     release it carries; the box writes the launch agent (`kuvo-link.js helper install`, built).
     The app never writes a plist or calls `launchctl`.
  2. **The box updates the helper, not the app.** The helper is a bundle in the box's signed
     release, swapped whole (built, #333 piece 7). The app only offers its release
     (`kuvo/box/update {from}`, built).
- **The desktop app's native part is small:**
  - running the box's installer from its bundle;
  - Sparkle, to update itself;
  - opening a System Settings pane;
  - carrying a tiny signed Swift tool for the one-time Keychain hand-over.
  Everything else goes in the box: when and how to move, stopping the old box, 0.7's upgrades, and
  permissions as facts.
- **0.7 → 1.0:** Sparkle in the user's Swift app installs the desktop app (same `run.kuvo.code`,
  same team, same feed key). The desktop app runs first and asks the box's installer what this Mac
  holds. The box then moves itself (most of it is #333's `rehome`, built), starts fresh, or the app
  just attaches.
  - What's new: the box runs the move without the Swift keeper, and brings 0.7's data and engine
    database up to date itself, in its staging copy only.
  - Until the move succeeds, nothing runs (a 0.7 Mac never had a box running anyway), so every
    refusal must be one the user can act on at once.
- **#715:** the box's files and its release are built by the box's own build (`scripts/build-box.sh`
  and a new `scripts/box-release.sh`), from sources in `box/`, never by running an app. The desktop
  app carries that release, and machines update from the same files.

## 1. Today (read, not run)

- **The Swift app keeps its box with its own executable.**
  - `--box`, registered with `SMAppService.agent(plistName: "run.kuvo.code.box.plist")`
    (`swift/KuvoCode/Stores/BackgroundWork.swift:42-44`). The plist's `BundleProgram` is
    `Contents/MacOS/${EXECUTABLE_NAME}` and its `KeepAlive` is `SuccessfulExit: false`. It runs
    the box in `~/Library/Application Support/run.kuvo.code/box` (`S/box`).
  - With `movesOwnBox` on (off in every build), that keeper runs the move into `~/.kuvo-code`
    (`K`). It copies the Keychain items as the app's identity (`KeychainMove`), loads the helper,
    settles what's owed and unregisters itself (`swift/KuvoCode/Keeper/OwnBoxMove.swift`, 528
    lines; `OwnBoxMove.swift:518`).
- **The helper is built and merged, behind the flag.**
  - Kuvo Code Box (`run.kuvo.code.box`) is Swift: `swift/OpenCodeKit/Sources/OpenCodeKit/BoxHelper/`
    (2,077 lines), the product `KuvoCodeBox` (`swift/OpenCodeKit/Package.swift:10,14`).
  - It's built into the app by `scripts/build-box-helper.sh:33-35`, packed into the box's release
    by `scripts/pack-box.sh`, and installed by the box (`helper install|start|status`,
    PROTOCOL.md:6666-6690).
  - It's the responsible process for everything the box runs (piece 0 §1, user checks 2a–3c). It
    holds the box's Keychain copies (§2, 4b/4c) and starts `serve` with the vault's secrets on
    stdin (PROTOCOL.md:6716-6723). It runs only the real `K` (PROTOCOL.md:6691).
- **The move is the box's: `kuvo-link.js rehome`** (PROTOCOL.md:6199-6402). Three of its rules
  assume a Swift keeper ran first:
  - It refuses a box that "hasn't started since Kuvo Code updated" (`box/src/link/rehome/move.ts:216-219`:
    `run/served.json` must name the app's version and the link's).
  - It accepts only the pinned engine 2.2.6's schema, `KNOWN_SCHEMAS = ["59 20261030054400_job"]`
    (`box/src/link/rehome/database.ts:19`). 0.7.2 and beta.1 run engine 2.0.32 (`v0.7.2`'s
    `OpenCodeKit.swift:5`); in #333's path, a keeper-era app migrated the database first.
  - `--new` needs the engine already in the app's folder (PROTOCOL.md:6381).
- **0.5–0.7.x and 0.8.0-beta.1 have no `S/box`.** Their upgrades into a box are Swift, run as the
  app opens:
  - `GroupMigration.run` (`swift/KuvoCode/Stores/GroupMigration.swift:61`, reading the app's
    defaults), `Personalities.moveToBox` (`Personalities.swift:211`), `BoxGroups.takeOldCache`
    (`BoxGroups.swift:121`);
  - and about ten more listed under "For released Macs" (PROTOCOL.md:8579 on): `botEditOutbox`,
    `agent-letters*.json`, `agent-messages.json`, `copilotClaudeModels`, `movesUnderWay`, Settings
    › Git from preferences, `passwords.agentSignIn*`, Keep This Mac Awake.
- **The desktop app (`gpui/`) only connects** (`gpui/kuvo/src/main.rs:24`).
  - `place::this_mac` takes `K` when `box/kind` says `mac`, else `S/box`
    (`gpui/kuvo_box/src/place.rs:47-54`). It reaches the box over `run/serve.json`
    (`place.rs:75-92`, `local.rs`).
  - It has no bundle, signature, updater, release, or way to start or install a box; its window
    says "isn't running". Its executable is `kuvo`.
- **The box's release is made by running the Swift app.**
  - `release.yml:220-232` runs `scripts/app-box-release.sh`, which runs
    `"Kuvo Code" --write-box-files` (`scripts/pack-box.sh:29`).
  - That writes `BoxRelease.write` (`swift/KuvoCode/Stores/BoxRelease.swift:22-55`): `kuvo-link.js`,
    `kuvo-browser.js`, `kuvo-agents.js`, the catalogs (`MachineBox.swift:56,106`, from Swift's
    `Integrations.all`), the bots' words (`swift/KuvoLink/Sources/KuvoLink/Resources/bot-words.json`),
    `box-version`, `box.json`, and the engine's URLs and integrity
    (`swift/OpenCodeKit/Sources/OpenCodeKit/Engine/EngineInstaller.swift:23-40`).
  - It also writes `BoxFiles.write` (`swift/OpenCodeKit/Sources/OpenCodeKit/Engine/BoxFiles.swift`):
    `kuvo-start`, `kuvo-launch` and `kuvo-setsid`, as shell held in Swift strings
    (`RemoteEngine.swift:1051`, `:922-927`, `:542`, `bootFiles` `:1344`), and `.kuvo-boot`.
    `kuvo-wake`, the integrations' launcher, `kuvo-npx` and their runtime and plugin come from
    their `installScript`s (`Wakes.swift:311`, `Launcher.swift:130`, `CommandEnvironment.swift:81`).
  - The app carries the result as data in `Contents/Resources/box-release` (`boxes.json` and the
    pack; `scripts/app-box-release.sh`).
- **What only the Swift app answers or does, with no replacement yet:**
  - the phone's `kuvo/machines`, `kuvo/hosts`, `kuvo/asks`, `kuvo/mac` and `kuvo/engine`, through
    the app's host (`MAC_APP_ROUTES`, `box/src/link/mac/relay.ts:41,72,86`);
  - adding and repairing machines over SSH (`RemoteEngine.swift`), and writing `machines.json` and
    `phone-link.json` (PROTOCOL.md:6588).

## 2. Who keeps this Mac's box (question 1 of the brief)

| | A. The desktop app keeps it | B. The helper, installed by the desktop app (user's leaning) | C. The box keeps itself, like a machine |
| --- | --- | --- | --- |
| Starts at login, runs with the app closed or removed | no, or only while the app is a login item | yes | yes |
| App updates restart the box | yes (0.8's `Keeper.update` problem again) | no | no |
| macOS asks about | the app | Kuvo Code Box | on a Mac, "sh" and each binary by its own name (piece 0 §1) |
| Keychain without files | yes | yes (piece 0, 4b/4c) | no: keys in files |
| Logic a new client rewrites | the whole keeper (Swift's was 2,782 lines) | nothing: install is one box command | nothing |
| Built | no | yes, behind the flag | yes, for machines |

**Recommend B as C on a Mac.** The box keeps itself, as on every machine (`kuvo-start`, signed
updates, `update.ts`). On a Mac its launchd program is the helper. That isn't a third program
with its own logic: the helper is the box's macOS shell, for what only a signed program can be
(TCC's responsible process, the Keychain, `serve`'s secrets).

- **"Started by the desktop app" means once, at install,** through the box's command. After that,
  launchd starts it at login, and the box restarts and updates its pieces itself.
- **If Login Items is off for it,** the app asks the box to start it once (`helper start`), and
  the box opens the bundle with `open` (§3).
- **A rejects itself.** It would rebuild the Swift keeper in Rust, put the box's life in a client,
  and restart the box with every app update, which is what #333 removed.
- **Plain C on a Mac** (`/bin/sh` as the program) loses the shared identity, so each binary is
  asked about by its own name and asked again at each update (piece 0 §1). It also gives up the
  Keychain.

**A future Linux desktop app** runs the same installer from its bundled release, with no helper.
Its box is machine-kind:

- it starts as a machine's does today (the `@reboot` line, `docs/footprint.md`'s exception);
- it keeps its keys in files;
- the app attaches in place as to a machine's box on its computer (`x-kuvo-from: mac`,
  PROTOCOL.md:6549-6556), not through `this_mac`'s `mac` kind. That's a small `kuvo_box` change
  (`place.rs`, `local.rs`'s `Speaker`), not one line.

**A Windows desktop app has no box of its own.** Box code runs only on macOS and Linux. On Windows
the app is a client of the user's other boxes. Its own box would need WSL or a port, which the
app should say plainly. Not in this work.

## 3. What the desktop app must do natively on macOS

1. **Run the box's installer** from its bundle (§4.1), as a child process, and draw its JSON lines.
   That's all the app does to "install the helper".
2. **Update itself with Sparkle**, embedded through `objc2`.
   - It reads the same feed (`SUFeedURL`), verifies with the same `SUPublicEDKey`, and uses the
     same `scripts/appcast.sh`.
   - Updating itself is one of CLAUDE.md's "only in a client" items, and Sparkle keeps 0.7's Swift
     apps able to update into it (§5).
   - The app keeps 0.7.2's and beta.1's `SMAppService.mainApp` registration (Open at Login) as it
     is: same bundle, same login item. Settings shows it.
3. **Open a System Settings pane** when the box says a permission is missing
   (`open x-apple.systempreferences:…`).
4. **Carry `kuvo-keys`, the one-time Keychain hand-over**, in `Contents/MacOS/`.
   - It's a tiny Swift tool built from the helper's package (§3, the helper) around the tested
     `KeychainMove.copy` and `deleteOriginals`. It's signed with the identifier `run.kuvo.code`
     and the team, so it meets the original items' designated requirement and reads them without
     asking (piece 0: access goes by the designated requirement, not the path; to confirm with
     the real builds in piece 0).
   - The box's move runs it (`kuvo-keys copy --home K --helper <the helper the release brings>`,
     then `kuvo-keys delete-originals`). The app's window never does Keychain work.
   - It also reads 0.7's pre-vault internet passwords (`Passwords.swift:252`) into a journaled,
     `0600` hand-over file in `K/updates/rehome/`. The box takes them into its vault once `serve`
     runs (`owed: passwords`), then deletes the file.
   - **Why not the helper:** it can't read the originals (-25293), and editing their access list
     asks once per item (piece 0 §2).
   - **Why not Rust in the app:** it would mean FFI to deprecated security APIs, for code that
     goes away later. If piece 0 finds a nested tool with the app's identifier refused, the
     fallback is that port.
   - It goes only by your word, once no 0.7 Mac is expected to update (PROTOCOL.md's rule for
     0.7), never on a date: a Mac updating late would otherwise lose its keys.

**Not in the app:**

- **Whether permissions are granted.** The helper preflights Screen Recording and Accessibility
  (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`: it imports CoreGraphics already) and
  writes facts the box serves (`kuvo/box/permissions`; not `kuvo/mac`, which the app answers
  today).
  - Files & Folders and Local Network have no preflight. The box says them from what fails
    (`EPERM` in a protected folder, `EHOSTUNREACH` on the LAN), as #333 §4.3 plans.
- **Login Items state.** The box says it (`helper start` answers `disabled`).
- **Opening the helper with Login Items off.** Today's PROTOCOL.md:6686-6690 has the app run
  `open -g -j -n <bundle>`. `helper start` does it itself: `open` goes through LaunchServices, so
  the helper is still its own responsible process.
- **The helper's install, update and removal:** box commands.
- **The old keeper's launch agent:** the box (`launchctl bootout`, §5 case C). There's no `--box`
  handling in the desktop app.

**The notarized helper.** It stays Swift, built from its own sources, signed and notarized. Its
language doesn't matter to any client, it's piece-0-verified and reviewed twice, and Linux and
Windows never need it.

- With `swift/` read-only, its sources (BoxHelper, plus the few OpenCodeKit files it uses) and
  `kuvo-keys` move to a package of their own (`mac/helper/`, question 2).
- `build-box-helper.sh` builds it on its own (not into an app), keeping its ID
  `run.kuvo.code.box`, its team and its entitlements, or macOS forgets the user's grants and its
  Keychain items (piece 0 §1).

**Dev builds never install or move.** `cargo run -p kuvo` takes the real `$HOME`. Installing and
moving run only from a signed `run.kuvo.code` bundle, or into a demo root
(`KUVO_DEMO_MACHINE_ROOT`). Any other build only attaches.

## 4. Where each piece of logic lives

### 4.1 Install, in the box: `kuvo-install` and `kuvo-link.js install`

The desktop app carries what the Swift app carries today, as data (`Contents/Resources/box-release`:
`boxes.json` and the pack), plus `kuvo-install`, a short POSIX shell script from `box/`. No
executable code sits in `Resources` outside the pack.

- **`sh <app>/Contents/Resources/box-release/kuvo-install <verb> --app <bundle>`.** On a new Mac
  there's no engine to run JavaScript with, so the first step is shell:
  1. it checks the pack's SHA-256 against `boxes.json`;
  2. it unpacks it into `K/updates/install/release/`;
  3. it fetches the engine for this system (the manifest's URL and npm integrity, checked as
     `update.ts` checks) beside it;
  4. it hands over to that release's `kuvo-link.js install …` on that engine's Bun.

  The app's code signature seals `boxes.json` and the pack, so no runtime signature check is
  added.
- **`install --status`** reads the folders (`here`'s judgment) and answers one of these. §5's table
  says what each does.

  | Verdict | What this Mac holds |
  | --- | --- |
  | `fresh` | nothing |
  | `ours` | a Mac-kind box in `K` |
  | `app-07` | 0.5–0.7.x or beta.1 data in `S`, no `S/box` |
  | `app-box` | `S/box`, a keeper build's |
  | `moving` | a move under way |
  | `stuck` | stopped past the point it goes back from |
  | `waits` | another move holds the lock |
  | `back` | moved back |
  | `machine` | a machine's box in `K`, nothing in `S` |
  | `two` | a machine's box in `K` and data in `S` |

- **`install --new`** is `rehome --new` with the release and engine from `K/updates/install/`
  rather than the app's folder. Then `helper install --load`.
- **`install --move`** is §4.2.
- **The app** runs `--status`, then the verb it names, and draws the result. For `ours` it offers
  its `box-release` folder (`kuvo/box/update {from}`, as today) and attaches, as #333 piece 6b
  does.

### 4.2 The move without the Swift keeper: `rehome --run`, in the box

The Swift keeper's outside steps (PROTOCOL.md:6404-6451) go into the box:

- **`kuvo-link.js rehome <root> --run --app <bundle>`** runs detached (`setsid`), so quitting the
  app doesn't stop it, and holds the move's lock. It:
  1. asks `--ready`;
  2. stops the old box. For `app-box`, that's the Swift keeper's `POST stop` (its control is in
     `run/keeper.json`, PROTOCOL.md:6087-6096); a keeper running from the replaced bundle's file
     is stopped by its pid, and its `keeper.lock` waited for. For `app-07`, it checks that
     nothing holds `S`'s engine database: an exclusive lock taken briefly at Plan and again before
     Clear, so an orphaned or second 0.7 engine refuses the move. The clear step skips the
     engine's folder (`move.ts:541`), so without this its writes would be lost;
  3. installs the release from `K/updates/install/release/`, and runs `kuvo-keys copy` trusting
     that release's helper (the same designated requirement as its final place in `K/bin`), then
     `Kuvo Code Box keys check`;
  4. runs the move it already has, with two new steps in staging, after Clone and before Rewrite:
     - **Upgrades:** 0.7's and the keeper builds' (§1's list, inventoried in piece 4), each
       reading `S`'s files or the app's preferences (`/usr/bin/defaults export run.kuvo.code -`)
       and writing into staging.
     - **The engine's database brought to the pinned schema:** the release's engine run on the
       staged copy only, isolated as the check step's engine is (`engine-check.ts`: no network,
       settings and home of its own). Then the schema check, then Rewrite.

     `S` is never changed, so the kept copy is the untouched 0.7 `S`;
  5. settles what's owed: `kuvo-keys delete-originals`, then `agent` (the old keeper's label
     booted out, §5 C), then `passwords` once `serve` runs.
  It writes progress to `state.json`, which the app draws from `--status` before `serve` is up.
- **`served.json`'s rule** (`move.ts:216-219`) becomes "the box's own upgrades ran in staging".
  There's no app version left to compare with.
- **Pacing.** `--ready`'s rules were built for a world where the old box keeps running: an hour
  between tries, then waiting for Move Now after three. Here, for `app-07`, nothing runs until the
  move succeeds, so they change:
  - `--run` started by the user (the app's Try Again) has no wait and no try cap;
  - every refusal says, in words, what to do (free space; unlock the Keychain; go online for the
    engine; quit Kuvo Code 0.7 wherever it's open);
  - "Nothing runs on this Mac until this is done" is said plainly.

  `app-box` keeps today's pacing, since its old keeper still runs the box meanwhile.
- **Interrupted.** A move cut short (app quit, logout) resumes at the next `install --status`,
  which runs at each app open. There's no login item yet then, so it waits for the app to open.

## 5. From 0.7 to the desktop app (question 3)

Same `run.kuvo.code`, same Developer ID team, same Sparkle key. To check in piece 0, in the
rehearsal account (it needs the real ID):

- that Sparkle 2 in 0.7.2 and beta.1 takes an archive whose executable differs;
- that it puts the app at the same path;
- that the moved TCC grants and the Keychain's designated-requirement check hold for the new
  build and for `kuvo-keys`.

**Where each kind of Mac starts:**

| Mac | Has | What happens |
| --- | --- | --- |
| `fresh` | nothing | `install --new`: the box in `K`, helper loaded, attach. |
| `app-07`: 0.5–0.7.x, 0.8.0-beta.1 (every user) | data in `S`, no `S/box`, no keeper | `install --move` at once: upgrades and engine database in staging, move, Keychain hand-over, helper loaded, attach. A few minutes. |
| `app-box`: a keeper build (main, try-update; 0.8.0 if it ships) | `S/box`, an `SMAppService` agent pointing into the replaced bundle | See below. |
| `ours` | `K` with `box/kind` `mac`, helper | Attach, offer the release. |
| `back` | moved back, then 1.0 installed again | Nothing starts by itself. The app says the box was moved back and offers **Move Again** (`kuvo/box/rehome {now}`, then `--run`). |
| `machine` | a machine's box in `K` (a Mac set up as one), nothing in `S` | No Mac-kind box is made over it. The app attaches as to a machine's box here (PROTOCOL.md:6549) and says this Mac is set up as a machine. Making it this Mac's own is 183's work. |
| `two` | a machine's box in `K` and data in `S` | As #333 §3.7: no move, said plainly. |

**The `app-box` case.**

- The old keeper sees a new app at its place and makes way once quiet (`Keeper.update`).
- launchd then can't start it again: `BundleProgram` names `Contents/MacOS/Kuvo Code`, which the
  new bundle doesn't have. Piece 0 checks this.
- The desktop app's `install --status` says `app-box`, and `rehome --run` stops whatever is left,
  moves, and boots the old label out.
- A stale Login Items entry may stay. This case exists only on your own Macs (question 5), so it's
  a support path, written in `troubleshooting.md`.

**What runs first** is the desktop app, which Sparkle relaunches. Its window shows the box's
progress (drafts: "Moving your sessions to their new place on this Mac…", with the step), and
starts nothing else meanwhile.

**Who moves the box:** the box (`rehome --run`). The app only starts it. The app's signed tool
lends its identity for the Keychain step.

**Kept intact:**

- Sessions, chats, bots, wake-ups, group chats, worktrees, attachments: `rehome` (built and
  tested), now after the engine database is migrated in staging.
- This Mac's identity: whatever link and signing keys the Keychain holds are copied, never made
  anew. 0.7 Macs likely have none, since the phone link was never on in a release; beta.1's peers
  may. Where there are none, the helper makes them at first use, as for a new Mac. No second box
  ever runs under one identity: the originals are deleted only after Clear, and the helper starts
  nothing mid-move (built).
- Saved passwords and the vault: the vault's items through the copies; 0.7's older internet
  passwords through `kuvo-keys` and `owed: passwords`.
- Integration and bots' keys: the Keychain copies, plus key files the box writes.
- Added Claude Code accounts: renamed (built).
- Permissions: asked once more, for Kuvo Code Box (#333 question 2). The app's own grants stay the
  app's.

**Going back (question 8).** For an `app-07` Mac, Move Back (Settings › This Mac's Box, 30 days)
is the kept copy put back, not `--back`'s keeper layout, which no released app reads. It's a new
`rehome --restore`:

1. The box in `K` is stopped and its helper's agent removed (`helper` uninstall's steps).
2. The Keychain items are made again under the app's names, trusting the app (`keys back`, built).
3. `kept/<date>` is renamed back into `S`: the untouched 0.7 folders and database.
4. `K` is set aside whole into `K/updates/rehome/after-<date>`, not deleted. Work done since the
   move stays there only, and the app says so before you confirm.

Then you install 0.7.2 from its download page; it reads `S` as it always did. Its Sparkle will
offer 1.0 again, and 1.0 then shows the `back` state. `--back` (the keeper layout) stays for
`app-box` Macs only.

**A stepping stone instead?** The other way is a last Swift release (0.9) with `movesOwnBox` on,
its feed pointing to the desktop app's: 0.7 → 0.9 moves, and 0.9 → 1.0 just attaches.

- Less new code: no `rehome --run`, no box-side upgrades, no `kuvo-keys`.
- But it needs piece 8's UI built in Swift (thrown away a release later), the Swift app built and
  released after #712, and every user to pass through 0.9. Anyone who skips it (1.0 downloaded
  over a 0.7 install) still needs §4.2.
- **I recommend against it** (question 3). It remains the fallback if piece 0 finds Sparkle won't
  install the desktop app over 0.7.2.

## 6. #715: the box's release, built by the box

| Today (Swift, by running the app) | Afterwards (in `box/`, built by `scripts/build-box.sh` or the new `scripts/box-release.sh`) |
| --- | --- |
| `kuvo-start`, `kuvo-launch`, `kuvo-setsid`, `.kuvo-boot` (shell in `RemoteEngine.swift`) | `box/src/keeper/*.sh`, plain files, byte for byte, the one copy; `.kuvo-boot`'s hash written by the build |
| `kuvo-wake`, the integrations' launcher, `kuvo-npx`, their runtime and the engine's plugin (`installScript`s) | `box/src/keeper/` and `box/src/plugins/`, plain files |
| catalogs (`MachineBox.catalogJSON`, `integrationsJSON(forMac:keysInBox:)`, from Swift's `Integrations.all`) | the table itself moves to `box/src/shared/integrations/` as data; the three catalogs are generated from it by the build |
| bots' words (`bot-words.json`) | moved to `box/src/shared/` |
| the engine's pin (`EngineInstaller.swift:23-40`) | `box/src/shared/engine-pin.json` (version, URLs, integrity per system), which `kuvo-install` reads too; the weekly upstream check updates it |
| `box-version`, `box.json` | written by `box-release.sh` from `VERSION` |
| the helper bundle, from the app's `Contents/Helpers` | built by `build-box-helper.sh` on its own, signed and notarized as a zip, then packed |
| `release.yml` builds the Swift app, then packs | `release.yml`: build the box; build and notarize the helper; pack and sign `boxes.json`; then build the desktop app with `box-release` inside |

- **Byte-for-byte check:** once, a test diffs the new release against the last Swift-made one, so
  machines see no change.
- **Adding machines:** whatever sets up a machine later (the desktop app's or a box's, §8 piece 8)
  takes these files from the release, never a second copy.

## 7. How #333 and #693 reorder (question 4)

- **#333:** pieces 0–7 stay as merged.
  - **Piece 5's keeper half** (Swift) is replaced by §4.2's `rehome --run` (box) and `kuvo-keys`
    (§3.4).
  - **Pieces 6a and 6b's client half** is what `gpui/kuvo_box` does by design (attach as
    `x-kuvo-from: app`, `place.rs`). Left for the desktop app: peers and pairing (#644), and
    `kuvo/box/app` only while #693 isn't done.
  - **Piece 8 (UI)** moves to the desktop app: the move's states, Settings › This Mac's Box (starts
    at login, where it is, Move Back, Uninstall…), permissions for the helper, `two`, `back`. The
    Swift drafts branch (`kuvo/333-piece-8-…`) is reference only.
  - **Piece 9 (rehearsals)** goes from 0.7.2, beta.1, a 0.6 build and a keeper build to the
    desktop app, then back, in the rehearsal account.
  - **`movesOwnBox`** ends as a Swift flag. The desktop app ships when §8's pieces pass.
- **#635** (vault and saved passwords on an attached box: this Mac's key joins the box's Macs
  through the signed setup) is box logic plus the desktop app's drawing. It's needed before 1.0:
  the desktop app has no Swift vault path to fall back on.
- **#644** (Settings › Phone while attached) is a desktop-app Settings page, drafts first, against
  the box's link routes (built).
- **#693** pieces 0–4 stand (1 and 2 merged). Pieces 5–9 need the box in `K` (§8 piece 4):
  - **5 (a Mac-kind box runs its browser)** comes before the desktop app ships, since the desktop
    app has no WebKit panel. `browser.own` is on from the start for a box the desktop app
    installed or moved.
  - **6 (Swift draws the box's browser)** goes. **11 (GPUI live view)** replaces it and is
    required for 1.0.
  - **7 (WebKit scenarios on the box)** stays.
  - **8 (rehearsals)** folds into #333 piece 9.
  - **9 (old path goes)** shrinks to the box's app hand-off (`appBrowser`, `kuvo/box/app/open`).

## 8. Pieces, in order

Sized in wall-clock session hours, start to merge-ready, review included.

- **From main's history** (first commit to merge, not counting work before the first commit):
  - #333 piece 2b: 4,672 lines, 2 h;
  - piece 4: 3,269 lines, 1.5 h;
  - piece 5: 2,471 lines, 17 commits, four review rounds, 3 h;
  - piece 7: 1,291 lines, 1.5 h;
  - 6a: 1.9 h;
  - #679: 5.5 h.
- **The #333 note sized the same pieces at 8–15 h each.** Most of a session goes before its first
  commit, so the ranges below lean on #333's estimates, not on commit spans.

**Tests never touch real data:**

- `KUVO_*` unset;
- a `HOME`, demo root and test bundle family of their own (`run.kuvo.code.trial713.*`);
- a test keychain;
- `launchctl`, `security` and `crontab` stand-ins on the PATH (`KUVO_TEST_UNINSTALL_TOOLS`);
- each box piece also runs on Linux in a devbox test folder;
- anything that needs the real `run.kuvo.code` ID (Sparkle, Keychain identity, TCC) runs only in
  the rehearsal account.

| # | Piece | Where | Tests | Risk | h |
| --- | --- | --- | --- | --- | --- |
| 0 | **Spikes** (rehearsal account for the real ID): Sparkle 0.7.2 → a GPUI bundle with the same ID (installs, path kept, relaunches); `kuvo-keys` (identifier `run.kuvo.code`, nested in it) reads 0.7.2's items with no prompt; TCC grants kept; launchd with the keeper's `SMAppService` agent after its bundle is replaced, and `launchctl bootout` of it; Sparkle through `objc2` in a bundle built without Xcode; engine 2.2.6 migrating 0.7.2's and 0.6's databases. | Mac | a written result each | low | 5–8 |
| 1 | **The helper on its own**: sources and `kuvo-keys` to `mac/helper/`, built and notarized standalone; `helper start` opens it itself with Login Items off; the helper writes permission facts (`kuvo/box/permissions`). | Mac, box | the helper's tests moved as they are; `helper start` with stand-ins | medium | 6–10 |
| 2 | **#715: the box's release built by the box** (§6), byte-for-byte with the last Swift-made one; `release.yml` without the Swift app (uses piece 1's helper). | box, scripts | a release built both ways, diffed; `update --from` takes it; Linux | medium | 10–14 |
| 3 | **`kuvo-install` and `install --status/--new`** (§4.1): every verdict, the engine from the release, `rehome --new` without the app's folder. | box | each verdict from fixtures; `--new` in a demo root with a test release; a cut-short install made again; Linux: `--new` as a machine's start | medium | 8–12 |
| 4 | **`rehome --run`, the upgrades and the database in staging, `--restore`** (§4.2, §5): the keeper's steps ported; an inventory of every preference key and `S` file the Swift app reads as data, each marked "box upgrade" or "dropped, said"; the engine database migrated in staging; the lock check on `S`'s database; `served.json`'s rule; pacing; `owed: passwords`. | box | fixtures from 0.7.2 (with its real 2.0.32 database), beta.1, a 0.6 build and `S/box`, moved by `--run` with a stand-in `kuvo-keys`; a stop at each step, then resume; a held database refuses; `--restore` gives back `S` byte for byte | **high** (data) | 20–30 |
| 5 | **The desktop app's part** (§3): running the installer and drawing its lines, `kuvo-keys` in the bundle, the System Settings panes, dev builds only attaching. | gpui | the install run against a stand-in installer script; a dev build refuses to install | medium | 6–10 |
| 6 | **Packaging the desktop app**: the `run.kuvo.code` bundle, signing, notarization, `box-release` inside, Sparkle embedded, DMG, appcast continuity. (Possibly another issue's; it's needed here.) | scripts, CI | `codesign --verify --strict` on a signed build; it carries the release; the feed's checks | medium | 12–18 |
| 7 | **UI** (drafts first, light and dark): first-run states (setting up, moving with its step, couldn't move with what to do, Try Again, moved back), Settings › This Mac's Box (#333 piece 8's content), permissions for the helper, `two`; the phone draws `moving`. | gpui, phone | the stand-in box's states; before-and-after looks | medium | 10–14 |
| 8 | **What only the Swift app did for this Mac** (§1's last item): the phone's Mac routes (`MAC_APP_ROUTES`), adding and repairing machines over SSH, `machines.json`. **Gates 1.0.** | box, gpui | sized after #712's survey | high | unsized |
| 9 | **Rehearsals and docs**: §5's cases there and back in the rehearsal account; `uninstall.md`, `privacy.md`, `settings.md`, `troubleshooting.md`, `footprint.md`; the changelog. | all | the checklists | medium | 8–12 |

- **Order:**
  - 0 first;
  - then 1 → 2 → 3 → 4 (box), with 5 and 6 alongside;
  - 7's drafts can start now;
  - 8 needs #712's list;
  - #693 pieces 5 and 11, and #635, come before 9;
  - 9 last.
- **Total:** about 95–130 h, plus piece 8.

**Risks:**

1. **Sparkle across an executable change.** Piece 0 checks it. If it fails, the stepping stone
   (§5) is the fallback.
2. **`kuvo-keys`'s identity:** a nested tool with the app's identifier. Piece 0 checks it; the Rust
   port is the fallback; asking once per item (about five prompts, said first) is the last resort.
3. **Migrating 0.7's engine database in staging.** It's opencode's own migration, run on a copy.
   A failure refuses the move with words, and `S` is untouched.
4. **The upgrades' inventory missing something** a 0.7 user kept only in the Swift app's
   preferences. Piece 4's inventory and the 0.7.2 fixture are the guard; what's dropped is said.
5. **Nothing runs while an `app-07` move is refused.** §4.2's pacing and words are the guard, and
   question 7 asks whether that's acceptable.
6. **The legacy keychain is "effectively deprecated"** (TN3137), as #333 noted.

## 9. Questions only the user can answer

1. **Who keeps this Mac's box?**
   - *Recommend: your leaning, with the box doing the installing.* The helper (Kuvo Code Box) is
     the login item. The desktop app has the box install it once, from the release it carries,
     and the box updates it after that. The app never runs the box itself.
2. **The helper stays Swift, in its own small package (`mac/helper/`, with the one-time
   `kuvo-keys`), or is rewritten in Rust?**
   - *Recommend: stays Swift.* It's 2,000 lines that are tested and verified on real macOS. A
     rewrite costs 15–25 h and new risk for no user-visible change.
3. **From 0.7: straight to the desktop app (the box moves itself), or through a last Swift release
   that moves first?**
   - *Recommend: straight.* No more Swift UI to build and throw away. A stepping stone still needs
     the straight path for anyone who skips it.
4. **Is 1.0 blocked on everything the Swift app did for this Mac** (§8 piece 8: adding and
   repairing machines, the phone's Mac routes), or may 1.0 ship saying plainly what's not there
   yet?
   - *Recommend: blocked on adding machines and the phone's routes.* Without them, a 0.7 user
     loses features they use.
5. **Will 0.8.0 (Swift, keeper, flag off) ship before the desktop app?**
   - *Recommend: no.* The `app-box` case then exists only on your own Macs, as a support path.
6. **Name:** the desktop app's window and menu say "Kuvo". Sparkle installs it at the old path,
   `/Applications/Kuvo Code.app`. Keep that name, or rename the bundle (and the helper, "Kuvo Code
   Box")?
   - A rename touches the Dock and Spotlight, the helper's `AssociatedBundleIdentifiers` grouping
     in Login Items, the bundle path the box keeps (`run/app.json`), and the docs' screenshots.
   - It's brand, so it's yours; drafts come with piece 7.
7. **On a 0.7 Mac nothing runs until the move succeeds** (it never had a box). Each refusal says
   what to do, with Try Again. Is that acceptable, or should the box be able to run in the old
   folder meanwhile?
   - *Recommend: acceptable.* After piece 4 the refusals left are rare and fixable (space, a
     locked Keychain, being offline, 0.7 still open). Running in the old folder would need the
     helper to run outside `K`, which its security rule refuses (PROTOCOL.md:6691).
8. **Must going back to 0.7.2 be possible?**
   - *Recommend: yes, for 30 days, as §5 says:* the 0.7 folders put back as they were, with work
     done since kept aside, not carried back. It's cheap, since the kept copy is already there.

## 10. Review

One `reviewer` pass on the first version. What it found, and what changed:

- **Blocker: every 0.7 move would be refused for its database's schema.** 0.7.2 runs engine 2.0.32,
  and `rehome` knows only 2.2.6's schema (`database.ts:19`). Now the pinned engine migrates the
  staged copy, isolated, before Rewrite (§4.2); there's a 0.7.2 fixture with its real database,
  and piece 4 is resized.
- **Blocker: nothing runs the box while a move can't happen** (no keeper, and the helper runs only
  `K`). Now §4.2's pacing (user-started tries, no cap, plain words), refusals turned into steps,
  and question 7.
- **Blocker: going back wasn't true.** `--back` restores a keeper layout and a migrated database
  that 0.7 can't read; nothing settled `owed: agent`; a round trip stranded the Mac. Now
  `--restore` puts back the untouched kept copy, removes the helper's agent, and sets `K` aside;
  there's a `back` verdict with Move Again, and question 8.
- **The 0.7 upgrades were under-counted** (three of about thirteen, plus keeper builds' unsent
  queues). Now piece 4 starts with an inventory, each item kept or "dropped, said".
- **The Keychain copies trusted a helper not yet in `K/bin`.** Now they trust the release's
  helper, unpacked first (§4.2 step 3).
- **An unpacked release with a helper bundle under `Resources`** went against the bundle layout and
  needed a new seal check. Now the app carries the pack as data, as today; `kuvo-install`
  unpacks it. The old question 4 is gone.
- **The Rust Keychain port** was high-risk temporary code. Now `kuvo-keys` is a tiny Swift tool
  from the helper's package, with the app's identifier; the port is the fallback. It's removed by
  your word, not on a date.
- **Case C's launchd details were wrong** (`BundleProgram` names `Kuvo Code`; `KeepAlive`; a
  missing plist). `--box` and unregistering are out of the app; the box boots the label out, and C
  is a support path.
- **A running 0.7 engine wasn't detected.** Now there's a lock check on `S`'s database at Plan and
  before Clear.
- **Real data:** dev builds only attach; spikes needing the real ID run in the rehearsal account.
- **Piece 8 hid a ship gate** (machines over SSH, `machines.json`). It's named as gating 1.0, with
  question 4.
- **Smaller:**
  - upgrades run in staging, after Clone;
  - `owed: passwords`;
  - 0.5/0.6 fixtures;
  - §6's missing files and the catalog's source;
  - the missing verdicts and rows;
  - no preflight for Files & Folders or Local Network;
  - the rename's costs;
  - the order (helper before release);
  - the calibration's weight;
  - the link key claim (0.7 likely has none);
  - Linux attaching as a machine's box;
  - Open at Login inherited.
- **Not checked by anyone:**
  - Sparkle 0.7.2's behaviour;
  - opencode migrating a 2.0.32 database to 2.2.6;
  - whether users' 0.7 Macs hold `phone-link` items;
  - the sandbox's walls around `K/updates/install`.
