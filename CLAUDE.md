# Kuvo Code

A native macOS harness for coding agents that works with any model. It runs the opencode engine (`@opencode/cli`), unmodified, as a private server, and is the interface around it: sessions, reviewing changes, a side panel with files, terminals and a browser the agent can use, and a usage tracker in the menu bar.

## UI and UX come first (strict)

What people see and touch is the most important part of Kuvo Code. Never trade its quality away, and never let the machinery behind a feature crowd it out.

- Design the UI of a change with as much care as its internals, in the same task. Never a quick sketch to get it out of the way and polish later: polishing it afterwards costs the user's time.
- Before you build a screen or a control, look at how the app already draws the same kind of thing (`KuvoCode/Design`, the views beside it, the website's screenshots) and match its materials, spacing, wording, states and motion.
- Work through every state: empty, loading, failed, long text, many items, a narrow window, light and dark, larger text, and VoiceOver.
- See it yourself in a demo copy before calling it done, and look at it as the user will.
- When a visible choice isn't obvious, mock the options and let the user pick.
- When the machinery makes the right UI hard, change the machinery. Don't bend the UI around it.

## Reviews at checkpoints

Have your work reviewed by reviewer agents by default, without being asked.

- At each checkpoint (a finished feature or phase, and before a merge to main or a release), start independent reviewer agents on everything since the last review. They look at correctness first, then the UI and UX against this file, then what could be simpler.
- Split a large change by area, one reviewer each, and give each the commits and what the change is for.
- Sort what they find. Fix what users would hit first, then the minor problems. Skip only edge cases no one would hit. Add a test for each fix where it can be tested.
- Say in your report which reviews ran, and what they found and you fixed.

## The same care for every task, start to finish

Quality slips as a session goes on. The context fills up, hours pass, a task looks small or familiar, and corners get cut. Watch for this in yourself, and don't let it happen.

- Give the last task of a long session the same care as the first. Read the code before you change it, test what you changed, look at the UI, run the reviews, and check the docs and the changelog.
- No task is too small for the rules in this file. A one-line fix still gets its test, its docs check and a look in the app.
- When you notice yourself skimming, guessing, or about to report something done that you haven't checked, stop and do it properly. If the context is too full to work well, say so and suggest a fresh session. Never lower the bar.

## Keep what Kuvo Code leaves on people's computers contained (strict)

Kuvo Code must never spread files across the user's Mac or their machines. Everything it needs is packaged, kept in its own folders, organized inside them, and gone when those folders are deleted.

- **On the Mac**, only Kuvo Code's own places: `~/Library/Application Support/run.kuvo.code` (data, engines, downloads for machines), `~/Library/Caches/run.kuvo.code`, `~/Library/Logs/Kuvo Code`, its `WebKit` and `HTTPStorages` folders, its preferences and its keychain items. Temporary files go in the app's temporary folder and are deleted once used. The one exception is SSH's connection sockets in `/tmp/kuvo-ssh-<uid>`, which need a short path. Never write to the home folder at large, shell profiles, `/usr/local` or other apps' folders.
- **On a remote machine**, everything goes in `~/.kuvo-code`: the engine, the browser, helpers, run state, trash. Never install system packages or ask for `sudo`, never write dotfiles or caches in the user's home, `/tmp` leftovers, crontabs or services. The one exception is a single `@reboot` line in the user's crontab, tagged `# kuvo-code`, that starts the engine again after the machine restarts (only for the real `~/.kuvo-code`, never a test's); **Remove…** takes it out, and `uninstall.md` says how to. Bring dependencies along instead (the browser brings its own libraries and fonts). Anything Kuvo Code starts there runs with its folders pointed inside `~/.kuvo-code` (the engine's `XDG_*` folders; the browser gets a home of its own in `~/.kuvo-code/browser/home`) and starts from a folder inside it, so nothing relative lands elsewhere. Check after a change: list what's new in the machine's home folder and `/tmp`.
- **Except the coding agents' own programs** (Claude Code, Codex, Grok), on the Mac and on machines (the user, 2026-10-23: "break the containment on machines for this"). Kuvo Code uses the ones on the computer's PATH (a machine's login shell's), and **Install** and **Update** run their makers' official installers and updaters (`curl -fsSL https://claude.ai/install.sh | bash`, `https://chatgpt.com/codex/install.sh`, `https://x.ai/cli/install.sh`; `claude update`, `codex update`, `grok update`, or the Homebrew or npm that owns an install), with the machine's own folders, so they put them where they always do (`~/.local/bin`, `~/.local/share/claude`, `~/.codex`, `~/.grok`; Grok's installer adds a PATH block to the shell profile). Kuvo Code never installs copies of its own of them, and only when you click Install or Update. Their sign-ins on a machine stay in `~/.kuvo-code/agents`. Cursor's SDK and Antigravity's agent still come with Kuvo Code, in its folders.
- **Organized inside**: a folder per kind (`engine/<version>`, `browser/<build>`, `bin`, `run`, `keys`, `bots`, `groups`, `trash`), older versions cleaned up, what's running recorded in `run/`.
- **Removing the folders removes everything**: `uninstall.md` and `privacy.md` list them all; anything new keeps that true and updates them.
- **Tests and demo copies too**: they use folders of their own (`KUVO_DEMO_MACHINE_ROOT`, `~/.kuvo-code-test`), keep test files inside them, and clean up what they leave on a machine or the Mac when done.

## Docs must match the code (strict)

The website and docs live in a separate repo, **kuvo-web**, checked out next to this one (`../kuvo-web`). Kuvo Code's docs are Markdown files in `src/content/docs/code/`, ordered by `src/lib/docs-nav.ts`, and its landing page is `src/pages/code/index.astro` (the site also hosts Kuvo Box under `/box`, and kuvo.run's own page is `src/pages/index.astro`).

**A change that affects what users see, run or rely on is not done until the docs match it.** This rule has no exceptions for "small" changes:

- Update the docs in the same task as the code change, never "later" and never as a follow-up suggestion.
- Before you report a task as finished, check every doc page mapped below for the files you touched, and say which pages you updated, or that you checked and none needed changes.
- Never document behavior you haven't confirmed in the code. If the docs and the code disagree, the code wins: fix the docs and mention the mismatch.
- If `../kuvo-web` isn't there, stop and tell the user. Don't skip the docs silently.
- Commit docs changes in kuvo-web separately from code commits here, with a message that says what changed for users. Pushing kuvo-web deploys kuvo.run, so push only when the user says so.
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
| `KuvoCode/Resources/kuvo-browser.js`, `Stores/MachineBrowser.swift`, `MachineBrowserInstaller.swift`, `Views/Utilities/MachineBrowserPane.swift`, `scripts/browser-runtime.py` (the browser on a machine: its keeper, tools, live view, downloads) | `src/content/docs/code/machines.md`, `browsing.md` (On a machine), `panel.md`, `privacy.md` (what it keeps in `~/.kuvo-code`, Chrome for Testing and Rocky Linux downloads), `uninstall.md`, `shortcuts.md`; this repo's `CONTRIBUTING.md` (The browser on a machine); bump `KEEPER` with every change to its host side |
| `KuvoCode/Stores/Bots.swift`, `BotTemplates.swift`, `BotGroups.swift`, `Views/BotEditor.swift`, `Packages/OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift` (bots, templates, wake-ups, pausing, group chats) | `src/content/docs/code/bots.md`, `privacy.md` (the `bots` folders) |
| `KuvoCode/Stores/Moves.swift`, `MachineGroups.swift`, `GroupChats.swift`, `Agents/src/groups/*` (Move to Computer for bots, chats and group chats; group chats that live on a machine and run in its agents bridge) | `src/content/docs/code/bots.md`, `machines.md`, `sessions.md` (Move to Computer), `privacy.md`, `uninstall.md`, `architecture.md`; this repo's `README.md` (How it works) and `CONTRIBUTING.md` (`scripts/group-vectors.sh` after changing the group chat rules on either side) |
| `KuvoCode/Stores/Integrations.swift`, `IntegrationKeys.swift`, `Views/Settings/IntegrationsSettings.swift`, `Packages/OpenCodeKit/Sources/OpenCodeKit/Engine/Launcher.swift` (integrations, their keys, `kuvo-npx`) | `src/content/docs/code/integrations.md`, `privacy.md` (keys, the `integrations` folder, connections), `uninstall.md` (Keychain items), `architecture.md` (third-party pieces), `settings.md` |
| `KuvoCode/Views/Providers/*`, `Stores/Catalog.swift` (accounts, sign-in, models) | `src/content/docs/code/accounts.md`, `sessions.md` (Model and effort) |
| `KuvoCode/Views/SettingsView.swift`, `Views/Settings/GeneralSettings.swift`, `AppearanceSettings.swift`, `StorageSettings.swift`, `GitSettings.swift`, `ArchivedSessionsSettings.swift`, `ShortcutsSettings.swift`, `KuvoCode/Design/Look.swift` (Settings' sidebar and pages, appearance, storage, git, worktrees, archived sessions) | `src/content/docs/code/settings.md`, and the page that covers a page: `accounts.md`, `customize.md` (Agents, Permissions, MCP Servers, Skills, Commands, Engine), `panel.md` (Panel, Browser, Passwords), `machines.md`, `usage.md`, `troubleshooting.md` (Engine), `shortcuts.md` |
| `KuvoCode/Views/Settings/BrowserSettings.swift`, `PasswordsSettings.swift`, `KuvoCode/Stores/Passwords.swift` (the panel browser's settings, website data and saved passwords) | `src/content/docs/code/panel.md`, `settings.md`, `privacy.md`, `uninstall.md` |
| `KuvoCode/Views/Settings/*`, `KuvoCode/Stores/EngineConfig.swift`, `SkillLibrary.swift` (the engine's settings file, skills from GitHub) | `src/content/docs/code/customize.md`, `privacy.md` (the settings file and skills folder, GitHub connections), `uninstall.md` |
| `Packages/UsageKit/*`, `KuvoCode/Stores/UsageAccounts.swift` (the menu bar usage panel) | `src/content/docs/code/usage.md`, `privacy.md` (the usage item, the `Usage` folder), `uninstall.md`; also `Packages/UsageKit/README.md` (What's different from upstream) |
| `KuvoCode/Stores/Updates.swift`, the update feed in `scripts/build-app.sh` | `src/content/docs/code/installation.md`, `privacy.md` (connections) |
| `Config/App.xcconfig`, `KuvoCode.entitlements`, the Xcode project's packages, `scripts/*` | `src/content/docs/code/installation.md` (requirements, Build from source), `architecture.md` (third-party pieces); this repo's `CONTRIBUTING.md`; rerun `./scripts/third-party-licenses.sh` when packages or copied code change |
| `KuvoCode/Stores/PhoneLink.swift`, `Views/Settings/PhoneSettings.swift`, `Packages/KuvoLink/*` (the phone link and the machines' bridge; switched off for users until the iPhone app ships, so no docs yet) | When it's switched on: a new phone page, `privacy.md` (`phone-link.json`, the `.phone-link` Keychain items, the relay connection, a machine's `~/.kuvo-code/run/link.json` and `bin/kuvo-link.js`), `uninstall.md`, `settings.md` (Phone), `machines.md`, `architecture.md` |
| Files, folders, defaults or website data Kuvo Code creates on the user's Mac | `src/content/docs/code/privacy.md`, `uninstall.md`, `troubleshooting.md` |
| `scripts/icon.py`, `KuvoCode/AppIcon.icon` (the app icon) | `public/code/icon.png`, `icon-dark.png`, `public/code/apple-touch-icon.png` and `public/code/og.jpg` (redraw with `python3 scripts/og-image.py code`) must show the same mark, and so must this repo's `docs/images/icon.png` (the README) |
| The version number | `src/lib/site.ts` (`code.version`), and `CHANGELOG.md` here |

Screenshots in `kuvo-web/public/code/screens`, and the README's `docs/images/screenshot-light.webp` and `screenshot-dark.webp` here (the same shot as the website's), show the real app. If a UI change makes one visibly wrong, tell the user it needs recapturing. They're captured from a separate demo copy of the app (built with `APP_BUNDLE_ID=run.kuvo.code.demo` into `build/DemoDerivedData`, launched with `KUVO_DEMO_USAGE=off` and a `KUVO_DEMO_NAME`) on a sample project, with the `KUVO_DEMO_*` launch variables listed in `CONTRIBUTING.md`, so the user's own app, sessions and logins are never touched and nothing personal shows. Sign the demo copy with the team (leave out `CODE_SIGN_IDENTITY=-` and `DEVELOPMENT_TEAM=`, so the git-ignored `Config/Signing.local.xcconfig` signs it), never ad-hoc. macOS takes each ad-hoc build for a new app and asks again for the Desktop and the Keychain, and a launch nobody is there to answer hangs on that prompt. Capture the window only (`screencapture -l`), never the full screen. `crop-usage.webp` is the Bars view rendered with sample numbers, not a capture.

## The iPhone app keeps up with the Mac

**A feature isn't done until the phone has it too, wherever it makes sense there.** Kuvo Code for
iPhone (`../kuvo-code-ios`) is the same app on the go: sessions, bots, group chats, the panel's
tools, what agents ask you, usage. When you add or change something people use on the Mac, do the
phone's side in the same task:

- The Mac's side: what the phone reads or does, as routes in `KuvoCode/Stores/PhoneLink.swift`
  (and in the machines' bridge, `Packages/KuvoLink`, for what works with the Mac closed), written
  up in `Packages/KuvoLink/PROTOCOL.md`.
- The phone's side, in `../kuvo-code-ios`: the screen or control for it, built the same way as
  the Mac's. If another session is working on the phone app, hand it the routes and their shapes
  (dates, streams, errors) and the commit, rather than editing its code.
- Leave out only what has no place on a phone (window layout, Mac-only settings, the Mac's own
  apps), and say so when you report the task as finished.

### It shares the Mac's look

Kuvo Code for iPhone (`../kuvo-code-ios`, closed source) draws with copies of the Mac's design
files: `KuvoCode/Design/Surfaces.swift`, `Spinner.swift`, `FolderIcon.swift`, the code block
style and CodeColors (`CodeBlockStyle.swift`, `CodeHighlighter.swift`) and the shared bits of
`Theme.swift`, in `KuvoCodeMobile/Design`. When you change one of those here, or how the
conversation, cards, composer or sidebar look, change the phone's copy too (or tell the session
working on the phone), so the two stay one app. The same goes for the app icon: the phone's
`KuvoCodeMobile/AppIcon.icon` is a copy of `KuvoCode/AppIcon.icon`.

## Upstreams stay up to date

Kuvo Code is built on other projects, and keeping up with them is part of every task, without being asked. **At the start of each conversation, before the first task, check each upstream below for anything new**, and tell the user what you found.

### The opencode engine

Kuvo Code runs one pinned build of `@opencode/cli`. A new opencode release brings model and provider support, fixes and new agent features, so the app should move to it quickly.

- **Where it's pinned**: `OpenCodeEngine.version` in `Packages/OpenCodeKit/Sources/OpenCodeKit/OpenCodeKit.swift`, and the tarball URL and npm `integrity` in `Packages/OpenCodeKit/Sources/OpenCodeKit/Engine/EngineInstaller.swift`, for the Mac's build and, in `EngineRelease.linux(machine:)`, the two Linux builds remote machines run (`cli-linux-x64`, `cli-linux-arm64`).
- **What's newest**: `https://registry.npmjs.org/@opencode/cli-darwin-arm64/latest` gives the `version` and `dist.integrity`; `@opencode/cli-linux-x64/latest` and `@opencode/cli-linux-arm64/latest` give the Linux builds'. The release notes are on [anomalyco/opencode](https://github.com/anomalyco/opencode/releases).
- **Updating**: set the version, tarball URLs and integrities together, all three builds. Read the release notes for API or event changes the client (`Packages/OpenCodeKit`) and the transcript reducer must follow, and for new features the app should offer (a new setting, a new kind of tool call, a new permission). Run OpenCodeKit's tests, including `LiveServerTests` with `OPENCODE_TEST_BINARY` pointing at the new binary and `LiveRemoteEngineTests` with `KUVO_TEST_SSH_HOST` naming a Linux machine you can reach with SSH, then run the app and do a real session: send a message, run a tool, answer a permission, review the changes. Add a line to `CHANGELOG.md`.
- `KuvoCode/Stores/ProviderCompatibility.swift` works around engine bugs with providers through the engine's own settings (today: GitHub Copilot's Claude models rejecting `thinking.block_binding`, anomalyco/opencode#55160). On each update, check whether the engine handles them now, and remove what it does.
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

### Swift packages and tooling

Also check, and update the same way (build, test, its own commit):

- SwiftTerm and Sparkle: requirements in `KuvoCode.xcodeproj/project.pbxproj`, versions in `KuvoCode.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`. Within a requirement, re-resolve (File › Packages › Update to Latest Package Versions); beyond it, raise `minimumVersion`. Commit the new `Package.resolved`; CI fails if building would change it. **SwiftTerm stays on 1.11.x**, because 1.12 and later need the Metal toolchain; ask before moving past it.
- KeyboardShortcuts, through `Packages/UsageKit/Package.swift`.
- `dmgbuild` in `scripts/build-dmg.sh`, the GitHub Actions in `.github/workflows/*.yml` (Dependabot also opens pull requests for these), and the `xcode-27` runner label once a newer Xcode's runner is out.
- kuvo-web's npm packages (`npm outdated` there), when you work on the site. Pushing kuvo-web deploys kuvo.run, so push only when the user says so.

### Every update

Its own commit, never mixed into the user's task. Build, run both packages' tests, run `./scripts/third-party-licenses.sh` and commit `THIRD_PARTY_LICENSES.txt`, update any doc page or README that names the version, and add a `CHANGELOG.md` line when people would notice. If you can't check for updates (no network), say so instead of skipping silently.

## The changelog

If people using Kuvo Code would notice a change, add a line to `CHANGELOG.md` under Unreleased, in plain words about what they'll see. The release workflow publishes that section as the release notes, and the app's update window shows it.

## Brand decisions

Ask the user before anything brand-related: app icons, logos and marks, favicons, brand or accent colors, taglines and headlines. Render options and let them pick; never apply one "for now".

## Releases

Releases come only from the pipeline: pushing an annotated `vX.Y.Z` tag on `main` runs `.github/workflows/release.yml`, which builds, signs with a Developer ID, notarizes and publishes `KuvoCode.dmg` and the update feed. Don't build or publish a release by hand. `Actions › Release › Run workflow` is a dry run that checks signing without publishing.

Betas are manual: an annotated `vX.Y.Z-beta.N` tag on `main` (the version it leads up to) goes through the same pipeline as a prerelease, with the changelog's Unreleased notes as they are (don't rename the heading). Only copies with **Settings › General › Get beta updates** on are offered it; the update feed keeps the newest release and any newer beta (`scripts/merge-appcast.py`). Its build version is `X.Y.ZbN`, which Sparkle orders before `X.Y.Z` (it ignores anything after a dash).

## Commits

- Commit in small, logical chunks with plain messages.
- Never add `Co-Authored-By` or any other AI attribution to commits or pull requests.
- This repo will be open source. Before committing, check for personal paths, secrets and machine-specific data. The signing team stays in the git-ignored `Config/Signing.local.xcconfig`.
