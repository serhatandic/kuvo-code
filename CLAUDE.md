# Kuvo Code

A native macOS harness for coding agents that works with any model. It runs the opencode engine (`@opencode/cli`), unmodified, as a private server, and is the interface around it: sessions, reviewing changes, a side panel with files, terminals and a browser the agent can use, and a usage tracker in the menu bar.

## The architecture: equal boxes, and clients (strict)

Kuvo Code is a small distributed system. Build every feature for that system, never for the Mac alone.

- **Every computer is an equal box, the Mac included.** This Mac and each machine run the same things: the engine with its sessions, bots, coding agents, group chats, wake-ups and the agent's browser. Each box keeps its own settings and keys, and keeps working with no client connected. A machine has its keeper for that, and this Mac's box runs in the background with Open at Login. The Mac is no different from a machine.
- **Boxes talk peer to peer**, end to end encrypted through the relay (`Packages/KuvoLink/PROTOCOL.md`, "Peers"). Agents on one box write to agents on another, and no box needs another one to do its own work.
- **Clients connect to boxes.** The Mac app and the iPhone app are both clients of every box, the Mac app's own box included. They show what a box has and change it, and hold none of its state.
- **So every feature lives on the box**: in the engine and the box's own code, `Packages/Box` (the link in `src/link`, the coding agents' bridge in `src/agents`, what they share in `src/shared`). `scripts/build-box.sh` builds the link into `kuvo-link.js`; never edit that built file (CI fails if it differs). It works on every box, including a machine with the Mac closed, and every client can reach it.
  - Never build a feature only into the Mac app, or only for this Mac's box, or so it works only through the Mac's SSH connection.
  - Where a box can't do something yet, say so plainly in the UI and in your report, rather than quietly making the Mac a hub.
  - **Box code runs on both macOS and Linux.** This Mac's box and each machine's, on Linux or a Mac, run the same code (`IS_MAC` is the box with the app next to it, not the system), so anything on the box side works on both. Prefer code that's the same on both (Node and Bun APIs that behave alike); where they differ (file watching, processes and `/proc`, paths, the keeper, the shell, the Keychain versus files), handle both explicitly, in one place, and test each. Check a box change on a Linux machine too (a test folder of your own on devbox) before calling it done.

### Logic goes in the box, never in a client (strict)

The default for all new code that isn't drawing is the box, `Packages/Box`. This rule has no exceptions unless the user agrees to one. In November 2026 a review found 32 to 45 hours of work to move out of the Mac app, and features that failed whenever the app was closed. That must not build up again.

**The end result to keep in mind:** clients as thin as possible, so it's almost trivial to add new Macs and Linux machines to the system, and easier to build Windows and Linux clients later. When two designs both work, pick the one a new client in another language would have less to rewrite for.

- **A box means every box: a Mac's and a Linux machine's.** Linux gets its share wherever it applies, not only the Mac's box. What can't apply there is said plainly, with the reason, in your plan and report.
- **A box decides, a client draws.** Anything about sessions, agents, accounts, models, settings, files, git, processes, the network or what's allowed belongs in the box, this Mac's box included. A client reads the box's state, changes it through a route, and draws the result.
- **The box states facts, not finished views.** It says "this session is running, and this bot oversees it", not "6 sessions at work". Clients work out what they show from that state, and what Mac and phone both work out goes in the shared client code, `Packages/KuvoClient`, so they can't differ. Only views go there: a rule that changes behavior or data is still the box's. That code is Swift, which a Windows or Linux client couldn't reuse as it is, so keep it small and simple, and describe what's needed in `PROTOCOL.md` so another client can do the same.
- **Only this stays in a client:** drawing and layout, animation, window and selection state, the side panel's browser, and what only an installed app can do (updating itself, login items, Mac notifications). The keeper starts and watches the box, and takes on no features.
- **Before writing logic in Swift, ask three questions.** Does it work with this client closed? Does it work on a Linux machine? Can the phone use it without a second copy? Any "no" means it goes in the box.
- **Never add:**
  - a route that only the app answers (`toApp` in `link/mac/relay.ts`, `PhoneLink.swift`);
  - a copy of box logic in a client, or in `kuvo-browser.js` and the keeper side by side;
  - client logic "for now", "until the box can do it", or because the app is quicker to change.
- **Logic already in a client:** don't extend it. Move it to the box as part of your change if that's small. If it's bigger, make the smallest fix, say so in your report, and add it to the list of what's left to move.
- **If something truly can't be on the box,** say why before you build it, and the user decides. Plans and briefs name where each new piece of logic lives.

## UI and UX come first (strict)

What people see and touch is the most important part of Kuvo Code. Never trade its quality away, and never let the machinery behind a feature crowd it out.

- Design the UI of a change with as much care as its internals, in the same task. Never a quick sketch to get it out of the way and polish later: polishing it afterwards costs the user's time.
- Before you build a screen or a control, look at how the app already draws the same kind of thing (`KuvoCode/Design`, the views beside it, the website's screenshots) and match its materials, spacing, wording, states and motion.
- Work through every state: empty, loading, failed, long text, many items, a narrow window, light and dark, larger text, and VoiceOver.
- See it yourself in a demo copy where you can, and look at it as the user will. Not having seen it doesn't hold up a merge (see "Carry work to main in checkpoints"), but say so in your report.
- **UI work starts with drafts to pick from, always.** Before building any screen, control or visible change, draft two or three options (mocks or renders, light and dark) with your recommendation and why, and let the user pick. Build the picked one; meanwhile build only what doesn't depend on the choice. This holds even when one option seems obvious. It's for new things: a bug fix that restores an existing design needs no drafts.
- **Look at how the best do it first.** Before designing a feature or a screen, study how the leading products handle the same thing (other agent apps like Codex, Claude Code and Cursor, and the best of their kind, like GitHub, Linear or Apple's own apps). Bring what you found with your drafts: what you borrow, and where Kuvo Code does it differently and why.
- When the machinery makes the right UI hard, change the machinery. Don't bend the UI around it.
- **The right panel is only for common tools**: the browser, terminals, files, and Changes for coding sessions. A feature's own view goes where it belongs, never in a new panel tab: a popover or sheet on the conversation (like Artifacts), or a page in Settings.

## Reviews at checkpoints

Have your work reviewed by reviewer agents by default, without being asked.

- At each checkpoint (a finished feature or phase, and before a merge to main or a release), start independent reviewer agents on everything since the last review. They look at correctness first, then the UI and UX against this file, then what could be simpler.
- Every review also checks each change to a client against "Logic goes in the box, never in a client". Logic in the wrong place counts as a bug and blocks the merge, even if it works.
- Split a large change by area, one reviewer each, and give each the commits and what the change is for.
- Sort what they find. Fix what users would hit first, then the minor problems. Skip only edge cases no one would hit. Add a test for each fix where it can be tested.
- Say in your report which reviews ran, and what they found and you fixed.

## When the user isn't around

The user isn't always available, and work goes on without them. Never stop and wait on a question box (it holds the whole session until someone answers).

- Keep a running note of every decision that needs the user: design choices (with the options mocked), brand, wording, pushes to kuvo-web, anything that needs a permission prompt or the user at the Mac. Say for each what you recommend and why.
- Meanwhile build everything that doesn't depend on the answer, and pick the work order so the user's choices come last.
- **Never build a waiting decision's "recommended side" when it costs the user anything**: an ask, a refusal, an extra step, a limit, or a change to how something they already use behaves. Those wait for the answer. Build around them, and say plainly in the list that they aren't built.
- Hand the whole list over at once, in your report to the user or to the session coordinating yours, with the paths to the mocks, so nothing is lost when the user comes back.

## Subagents: two at a time

Each session runs at most 2 subagents at once: workers, reviewers, and any that your subagents start themselves all count. Start another only when one finishes. This caps the subagents inside one session, not the number of sessions: several sessions can run side by side, each with its own two. A review split by area runs two reviewers at a time, and the rest wait for a free slot.

## Never kill by pattern (strict)

A pattern matches the user's other apps and other sessions: on 2026-11-07 one `pkill` with a stray option took down two other sessions, the box's link, Kuvo Code's SSH connections and the user's browser tabs.

- Never use `pkill`, `killall`, `pgrep … | xargs kill`, `kill $(pgrep …)`, or the same through a script, a tool or a subagent. That includes a pattern that looks narrow.
- Kill only a process you started yourself, by its PID (save `$!`, write a pid file) or by a process group you created (`set -m`, `setsid`), never the one you were started in. `scripts/heavy.sh` stops what its job started (what stays in the job's process group) when the job ends or is stopped, so there is nothing left for you to clean up by name. If something is still running that you didn't start, leave it and report it.
- On macOS every option goes before the pattern, in `pgrep` too: BSD stops reading options at the first pattern and takes everything after it as more patterns.

## Tests: what users rely on (strict)

- **Test scenarios, not the code's insides.** A test answers this: if someone refactors this or changes something nearby, will it catch a break a user would notice? Assert what the app shows, keeps or does, never which functions ran.
- **Use the real components.** Stub only what's outside the app or unpredictable: the engine's HTTP API, SSH, the network. Never write a test that only proves a stub returns what it was given.
- **A bug fix starts with a test** that fails on the old code for the right reason. Then fix the cause, not the symptom. Never loosen a test to make it pass.
- **A test must go the way the real thing goes.** Send events through the window, as AppKit routes them, not straight to our own handler. A test that skips the system's part can pass while the bug is still there.
- **Reproduce a user's bug the way they saw it where you can**: in a demo copy, or with their logger or steps. A fix to a nearby test is not a fix to their bug. Once the fix completes its review loop it goes to local main, and the user confirms it in their own copy (see "Carry work to main in checkpoints"). Until then, report it as merged and not yet seen by the user, not as fixed.
- **Keep tests deterministic.** No sleeps, timeouts or retries, and no device clocks. A flaky test gets fixed, not retried. Each test runs alone, in folders of its own.
- **Skip low-value tests**: trivial getters, wiring, and edge cases no one would hit. A visual nitpick gets a look before and after, not a UI test.
- **Running them:** Run quick, targeted box and bridge tests locally with
  `scripts/test-box.sh [box|bridge|all] [extra test args]`. For the full Mac app, package, box
  and bridge suites, commit the work and run `scripts/ci-branch.sh --wait` on GitHub; only
  committed changes are tested. The helper pushes the work branch to `origin` as a `ci/` branch
  over SSH. The phone has no CI: run its tests locally through `scripts/heavy.sh phone` (see
  `CONTRIBUTING.md`), but only a run that boots a simulator takes a `phone` slot: build the phone
  app (and anything else that boots no simulator) with the phone's `scripts/build-app.sh`, which
  takes `scripts/heavy.sh phone-build`, the build lane, so it never queues behind test runs.

  Never drive the Mac app's window from tests, because it takes over the user's keyboard and mouse.

## The same care for every task, start to finish

Quality slips as a session goes on. The context fills up, hours pass, a task looks small or familiar, and corners get cut. Watch for this in yourself, and don't let it happen.

- Give the last task of a long session the same care as the first. Read the code before you change it, test what you changed, look at the UI, run the reviews, and check the docs and the changelog.
- No task is too small for the rules in this file. A one-line fix still gets its test, its docs check and a look in the app.
- When you notice yourself skimming, guessing, or about to report something done that you haven't checked, stop and do it properly. If the context is too full to work well, say so and suggest a fresh session. Never lower the bar.
- **Where the leading products already settled a behavior, match them.** This covers what a mode does, what asks and what's refused, and how a common control works, as in Codex, Claude Code and Cursor. Before building, show it side by side: ours, theirs, what we'll do. Doing it differently is a question for the user, never a default. (The sandbox's Full Access kept walls and exceptions that neither has, and the user had to catch it.)
- **Fresh session at each phase.** When a phase ends, write a handover note (what's done, what's open, the decisions) and ask the coordinating session or the user for a fresh session to carry on the next one. Within a phase, auto-compact keeps the context in check.
- **Check against the user's goal, not only the spec.** Before reporting a list of decisions or a finished piece, ask of each item whether it gets in the way of what the user said they want (for agents: working on their own while the user is away). Anything that does goes to the top of the report.

## Keep what Kuvo Code leaves on people's computers contained (strict)

Kuvo Code must never spread files across the user's Mac or their machines. Everything it needs is packaged, kept in its own folders, organized inside them, and gone when those folders are deleted.

- **On the Mac**, only Kuvo Code's own places: `~/Library/Application Support/run.kuvo.code` (data, engines, downloads for machines), `~/Library/Caches/run.kuvo.code`, `~/Library/Logs/Kuvo Code`, its `WebKit` and `HTTPStorages` folders, its preferences and its keychain items. Temporary files go in the app's temporary folder and are deleted once used. The one exception is SSH's connection sockets in `/tmp/kuvo-ssh-<uid>`, which need a short path. Never write to the home folder at large, shell profiles, `/usr/local` or other apps' folders.
- **On a remote machine**, everything goes in `~/.kuvo-code`: the engine, the browser, helpers, run state, trash. Never install system packages or ask for `sudo`, never write dotfiles or caches in the user's home, `/tmp` leftovers, crontabs or services. The one exception is a single `@reboot` line in the user's crontab, tagged `# kuvo-code`, that starts the engine again after the machine restarts, and on a Mac its login agent `~/Library/LaunchAgents/run.kuvo.code.machine.plist` beside it (only for the real `~/.kuvo-code`, never a test's); **Uninstall from <machine>…** takes them out (Remove only forgets the machine on this Mac), and `uninstall.md` says how to. Bring dependencies along instead (the browser brings its own libraries and fonts). On a Mac, Chrome gets `CFFIXED_USER_HOME` as well; macOS still records its last run in the real `~/Library/Preferences/com.google.chrome.for.testing.plist`, which nothing we set stops, so **Uninstall from <machine>…** takes that key out. Anything Kuvo Code starts there runs with its folders pointed inside `~/.kuvo-code` (the engine's `XDG_*` folders; the browser gets a home of its own in `~/.kuvo-code/browser/home`) and starts from a folder inside it, so nothing relative lands elsewhere. Check after a change: list what's new in the machine's home folder and `/tmp`.
- **Except the coding agents' own programs** (Claude Code, Codex, Grok), on the Mac and on machines (the user, 2026-10-23: "break the containment on machines for this"). Kuvo Code uses the ones on the computer's PATH (a machine's login shell's), and **Install** and **Update** run their makers' official installers and updaters (`curl -fsSL https://claude.ai/install.sh | bash`, `https://chatgpt.com/codex/install.sh`, `https://x.ai/cli/install.sh`; `claude update`, `codex update`, `grok update`, or the Homebrew or npm that owns an install), with the machine's own folders, so they put them where they always do (`~/.local/bin`, `~/.local/share/claude`, `~/.codex`, `~/.grok`; Grok's installer adds a PATH block to the shell profile). Kuvo Code never installs copies of its own of them, and only when you click Install or Update. Their sign-ins on a machine stay in `~/.kuvo-code/agents`. Cursor's SDK and Antigravity's agent still come with Kuvo Code, in its folders.
- **Organized inside**: a folder per kind (`engine/<version>`, `browser/<build>`, `bin`, `run`, `keys`, `bots`, `groups`, `trash`), older versions cleaned up, what's running recorded in `run/`.
- **Removing the folders removes everything**: `uninstall.md` and `privacy.md` list them all; anything new keeps that true and updates them.
- **Tests and demo copies too**: they use folders of their own (`KUVO_DEMO_MACHINE_ROOT`, `~/.kuvo-code-test`), keep test files inside them, and clean up what they leave on a machine or the Mac when done. A home folder of a test's own doesn't keep a script from `crontab` or `launchctl`, which are the account's: stand-ins come first on its PATH, and a run that changes the real ones fails (`AccountUntouched`, `scripts/test-app.sh`).

## Docs must match the code (strict)

The website and docs live in a separate repo, **kuvo-web**, checked out next to this one (`../kuvo-web`). Kuvo Code's docs are Markdown files in `src/content/docs/code/`, ordered by `src/lib/docs-nav.ts`, and its landing page is `src/pages/code/index.astro` (the site also hosts Kuvo Box under `/box`, and kuvo.run's own page is `src/pages/index.astro`).

**A change that affects what users see, run or rely on is not done until the docs match it.** This rule has no exceptions for "small" changes:

- Update the docs in the same task as the code change, never "later" and never as a follow-up suggestion.
- Before you report a task as finished, check every doc page mapped below for the files you touched, and say which pages you updated, or that you checked and none needed changes.
- Never document behavior you haven't confirmed in the code. If the docs and the code disagree, the code wins: fix the docs and mention the mismatch.
- If `../kuvo-web` isn't there, stop and tell the user. Don't skip the docs silently.
- Commit docs changes in kuvo-web separately from code commits here, with a message that says what changed for users. They go to kuvo-web's local main when the work they describe is done, as its code goes to local main here. Pushing kuvo-web deploys kuvo.run, so push only when the user says so.
- Set `updated:` in the frontmatter of every page you change to today's date.
- **Keep the docs short.** Say what people do and what they see, in a few sentences per topic. Leave out implementation details, exact numbers and limits, internal file formats, every menu item and edge case, and tables of settings that the app already labels. When in doubt, cut it.

User-facing means, for example: anything in the window, the side panel, the menu bar's usage panel, menus, settings or keyboard shortcuts; what the agent can do (tools, browsing, permissions); file and folder paths; environment variables users set; requirements (macOS version, hardware, downloads); install, update and uninstall steps; what Kuvo Code stores or changes on the user's Mac; and the network connections it makes.

### Where each change is documented

All paths on the right are in `../kuvo-web`.

| When you change… | Check these files |
| --- | --- |
| `KuvoCode/App/KuvoCodeApp.swift` (menus, shortcuts, the update menu item) | `src/content/docs/code/shortcuts.md`, and the pages that name those commands: `sessions.md`, `panel.md`, `changes.md` |
| `KuvoCode/App/AppModel.swift`, `AppInfo.swift` (starting the engine, data folders, the browser tools' config) | `src/content/docs/code/architecture.md`, `privacy.md`, `installation.md` (First launch), `troubleshooting.md` |
| `Packages/OpenCodeKit/Sources/OpenCodeKit/Engine/*` (engine download, checks, private server) | `src/content/docs/code/installation.md`, `architecture.md`, `privacy.md`, `troubleshooting.md`; also this repo's `README.md` (How it works) |
| `KuvoCode/Views/SidebarView.swift`, `MainView.swift`, `TitleBar.swift`, `ProjectEditor.swift`, `Views/Session/*` except the Changes files (projects, tabs and their status, composer, modes, permissions, questions, transcript) | `src/content/docs/code/sessions.md`, the feature rows in `src/pages/code/index.astro` |
| `KuvoCode/Stores/Attachments.swift`, `Views/Session/AttachmentViews.swift` | `src/content/docs/code/sessions.md` (Attachments), `privacy.md` (the `Attachments` folder) |
| `KuvoCode/Views/Session/MermaidView.swift`, `KuvoCode/Resources/mermaid-page.html` (diagrams in a Markdown file's preview) | `src/content/docs/code/panel.md` (Files), `architecture.md` (third-party pieces) |
| `KuvoCode/Stores/ProjectChanges.swift`, `ReviewComments.swift`, `Views/Session/ChangesPanel.swift`, `DiffView.swift` | `src/content/docs/code/changes.md`, the Review feature on `src/pages/code/index.astro` |
| `KuvoCode/Stores/Utilities.swift`, `BrowserHistory.swift`, `PanelSettings.swift`, `Views/Utilities/*` (tabs, new tab page, files, terminal, browser, Settings › Panel) | `src/content/docs/code/panel.md`, `privacy.md` (the `Browser` folder, website data), `uninstall.md` |
| `KuvoCode/Stores/Machines.swift`, `SessionCopies.swift`, `App/AppModel+Machines.swift`, `Views/MachineForm.swift`, `MachineStatusViews.swift`, `Views/Settings/MachinesSettings.swift`, `Packages/OpenCodeKit/Sources/OpenCodeKit/Engine/RemoteEngine.swift` (remote machines: adding them, their engines over SSH, their projects' files, git and terminals) | `src/content/docs/code/machines.md`, `architecture.md`, `privacy.md`, `troubleshooting.md`, `uninstall.md`; also this repo's `README.md` (How it works) |
| `KuvoCode/Stores/BrowserAgent.swift`, `BrowserToolServer.swift` (the agent's browser tools) | `src/content/docs/code/browsing.md`, `architecture.md`, `privacy.md` (connections on `127.0.0.1`) |
| `KuvoCode/Stores/BrowserAsks.swift`, `Views/BrowserAskCard.swift`, `Design/AgentPointer.swift` (sign-in, code and step cards, the agent's pointer) | `src/content/docs/code/browsing.md` (Signing in), `sessions.md` (cards above the composer), `privacy.md` (what's kept of a sign-in), `panel.md` (Passwords) |
| `KuvoCode/Resources/kuvo-browser.js`, `Packages/Box/src/link/browser/`, `Stores/MachineBrowser.swift`, `MachineBrowserInstaller.swift`, `Views/Utilities/MachineBrowserPane.swift`, `scripts/browser-runtime.py` (the browser on a machine: its keeper, tools, live view, the box's own setup of it) | `src/content/docs/code/machines.md`, `browsing.md` (On a machine), `panel.md`, `privacy.md` (what it keeps in `~/.kuvo-code`, Chrome for Testing and Rocky Linux downloads), `uninstall.md`, `shortcuts.md`; this repo's `CONTRIBUTING.md` (The browser on a machine); bump `KEEPER` with every change to its host side |
| `KuvoCode/Stores/Bots.swift`, `BotTemplates.swift`, `BotGroups.swift`, `Views/BotEditor.swift`, `Packages/OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift`, `Packages/KuvoLink/Sources/KuvoLink/Resources/bot-words.json` (bots, templates, Kuvo Code's own personalities and what a bot is told, which every box reads; wake-ups, pausing, group chats) | `src/content/docs/code/bots.md`, `privacy.md` (the `bots` folders); a template change in `bot-words.json` also goes to kuvo-web's `src/lib/bots.ts`, which copies them |
| `KuvoCode/Stores/Moves.swift`, `MachineGroups.swift`, `GroupChats.swift`, `Packages/Box/src/agents/groups/*` (Move to Computer for bots, chats and group chats; group chats that live on a machine and run in its agents bridge) | `src/content/docs/code/bots.md`, `machines.md`, `sessions.md` (Move to Computer), `privacy.md`, `uninstall.md`, `architecture.md`; this repo's `README.md` (How it works) and `CONTRIBUTING.md` (`scripts/group-vectors.sh` after changing the group chat rules on either side) |
| `KuvoCode/Stores/Integrations.swift`, `IntegrationKeys.swift`, `Views/Settings/IntegrationsSettings.swift`, `Packages/OpenCodeKit/Sources/OpenCodeKit/Engine/Launcher.swift` (integrations, their keys, `kuvo-npx`) | `src/content/docs/code/integrations.md`, `privacy.md` (keys, the `integrations` folder, connections), `uninstall.md` (Keychain items), `architecture.md` (third-party pieces), `settings.md` |
| `KuvoCode/Views/Providers/*`, `Stores/Catalog.swift` (accounts, sign-in, models) | `src/content/docs/code/accounts.md`, `sessions.md` (Model and effort) |
| `KuvoCode/Views/SettingsView.swift`, `Views/Settings/GeneralSettings.swift`, `AppearanceSettings.swift`, `StorageSettings.swift`, `GitSettings.swift`, `ArchivedSessionsSettings.swift`, `ShortcutsSettings.swift`, `KuvoCode/Design/Look.swift` (Settings' sidebar and pages, appearance, storage, git, worktrees, archived sessions) | `src/content/docs/code/settings.md`, and the page that covers a page: `accounts.md`, `customize.md` (Agents, Permissions, MCP Servers, Skills, Commands, Engine), `panel.md` (Panel, Browser, Passwords), `machines.md`, `usage.md`, `troubleshooting.md` (Engine), `shortcuts.md` |
| `KuvoCode/Views/Settings/BrowserSettings.swift`, `PasswordsSettings.swift`, `KuvoCode/Stores/Passwords.swift` (the panel browser's settings, website data and saved passwords) | `src/content/docs/code/panel.md`, `settings.md`, `privacy.md`, `uninstall.md` |
| `KuvoCode/Views/Settings/*`, `KuvoCode/Stores/EngineConfig.swift`, `BoxSkills.swift` and the box's Skills in `Packages/Box/src/link` (the engine's settings file, skills from GitHub) | `src/content/docs/code/customize.md`, `privacy.md` (the settings file and skills folder, GitHub connections), `uninstall.md` |
| `Packages/UsageKit/*`, `KuvoCode/Stores/UsageAccounts.swift` (the menu bar usage panel) | `src/content/docs/code/usage.md`, `privacy.md` (the usage item, the `Usage` folder), `uninstall.md`; also `Packages/UsageKit/README.md` (What's different from upstream) |
| `KuvoCode/Stores/Updates.swift`, the update feed in `scripts/build-app.sh` | `src/content/docs/code/installation.md`, `privacy.md` (connections) |
| `Config/App.xcconfig`, `KuvoCode.entitlements`, the Xcode project's packages, `scripts/*` | `src/content/docs/code/installation.md` (requirements, Build from source), `architecture.md` (third-party pieces); this repo's `CONTRIBUTING.md`; rerun `./scripts/third-party-licenses.sh` when packages or copied code change |
| `KuvoCode/Stores/PhoneLink.swift`, `Views/Settings/PhoneSettings.swift`, `Packages/KuvoLink/*` (the phone link and the machines' bridge; switched off for users until the iPhone app ships, so no docs yet) | When it's switched on: a new phone page, `privacy.md` (`phone-link.json`, the `.phone-link` Keychain items, the relay connection, a machine's `~/.kuvo-code/run/link.json` and `bin/kuvo-link.js`), `uninstall.md`, `settings.md` (Phone), `machines.md`, `architecture.md` |
| Files, folders, defaults or website data Kuvo Code creates on the user's Mac | `src/content/docs/code/privacy.md`, `uninstall.md`, `troubleshooting.md` |
| `scripts/icon.py`, `KuvoCode/AppIcon.icon` (the app icon) | `public/code/icon.png`, `icon-dark.png`, `public/code/apple-touch-icon.png` and `public/code/og.jpg` (redraw with `python3 scripts/og-image.py code`) must show the same mark, and so must this repo's `docs/images/icon.png` (the README) |
| The version number | `src/lib/site.ts` (`code.version`), and `CHANGELOG.md` here |

Screenshots in `kuvo-web/public/code/screens`, and the README's `docs/images/screenshot-light.webp` and `screenshot-dark.webp` here (the same shot as the website's), show the real app. If a UI change makes one visibly wrong, tell the user it needs recapturing. They're captured from a separate demo copy of the app (built with `APP_BUNDLE_ID=run.kuvo.code.demo` into `build/DemoDerivedData`, launched with `KUVO_DEMO_USAGE=off` and a `KUVO_DEMO_NAME`) on a sample project, with the `KUVO_DEMO_*` launch variables listed in `CONTRIBUTING.md`, so the user's own app, sessions and logins are never touched and nothing personal shows. Sign the demo copy with the team (leave out `CODE_SIGN_IDENTITY=-` and `DEVELOPMENT_TEAM=`, so the git-ignored `Config/Signing.local.xcconfig` signs it), never ad-hoc. macOS takes each ad-hoc build for a new app and asks again for the Desktop and the Keychain, and a launch nobody is there to answer hangs on that prompt. Capture the window only (`screencapture -l`), never the full screen. `crop-usage.webp` is the Bars view rendered with sample numbers, not a capture.

## The iPhone app is a client, like the Mac app

**The phone is just another client, like the Mac app, and it gets every feature the Mac app has,
wherever it makes sense on a phone.** Both are clients of every box: this Mac's and each machine.
So anything you can see or do in the Mac app, you can see or do from Kuvo Code for iPhone
(`../kuvo-code-ios`) on any box, with the Mac's window closed too. That covers sessions, bots,
group chats, the panel's tools, settings, accounts, what agents ask you and usage. A feature isn't
done until the phone has it.

When you add or change something people use:

- **The box's side**: what a client reads or does is a route. It goes in
  the box's link, `Packages/Box/src/link` (routes in `server/router.ts`, their answers' shapes in
  `src/shared/routes`), so it works on every box, and where this Mac's box answers it differently,
  in `KuvoCode/Stores/PhoneLink.swift`. Write it up in
  `Packages/KuvoLink/PROTOCOL.md`. Never build a feature that only the Mac app's own code path
  can reach.
- **Tell the phone session, in the same task.** Usually a session is working on the phone app
  ("Mobile App Development"; find it with ListAgents or the session list). Send it:
  - what changed and how the Mac app shows it;
  - the routes and their shapes (fields, dates, streams, errors);
  - the commit;
  - whether the routes are final or still moving.

  Don't edit its code. If no session is working on the phone, build the phone's side yourself,
  the same way the Mac's is built.
- **Leave out only what has no place on a phone**: window layout, Mac-only settings, the Mac's
  own apps. When you report the task, say what you left out and why.

### It shares the Mac's look

Kuvo Code for iPhone (`../kuvo-code-ios`, closed source) draws its code blocks as the Mac does
(`KuvoCode/Design/CodeBlockStyle.swift`; the phone's `CodeStyle.swift` is its own version, for
touch and the phone's text size) and its quote cards in its own way. When you change those here,
or how the conversation, cards, composer or sidebar look, change the phone's too (or tell the
session working on the phone), so the two stay one app. The same goes for the app icon: the phone's
`KuvoCodeMobile/AppIcon.icon` is a copy of `KuvoCode/AppIcon.icon`.

What both apps share as code, not copies, is in `Packages/KuvoClient`, which the phone builds
against from this checkout as it does OpenCodeKit: `ClientText`, the rules for what a message says
(picture names, web links, the site a link is on, a field's own typing), `ClientAccounts`, and
`ClientDesign`, the look both draw with (surfaces, sizes, the loader, the bots, code colors, math
and more). Its README says what belongs there.
A change to it is a change to both apps: run the Mac and package suites in CI and the phone's tests locally.

## Upstreams stay up to date

Kuvo Code is built on other projects, and keeping up with them is part of every task, without being asked. **At the start of each conversation, before the first task, check each upstream below for anything new**, and tell the user what you found.

### The opencode engine

Kuvo Code runs one pinned build of `@opencode/cli`. A new opencode release brings model and provider support, fixes and new agent features, so the app should move to it quickly.

- **Where it's pinned**: `OpenCodeEngine.version` in `Packages/OpenCodeKit/Sources/OpenCodeKit/OpenCodeKit.swift`, and the tarball URL and npm `integrity` in `Packages/OpenCodeKit/Sources/OpenCodeKit/Engine/EngineInstaller.swift`, for the Mac's build and, in `EngineRelease.linux(machine:)`, the two Linux builds remote machines run (`cli-linux-x64`, `cli-linux-arm64`) and, in `EngineRelease.darwin(machine:)`, Intel Macs' as machines (`cli-darwin-x64`; Apple silicon Macs run the Mac's).
- **What's newest**: `https://registry.npmjs.org/@opencode/cli-darwin-arm64/latest` gives the `version` and `dist.integrity`; `@opencode/cli-linux-x64/latest` and `@opencode/cli-linux-arm64/latest` give the Linux builds', `@opencode/cli-darwin-x64/latest` Intel Macs'. The release notes are on [anomalyco/opencode](https://github.com/anomalyco/opencode/releases).
- **Updating**: set the version, tarball URLs and integrities together, all four builds, and the Mac build's `binarySHA256` (`shasum -a 256` of `package/bin/opencode` from its tarball, checked against npm's integrity first): the app runs only that exact binary. Read the release notes for API or event changes the client (`Packages/OpenCodeKit`) and the transcript reducer must follow, and for new features the app should offer (a new setting, a new kind of tool call, a new permission). Run OpenCodeKit's tests, including `LiveServerTests` with `OPENCODE_TEST_BINARY` pointing at the new binary and `LiveRemoteEngineTests` with `KUVO_TEST_SSH_HOST` naming a Linux machine you can reach with SSH, then run the app and do a real session: send a message, run a tool, answer a permission, review the changes. Add a line to `CHANGELOG.md`.
- `Packages/Box/src/link/engine/compatibility.ts` works around engine bugs with providers through the engine's own settings, on each box for its own engine (today: GitHub Copilot's Claude models rejecting `thinking.block_binding`, anomalyco/opencode#55160). On each update, check whether the engine handles them now, and remove what it does.
- Do patch and minor updates on your own when all of that passes. Ask first if the engine's API changed in a way that needs real work, and say what changed.

### OpenUsage, upstream of UsageKit

`Packages/UsageKit` is a fork of [OpenUsage](https://github.com/robinebers/openusage). Providers change their usage APIs and logins often, and OpenUsage keeps up with them, so the fork has to follow.

- **Where we are**: the upstream commit named in `Packages/UsageKit/README.md`.
- **What's new**: the commits on `robinebers/openusage` since then (`gh api repos/robinebers/openusage/compare/<commit>...main`).
- **Updating**: port provider fixes, new providers, pricing and parsing changes, and bug fixes in shared code. Skip what the fork removed (Sparkle, analytics, the local API, the CLI, iCloud sync, single-instance handling, OpenUsage's branding) and keep the fork's own changes (the host embedding, the Bars style). Port in small commits that say which upstream change they bring, run UsageKit's tests, then move the commit named in the README.

### Integrations' servers

`KuvoCode/Stores/Integrations.swift` names each integration's server: official URLs, and npm packages pinned to a version (mcp-server-apple-events, @softeria/ms-365-mcp-server, caldav-mcp, @doist/todoist-mcp, figma-developer-mcp; and chrome-devtools-mcp in `KuvoCode/Stores/MCPCatalog.swift`). Check the packages on npm (`https://registry.npmjs.org/<package>/latest`) and move the pins, reading their changes for new keys or settings; check that the official URLs still answer, and whether a service now has its maker's own server (move it off the browser or an open-source package when it does).

### Code copied from other projects

- **browser-use**'s page reader, `KuvoCode/Resources/buildDomTree.js` (version in `scripts/third-party-licenses.sh`): ours is 0.4.2's, unchanged, and 0.4.2 is the last browser-use release that has the file; later ones read pages through Chrome's DevTools protocol, which WebKit doesn't offer. Check new releases in case it comes back, and port fixes to it by hand if the agent's browsing needs them.
- **Textual**, `Packages/Textual`: a copy of [gonzalezreal/textual](https://github.com/gonzalezreal/textual) at the commit its README names, changed so replies lay out in one pass (the README lists what's different). Check upstream's releases, port fixes and features by hand while keeping those changes, and move the commit in the README.
- **Prism**, `KuvoCode/Resources/prism-bundle.js`: rebundle when Textual's bundle script moves to a newer Prism.
- **Mermaid**, `KuvoCode/Resources/mermaid.min.js` (version in `scripts/third-party-licenses.sh`, license in `Licenses/mermaid.txt`): npm's `mermaid` build, unchanged. Check for new releases (`https://registry.npmjs.org/mermaid/latest`), read their notes for changes to how diagrams look or what the page must allow, and move it in its own commit.
- **Brand marks**, `Packages/KuvoClient/Sources/ClientDesign/Resources/Marks.xcassets` (listed in `BrandMark.swift`; sources in `scripts/third-party-licenses.sh`): providers' logos from models.dev (`https://models.dev/logos/<id>.svg`), services' marks from Simple Icons (pinned on jsDelivr) and UsageKit's provider icons, unchanged. When the app gains a provider, integration or MCP server, bundle its mark (read the SVG first: plain paths only), or give it a plain symbol in `BrandMark.symbols` where its maker has no mark to use.

### Swift packages and tooling

Also check, and update the same way (build, test, its own commit):

- SwiftTerm and Sparkle: requirements in `KuvoCode.xcodeproj/project.pbxproj`, versions in `KuvoCode.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`. Within a requirement, re-resolve (File › Packages › Update to Latest Package Versions); beyond it, raise `minimumVersion`. Commit the new `Package.resolved`; CI fails if building would change it. **SwiftTerm stays on 1.11.x**, because 1.12 and later need the Metal toolchain; ask before moving past it.
- KeyboardShortcuts, through `Packages/UsageKit/Package.swift`.
- `dmgbuild` in `scripts/build-dmg.sh`, the GitHub Actions in `.github/workflows/*.yml` (Dependabot also opens pull requests for these), and the `xcode-27` runner label once a newer Xcode's runner is out.
- kuvo-web's npm packages (`npm outdated` there), when you work on the site. Pushing kuvo-web deploys kuvo.run, so push only when the user says so.

### Every update

Its own commit, never mixed into the user's task. Build, run both packages' tests, run `./scripts/third-party-licenses.sh` and commit `THIRD_PARTY_LICENSES.txt`, update any doc page or README that names the version, and add a `CHANGELOG.md` line when people would notice. If you can't check for updates (no network), say so instead of skipping silently.

## The changelog

If people using Kuvo Code would notice a change, add a line to `CHANGELOG.md` under Unreleased, in plain words about what they'll see. The release workflow publishes that section as the release notes, and the app's update window shows it. A new keyword or Settings page gets a "New" mark (`<!-- new: … -->` after its line), and a release with headline features a short `### Highlights` list for What's New, the sheet after an update; run `scripts/whats-new.py` after changing either (CONTRIBUTING.md, Workflow). The phone's own `CHANGELOG.md` works the same way.

## Brand decisions

Ask the user before anything brand-related: app icons, logos and marks, favicons, brand or accent colors, taglines and headlines. Render options and let them pick; never apply one "for now".

## Releases

Releases come only from the pipeline: pushing an annotated `vX.Y.Z` tag on `main` runs `.github/workflows/release.yml`, which builds, signs with a Developer ID, notarizes and publishes `KuvoCode.dmg` and the update feed. Don't build or publish a release by hand. `Actions › Release › Run workflow` is a dry run that checks signing without publishing.

Before any release or beta tag, the user tries its update first, the way people will get it: `scripts/try-update.sh` (the user, 2026-10-31: "I want to test new updates beforehand just like this from now on"). Run it in the background, tell the user to choose **Check for Updates…** in the copy in /Applications, and stop it once they've updated, so the real feed comes back.

Betas are manual: an annotated `vX.Y.Z-beta.N` tag on `main` (the version it leads up to) goes through the same pipeline as a prerelease, with the changelog's Unreleased notes as they are (don't rename the heading). Only copies with **Settings › General › Get beta updates** on are offered it; the update feed keeps the newest release and any newer beta (`scripts/merge-appcast.py`). Its build version is `X.Y.ZbN`, which Sparkle orders before `X.Y.Z` (it ignores anything after a dash).

## Go easy on GitHub (strict)

On 2026-10-28 GitHub's automated abuse checks hid the user's account: the profile, the repos and the release downloads (the DMG and the update feed) answered 404 to everyone else. The likely cause is the heavy automated traffic of many sessions at once. A reinstatement request is open. Until the user says the account is cleared, and as a habit after it:

- **Sessions never push.** Commit finished, tested, reviewed work to your branch (merged with main locally) and tell the coordinating session (or the user) it is ready. **Push only when the user asks** (the user, 2026-10-28: "don't push unless I ask"), then once per repo, carrying everyone's finished work together. Never push only to start CI.
- **No polling.** Never loop on `gh run`, `gh api`, `gh pr` or `git fetch`. Check CI once after a push, and read the result when you're told it's done.
- **No GitHub writes beyond the task**: no issues, labels, releases, tags or repo settings unless the user asks.
- **One account.** Never create or use another GitHub account or token.

## Commits

- Commit in small, logical chunks with plain messages.
- Never add `Co-Authored-By` or any other AI attribution to commits or pull requests.
- This repo will be open source. Before committing, check for personal paths, secrets and machine-specific data. The signing team stays in the git-ignored `Config/Signing.local.xcconfig`.
- **Carry work to main in checkpoints.** Each finished piece that passes every suite and completes its review loop is merged into local main, rather than waiting on a branch. It's pushed only when the user asks. The user reviews merged work in batches, whenever they ask, in their own copy by taking a local update (`scripts/try-update.sh`). Main doesn't need to be release ready: releases and betas come only from tags, on the user's word.
- **Delete a branch once it's merged into main**, both locally and on origin (`git branch -d`, `git push origin --delete`), and remove its worktree. `git fetch --prune` and `git branch --merged origin/main` (with `-r` for origin's) show what's left. A branch someone is still working on stays until they're done, and a branch that isn't merged is never deleted this way.
