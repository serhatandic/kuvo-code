# The side panel (Zed's docks)

Shots: `shots/screens-changes-*`, `screens-panel-narrow-*` (a 980 px window). Code: `kuvo/src/panel/mod.rs`,
the workspace's `panel_card`, `toggle_panel`, `resize_to`.

## What Zed does

Read: `crates/workspace/src/dock.rs` (its resize handle, `min_size`, how a dock's size is kept and
restored with the workspace). Behaviour only; nothing copied (GPL).

- A dock on either side holds panels; a toggle shows or hides it, and its size survives hiding.
- A thin handle (6 px) on its inner edge drags it; a double click puts it back to its default size.
- Each panel says its narrowest; the dock's size is saved with the workspace.

## What Kuvo takes

- One panel to the right of the conversation, a card of its own beside the conversation's card,
  with Changes, Files and Branches as tabs (the Mac's right panel; the user's rule keeps it for
  common tools only).
- ⌥⌘0 opens and closes it (the Mac's Show Panel); ⌥⌘I opens it on Changes and ⌥⌘F on Files (the
  Mac's Show Changes and Show Files). A button at the conversation's top right does the same.
- Its edge (8 px to grab, a 2 px line that shows under the pointer) drags it between 280 and 720
  px; a double click puts it back to 380. Its width is kept while it's closed and as conversations
  change. In a window too narrow for it, it gives way first: the conversation keeps 360 px.
- It shows the open session's folder (its worktree's, for a session in one); on the landing view,
  the project a new session starts in; for a chat, nothing ("No folder to show").
- What's hidden asks the box nothing: only the tab on screen follows or reads its folder.

## Where we differ, and why

- One side, not docks on both: the sidebar is the left's.
- The width isn't kept across launches yet: the app keeps no settings of its own so far (where a
  client keeps its window state is a decision for the user, `phase-4-handover.md`).
