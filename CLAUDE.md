# Kuvo Code

A native macOS harness for coding agents that works with any model. It runs the opencode engine (`@opencode/cli`), unmodified, as a private server, and is the interface around it: sessions, reviewing changes, a side panel with files, terminals and a browser the agent can use, and a usage tracker in the menu bar.

Strict rules are marked (strict): never bend them. Contributor docs are in `CONTRIBUTING.md`; longer notes for sessions are in `docs/`.

## The architecture: equal boxes, and clients (strict)

Kuvo Code is a small distributed system. Build every feature for that system, never for the Mac alone.

- **Every computer is an equal box, the Mac included**: the engine with its sessions, bots, coding agents, group chats, wake-ups and the agent's browser. Each box keeps its own settings and keys, and works with no client connected.
- **Boxes talk peer to peer**, end to end encrypted through the relay (`Packages/KuvoLink/PROTOCOL.md`, "Peers"). No box needs another to do its own work.
- **Clients connect to boxes.** The Mac app and the iPhone app are clients of every box, the Mac's own included, and hold none of its state.
- **So every feature lives on the box**: `Packages/Box` (the link in `src/link`, the coding agents' bridge in `src/agents`, shared code in `src/shared`). `scripts/build-box.sh` builds the link into `kuvo-link.js`; never edit that built file. Never build a feature only into the Mac app, only for this Mac's box, or only through the Mac's SSH connection. Where a box can't do something yet, say so plainly in the UI and your report; never quietly make the Mac a hub.
- **Box code runs on macOS and Linux** (`IS_MAC` means the box beside the app, not the system). Prefer code that's the same on both; where they differ (file watching, processes, paths, the keeper, the shell, Keychain versus files), handle both in one place and test each. Check a box change on a Linux machine (a test folder of your own on devbox) before calling it done.

### Logic goes in the box, never in a client (strict)

All new code that isn't drawing goes in `Packages/Box`, with no exceptions unless the user agrees. (In November 2026 a review found 32 to 45 hours of logic to move out of the Mac app, and features that failed whenever the app was closed.) Keep clients thin enough that adding a machine, or a Windows or Linux client, is almost trivial; between two working designs, pick the one a new client would rewrite less of.

- **A box decides, a client draws**: a client reads the box's state, changes it through a route, and draws the result. Sessions, agents, accounts, models, settings, files, git, processes, the network and what's allowed belong in the box, on Macs and Linux alike (say plainly, with the reason, what can't apply on Linux).
- **The box states facts, not finished views** ("this session runs, this bot oversees it", not "6 sessions at work"). What Mac and phone both work out from them goes in `Packages/KuvoClient`: views only (a rule that changes behavior or data is still the box's), kept small, and described in `PROTOCOL.md` so another client can do the same.
- **Only this stays in a client:** drawing and layout, animation, window and selection state, the side panel's browser, and what only an installed app can do (updating itself, login items, Mac notifications). The keeper starts and watches the box, and takes on no features.
- **Before writing logic in Swift, ask:** does it work with this client closed, on a Linux machine, and for the phone without a second copy? Any "no" puts it in the box.
- **Never add** a route only the app answers (`toApp` in `Packages/Box/src/link/mac/relay.ts`, `PhoneLink.swift`), a copy of box logic in a client (or in `kuvo-browser.js` and the keeper side by side), or client logic "for now", "until the box can", or because the app is quicker to change.
- **Logic already in a client:** don't extend it. Move it to the box if that's small; otherwise make the smallest fix and list it in your report as left to move.
- **If something truly can't be on the box,** say why before building it, and the user decides. Plans and briefs name where each new piece of logic lives.

### The iPhone app is a client, like the Mac app

Kuvo Code for iPhone (`../kuvo-code-ios`) gets every feature the Mac app has, wherever it makes sense on a phone, and shares the Mac's look. A feature isn't done until the phone has it: tell the phone session in the same task, or build the phone's side yourself if none is on it. A change to how the app looks changes the phone's too. What to send and what the apps share: `docs/iphone.md`.

## UI and UX come first (strict)

What people see and touch matters most. Never trade its quality away or let the machinery crowd it out.

- Design the UI with as much care as the internals, in the same task; no sketch to polish later.
- **Drafts first, always:** before building any new screen, control or visible change, draft two or three options (light and dark) with your recommendation, and let the user pick, even when one seems obvious. Meanwhile build only what doesn't depend on the choice. A bug fix that restores an existing design needs none.
- **Look at how the best do it** (Codex, Claude Code, Cursor, GitHub, Linear, Apple's apps) and bring what you borrow and where we differ, and why. Where they've settled a behavior (what a mode does, what asks and what's refused, how a common control works), match it, showing ours, theirs and what we'll do side by side; doing it differently is the user's call, never a default.
- Match how the app already draws the same kind of thing (`KuvoCode/Design`, the views beside it, the website's screenshots): materials, spacing, wording, states, motion.
- Work through every state: empty, loading, failed, long text, many items, a narrow window, light and dark, larger text, VoiceOver. See it yourself in a demo copy where you can; if you couldn't, say so (it doesn't hold up a merge).
- When the machinery makes the right UI hard, change the machinery.
- **The right panel is only for common tools** (browser, terminals, files, Changes). A feature's own view goes in a popover or sheet on the conversation, or a page in Settings.

## Tests: what users rely on (strict)

- **Test scenarios, not the code's insides**: assert what the app shows, keeps or does, so a refactor that breaks it for users fails.
- **Use the real components.** Stub only what's outside or unpredictable (the engine's HTTP API, SSH, the network). Never test that a stub returns what it was given.
- **A bug fix starts with a test that fails on the old code** for the right reason. Fix the cause, never loosen a test.
- **Go the way the real thing goes**: send events through the window as AppKit routes them, not straight to our handler.
- **Reproduce a user's bug the way they saw it** where you can (demo copy, their logger or steps). A fix to a nearby test isn't a fix to their bug. Until the user confirms it in their own copy, report it as merged and not yet seen, not as fixed.
- **Deterministic:** no sleeps, timeouts, retries or device clocks. Fix a flaky test, never retry it. Each test runs alone, in folders of its own.
- **Skip low-value tests** (trivial getters, wiring, edge cases no one hits). A visual nitpick gets a look before and after, not a UI test.
- **Running them: locally, through `scripts/heavy.sh` lanes** (`CONTRIBUTING.md`, Tests): the app's suite with `scripts/heavy.sh mac scripts/test-app.sh`, builds and packages' `swift test` in `mac-build`, box and bridge with `scripts/test-box.sh [box|bridge|all] [filter]`, the phone's simulator runs in `phone` and its builds in `phone-build`. While working and at merge, run only your area's tests (`ONLY=…`, a test-box filter), the area including what uses the code you changed. No full suite unless the user asks; the lead asks for one before a release. CI is paused: sessions never push and never run `scripts/ci-branch.sh`, which only the lead runs when the user asks.
- Never drive the Mac app's window from tests: it takes over the user's keyboard and mouse.

## Never kill by pattern (strict)

On 2026-11-07 one `pkill` took down two other sessions, the box's link, Kuvo Code's SSH connections and the user's browser tabs.

- Never `pkill`, `killall`, `pgrep … | xargs kill` or `kill $(pgrep …)`, directly or through a script, tool or subagent, however narrow the pattern.
- Kill only what you started, by its PID (`$!`, a pid file) or a process group you created, never the one you were started in. `scripts/heavy.sh` stops what its job started. Leave anything else running and report it.
- On macOS every option goes before the pattern, in `pgrep` too.

## Keep the footprint contained (strict)

Kuvo Code never spreads files across the user's Mac or machines: everything is packaged, kept in its own folders, organized inside them, and gone when they're deleted.

- **On the Mac**, only its own places (`~/Library/Application Support/run.kuvo.code`, its Caches, Logs, WebKit and HTTPStorages folders, preferences, keychain items); temporary files in the app's temporary folder. **On a machine**, only `~/.kuvo-code`: no system packages, `sudo`, dotfiles, `/tmp` leftovers, crontabs or services, beyond the listed exceptions. Tests and demo copies use folders of their own and clean up.
- Anything new keeps `uninstall.md` and `privacy.md` (kuvo-web) complete. After a change, list what's new in the machine's home folder and `/tmp`.
- The exceptions (SSH sockets, the `@reboot` line and login agent, the coding agents' own installers) and the details: `docs/footprint.md`.

## Docs must match the code (strict)

A change that affects what users see, run or rely on isn't done until the docs in `../kuvo-web` match it, however small.

- Update them in the same task. Before reporting, check the pages mapped for the files you touched (`docs/docs-map.md`) and say which you updated, or that none needed it.
- Document only what you confirmed in the code; where they disagree, the code wins: fix the docs and say so.
- If `../kuvo-web` isn't there, stop and tell the user.
- Commit kuvo-web separately, saying what changed for users; it goes to its local main when the work does. Pushing it deploys kuvo.run: only when the user says so.
- Set `updated:` to today on every page you change. Keep docs short: what people do and see, no internals, exact limits or tables the app already labels.
- If a UI change makes a screenshot visibly wrong, tell the user it needs recapturing (`docs/docs-map.md`, Screenshots).

## The changelog

If people would notice a change, add a line to `CHANGELOG.md` under Unreleased, in plain words about what they'll see. "New" marks, Highlights and `scripts/whats-new.py`: `CONTRIBUTING.md`, Workflow. The phone's `CHANGELOG.md` works the same way. Releases and betas come only from tags, through the pipeline, on the user's word: `docs/releases.md`.

## Brand decisions

Ask the user before anything brand-related: icons, logos and marks, favicons, brand or accent colors, taglines and headlines. Render options and let them pick; never apply one "for now".

## Upstreams

The engine, OpenUsage, integrations' servers, copied code and packages are kept up to date: the lead (Kuvo Foreman) checks them every week. Sessions don't check them at their start; update one only when your task needs it, as `docs/upstreams.md` says. Each update is its own commit.

## How sessions work

- **Report to the lead** (Kuvo Foreman) or the user. Never wait on a question box: it holds the whole session.
- **When the user isn't around:** keep a list of every decision that needs them (design, brand, wording, kuvo-web pushes, anything needing a prompt or the user at the Mac), with what you recommend and why. Build what doesn't depend on the answers, so their choices come last. Never build the "recommended side" of a waiting decision when it costs the user anything (an ask, a refusal, an extra step, a limit, a change to what they already use): build around it and say it isn't built. Hand the whole list over at once, with paths to the mocks.
- **Subagents: two at a time** per session, workers and reviewers and their own subagents counted. Start another only when one finishes.
- **Reviews, by risk.** Small fixes (no new client logic, nothing touching security, data or another computer): no reviewer. Normal changes: one pass with the `reviewer` subagent at each checkpoint (correctness, then UI and UX against this file, then what could be simpler). High risk (security, data, cross-computer): that, plus a separate review the lead arranges. Every review checks client changes against "Logic goes in the box": logic in the wrong place is a bug that blocks the merge. Fix what users would hit first, then the minor ones (skip only edge cases no one would hit), add a test where you can, and say what ran and what you fixed.
- **Small fixes land fast**, with the check that proves them (for a bug, the test that fails on the old code) and no ceremony beyond that; the strict rules still hold. Bigger work keeps the same care to the end: read before changing, test, look at the UI, check the docs and changelog. If you're skimming, guessing, or about to report what you haven't checked, stop and do it properly; if the context is too full, say so and suggest a fresh session. Never lower the bar.
- **Fresh session at each phase:** write a handover note (done, open, decisions) and ask the lead or the user for a fresh session.
- **Check against the user's goal, not only the spec** (for agents: working on their own while the user is away). Anything that gets in its way goes to the top of your report.

## Go easy on GitHub (strict)

On 2026-10-28 GitHub's abuse checks hid the user's account, likely from many sessions' automated traffic.

- **Sessions never push** (the user: "don't push unless I ask"). Commit finished, tested, reviewed work to your branch, merged with main locally, and tell the lead it's ready. Only the lead pushes, when the user asks, once per repo, and checks CI once after.
- **No polling** `gh run`, `gh api`, `gh pr` or `git fetch`. **No GitHub writes** beyond the task (issues, labels, releases, tags, settings). **One account**: never another account or token.

## Commits

- Small, logical commits with plain messages. Never `Co-Authored-By` or any AI attribution.
- This repo will be open source: check for personal paths, secrets and machine data before committing. The signing team stays in the git-ignored `Config/Signing.local.xcconfig`.
- **Carry work to main in checkpoints:** a finished piece that passes its area's tests (what uses it included) on its final tip and its review is merged into local main, not left on a branch; the user takes merged work in batches with `scripts/try-update.sh`. Main needn't be release ready.
- **Delete a branch once it's merged**, and its worktree (`git branch -d`); on origin only with a push the user asked for. Never delete an unmerged branch or one someone is still on.
