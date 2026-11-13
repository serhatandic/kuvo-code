// What names the old place, rewritten as the box moves (#333 §3.4, piece 2b): the box's own files,
// the engine's database, worktrees' git links, the coding agents' history kept by a folder's path.
// One path map (old prefix → new) applied by one rewriter; a move back is the same map turned
// around. Until 2b, nothing's rewritten: the move puts the box's folders in place as they are.

import { IN_TEST_FOLDER } from "../home";
import type { Placement } from "./state";

/** One old prefix and the new one it becomes, longest first. */
export type PathMap = { from: string; to: string }[];

/** What a rewriter does at each of the move's steps. Each may throw: before the move clears the
 * old place, that goes back. */
export interface Rewriter {
  /** Why the move can't go ahead (an engine database of a schema it doesn't know), or null. Asked
   * as the move's planned, before anything changes. */
  refuses(placements: readonly Placement[], map: PathMap): string | null;
  /** The staged copy rewritten (`staged` in each placement), before it's checked. */
  rewrite(placements: readonly Placement[], map: PathMap): void;
  /** The staged copy checked (no old path left where it rewrites, counts as they were): throws
   * with what's wrong. */
  check(placements: readonly Placement[], map: PathMap): void;
  /** What's outside the box that names its folders (a repository's worktree links, Claude Code's
   * history), fixed once it's in place, each change journaled through `journal` first, so going
   * back puts it back. */
  outside(map: PathMap, journal: (undo: { act: "rename"; from: string; to: string }) => void): void;
}

/** The rewriter until piece 2b: nothing rewritten, and so no real box moved (its sessions would name
 * folders it left): a test's alone. */
export const NO_REWRITE: Rewriter = {
  refuses: () => (IN_TEST_FOLDER ? null : "This version of Kuvo Code can't move its box yet."),
  rewrite: () => {},
  check: () => {},
  outside: () => {},
};

/** The path map of a plan: each placement's folder to where it goes, the longest first (a folder
 * inside another moved apart from it goes by its own). */
export function pathMap(placements: readonly Placement[]): PathMap {
  return placements.filter(each => !each.installed).map(each => ({ from: each.from, to: each.to }))
    .sort((a, b) => b.from.length - a.from.length);
}

/** `file` as the map has it, or as it was where nothing maps it. */
export function mapped(file: string, map: PathMap): string {
  for (const { from, to } of map) {
    if (file === from) return to;
    if (file.startsWith(from + "/")) return to + file.slice(from.length);
  }
  return file;
}
