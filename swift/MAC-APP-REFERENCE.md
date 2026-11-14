# The Swift Mac app: kept only to read

The Swift Mac app is retired. Kuvo Code 1.0 is the desktop app in `gpui/`. The Swift app gets no
more updates, CI doesn't build or test it, and it has no test batch.

Its code stays here **only to read**, for two things:

- **Logic that still belongs in the box** (#668): the reviews found hours of logic in this app
  that the box has to own. Read it here, then build it in `box/`.
- **What the desktop app has to match**: how each screen, state and flow behaved, as people
  knew it.

**Never edit it.** Don't fix, update or reformat it, and don't move logic into it. A finding goes
to the box or the desktop app.

## What's the retired app

- `KuvoCode/`: the app (views, stores, design, keeper, resources), and `KuvoCode.xcodeproj`
- `KuvoCodeTests/`: its tests
- `Tests/`: its end-to-end runs (`E2E`), measurements (`Perf`), and the scripts' guards against
  the real app (`Guard`)
- `UsageKit/`: the menu bar's usage tracker, a fork of OpenUsage that only this app uses
- `Config/`: its build settings, Info.plist and entitlements

## What's not, and is kept up

The phone (`../kuvo-code-ios`) builds against these packages, and the desktop app's tests read
some of them, so they're maintained like any other code:

- `KuvoClient/`, `KuvoLink/` (with the box's link as built, `kuvo-link.js`), `KuvoVoice/`,
  `OpenCodeKit/` and `Textual/`

The box's other two bundles, `kuvo-agents.js` and `kuvo-browser.js`, used to be built into
`KuvoCode/Resources`. They're the box's own, so they're built into `box/dist/` now, and the app's
project takes them from there.

## What it's still built for, until the box does it (#713)

Machines and the protocol still need three things that only this app's code makes today. Each
runs the app's code as it is, without editing it:

- **The box release machines update from**: `.github/workflows/release.yml` builds this app and
  runs `"Kuvo Code" --write-box-files` (`KuvoCode/Stores/BoxRelease.swift`, with OpenCodeKit's
  `BoxFiles`). `scripts/pack-box.sh` and `sign-box.mjs` then pack and sign the release. This is
  the only way machines get updates today, so release.yml and its scripts stay as they are.
- **`protocol/vectors/routes/box`**: `scripts/route-vectors.sh` writes these from the app's
  `RouteContractTests` (the integrations, the MCP catalog, the Mac's bot kit), through
  `scripts/test-app.sh`.
- **The Mac app's What's New**: `scripts/whats-new.py` writes `KuvoCode/Resources/whats-new.json`
  as release.yml builds the app.
