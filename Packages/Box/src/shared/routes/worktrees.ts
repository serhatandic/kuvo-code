// Worktrees (PROTOCOL.md, "Worktrees"): the git worktrees the box's sessions run in, each on a
// branch of its own, made, listed and removed by the box, and where new ones go.

import { bool, type Infer, list, NOTHING, nullable, number, object, oneOf, type RouteShape, string } from "../shape";

/** A worktree as the box keeps it: the project it's of, the repository's checkout it is (`root`),
 * where its session runs (the project's place in it; left out in one an older Mac kept, where
 * it's `root`), its branch and the one it was made from. One made here also has `made`, the branch
 * it was made on, and `prefix`, what its name starts with; `used` once a session has run in it
 * (it goes with its last one), false as one restored waits for one of its sessions to be open;
 * `restored` once git made it again here (the engine doesn't know it, so git removes it). */
export const WORKTREE_RECORD = object({
  project: string,
  root: string,
  "folder?": string,
  branch: string,
  "base?": string,
  "made?": string,
  "prefix?": string,
  "used?": bool,
  "restored?": bool,
});

/** A worktree removed (in Settings, or as its last session was archived or deleted) whose sessions
 * are still here, as the records list it: where its sessions ran, its branch, whether Restore
 * Worktree can bring it back (its branch is there, or what wasn't committed was kept), whether
 * that's kept (`saved`), and how many commits its branch is ahead of `base`. */
export const RESTORABLE_WORKTREE = object({
  project: string,
  root: string,
  folder: string,
  branch: string,
  "base?": string,
  restorable: bool,
  saved: bool,
  "ahead?": number,
});

/** A worktree as Settings › Worktrees lists it: its checkout (`path`), where its session runs, its
 * project and the project's name, its branch and the one it was made from, how many sessions run
 * in it and whether one is at work; and, when git can say, whether it has changes not committed,
 * how many commits it's ahead of `base`, and its size in bytes. */
export const WORKTREE = object({
  path: string,
  folder: string,
  project: string,
  projectName: string,
  branch: string,
  "base?": string,
  sessions: number,
  working: bool,
  "uncommitted?": bool,
  "ahead?": number,
  "size?": number,
});

/** The box's worktrees as Settings lists them, or, with `?records=1`, as it keeps them (their
 * branches named after their sessions first), with those removed whose sessions are still here. */
export const WORKTREES = oneOf(
  object({ worktrees: list(WORKTREE), "restorable?": list(RESTORABLE_WORKTREE) }),
  object({ worktrees: list(WORKTREE_RECORD), "restorable?": list(RESTORABLE_WORKTREE) }),
);

/** Where new worktrees go with `directory` as Settings' Worktrees folder (null for the engine's
 * own, `default`), and the home folder a `~/` one starts at: for each project in a git repository,
 * the folder (null when the engine's own has none for it yet), whether it's there or can be made,
 * and whether it's inside the repository's checkout and, then, ignored by git there. */
export const WHERE = object({
  directory: nullable(string),
  default: string,
  home: string,
  projects: list(object({
    project: string,
    name: string,
    folder: nullable(string),
    "exists?": bool,
    "canMake?": bool,
    "inside?": bool,
    "ignored?": bool,
  })),
});

export type WorktreeRecordShape = Infer<typeof WORKTREE_RECORD>;
export type ListedRestorable = Infer<typeof RESTORABLE_WORKTREE>;
export type ListedWorktree = Infer<typeof WORKTREE>;
export type Worktrees = Infer<typeof WORKTREES>;
export type WorktreesWhere = Infer<typeof WHERE>;

export const WORKTREE_ROUTES: RouteShape[] = [
  { route: "GET kuvo/worktrees", answers: { 200: WORKTREES } },
  // A new one, for a session to run in: as the box keeps it.
  { route: "POST kuvo/worktrees", answers: { 200: WORKTREE_RECORD } },
  { route: "POST kuvo/worktrees/remove", answers: { 200: NOTHING } },
  // A removed one back where it was, for its sessions: as the box keeps it again.
  { route: "POST kuvo/worktrees/restore", answers: { 200: WORKTREE_RECORD } },
  { route: "POST kuvo/worktrees/record", answers: { 200: NOTHING } },
  { route: "GET kuvo/worktrees/where", answers: { 200: WHERE } },
];
