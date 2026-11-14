# A conversation (Zed's agent panel and thread view)

Shots: `shots/screens-conversation-*` (a session at work), `screens-asking-*` (one waiting on
you, with a reply written), `screens-narrow-*`.

## What Zed does

Read: `crates/agent_ui/src/conversation_view/thread_view.rs`, `crates/agent_ui/src/conversation_view.rs`,
`crates/agent_ui/src/entry_view_state.rs`, `crates/agent_ui/src/agent_panel.rs`. Behaviour only.

- The column is capped (850 px) and centred.
- Your message is a card; the agent's is plain Markdown with no container.
- Tool calls are one quiet line each (a kind icon, a label, its target), expanding on demand;
  thinking is a "Thinking" line that opens to its words.
- While it generates, a spinner row at the end; a turn's end shows its length.
- The list follows the newest while you're at the bottom and stops when you scroll up. Zed loads
  a whole thread at once, so it has no paging.
- Errors show as callouts above the composer.

## What Kuvo takes

- Rows come from the box's messages (`kuvo_box::follow_conversation`): your messages drawn by
  their parts (the words, the keyword they went with as a chip, who wrote it, files and comments as
  chips), never by parsing text; the agent's words as Markdown with code blocks; thinking and tool
  steps as one quiet line each, with a spinner while a step runs and a warning when it failed; the
  turn's end as "Worked for 25s", or "Stopped", or that it didn't finish.
- What's only for the agent shows nothing: the box's notes to it, switches of mode or model.
- The chat list block (phase 0) follows a run as it streams and keeps your place when you scroll
  back, with its jump-to-latest button. A run under way ends with "Working…".
- Paging: while the box has more, the first row is "Loading earlier messages…"; it asks for the
  page before as it comes into view, and the page goes above. GPUI's list keeps its place by an
  item, and the rows put above aren't measured yet, so what was under that row moves up by the
  row's height (about 60 px), never further. A page that couldn't be read says so there, with Try
  Again.
- A conversation that can't be read says why and is tried again; one that's gone says so and the
  composer goes.
- What it waits on you for shows as a card in the composer's place: `screens-asks.md`.
- Streaming redraws only what changed: each message carries a revision from `kuvo_box` (compared
  off the UI's thread), and the rows are moved in, not copied.
- Column 720 px, centred; your messages right-aligned in a soft bubble (the chat list block's look).

## Where we differ, and why

- Your message isn't editable in place (Zed's is): the box has no route for it yet.
- Tool steps open to their output, diffs and results: `screens-tool-output.md`.
- Paging exists because the box pages (`api/session/<id>/message` with a cursor).
