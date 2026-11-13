// What this box keeps of the worktrees it makes for sessions (`box/worktrees.json`, PROTOCOL.md
// "Worktrees"): read by the worktrees' routes, and by a project's, which names a session in one
// after its project.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { writePrivate } from "../files";
import { K } from "../home";
import type { WorktreeRecordShape } from "../../shared/routes/worktrees";
import { linkedTrees } from "../work/project-trees";

export const WORKTREES_FILE = path.join(K, "box", "worktrees.json");
// What git-words.ts keeps of Settings › Git besides the box's settings: whether a Mac's settings
// from before moved here.
export const BRANCH_PREFIX_FILE = path.join(K, "box", "git.json");

/** A worktree this box keeps, as `box/worktrees.json` has it. */
export type WorktreeRecord = WorktreeRecordShape;

/** The worktrees this box keeps: `{project, root, folder, branch, base?}` each (`folder`: where
 * its session runs, the project's place in its repository; one made here also has `made`, the
 * branch it was made on, and `prefix`, what its name starts with). */
export function readWorktrees(): WorktreeRecord[] {
  try {
    const list: unknown = JSON.parse(fs.readFileSync(WORKTREES_FILE, "utf8")).worktrees;
    return Array.isArray(list) ? list.filter(each => typeof each?.root === "string" && typeof each?.project === "string" && typeof each?.branch === "string") : [];
  } catch {
    return [];
  }
}

/** Worktrees removed here: the project each was of, by the folder its sessions ran in, so a
 * conversation that ran in one is still named after its project, as the Mac names it. */
export function readRemovedWorktrees(): Record<string, string> {
  try {
    const removed = JSON.parse(fs.readFileSync(WORKTREES_FILE, "utf8")).removed;
    return isObject(removed) ? Object.fromEntries(Object.entries(removed).filter(([, project]) => typeof project === "string")) as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** The project each worktree folder here belongs to, by the folder its sessions run in (a
 * worktree's top folder too): those this box keeps, those removed that can come back, and those
 * removed before, so a session that ran in one is still filed under its project; and each project's
 * linked git worktrees made elsewhere (`linkedTrees`). The one rule every client and this box's own
 * notices go by. */
export function worktreeProjects(): Record<string, string> {
  // Read once: followers ask each second.
  let kept: { worktrees?: unknown; removed?: unknown; restorable?: unknown } = {};
  try { kept = JSON.parse(fs.readFileSync(WORKTREES_FILE, "utf8")) ?? {}; } catch {}
  // (A project's git worktrees made elsewhere, `git worktree add`, are its too; this box's own
  // records, after, say for theirs.)
  const projects: Record<string, string> = { ...linkedTrees() };
  if (isObject(kept.removed)) for (const [folder, project] of Object.entries(kept.removed)) if (typeof project === "string") projects[folder] = project;
  const records = (list: unknown) => (Array.isArray(list) ? list.filter(each => typeof each?.root === "string" && typeof each?.project === "string") as WorktreeRecord[] : []);
  for (const tree of records(kept.restorable)) projects[tree.folder ?? tree.root] = tree.project;
  for (const tree of records(kept.worktrees)) {
    projects[tree.root] = tree.project;
    projects[tree.folder ?? tree.root] = tree.project;
  }
  return projects;
}

/** The project a folder sessions run in belongs to: a worktree's, or its own. */
export const projectOf = (directory: string): string => worktreeProjects()[directory] ?? directory;

/** A worktree removed here (in Settings, or cleaned up as its last session went) that Restore
 * Worktree can bring back (`restorable` in `box/worktrees.json`): its record, the commit its branch
 * was at (`head`), and, when something in it wasn't committed and a session that ran there was
 * kept, the commit that keeps that (`snapshot`, under `refs/kuvo/worktrees/`). Kept while a session
 * that ran in it is. */
export type RestorableWorktree = WorktreeRecord & { head: string; snapshot?: string };

/** The worktrees removed here that can still come back. */
export function readRestorableWorktrees(): RestorableWorktree[] {
  try {
    const list: unknown = JSON.parse(fs.readFileSync(WORKTREES_FILE, "utf8")).restorable;
    return Array.isArray(list) ? list.filter(each => typeof each?.root === "string" && typeof each?.project === "string" && typeof each?.branch === "string" && typeof each?.head === "string") : [];
  } catch {
    return [];
  }
}

/** The list as `change` makes it, read again just before: a phone's request and a Mac's run
 * beside each other, each in a process of its own. `gone`: a worktree removed, kept in `removed`
 * (the latest 200). `restorable`: the removed ones Restore Worktree can bring back, as it makes them. */
export function updateWorktrees(change: (list: WorktreeRecord[]) => WorktreeRecord[], gone?: WorktreeRecord, restorable: (list: RestorableWorktree[]) => RestorableWorktree[] = list => list) {
  let removed = readRemovedWorktrees();
  if (gone) removed = Object.fromEntries([...Object.entries(removed).filter(([folder]) => folder !== (gone.folder ?? gone.root)), [gone.folder ?? gone.root, gone.project]].slice(-200));
  writePrivate(WORKTREES_FILE, JSON.stringify({ worktrees: change(readWorktrees()), removed, restorable: restorable(readRestorableWorktrees()) }, null, 2));
  for (const tell of worktreeFollowers) tell();
}

// Those following this box's worktrees (`kuvo/worktrees/events`), told of each change made here.
export const worktreeFollowers = new Set<() => void>();
