# The sidebar (Zed's threads sidebar)

Shots: `shots/screens-*-{light,dark}.png` (every screen has it; `screens-empty-*` shows a box with
no sessions).

## What Zed does

Read: `crates/sidebar/src/sidebar.rs`, `crates/ui/src/components/ai/thread_item.rs`,
`crates/agent_settings/src/agent_settings.rs`, `assets/settings/default.json`,
`crates/agent_ui/src/threads_archive_view.rs` (its times). Behaviour only; nothing copied.

- Threads grouped by project, newest first; no subagent threads in the list (they show inside the
  conversation).
- A group's header: the project's name, with New Thread and a menu that show under the pointer;
  a click folds it. Folded, it sums up what's under it: a spinner while one runs, a warning for
  those waiting on you.
- A thread's row: one status slot before the title (running spinner, error, waiting for you,
  finished unseen), then the title, then a short relative time ("5m", "3h", "2d", "1w").
- An empty group says "No threads yet"; no matches, "No threads match your search."
- 300 px wide by default, resizable.

## What Kuvo takes

- The box decides what shows where: `kuvo_box`'s `Listing::sidebar()` (pinned, projects by their
  newest session, chats; subagents nowhere), held to `Vectors/session-lists.json`. The sidebar
  draws it as it is.
- Projects with their sessions nested under a thin line (Capy's nested threads), newest first; a
  project with none says "No sessions yet". Six show, then "Show N more".
- One status slot before the title: a spinner while the session works, an accent dot while it
  waits on you (`asked`), and its time in the accent too. A project counts its sessions waiting
  on you in a badge; folded, it shows a spinner while one works.
- A project's row folds it; its "+" (under the pointer) starts a session there.
- New Session (⌘N) at the top; under it all, the box it's on, with a dot for how it's reached
  (connecting, connected, updating, can't be reached) and the appearance switch.
- Loading, the box waiting on its engine, a box held for its update, and a list that can't be read
  each say so in the sidebar's place.

## Where we differ, and why

- No search or keyboard walking of the list yet (Zed has both): phase 3.
- No hover actions on a session (rename, archive, stop): they need routes the client doesn't
  use yet.
- Fixed width (272 px); resizing comes with the window's other panes.
