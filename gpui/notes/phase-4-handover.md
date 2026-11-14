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
- Docs: the desktop client isn't shipped, and the Mac and phone don't use the new routes, but the
  box's Discard changed for the Mac too (a new file committed since is refused; a staged deletion's
  file, and a file at a staged move's old name, go to the Trash before the committed one comes
  back). CHANGELOG has a line; kuvo-web's `changes.md` and `privacy.md` say it, on kuvo-web branch
  `kuvo/gpui-p4-discard-safety` (worktree `~/.kuvo-code/tmp/opencode/kuvo-web-gpui-p4`), to merge
  with this one. The phone's CHANGELOG says Files no longer lists `.git`.

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
- NITs left: the rows' actions show under the pointer only, with no keyboard walk of the
  lists yet; Commit and Merge don't send your shell's git author (the box's own environment is your
  login shell's on a Mac); no Archive Session after a merge, nor Ask the Agent to Fix It after a
  conflict; the header's +/− leaves out new files (git doesn't count them).

## Separate review (the lead's)

Fixed, each with a test that fails on the code before (box tests in `git-files.test.ts`, 13; the
panel's in `panel.rs`, 12; `commit_takes`' unit test):
- **MUST**: what a commit takes, for a folder inside a larger repository. `commits` is the box's
  `hasStaged` over the whole repository, as `commit()` decides (unchanged), and `stagedElsewhere`
  counts the staged files outside the folder it takes along; the panel says so ("Commits the 3
  staged files, 2 of them outside this folder.").
- A stale discard: the confirm goes as soon as its row changes or leaves the list; the box refuses
  (409) a "new file" discard of a path the last commit has, and, given the list's `stamp` (the
  index's object and the file's size and time on disk), one whose file changed since. Nothing an
  agent did after the confirm opened is thrown away.
- A staged deletion of a file still on disk: what's there goes to the Trash before the committed
  one comes back. (This and the previous point change the Mac's Discard too: CHANGELOG, and
  kuvo-web's `changes.md` on branch `kuvo/gpui-p4-discard-safety`, worktree
  `~/.kuvo-code/tmp/opencode/kuvo-web-gpui-p4`.)
- The follow's cost: no watch outside a repository, git's own folder ignored, reads spaced by twice
  the last one's time (a second at least), one read shared by every follower of a folder (only one
  that started after the change a follower heard of), new files past 1,000 counted (`more`), not
  listed.
- NITs: a file's sizes are checked before its diff is built (bytes, not characters); a merge, rebase,
  cherry-pick or revert under way is said (`underway`) and shown over the list; a linked worktree's
  `.git` file is left out of Files; Discard's button is a new destructive style (`danger_hover`,
  `danger_pressed` in the theme; on the gallery's buttons page).
- Merged kuvo-ai main (#693 piece 1); the four built files checked.

Its reviewer pass (one) found, fixed with tests that fail on the code before (box tests now 16):
- **MUST**: discarding a staged move overwrote a file written at its old path since. That file goes
  to the Trash first (unless it's just what was committed), and the stamp covers the old path, so
  the panel's discard is refused once one's there. The confirm says what comes back ("Undo the
  move to …").
- Shared reads could hand a follower one that started before the change it heard of: a read is
  shared only when it started after.
- A move into the folder from outside it wasn't counted in `stagedElsewhere` (counted with both
  sides named now).
- The stamps come from `git status`' own index objects, not a listing of the whole folder's index;
  new files past 1,000 are counted with a counter, not a filter per file.
- NITs: a diff's size check reads the two sides that diff compares; the destructive button's fills
  meet 4.5:1 with white words in dark too (held by the theme's contrast test); red only for what
  can't be taken back (Discard), not Restore, Undo Move or Move to Trash; a staged deletion of a
  file just as committed leaves no copy in the Trash.
- Left: `hasStaged` and the staged names are two reads of the same diff (`commits` stays
  `hasStaged`'s, as the lead asked); a `web/` repository's stamp is its top folder's (edits deep in
  it still go to the Trash with it, nothing lost); the follow's spacing, its watch only inside a
  repository and its ignoring of `.git` have no deterministic test (they wait on the system's
  watch and a clock).

## The re-review (the lead's)

Fixed, each with a test that fails on the code before (box tests now 20):
- A file only noted with `git add -N` could never be discarded: the check read its index entry
  with `ls-files -s` (the empty file's), the list with `git status` (none); both read it as the list
  does now.
- A copy left after `git rm --cached` was refused as "committed since", on the Mac too: refused
  only when the last commit and the index both have the path.
- A follower's clock marked a change seen by its look a second early, so a read started just before
  it could be shared: it's marked when seen (`changeClock`).
- A file changed while the list was read is stamped so no discard matches it until it's listed
  again; the look takes in HEAD's log too, so a reset that moves only the branch is seen.
- The two "to move to the box" items above (8, 9), and the Docs line.
- Recorded, not changed: a `web/` repository's stamp is its top folder's, so work deep inside it
  goes to the Trash with it, recoverable, as its confirm says (N3); stamps lean on a file's size and
  time, so on a disk that keeps times to the second (FAT32, some network shares) a same-size edit
  within that second isn't seen (N4; APFS and ext4 keep nanoseconds).
- Merged kuvo-ai main again; the built bundles rebuilt from the merged sources, not merged by hand.

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
- **Box cost:** a Mac's follow reads git again as the folder's files change (spaced, shared); a
  build writing thousands of files under an ignored folder still wakes it, spaced to twice a read's
  time. A folder with thousands of new files git doesn't ignore lists the first 1,000 and counts the
  rest.
- **Left in a client, to move:** the Mac's Files panel leaves out `.git`, `.hg` and `.svn` itself
  (`KuvoCode/Views/Utilities/FilesView.swift`, `unlisted`); the box does now for `files=1`.

## To move to the box later

The user's rule: GPUI work leaves no logic in the client that the box ought to own, and adds no new
box features outside a review's fixes; what's left is listed here, for a box session. The panel
decides nothing about git beyond these (what's staged, the groups, the scopes, what a commit takes,
what a discard does, a stale discard, merge and rebase states, where Merge goes and whether a pull
request can be made are the box's), but it still works these out from the box's facts:

1. **Which action a file's button takes.** `GET kuvo/git/files`, each file: `"stage": "stage" |
   "unstage" | "resolve"`, what its stage button does (today the client maps `group`: staged →
   Unstage, conflicted → Mark as Resolved, else Stage). View: Changes' row and file page
   (`kuvo/src/panel/changes.rs`, `actions`).
2. **How many files a commit takes.** `GET kuvo/git/files`: `"takes": <number>`, the files `commit()`
   would take now, those outside the folder included (today the client counts staged rows plus
   `stagedElsewhere`, or distinct paths plus `more`). View: Changes' foot (`commit_takes`).
3. **"Restore" for a deleted file.** `GET kuvo/git/files`, each file's `discard`: a fourth value,
   `restore`, for a deletion (the file comes back), in place of the client reading `status ==
   "deleted"`. View: Changes' discard confirm (`confirm`).
4. **A binary file's diff.** `POST kuvo/git/changes` with `path`: `"binary": true` (today the client
   reads git's `Binary files … differ` line from the patch). View: Changes' file page (`open`,
   `reload`).
5. **Whether a file is text.** `GET kuvo/file` (or a viewer's route of its own): whether it's text and
   in which encoding, so no client looks for NUL bytes or invalid UTF-8 (`files::shown`; the Mac's
   `FileViewer` does the same). View: Files' viewer.
6. **Whether a pull request can be made from here.** `POST kuvo/git/branches`: `"pullRequest": bool`
   (false on the base itself, with no remote, on no branch), so Create Pull Request… isn't offered
   only to be refused (today it shows on any branch, and the box's draft says why it can't). View:
   Branches' card (`current`).
7. **The Mac's own `.git` filter.** The Mac's Files panel leaves out `.git`, `.hg` and `.svn` itself
   (`KuvoCode/Views/Utilities/FilesView.swift`, `unlisted`); the box does it for `files=1`, so the
   Mac could list folders through it.
8. **"Undo Move" for a staged move.** `GET kuvo/git/files`, each file's `discard`: a value for a
   staged move (its old path comes back, the new one goes to the Trash), in place of the client
   reading `status == "renamed"` with `discard == "head"`. View: Changes' discard confirm
   (`confirm`).
9. **Whether a discard can be undone.** `GET kuvo/git/files`, each file: `"undoable": bool` (what
   goes, goes to the Trash, or a file comes back), in place of the client deciding from `discard`
   and `status`, which picks the plain or the red button. View: Changes' discard confirm.

Wanted from the box, not built (new features, not fixes): Stage All and Unstage All in one request;
a branch's last commit and its time, and deleting a branch, in `kuvo/git/branches`; a Files filter
the box matches over `kuvo/folders/tree`; follow-ups after Merge into… (Archive Session) and after a
conflict (Ask the Agent to Fix It) as the box's offers; one git read per folder shared across the
box's processes; a live follow for Files.

## Decisions for the user

Built without drafts (the user was away): each is the Mac's or Zed's behaviour in the phase 0 look,
every colour and size from `kuvo_ui/src/theme.rs` or the block.

- **The panel as a second card** beside the conversation, tabs Changes · Files · Branches, 380 px,
  resized by its edge. Recommended: keep.
- **A file opens to its diff inside the panel** (with ‹ back), rather than the Mac's one long list of
  every file's diff. Recommended: keep for the panel's width; add the Mac's scope menu next.
- **Group names** "Conflicts", "Staged", "Unstaged", "New Files" (Zed says Untracked). Recommended:
  keep.
- **Discard's confirm in the panel's foot**, worded by what happens (Zed's), not a system alert,
  with a new destructive button style (the theme's danger red). Recommended: keep.
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
