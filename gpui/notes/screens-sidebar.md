# The sidebar (Zed's threads sidebar)

Shots: `shots/screens-*-{light,dark}.png` (every screen has it; `screens-empty-*` shows a box with
no sessions; `screens-search-*` a search; `screens-walking-*` the keyboard on a row).

## What Zed does

Read: `crates/sidebar/src/sidebar.rs`, `crates/ui/src/components/ai/thread_item.rs`,
`crates/agent_settings/src/agent_settings.rs`, `assets/settings/default.json`,
`crates/agent_ui/src/threads_archive_view.rs` (its times); for search and the keyboard (phase 3),
`crates/sidebar/src/sidebar.rs`'s filter editor, `select_next`/`select_previous`/`confirm` and
`editor_move_down`/`editor_confirm`. Behaviour only; nothing copied.

- Threads grouped by project, newest first; no subagent threads in the list (they show inside the
  conversation).
- A group's header: the project's name, with New Thread and a menu that show under the pointer;
  a click folds it. Folded, it sums up what's under it: a spinner while one runs, a warning for
  those waiting on you.
- A thread's row: one status slot before the title (running spinner, error, waiting for you,
  finished unseen), then the title, then a short relative time ("5m", "3h", "2d", "1w").
- An empty group says "No threads yet"; no matches, "No threads match your search."
- 300 px wide by default, resizable.
- A filter field in its header: threads (and projects) match by a fuzzy search as you type, "No
  threads match your search." otherwise. ↓ from the field moves into the list; ↑ from the first
  entry back to the field; Return opens a thread or folds a project, and from the field takes the
  first match.

## What Kuvo takes

- The box decides what shows where: `kuvo_box`'s `Listing::sidebar()` (pinned, projects by their
  newest session, chats; subagents nowhere), held to `protocol/vectors/session-lists.json`. The sidebar
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

- **Search** (phase 3), as the Mac's sidebar: a sunken field under New Session. As you type,
  sessions whose title or project's name has the words (`Listing::named`, newest first, archived
  too); from three characters, after a short pause, the conversations the box finds them in
  (`kuvo/search`), under "In Conversations" with the words around them, less those found by name.
  "Nothing matches." when neither finds anything; a search that couldn't be made says why. × or
  Escape clears it.
- **The keyboard** (phase 3), as Zed's: ↓ from the search steps into the list, ↑ from its first row
  back out; the row under the keyboard has the accent's ring. Return opens a session (and the
  keyboard goes to its composer), folds a project, or shows more; from the search, it opens the
  first found. Escape goes back to the search, then clears it, then to the conversation. ⌘⇧F puts
  the keyboard in the search.

## Where we differ, and why

- Matching names is an exact substring (any case), as the Mac's; Zed's is fuzzy. Accents aren't
  folded yet (the Mac's `localizedStandardContains` folds them). The match is the client's, as on the
  Mac and the phone; `kuvo/search` could match names too, so no client does.
- A conversation found opens; the Mac also opens Find on the words, which this app hasn't yet.
- No hover actions on a session (rename, archive, stop): they need routes the client doesn't
  use yet.
- Fixed width (272 px); resizing comes with the window's other panes.
