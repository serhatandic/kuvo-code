// @ts-nocheck
// What this box keeps of the worktrees it makes for sessions (`box/worktrees.json`, PROTOCOL.md
// "Worktrees"), and the branch prefix a client last gave: read by the worktrees' routes, and by a
// project's, which names a session in one after its project.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { writePrivate } from "../files";
import { K } from "../home";

export const WORKTREES_FILE = path.join(K, "box", "worktrees.json");
// The branch prefix a client last gave (Settings › Git's), for one that doesn't give one.
export const BRANCH_PREFIX_FILE = path.join(K, "box", "git.json");
export const branchPrefix = () => {
  try {
    const kept = JSON.parse(fs.readFileSync(BRANCH_PREFIX_FILE, "utf8")).branchPrefix;
    return typeof kept === "string" ? kept : "kuvo/";
  } catch {
    return "kuvo/";
  }
};

/** The worktrees this box keeps: `{project, root, folder, branch, base?}` each (`folder`: where
 * its session runs, the project's place in its repository; one made here also has `made`, the
 * branch it was made on, and `prefix`, what its name starts with). */
export function readWorktrees() {
  try {
    const list = JSON.parse(fs.readFileSync(WORKTREES_FILE, "utf8")).worktrees;
    return Array.isArray(list) ? list.filter(each => typeof each?.root === "string" && typeof each?.project === "string" && typeof each?.branch === "string") : [];
  } catch {
    return [];
  }
}

/** Worktrees removed here: the project each was of, by the folder its sessions ran in, so a
 * conversation that ran in one is still named after its project, as the Mac names it. */
export function readRemovedWorktrees() {
  try {
    const removed = JSON.parse(fs.readFileSync(WORKTREES_FILE, "utf8")).removed;
    return isObject(removed) ? Object.fromEntries(Object.entries(removed).filter(([, project]) => typeof project === "string")) : {};
  } catch {
    return {};
  }
}

/** The list as `change` makes it, read again just before: a phone's request and a Mac's run
 * beside each other, each in a process of its own. `gone`: a worktree removed, kept in `removed`
 * (the latest 200). */
export function updateWorktrees(change, gone) {
  let removed = readRemovedWorktrees();
  if (gone) removed = Object.fromEntries([...Object.entries(removed).filter(([folder]) => folder !== (gone.folder ?? gone.root)), [gone.folder ?? gone.root, gone.project]].slice(-200));
  writePrivate(WORKTREES_FILE, JSON.stringify({ worktrees: change(readWorktrees()), removed }, null, 2));
  for (const tell of worktreeFollowers) tell();
}

// Those following this box's worktrees (`kuvo/worktrees/events`), told of each change made here.
export const worktreeFollowers = new Set();
