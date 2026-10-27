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
(`Offers`). The Mac's first launch and the phone's sheet after pairing a computer offer the same.

## ClientDesign

The look both apps draw with, the same on each: SwiftUI, no app state. It's taking the place of the
phone's copies of the Mac's design files, a piece at a time.

- `Surface`: the window's materials (canvas, card fills, lit rims, accent glass, recessed wells),
  and the `accent` and `cardIsFocused` they read.
- `Metrics`, `Animation.ui`, `.fold`: the shared sizes, the app's spring, and how folds open and
  close; `formattedCost` and `compactTokens` for a run's cost and tokens.
- `FolderIcon`: a project's folder, open or closed.
- `Color(hex:)`: a color written as 0xRRGGBB, and `PlatformColor` (NSColor or UIColor).
- `CodeColors`: the colors of code everywhere (diffs, files, replies), and Textual's theme of them.
- `TerminalColors`: a command's output colored as a terminal shows it.

## What belongs here

Only what both apps call, with a small public surface: rules and formatting both clients follow,
tested here. Not:

- text views (each app's composer field, reply renderers), where AppKit and UIKit differ;
- anything bound to an app's state, stores or settings (drafts, the site-icon cache and its
  network session);
- what only one app uses.

A change here is a change to both apps: run this package's tests (`swift test`), the Mac app's
(`scripts/test-app.sh`) and the phone's.
