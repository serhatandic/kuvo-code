# KuvoClient

What Kuvo Code's two clients share: the Mac app (this repository) and Kuvo Code for iPhone, which
builds against this checkout as a local package, as it does OpenCodeKit, KuvoLink and Textual.
Written once, tested once, so the two can't drift.

## ClientText

The rules for what a message says, the same in both apps. Foundation only: no views, no app state.

- `ImageReferences`: a picture's name in a message ("[Image 1]"), finding them, taking one out.
- `WebLinks`: the web addresses written in a message.
- `SiteAddresses`: the site a web link is on (its main domain), whether an address is a public
  one, and the icons a page declares.
- `TypedEchoes`: a message field's own typing handed back to it late by a busy app, told apart from
  a change by the app, so no key is lost.

## ClientAccounts

"Bring your subscriptions": what a computer has that Kuvo Code can use, as its box answers
`kuvo/accounts/found` (`Found`), and the rows offered from it, each with the one thing it needs
(`Offers`). Only the Mac's first launch offers them now: a computer is set up on the Mac before a
phone pairs with it, so the phone, which had a sheet of its own for this, doesn't use them.

## ClientSessions

What a client shows of a computer's sessions, the same in both apps. Rules only, on OpenCodeKit's
`Session`: no views, no app state.

- `HiddenSessions`: what's kept out of sight (a group chat's seat, the engine's run for a coding
  agents' session).
- `ReadState`: which sub-sessions are new (finished since you were last in them, or in the session
  at the top of their chain), what reading a session reads with it (its finished sub-sessions, all
  the way down), and a read elsewhere taken when it's later.
- `UnsearchedReason`: why a computer's conversations weren't searched, in the words both apps show.

## ClientDesign

The look both apps draw with, the same on each: SwiftUI, no app state. It's taking the place of the
phone's copies of the Mac's design files, a piece at a time.

- `Surface`: the window's materials (canvas, card fills, lit rims, accent glass, recessed wells),
  and the `accent` and `cardIsFocused` they read.
- `Metrics`, `Animation.ui`, `.fold`, `readableColumn()`: the shared sizes, the app's spring, how
  folds open and close, and the readable column; `formattedCost` and `compactTokens` for a run's
  cost and tokens.
- `Spinner`: the app's loader, played by Core Animation on each platform's own view.
- `FirstLineListItemStyle` (`.firstLine`): a list item's marker on its first line's middle.
- `ShimmerText`: words that shimmer while something's under way, played by Core Animation.
- `BotAvatar`, `BotLook`, `BotMood`, `GroupAvatar`, `MachineBadge`: the bots' looks, still and
  moving (`BotMotion`, played by Core Animation on each platform's own view).
- `DiffStat` and `Color.additions`/`deletions`: "+12 −3" in the system's green and red.
- `MathText`, `MathBlockView`, `InlineMath`, `MathMarkdownParser`: formulas in replies and files,
  at the size of the text they're in (handed in, as each app sets its own).
- `CodeLanguage` and `CodeLine`: a code block's language name, and how wide a line of it is set.
- `FolderIcon`: a project's folder, open or closed.
- `Color(hex:)`: a color written as 0xRRGGBB, and `PlatformColor` (NSColor or UIColor).
- `CodeColors`: the colors of code everywhere (diffs, files, replies), and Textual's theme of them.
- `TerminalColors`: a command's output colored as a terminal shows it.
- `BarFolds`: which bar in the card over a conversation's composer is open once the card is full
  (three bars or more): the newest change, none while a card asks, one at a time.
- `PutAways`: what a bar's ✕ put away, with Undo in its place for a few seconds: what goes only
  once the moment passes (a goal, a wake-up), and what goes at once and comes back with Undo.

## What belongs here

Only what both apps call, with a small public surface: rules and formatting both clients follow,
tested here. Not:

- text views (each app's composer field, reply renderers), where AppKit and UIKit differ;
- anything bound to an app's state, stores or settings (drafts, the site-icon cache and its
  network session);
- what only one app uses.

A change here is a change to both apps: run this package's tests (`swift test`), the Mac app's
(`scripts/test-app.sh`) and the phone's.
