// Changes (PROTOCOL.md, "Changes"): a project's changes on the box as git has them, for a client to
// show and parse, and staging, unstaging, discarding, committing and pushing them there, and bringing a
// branch's work back (Merge into…, Create Pull Request).

import { bool, BYTES, type Infer, list, literal, map, NOTHING, object, oneOf, type RouteShape, string } from "../shape";

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

/** What a commit would take, for writing its message: the diff, cut short, and whether it's what's staged. */
export const COMMIT_DIFF = object({ diff: string, staged: bool });

/** A commit whose push didn't go through: committed all the same, for a client to offer Push. */
const NOT_PUSHED = object({ message: string, "committed?": literal(true), "pushed?": literal(false) });
/** A merge that would conflict (nothing merged; the files it stopped on), or that can't go yet. */
const NOT_MERGED = object({ message: string, "conflicts?": list(string) });
/** A pull request made (`url`), or the page to make one on (`compareURL`); neither on a host the
 * box doesn't know, where the branch is pushed. */
export const PULL_REQUEST = object({ "url?": string, "compareURL?": string });

export const CHANGES_ROUTES: RouteShape[] = [
  { route: "POST kuvo/git/changes", answers: { 200: GIT_CHANGES } },
  { route: "POST kuvo/git/stage", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/unstage", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/discard", answers: { 200: NOTHING } },
  { route: "GET kuvo/git/show", answers: { 200: BYTES } },
  { route: "POST kuvo/git/commit", answers: { 200: NOTHING, 422: NOT_PUSHED } },
  { route: "POST kuvo/git/push", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/merge", answers: { 200: NOTHING, 409: NOT_MERGED } },
  { route: "POST kuvo/git/pull-request", answers: { 200: PULL_REQUEST } },
  { route: "POST kuvo/git/commit-diff", answers: { 200: COMMIT_DIFF } },
];
