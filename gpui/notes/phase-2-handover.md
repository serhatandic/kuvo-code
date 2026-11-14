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
  offers only its own side's models, as that side lists them, and says the rest aren't here yet.
  A `side` field on `kuvo/models/offered` would let clients skip reading `api/model` for it.
- Picking another model mid-run takes effect from its next step; the Mac also stops the step and
  adds a note, which is logic for the box to own if wanted.

## Decisions for the user

- The look follows the Capy references the user gave (nested threads, landing with the project chip
  above the composer). The block shots aren't approved yet; the screens use the theme's tokens, so
  changes there flow through.
- A session waiting on you shows an accent dot and its time in the accent, and its project counts
  them in a badge (rather than a "Needs you" label, which crowded titles).
- The landing view starts in the newest project until another is picked.
