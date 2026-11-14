# Phase 2 handover

## Done

- `gpui/kuvo`, the app (binary `kuvo`, named Kuvo): the sidebar, a conversation, the composer and
  the landing view, against this Mac's box or (`--stand-in`) a made-up one. Notes per screen in
  `notes/screens-*.md`; shots in `shots/screens-*.png`; scenarios in `kuvo/tests/screens.rs`.
- `kuvo_box`: a plain message is checked in the box's order (a model that can't run before the side
  thread's tag), held to every plain case in `Vectors/typed.json`; `models` (a conversation's
  model, the models offered, efforts, picking one, starting and stopping a session).
- `kuvo_ui`: the text field says its error (`error()`) and names its key context (`CONTEXT`).

## Open

- **Commands shown as typed** need the box: its `send` gives a command's message no parts
  (`metadata: {}` in `Packages/Box/src/link/areas/messages.ts`), so no client can tell which
  message ran one without guessing by time, as the Mac's `CommandMessages` does. The box should keep
  `{words, keyword: "/<name>"}` on it. Until then the app shows the engine's words.
- **Machines**: the app shows this Mac's box only; following a machine live is
  `notes/kuvo-box-machines.md` (option 2 wants a PROTOCOL.md line and the lead's yes).
- **Paging**: what was under "Loading earlier messages…" moves up by that row's height as the page
  goes above (GPUI's list anchors by item, and the new rows aren't measured yet).
- The live follows' wiring (a follow's thread → the view) has no app-level test: the scenarios hand
  the views what the follows would, read at once, to stay deterministic. `kuvo_box`'s own tests
  cover the follows.
- Not built yet: attachments, "@" and "&", the queue, tool output and permission asks, rename and
  archive, search, keyboard walking of the sidebar, a resizable sidebar, "!" commands, compacting,
  Autopilot, goals and side threads (the composer says so when the box hands one back).
- An existing conversation can't move to another side's model (the coding agents' from an
  engine session): that's `POST kuvo/sessions/<id>/agents`, which opens a new session; the menu
  offers only its own side's models (the box's `side` on `kuvo/models/offered`, added in phase 2's
  second review, with each model's `efforts`) and says the rest aren't here yet.
- **Left to move to the box:** whether a message may go on a session's model, and the words
  saying why not, are worked out in the client (a port of KuvoClient's `SessionModelState`
  `namesModel` and `refusal`), as on the Mac and phone. The box already knows `missing`, `account`
  and `plan`: its typed send (and `kuvo/sessions/models`) could decide and word it, so no client
  needs either. Until then the Rust port mirrors Swift's conditions, except Swift's fallback to the
  picker's name for a model gone from its list.
- `kuvo/models/offered` takes no folder, so a model only a project's own settings add has no
  efforts on the landing view (the box's gap).
- Left from the second review: the earlier page is asked for from the list's render (pages shorter
  than the window load one after another without scrolling); composers are kept for every
  conversation opened, never freed; the sidebar's times refresh only as something else redraws, and
  a list that fails after its first read shows no sign; the dark user bubble barely stands out from
  the card.
- Picking another model mid-run takes effect from its next step; the Mac also stops the step and
  adds a note, which is logic for the box to own if wanted.

## Decisions for the user

- A new sidebar mark, built without drafts: a red dot before a session started from the landing
  view whose first message didn't go while you were elsewhere (it waits in that conversation's
  composer, with why). Recommended: keep the dot and add words beside it once the sidebar has room
  for a second line; it has no VoiceOver label yet (GPUI has no accessibility here yet).

- New words and a new line, built without drafts (the user was away): the line above the composer
  of a session waiting on you ("It’s waiting on you for an answer this app can’t give yet: answer
  it in Kuvo Code on your Mac or iPhone."), and a model refusal's "in Kuvo Code on your Mac or
  iPhone" in place of "Settings › Accounts", which this app hasn't. Recommended: keep both until
  this app answers asks and has Accounts; the refusal's words should come from the box.
- The look follows the Capy references the user gave (nested threads, landing with the project chip
  above the composer). The block shots aren't approved yet; the screens use the theme's tokens, so
  changes there flow through.
- A session waiting on you shows an accent dot and its time in the accent, and its project counts
  them in a badge (rather than a "Needs you" label, which crowded titles).
- The landing view starts in the newest project until another is picked.
