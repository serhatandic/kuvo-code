// Changes (PROTOCOL.md, "Changes"): a project's changes on the box as git has them, for a client to
// show and parse, and staging, unstaging, discarding, committing and pushing them there, bringing a
// branch's work back (Merge into…, Create Pull Request), and the repository's branches and status.

import { bool, BYTES, type Infer, list, literal, map, NOTHING, nullable, number, object, oneOf, type RouteShape, string } from "../shape";

/** What changed in a folder's repository in a scope: outside one, `repository: false`; in one, its
 * top folder (`root`), what it was compared with (`against`: HEAD, a commit, or the empty tree
 * before the first commit), git's diff with the whole of each file as context, the new files git
 * doesn't know (a repository inside this one ends in "/"), git's hash of each of them by its path,
 * and whether anything isn't committed yet. */
export const GIT_CHANGES = oneOf(
  object({ repository: literal(false) }),
  object({ repository: literal(true), root: string, against: string, patch: string, untracked: list(string), hashes: map(string), uncommitted: bool }),
);
export type GitChanges = Infer<typeof GIT_CHANGES>;

/** How much changed in a scope, as `GIT_CHANGES` would list it but without the diff: outside a
 * repository `repository: false`; in one, its top folder, what it was compared with, how many
 * files changed (`untracked` of them new files git doesn't know), git's count of lines added and
 * removed in the files it knows, and whether anything isn't committed yet. */
export const GIT_CHANGES_COUNT = oneOf(
  object({ repository: literal(false) }),
  object({ repository: literal(true), root: string, against: string, files: number, additions: number, deletions: number, untracked: number, uncommitted: bool }),
);
export type GitChangesCount = Infer<typeof GIT_CHANGES_COUNT>;

/** The repository a folder is in, for a branch menu: outside one `repository: false`; in one, its
 * top folder, the branch checked out (null on none) and its branches, the latest commit first. */
export const GIT_BRANCHES = oneOf(
  object({ repository: literal(false) }),
  object({ repository: literal(true), root: string, current: nullable(string), branches: list(string) }),
);
export type GitBranches = Infer<typeof GIT_BRANCHES>;

/** Whether anything in a folder's repository isn't committed (changes, new files git doesn't
 * ignore, changes in submodules whatever their `ignore` setting): outside one `repository: false`. */
export const GIT_STATUS = oneOf(
  object({ repository: literal(false) }),
  object({ repository: literal(true), root: string, uncommitted: bool }),
);
export type GitStatus = Infer<typeof GIT_STATUS>;

/** What a commit would take, for writing its message: the diff, cut short, whether it's what's
 * staged, and (asked with `prompt`) what a model is asked to write its message from, with your
 * instructions on this computer. */
export const COMMIT_DIFF = object({ diff: string, staged: bool, "prompt?": string });

/** A commit whose push didn't go through: committed all the same, for a client to offer Push. */
const NOT_PUSHED = object({ message: string, "committed?": literal(true), "pushed?": literal(false) });
/** A merge that would conflict (nothing merged; the files it stopped on, and the branch it would
 * have gone into), or that can't go yet. */
const NOT_MERGED = object({ message: string, "conflicts?": list(string), "into?": string });
/** A pull request made (`url`), or the page to make one on (`compareURL`); neither on a host the
 * box doesn't know, where the branch is pushed. */
export const PULL_REQUEST = object({ "url?": string, "compareURL?": string });
/** Create Pull Request's confirmation (`kuvo/git/pull-request/draft`): the branch, its base, a title
 * and description from the commits, what it brings (`summary`, when asked, for a model to write them from), what a
 * model is asked to write them from (`prompt`, when asked, with your instructions on this computer), its
 * host, and whether Create makes it on the box (`creates`, with `gh` there and signed in), or why
 * not on GitHub (`gh`: not signed in, or not there), when it opens the host's page instead. */
export const PULL_REQUEST_DRAFT = object({
  branch: string, "base?": string, title: string, body: string, "summary?": string, "prompt?": string,
  host: oneOf(literal("github"), literal("gitlab"), literal("other")), creates: bool, "gh?": oneOf(literal("signed-out"), literal("missing")),
});
export type PullRequestDraft = Infer<typeof PULL_REQUEST_DRAFT>;

/** One of a repository's branch backups (taken as agents' turns start and end): when, the branch
 * checked out then ("" for none), how many branches and stashes it has, and what taking it back
 * would bring back now: branches gone since (`gone`), branches elsewhere now (`moved`, which come
 * back beside them), and stashes no longer on the list. */
export const BRANCH_BACKUP = object({
  id: string, at: number, head: string, branches: number, stashes: number,
  gone: list(string), moved: list(string), stashesGone: number,
});

/** A folder's repository's backups, newest first: its top folder (null where none was ever backed
 * up), and whether it's a repository now (`exists`: false once its `.git` is gone). */
export const BRANCH_BACKUPS = object({ repository: nullable(string), exists: bool, backups: list(BRANCH_BACKUP) });

/** A backup taken back: the repository made again (its `.git` was gone), each branch brought back
 * and the name it has now ("" for a checkout on no branch), how many stashes came back, and what
 * didn't, in words to show (`missed`). */
export const BACKUP_RESTORED = object({ remade: bool, branches: list(object({ name: string, as: string })), stashes: number, "missed?": list(string) });

export type BranchBackups = Infer<typeof BRANCH_BACKUPS>;
export type BackupRestored = Infer<typeof BACKUP_RESTORED>;

const REFUSED = object({ message: string });

export const CHANGES_ROUTES: RouteShape[] = [
  { route: "POST kuvo/git/changes", answers: { 200: GIT_CHANGES } },
  { route: "POST kuvo/git/changes/count", answers: { 200: GIT_CHANGES_COUNT } },
  { route: "POST kuvo/git/branches", answers: { 200: GIT_BRANCHES, 404: REFUSED, 500: REFUSED } },
  { route: "POST kuvo/git/switch", answers: { 200: NOTHING, 400: REFUSED, 404: REFUSED, 422: REFUSED } },
  { route: "POST kuvo/git/status", answers: { 200: GIT_STATUS, 404: REFUSED, 500: REFUSED } },
  { route: "POST kuvo/git/stage", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/unstage", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/discard", answers: { 200: NOTHING } },
  { route: "GET kuvo/git/show", answers: { 200: BYTES } },
  { route: "POST kuvo/git/commit", answers: { 200: NOTHING, 422: NOT_PUSHED } },
  { route: "POST kuvo/git/push", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/merge", answers: { 200: object({ "into?": string }), 409: NOT_MERGED } },
  { route: "POST kuvo/git/pull-request", answers: { 200: PULL_REQUEST } },
  { route: "POST kuvo/git/pull-request/draft", answers: { 200: PULL_REQUEST_DRAFT } },
  { route: "POST kuvo/git/commit-diff", answers: { 200: COMMIT_DIFF } },
  { route: "POST kuvo/git/settings/move", answers: { 200: object({ moved: bool }), 400: REFUSED, 409: REFUSED, 500: REFUSED } },
  { route: "GET kuvo/git/backups", answers: { 200: BRANCH_BACKUPS, 400: REFUSED } },
  { route: "POST kuvo/git/backups/restore", answers: { 200: BACKUP_RESTORED, 400: REFUSED, 404: REFUSED, 409: REFUSED, 500: REFUSED } },
];
