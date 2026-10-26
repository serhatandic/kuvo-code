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

## What belongs here

Only what both apps call, with a small public surface: rules and formatting both clients follow,
tested here. Not:

- views and text views (each app's composer field, reply renderers): AppKit and UIKit differ;
- anything bound to an app's state, stores or settings (drafts, the site-icon cache and its
  network session);
- what only one app uses.

A change here is a change to both apps: run this package's tests (`swift test`), the Mac app's
(`scripts/test-app.sh`) and the phone's.
