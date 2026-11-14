# Phase 4 handover

## Done

Notes per view, each naming the Zed files read: `notes/screens-side-panel.md`, `screens-changes.md`,
`screens-files.md`, `screens-branches.md`. Scenarios in `kuvo/tests/panel.rs` (10, real clicks and
keys against the stand-in, whose repositories are fixtures: no git runs). Shots in
`shots/screens-*-{light,dark}.png` (every screen re-rendered: the header has the panel's button now).

1. **The side panel** (`kuvo/src/panel/mod.rs`, the workspace's `panel_card`): a card beside the
   conversation, opened and closed with ⌥⌘0 or the header's button; ⌥⌘I and ⌥⌘F open it on Changes
   and Files (the Mac's shortcuts). Its edge drags it between 280 and 720 px, a double click resets
   it to 380; its width is kept while it's closed and across conversations, and in a narrow window it
   gives way first (the conversation keeps 360 px). It shows the open session's folder (a worktree's
   for a session in one), on the landing view the project a new one starts in; a chat shows "No
   folder to show". Only the tab on screen asks the box anything. Shots: `screens-changes-*`,
   `screens-panel-narrow-*`.
2. **Changes** (`panel/changes.rs`): the box's groups (Conflicts, Staged, Unstaged, New Files),
   followed live through `kuvo/git/files/events`; a row opens the file's diff in the panel (the phase
   3 `DiffView`, now folding long unchanged stretches), Escape or ‹ goes back; Stage, Unstage, Mark
   as Resolved and Discard (asked first, worded by what happens) send back what the box listed;
   Commit (⌘↩) with a message and Push, a push that didn't go through offering Push. Shots:
   `screens-changes-*`, `screens-diff-*`, `screens-discard-*`.
3. **Files** (`panel/files.rs`): the folder a folder at a time (`kuvo/folders?files=1&hidden=1`), an
   unreadable one saying why with Try Again, a file opened read-only, highlighted and numbered
   (`kuvo/file`, 2 MB, first 3,000 lines). Shots: `screens-tree-*`, `screens-file-*`.
4. **Branches** (`panel/branches.rs`): the list with the checked-out one ticked, switching, New
   Branch…; a worktree's session shows "works on its own branch" with Merge into <the box's branch>;
   Create Pull Request… from the box's draft, made from the session in view. Shots:
   `screens-branches-*`, `screens-worktree-*`, `screens-pull-request-*`.
5. `kuvo_box`: `git` (files and their follow, a file's diff, stage, unstage, discard, commit, push,
   branches, switch, merge, pull request draft and create) and `folders` (a folder, a file's bytes).
   `kuvo_ui`: `fold_unchanged` and `DiffView::folding`; icons `undo` and `panel-right`; buttons and
   checkboxes carry their ids as debug selectors.
6. `cargo build`, `cargo test` (workspace) and `cargo clippy --all-targets` for kuvo, kuvo_box and
   kuvo_ui pass clean.

## Box changes

All additive, each with its route shape, PROTOCOL.md ("Changes"), feature name and tests
(`Packages/Box/test/git-files.test.ts`, 6, real repositories in a folder of their own):

- `git.files`: `GET kuvo/git/files?directory=` → the folder's changed files as a Changes panel
  groups them, from `git status --porcelain=v2`: group, status, the scope each one's actions and
  diff take, git's line counts, what its discard does (`trash`, `unstaged`, `head`; none for a
  conflict), a repository inside it, a partly staged file in both groups, a conflict once, and what
  a commit takes now (`commits`); and `…/events` (ndjson): within a second of the index or HEAD
  changing, on a Mac as the system says the folder's files change (30 s fallback), on Linux every
  10 s (a recursive watch there costs a system watch per folder).
- `git.changes.path`: `kuvo/git/changes` with `path` (and `oldPath`): one file's diff, a new file's
  as all its lines (`git diff --no-index` against nothing), `big` past 4 MB.
- `git.branches.worktree`: `kuvo/git/branches`' `worktree: {into}`, where Merge into… takes a
  worktree's branch (so a client knows to offer Merge, and says where).
- `kuvo/folders?files=1` leaves out `.git`, `.hg` and `.svn` (no client used `files=1` before).
- The gate: the three names in KuvoClient's `BoxGate.required`, gpui's `gate.rs` and PROTOCOL.md;
  the phone's sample Mac lists them on kuvo-code-ios branch `kuvo/gpui-phase-4-demo-features`
  (worktree `~/.kuvo-code/tmp/kuvo-gpui-p4/phone`), to merge together with this one. The bridge
  test's feature table names their routes.
- Checks: `route-shapes.sh`, `build-box.sh` and `build-agents.sh --check`, `compat.sh`,
  `test-box.sh bridge compat.test.js` (3) and `bridge.test.js` (54), the new box tests (7) here
  and on Linux (`scripts/lokum-box-check.sh`, 7 of 7, nothing left in its home or /tmp), and
  `scripts/batch-build.sh --compile-only all` (the Mac and the phone compile with KuvoClient's gate
  and the phone branch).
- The phone: `kuvo/folders?files=1` no longer lists `.git`, which the phone's Files showed; its
  CHANGELOG says so (same phone branch).
- Docs: nothing users see changed (the desktop client isn't shipped; the Mac and phone don't use
  the new routes), so no kuvo-web page or CHANGELOG line.

## Review

One reviewer pass. Fixed, each with a test where it can have one:
- **MUST**: a session started with the panel open showed "No folder to show" for good (the panel
  was placed before the box listed the session); it's placed again as each list comes, and as the
  landing view's project is picked (`a_session_started_with_the_panel_open…`, fails without it).
- Discard's words and whether a file can be discarded restated the box's rule (and were wrong for a
  staged new file, and a repository inside the folder): the box now says what discard does to each
  file, and whether it's a repository; the client only words it. What a commit takes is the box's
  `commits` too.
- The follow ran git every 3 s for each open panel: now on the index or HEAD changing, the folder's
  own changes on a Mac, and every 10 s on Linux.
- Changes and Files drew every row each frame: both are virtual lists now, Files' rows worked out
  only as folders change (an unreadable folder is one row, its whole reason on hover).
- The open diff flashed "Reading…" as an agent worked, never refreshed a new file, and closed when
  staged: it keeps its lines while read again, is read again as the list changes, and follows the
  file to its new group.
- The phone's Files lost `.git` unannounced: a phone CHANGELOG line.
- NITs fixed: box tests for names with spaces (a move's two sides), binary and too big new files;
  a drag of the panel's edge let go outside the window ends as the pointer comes back.
- NITs left: Discard's confirm button is the primary style (kuvo_ui has no destructive one yet, a
  look for the user); the rows' actions show under the pointer only, with no keyboard walk of the
  lists yet; Commit and Merge don't send your shell's git author (the box's own environment is your
  login shell's on a Mac); no Archive Session after a merge, nor Ask the Agent to Fix It after a
  conflict; the header's +/− leaves out new files (git doesn't count them).

## Open

- **Not built:** the Mac's scope menu (Branch since its base, This Session), review comments on
  lines and Review, Suggest a Message, Stage All and Unstage All, Branch Backups, a picture's before
  and after; Files' filter (the box's `folders.tree`), Reveal, Copy Path and Open in Editor, pictures
  in the viewer; a branch's last commit, deleting one; diffs aren't syntax-highlighted.
- **Machines:** the app reaches this Mac's box only, as before; every route here is the box's, so a
  machine's panel works once the app reaches machines.
- Files has no live follow (the box offers none for folders): open folders are read again as the tab
  shows again.
- The live follow's wiring (follow thread → view) has no app-level test, as in phases 2 and 3; the
  box's events route is tested, and the view takes what a follow hands it in a scenario.
- A diff past 400 rows (after folding) shows its first 400 and counts the rest (`output::MOST`).
- **Box cost:** each followed `kuvo/git/files` reads git on its own; one shared read per folder
  would be cheaper with many clients. A folder with thousands of new files git doesn't ignore lists
  them all (no cap yet).
- **Left in a client, to move:** the Mac's Files panel leaves out `.git`, `.hg` and `.svn` itself
  (`KuvoCode/Views/Utilities/FilesView.swift`, `unlisted`); the box does now for `files=1`.

## Decisions for the user

Built without drafts (the user was away): each is the Mac's or Zed's behaviour in the phase 0 look,
every colour and size from `kuvo_ui/src/theme.rs` or the block.

- **The panel as a second card** beside the conversation, tabs Changes · Files · Branches, 380 px,
  resized by its edge. Recommended: keep.
- **A file opens to its diff inside the panel** (with ‹ back), rather than the Mac's one long list of
  every file's diff. Recommended: keep for the panel's width; add the Mac's scope menu next.
- **Group names** "Conflicts", "Staged", "Unstaged", "New Files" (Zed says Untracked). Recommended:
  keep.
- **Discard's confirm in the panel's foot**, worded by what happens (Zed's), not a system alert;
  its button in the primary style until kuvo_ui has a destructive one. Recommended: keep, and add a
  destructive button style.
- **Push as a checkbox beside Commit** ("Commit and Push" when on), not remembered yet. The Mac
  remembers it; where a client keeps its own settings is a decision to make once (below).
- **Width kept across launches** needs a client settings file (the app keeps none yet): where, and
  in which folder of the app's, is the user's call (CLAUDE.md, footprint).
- **Branches as a panel tab** (the Mac has a title bar menu). Recommended: keep; a title bar menu can
  come with the window's chrome.
- **Create Pull Request… shows on any branch**, the box saying why when it can't (on the base
  itself). Recommended: keep, the box decides.
- **Two new icons**, `undo` (Discard) and `panel-right` (the panel's button), drawn in the set's style.
- **Shortcuts** ⌥⌘0, ⌥⌘I, ⌥⌘F, as the Mac's; none for Branches yet.
- Adding the three names to the shared gate makes the Mac and the phone hold a box without them too:
  a phone release mustn't ship before a Mac release with them (PROTOCOL.md, "The update gate").
