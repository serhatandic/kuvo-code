# Changes (Zed's git panel and project diff)

Shots: `shots/screens-changes-*`, `screens-diff-*`, `screens-discard-*`. Code: `kuvo/src/panel/changes.rs`;
the box's `GET kuvo/git/files` (and `…/events`) and `kuvo/git/changes` with `path`.

## What Zed does

Read: `crates/git_ui/src/git_panel.rs` (its sections, `GitHeaderEntry`, `StageIntent`,
`DiscardTarget` and the discard prompts, the commit editor and its button's words, empty states),
`crates/git_ui/src/project_diff.rs` (the multibuffer of changes, "No uncommitted changes"),
`crates/git_ui/src/commit_modal.rs`. Behaviour only; nothing copied (GPL).

- Sections: Conflicts, Tracked and Untracked by default, or Staged and Unstaged; a file partly
  staged shows in both, and a row's action comes from its section (stage in Unstaged, unstage in
  Staged). Conflicts are never swept up by Stage All or Unstage All.
- Discard asks first, worded by what happens: "Discard changes to X?", "Trash X?" for a new file,
  "Restore X?" for a deleted one, with the button saying the same.
- A commit editor at the panel's foot, "Commit" (or "Commit Tracked"), disabled with nothing to
  commit; ⌘↩ commits.
- A file opens in a diff editor with its hunks; unchanged stretches are folded.

## What Kuvo takes

- The box groups the files (`git.files`): Conflicts, Staged, Unstaged, New Files, by name in each;
  a file partly staged in both. Each row: a letter for what happened (M, A, D struck through, R, !
  for a conflict), the name, its folder, the lines added and removed; under the pointer, Discard and
  Stage (or Unstage, or Mark as Resolved for a conflict, which can't be discarded). Each sends back
  what the box listed, scope included: the client decides nothing about git.
- Followed live (`kuvo/git/files/events`): the box asks git every 3 seconds and within a second of
  its index or HEAD changing. After an action the list is read again at once.
- A click opens the file's diff in the panel (`kuvo/git/changes` with `path`, in the scope the box
  listed), the whole file with its long unchanged stretches folded to "N unchanged lines" (three
  kept around each change), each fold opening on a click; with its actions in the header and a way
  back. Too big or binary files say so.
- Discard asks in the foot's place, worded as Zed's by what happens (a new file goes to the Trash).
- The foot: the message, what a commit takes (the staged files, else everything, as the box's
  commit does), Push, and Commit (⌘↩). A push that didn't go through after the commit landed says
  so and offers Push, never the commit again.

## Where we differ, and why

- The Mac's panel shows every file's diff in one long list with a scope menu (Uncommitted,
  Unstaged, Staged, Branch); Zed's panel lists and a diff opens elsewhere. In a 380 px panel a list
  that opens to one file's diff reads better; the scope menu, This Session, review comments and
  Review aren't built yet.
- No Stage All yet: Commit takes everything when nothing is staged, as the box's commit does.
- No "Suggest a Message" yet (the box has `kuvo/git/commit-diff` with `prompt`).
