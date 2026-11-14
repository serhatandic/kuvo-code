# The iPhone app

CLAUDE.md keeps the core rule (the phone is a client like the Mac app, and shares the Mac's look); this page has the rest. The phone's own rules are in `../kuvo-code-ios/CLAUDE.md`.

## A client, like the Mac app

**The phone is just another client, like the Mac app, and it gets every feature the Mac app has,
wherever it makes sense on a phone.** Both are clients of every box: this Mac's and each machine.
So anything you can see or do in the Mac app, you can see or do from Kuvo Code for iPhone
(`../kuvo-code-ios`) on any box, with the Mac's window closed too. That covers sessions, bots,
group chats, the panel's tools, settings, accounts, what agents ask you and usage. A feature isn't
done until the phone has it.

When you add or change something people use:

- **The box's side**: what a client reads or does is a route. It goes in
  the box's link, `box/src/link` (routes in `server/router.ts`, their answers' shapes in
  `src/shared/routes`), so it works on every box, and where this Mac's box answers it differently,
  in `swift/KuvoCode/Stores/PhoneLink.swift`. Write it up in
  `protocol/PROTOCOL.md`. Never build a feature that only the Mac app's own code path
  can reach.
- **Tell the phone session, in the same task.** Usually a session is working on the phone app
  ("Mobile App Development"; find it with list_agents or the session list). Send it:
  - what changed and how the Mac app shows it;
  - the routes and their shapes (fields, dates, streams, errors);
  - the commit;
  - whether the routes are final or still moving.

  Don't edit its code. If no session is working on the phone, build the phone's side yourself,
  the same way the Mac's is built.
- **Leave out only what has no place on a phone**: window layout, Mac-only settings, the Mac's
  own apps. When you report the task, say what you left out and why.

## It shares the Mac's look

Kuvo Code for iPhone (`../kuvo-code-ios`, closed source) draws its code blocks as the Mac does
(`swift/KuvoCode/Design/CodeBlockStyle.swift`; the phone's `CodeStyle.swift` is its own version, for
touch and the phone's text size) and its quote cards in its own way. When you change those here,
or how the conversation, cards, composer or sidebar look, change the phone's too (or tell the
session working on the phone), so the two stay one app. The same goes for the app icon: the phone's
`KuvoCodeMobile/AppIcon.icon` is a copy of `swift/KuvoCode/AppIcon.icon`.

What both apps share as code, not copies, is in `swift/KuvoClient`, which the phone builds
against from this checkout as it does OpenCodeKit: `ClientText`, the rules for what a message says
(picture names, web links, the site a link is on, a field's own typing), `ClientAccounts`, and
`ClientDesign`, the look both draw with (surfaces, sizes, the loader, the bots, code colors, math
and more). Its README says what belongs there.
A change to it is a change to both apps: run the Mac's and the package's tests and the phone's, locally through `scripts/heavy.sh`.
