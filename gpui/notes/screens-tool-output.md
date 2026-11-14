# A tool step's output (Zed's tool call cards)

Shots: `shots/screens-steps-{light,dark}.png` (an edit's diff, a test run's output folded).
Blocks: `kuvo_ui/src/output.rs` (`OutputWell`, `DiffView`, `parse_patch`); the theme's diff
tokens (`diff_added_wash`, `diff_removed_wash`, `diff_added`, `diff_removed`).

## What Zed does

Read: `crates/agent_ui/src/conversation_view/thread_view.rs` (`render_tool_call`,
`render_terminal_tool_call`, `render_tool_call_content`, `render_diff_editor`),
`crates/agent_ui/src/entry_view_state.rs` (which calls are expanded). Behaviour only; nothing
copied (GPL).

- Each tool call is a line; one with content has a disclosure and opens to it. Edits and terminal
  commands are cards: a header (the command, or the file with its +/− counts) over the content.
- A terminal's output is shown in an embedded terminal, its height capped; truncated output says
  how much the agent got. A failed command marks its header with the exit code.
- Edits open to a diff editor with the changed hunks.

## What Kuvo takes

- The quiet one-line row stays (phase 2); a step with something to show gets a chevron and opens on
  a click, as a thinking block does. Opened: an edit's changes (the engine's `metadata.files`, each
  a unified patch) as a diff with old and new line numbers, added and removed lines on their
  washes; a command's output under `$ <command>`; a search's results (grep, glob, list, web
  search). As the Mac's step rows: a file read, or a step still running, opens to nothing.
- An edit's row shows its "+4 −2" beside its target.
- Long output folds to its first 12 lines, with "Show all N lines" along the well's foot, and
  "Show less" once whole (only past 14 lines: folding away one or two hides nothing). Past 400
  lines, the rest is counted, not drawn.
- What's open is the conversation's (`Fold`), kept while it streams; rows are drawn again only
  when they change.

## Where we differ, and why

- Not a terminal or an editor: the box sends what the step printed, already finished; a monospaced
  well is enough and keeps every client able to draw the same.
- The Mac cuts a long output by its height with a fade; we fold by lines, with a button, as Zed's
  disclosure does: the fold is a choice the user makes, and reads the same at any font size.
- Shown from the top, as the Mac does: a test run's summary at its end needs "Show all".
