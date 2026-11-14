# Upstreams

Kuvo Code is built on other projects, and keeps up with them. **The lead (Kuvo Foreman) checks each upstream below every week** and tells the user what it found. Sessions don't check them at their start: they update one only when their task needs it. Either way, this is how to check and update each. (CLAUDE.md points here.)

**The retired Swift Mac app is frozen** (`swift/MAC-APP-REFERENCE.md`): its own upstreams aren't updated any more: OpenUsage (UsageKit), SwiftTerm, Sparkle, KeyboardShortcuts, `dmgbuild`, and Prism and Mermaid in `swift/KuvoCode/Resources`. The integrations' servers below are pinned in that app's code too, and still reach machines through the box release it's built for. Until the box holds them (#713), moving one means editing the retired app, so ask the user first.

## The opencode engine

Kuvo Code runs one pinned build of `@opencode/cli`. A new opencode release brings model and provider support, fixes and new agent features, so the app should move to it quickly.

- **Where it's pinned**: `OpenCodeEngine.version` in `swift/OpenCodeKit/Sources/OpenCodeKit/OpenCodeKit.swift`, and the tarball URL and npm `integrity` in `swift/OpenCodeKit/Sources/OpenCodeKit/Engine/EngineInstaller.swift`, for the Mac's build and, in `EngineRelease.linux(machine:)`, the two Linux builds remote machines run (`cli-linux-x64`, `cli-linux-arm64`) and, in `EngineRelease.darwin(machine:)`, Intel Macs' as machines (`cli-darwin-x64`; Apple silicon Macs run the Mac's).
- **What's newest**: `https://registry.npmjs.org/@opencode/cli-darwin-arm64/latest` gives the `version` and `dist.integrity`; `@opencode/cli-linux-x64/latest` and `@opencode/cli-linux-arm64/latest` give the Linux builds', `@opencode/cli-darwin-x64/latest` Intel Macs'. The release notes are on [anomalyco/opencode](https://github.com/anomalyco/opencode/releases).
- **Updating**: set the version, tarball URLs and integrities together, all four builds, and the Mac build's `binarySHA256` (`shasum -a 256` of `package/bin/opencode` from its tarball, checked against npm's integrity first): the app runs only that exact binary. Read the release notes for API or event changes the client (`swift/OpenCodeKit`) and the transcript reducer must follow, and for new features the app should offer (a new setting, a new kind of tool call, a new permission). Run OpenCodeKit's tests, including `LiveServerTests` with `OPENCODE_TEST_BINARY` pointing at the new binary and `LiveRemoteEngineTests` with `KUVO_TEST_SSH_HOST` naming a Linux machine you can reach with SSH, then run the app and do a real session: send a message, run a tool, answer a permission, review the changes. Add a line to `CHANGELOG.md`.
- The sandbox's plugin and Auto's reviewer count on how the engine's `read` takes another file for one that isn't there (`ReadTool.alternatePath`, and `FileAccess.authorizeRead`'s `siblingOf`, which doesn't ask about it again): in 2.2.5, one plain file beside it, never a link, by a rule `box/src/link/fence/lookalike.ts`'s `alikeName` covers. On each update, `strings` the binary and check that's still so; if it now takes a link, a file elsewhere, or names `alikeName` doesn't fold together, change `lookalike.ts` and the plugin (`fence/files.ts`) to match.
- `box/src/link/engine/compatibility.ts` works around engine bugs with providers through the engine's own settings, on each box for its own engine (today: GitHub Copilot's Claude models rejecting `thinking.block_binding`, anomalyco/opencode#55160). On each update, check whether the engine handles them now, and remove what it does.
- Do patch and minor updates on your own when all of that passes. Ask first if the engine's API changed in a way that needs real work, and say what changed.

## OpenUsage, upstream of UsageKit

`swift/UsageKit` is a fork of [OpenUsage](https://github.com/robinebers/openusage). Providers change their usage APIs and logins often, and OpenUsage keeps up with them, so the fork has to follow.

- **Where we are**: the upstream commit named in `swift/UsageKit/README.md`.
- **What's new**: the commits on `robinebers/openusage` since then (`gh api repos/robinebers/openusage/compare/<commit>...main`).
- **Updating**: port provider fixes, new providers, pricing and parsing changes, and bug fixes in shared code. Skip what the fork removed (Sparkle, analytics, the local API, the CLI, iCloud sync, single-instance handling, OpenUsage's branding) and keep the fork's own changes (the host embedding, the Bars style). Port in small commits that say which upstream change they bring, run UsageKit's tests, then move the commit named in the README.

## Integrations' servers

`swift/KuvoCode/Stores/Integrations.swift` names each integration's server: official URLs, and npm packages pinned to a version (mcp-server-apple-events, @softeria/ms-365-mcp-server, caldav-mcp, @doist/todoist-mcp, figma-developer-mcp; and chrome-devtools-mcp in `swift/KuvoCode/Stores/MCPCatalog.swift`). Check the packages on npm (`https://registry.npmjs.org/<package>/latest`) and move the pins, reading their changes for new keys or settings; check that the official URLs still answer, and whether a service now has its maker's own server (move it off the browser or an open-source package when it does).

## Code copied from other projects

- **browser-use**'s page reader, `box/src/browser/buildDomTree.js` (version in `scripts/third-party-licenses.sh`): ours is 0.4.2's, unchanged, and 0.4.2 is the last browser-use release that has the file; later ones read pages through Chrome's DevTools protocol, which WebKit doesn't offer. Check new releases in case it comes back, and port fixes to it by hand if the agent's browsing needs them.
- **Textual**, `swift/Textual`: a copy of [gonzalezreal/textual](https://github.com/gonzalezreal/textual) at the commit its README names, changed so replies lay out in one pass (the README lists what's different). Check upstream's releases, port fixes and features by hand while keeping those changes, and move the commit in the README.
- **Prism**, `swift/KuvoCode/Resources/prism-bundle.js`: rebundle when Textual's bundle script moves to a newer Prism.
- **Mermaid**, `swift/KuvoCode/Resources/mermaid.min.js` (version in `scripts/third-party-licenses.sh`, license in `Licenses/mermaid.txt`): npm's `mermaid` build, unchanged. Check for new releases (`https://registry.npmjs.org/mermaid/latest`), read their notes for changes to how diagrams look or what the page must allow, and move it in its own commit.
- **Brand marks**, `swift/KuvoClient/Sources/ClientDesign/Resources/Marks.xcassets` (listed in `BrandMark.swift`; sources in `scripts/third-party-licenses.sh`): providers' logos from models.dev (`https://models.dev/logos/<id>.svg`), services' marks from Simple Icons (pinned on jsDelivr) and UsageKit's provider icons, unchanged. When the app gains a provider, integration or MCP server, bundle its mark (read the SVG first: plain paths only), or give it a plain symbol in `BrandMark.symbols` where its maker has no mark to use.

## Swift packages and tooling

Also check, and update the same way (build, test, its own commit):

- SwiftTerm and Sparkle: requirements in `swift/KuvoCode.xcodeproj/project.pbxproj`, versions in `swift/KuvoCode.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`. Within a requirement, re-resolve (File › Packages › Update to Latest Package Versions); beyond it, raise `minimumVersion`. Commit the new `Package.resolved`; CI fails if building would change it. **SwiftTerm stays on 1.11.x**, because 1.12 and later need the Metal toolchain; ask before moving past it.
- KeyboardShortcuts, through `swift/UsageKit/Package.swift`.
- `dmgbuild` in `scripts/build-dmg.sh`, the GitHub Actions in `.github/workflows/*.yml` (Dependabot also opens pull requests for these), and the `xcode-27` runner label once a newer Xcode's runner is out.
- kuvo-web's npm packages (`npm outdated` there), when you work on the site. Pushing kuvo-web deploys kuvo.run, so push only when the user says so.

## Every update

Its own commit, never mixed into the user's task. Build, run both packages' tests, run `./scripts/third-party-licenses.sh` and commit `THIRD_PARTY_LICENSES.txt`, update any doc page or README that names the version, and add a `CHANGELOG.md` line when people would notice. If you can't check for updates (no network), say so instead of skipping silently.
