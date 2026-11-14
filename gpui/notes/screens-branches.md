# Branches (Zed's branch picker)

Shots: `shots/screens-branches-*`, `screens-worktree-*`, `screens-pull-request-*`. Code:
`kuvo/src/panel/branches.rs`; the box's `kuvo/git/branches` (with `worktree`), `…/switch`, `…/merge`,
`…/pull-request/draft` and `…/pull-request`.

## What Zed does

Read: `crates/git_ui/src/branch_picker.rs` (`confirm`, `render_match`, its placeholder and footer).
Behaviour only; nothing copied (GPL).

- A picker of branches, the checked-out one marked; picking another switches; typing a name that
  isn't one offers to create it from where you are.
- Each branch shows its last commit's subject and when.

## What Kuvo takes

- The branches as the box lists them (the latest commit first), the one checked out ticked; a
  click switches (`kuvo/git/switch`), and New Branch… takes a name and switches to it, changes not
  committed coming along. What git says when it can't shows under the card.
- A card on top says what's checked out. In a worktree (the box's `worktree`), "This session works
  on its own branch", with Merge into <branch> where the box says it goes; a merge that would
  conflict is the box's words, naming the files, nothing merged.
- Create Pull Request… reads the box's draft (title and description from the commits, the base,
  what Create does there: made with `gh`, or the host's page to finish it) for you to change, then
  makes it from the session in view, and says where it is, with Open.

## Where we differ, and why

- A list in the panel rather than a picker: the Mac's branch menu lives in its title bar, and the
  panel has room to show what a worktree's branch can do.
- No filter, last commit subjects or delete yet (the box's `kuvo/git/branches` lists names only).
