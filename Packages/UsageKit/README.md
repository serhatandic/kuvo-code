# UsageKit

The usage tracker in Kuvo Code's menu bar: plan limits with pace and reset countdowns, local spend
(today, yesterday, 30 days, a total across providers, a 30-day trend), notifications, and
customizable menu bar metrics, for Antigravity, Claude, Codex, Copilot, Cursor, Devin, Grok,
Ollama, OpenCode, OpenRouter and Z.ai.

**This is a fork of [OpenUsage](https://github.com/robinebers/openusage) by Robin Ebers (MIT),
not the official OpenUsage, and isn't affiliated with or endorsed by it.** It was imported at
upstream commit `05c7a87` and follows upstream up to `abf472d`. The OpenUsage name and logo are Robin Ebers' trademarks and aren't used
here.

## What's different from upstream

- **Embedded, not a standalone app.** `UsageMenuBar` replaces OpenUsage's app delegate. It never
  changes the activation policy or quits the app, and OpenUsage's first-run welcome window is gone:
  the host's own first launch turns the panel on (`UsageMenuBar.turnOnFirstLaunch`), or a first click on the
  menu bar item does, and nothing asks for Keychain access before that. It tells the host when the panel opens (`UsageMenuBar.onPanelShown`), for the host's own counts.
- **Removed:** Sparkle updates, PostHog analytics, the local HTTP API on port 6736, the `openusage`
  command-line tool, iCloud sync, single-instance handling and OpenUsage's own logo.
- **The host's identity.** Names, the user agent, logs (`~/Library/Logs/<app>/Usage.log`) and
  caches (`~/Library/Application Support/<bundle id>/Usage`) follow the app UsageKit runs in, so it
  never shares files with an installed OpenUsage. A proxy goes in `Usage/proxy.json` there.
- **The host's accounts** (`HostAccounts`). Copilot, OpenRouter and Z.ai accounts connected in Kuvo
  Code are used, and so are its sign-ins (Cursor's for its coding agent, an API key exchanged for an
  access token for each read, when the Cursor app isn't signed in): ChatGPT's for Codex, instead of the Codex CLI's or pi's
  login (an account card for another account stays off), and SuperGrok's for Grok's weekly limit,
  before the Grok CLI's login (one the server turns away gives way to the next, which is then only
  read, never renewed). A sign-in's token is used as the host's engine keeps it, never refreshed or
  saved here: OpenAI and xAI rotate refresh tokens, so refreshing it would sign the engine out. The
  engine renews it without saying so, so one that has lapsed or is turned away is asked of the host
  again (`HostAccounts.setReader`). Refreshing starts only once the host has handed its accounts
  over, so a tool's own login is never read in their place at launch. OpenCode also reads the databases of Kuvo Code's private engine,
  so Kuvo Code's own runs count toward spend, and its OpenCode Go key is found there.
- **Claude Code's sign-in is only read** (`Providers/Claude`). Upstream renews its token when it's
  about to expire or turned away, outside Claude Code's lock, which spends its single-use refresh
  token and signs out a Claude Code holding the old one. Here an expired or turned-away token waits
  for Claude Code to renew it the next time it runs, and nothing is written to its Keychain item or
  file. Meanwhile the bars keep the last numbers read, "As of" when, with "Run `claude` to renew it"
  under them; the reading keeps its age (Outdated in the panel, left out of `PlanLimits`), and a
  window that started over since goes.

- **The host's usage history** (`Embedding/HostHistory.swift`): Kuvo Code's boxes read their
  accounts' logs, price them and add them up across your computers (Claude's, so far); for each
  provider the host says it covers, its main card's spend tiles, trend and model breakdown take the
  host's days in place of its own scan of the logs here (and Pi's), so nothing is read twice. Its
  other cards, and the providers the host doesn't cover yet, scan as before.
- **The host's plan limits, one row per account** (`Embedding/HostLimits.swift`): Kuvo Code's boxes
  read each account's limits with their own sign-ins, and the Bars view draws a bar for each
  account however many boxes have it (named "Claude · Work"; the host names them) in place of the
  panel's own row for that provider, when this Mac's box has a row for it (the others follow), or,
  for Claude, whose own row then has no limits, when any box has one; their detail draws
  the same way, the provider's spend and trend under the first. The panel then doesn't read
  Claude's limits or sign-ins itself (Anthropic would only count it against the same hold): its own
  Claude reading takes this Mac's own Claude login's limits from the host, as of when, for the menu
  bar, the cards, notices and the host's readers. Anthropic's reset grants and extra usage aren't
  shown meanwhile (the box doesn't read them yet). `kuvo/usage` marks the rows whose place the
  boxes' rows take (`covers`), without their limits.
- **Plan limits for the host** (`Embedding/PlanLimits.swift`): the latest limits of one provider,
  read from what the panel already has, for Kuvo Code to show beside a session.
- **A card of the host's** (`Embedding/HostCard.swift`): shown at the foot of the dashboard, above
  the footer's row, for Kuvo Code's "Working in the background" while its window is closed, on
  the panel's own card surface, with buttons on the Options button's glass capsule. While Kuvo
  Code is in the background, the Options menu's and the right-click menu's Quit read and do what
  the host says (`HostCard.quitItem`: "Stop Background Work…"), since quitting only takes it there.
- **The panel for the host's phones** (`Embedding/UsageMenuBar+Phone.swift`): what the Bars view
  lists, as JSON (providers in its order with their brand color, mark, notice and lines), and a
  refresh of everything, for Kuvo Code for iPhone.
- **API keys pasted into the panel go into the Keychain** (`Providers/APIKeySecrets.swift`), not a
  JSON file; a key an earlier version saved in a file moves there the next time it's read. A key in
  another tool's file (`~/.config/openrouter/key.json`, `~/.config/zai/key.json`) is read but never
  changed or removed: the panel shows it as the user's own, like one from the environment.
- **The menu bar item is compact by default**: its Icon Style starts as Bars, not Text
  (`Stores/LayoutPersistence.swift`); a style you picked stays.
- **Its settings in the host's Settings** (`Embedding/UsageSettingsSections.swift`): the
  panel's settings as sections of the host's own Usage page, and the panel's Settings opens that
  page (`UsageMenuBar.settingsInHost`); Theme and Launch at Login are left to the host's.
- **A Bars style for the dashboard**, the default (`Views/UsageBarsView.swift`): one compact bar
  per provider in a pastel of its brand color, in the system's type with lining digits, showing the limit closest to running out, and the spend
  as one bar on top (its period a menu, each provider's share under it once two or more spent), the bars concentric with the panel's corners. Clicking a bar opens every metric underneath in the same style
  (`Views/UsageBarDetail.swift`), not the card. It folds open and closed with the panel: laid out with the window's own height while the
  panel moves, so the bars below never run under the footer (`Fold` in `UsageBarsView`, `PanelHeightChange`), and the panel is drawn
  with each new frame (`PanelHeightController`).
  Settings › Style switches back to the cards.
- **Only the host's accounts** (`Stores/ProviderAvailability.swift`): the panel follows the providers whose accounts are connected in
  Kuvo Code (`HostAccounts.setConnectedProviders`), turning on newly connected ones, and leaves out tools signed in elsewhere on the
  Mac. Of those, one whose refresh finds no login, or no usage for its account, stays off the dashboard, the menu bar and Total
  Spend too, and Customize (which lists only connected providers) says why. Only those are refreshed, whatever's turned on, so a
  tool's own login (Claude Code's, the Codex CLI's) is never read or renewed for a provider that isn't connected; and
  `PlanLimits` leaves out readings past the Outdated age and limits whose reset time has passed.
- **Commands never hang the panel** (`Services/ProcessRunner.swift`): the runner reads stdout and stderr as
  they come and, once a command has exited, waits only a moment for the end of its output, so a login
  shell whose profile leaves something running with its output can't hold every refresh up; what that
  leftover says later is read and let go until it ends, so it's never killed or stuck on the pipe, for
  32 runs at a time and 10 minutes each at most (`LingeringReads`), so the host's descriptors can't
  run out. It waits for the exit through the termination handler, never `waitUntilExit()`, and its
  pipes close on exec, so a terminal the host starts meanwhile doesn't keep them open.

Everything else, including providers, pricing, pace, layout and the views, is upstream code. Kuvo
Code-specific code lives in `Sources/UsageKit/Embedding` and `Support/HostApp.swift`. Other edits are
kept small and marked "fork addition" where they aren't obvious.

## Network

Each provider talks only to its own service, with the login it found. Pricing for spend estimates
is refreshed about hourly from three public price lists: LiteLLM on raw.githubusercontent.com,
models.dev, and OpenUsage's pricing supplement on GitHub Pages. These requests carry no usage data.

## Tests

```sh
swift test
```

Upstream's suite, minus the tests for the removed parts.
