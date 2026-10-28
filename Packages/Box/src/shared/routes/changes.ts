// Changes (PROTOCOL.md, "Changes"): a project's changes on the box as git has them, for a client to
// show and parse, and staging, unstaging, discarding and committing them there.

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

export const CHANGES_ROUTES: RouteShape[] = [
  { route: "POST kuvo/git/changes", answers: { 200: GIT_CHANGES } },
  { route: "POST kuvo/git/stage", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/unstage", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/discard", answers: { 200: NOTHING } },
  { route: "GET kuvo/git/show", answers: { 200: BYTES } },
  { route: "POST kuvo/git/commit", answers: { 200: NOTHING } },
  { route: "POST kuvo/git/commit-diff", answers: { 200: COMMIT_DIFF } },
];
