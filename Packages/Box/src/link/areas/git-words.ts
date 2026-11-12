// Settings › Git, each computer's own (PROTOCOL.md, "Git"): what a session's branch in a worktree
// starts with, and what you'd like commit messages and pull requests written like, kept in its
// settings (`kuvo/config`, which the engine doesn't read), and the prompts that ask a model to write
// them, the same for every client. A Mac's own from before moves to each box once (`moveGitSettings`).

import fs from "node:fs";
import { isObject } from "../../shared/json";
import { locked, writePrivate } from "../files";
import { CONFIG_LOCK } from "../home";
import { CONFIG_FILE, ownsSettings, readSettings, valueAt, writeSettings } from "./config";
import type { SettingChange } from "./config";
import { BRANCH_PREFIX_FILE } from "./worktree-records";

/** Where each is in the settings. */
export const GIT_SETTINGS = {
  branchPrefix: ["branch_prefix"],
  commitInstructions: ["commit_instructions"],
  pullRequestInstructions: ["pull_request_instructions"],
} as const;
export type GitSetting = keyof typeof GIT_SETTINGS;

export const DEFAULT_BRANCH_PREFIX = "kuvo/";

/** What `box/git.json` keeps: whether a Mac's settings from before moved here (`moved`). (A box
 * from before kept the branch prefix a client last gave there too, `branchPrefix`, taken into the
 * settings once: `keepOldBranchPrefix`.) */
function readGitFile(file = BRANCH_PREFIX_FILE): Record<string, unknown> {
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(kept) ? kept : {};
  } catch {
    return {};
  }
}

/** `box/git.json` with `change` made, the rest as it was. */
function keepInGitFile(change: Record<string, unknown>, file = BRANCH_PREFIX_FILE): void {
  writePrivate(file, JSON.stringify({ ...readGitFile(file), ...change }));
}

/** A branch prefix as git takes it in a branch's name: without spaces, the characters a branch
 * can't have (~ ^ : ? * [ \ and control characters), ".." or a start in - / or .; else every
 * worktree's branch would fail to be made. */
export function cleanBranchPrefix(typed: string): string {
  let prefix = [...typed.trim()].filter(character => !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(character)).join("");
  while (prefix.includes("..")) prefix = prefix.replaceAll("..", ".");
  while (prefix && "-/.".includes(prefix[0]!)) prefix = prefix.slice(1);
  return prefix;
}

const settingsHere = (file = CONFIG_FILE): Record<string, unknown> => readSettings(file).settings ?? {};

/** What a session's own branch starts with here: as Settings › Git has it on this computer, or
 * `kuvo/` where it has none. */
export function branchPrefixHere(file = CONFIG_FILE): string {
  const set = valueAt(settingsHere(file), [...GIT_SETTINGS.branchPrefix]);
  return typeof set === "string" ? cleanBranchPrefix(set) : DEFAULT_BRANCH_PREFIX;
}

/** Your instructions here for a commit message or a pull request, "" for none. */
export function instructionsHere(kind: "commit" | "pullRequest", file = CONFIG_FILE): string {
  const set = valueAt(settingsHere(file), [...GIT_SETTINGS[kind === "commit" ? "commitInstructions" : "pullRequestInstructions"]]);
  return typeof set === "string" ? set.trim() : "";
}

const withInstructions = (prompt: string, instructions: string) =>
  instructions ? `${prompt}\n\nAlso follow these instructions from the user:\n${instructions}` : prompt;

/** What a model is asked to write a commit message from: what the commit takes (`commitDiff`), and
 * your instructions here. */
export function commitPrompt(diff: string, file = CONFIG_FILE): string {
  return withInstructions(`Write a git commit message for the changes below. A summary line in the imperative mood, under 72 characters; then, only if it helps, a blank line and a few short lines on what changed and why. Reply with the message alone: no quotes, no code fences.

${diff}`, instructionsHere("commit", file));
}

/** What a model is asked to write a pull request from: what the branch brings, and your
 * instructions here. Its first line is the title, the rest the description. */
export function pullRequestPrompt(summary: string, file = CONFIG_FILE): string {
  return withInstructions(`Write a pull request for the changes below. The first line is its title: under 72 characters, in the imperative mood. Then a blank line and a short description in Markdown: what changed and why, in a few bullet points, and anything a reviewer should check. Reply with the pull request alone: no preamble, no code fences.

${summary}`, instructionsHere("pullRequest", file));
}

// COMPAT(0.7 box-branch-prefix): the branch prefix a box from before kept in `box/git.json`, taken into its settings once. Goes 3 months after 0.8.0.
/** With the settings' lock held: the branch prefix a box from before kept (the one a client last
 * made a worktree with, so a phone's started as yours did) made Settings › Git's here where it has
 * none, then gone from `box/git.json`, so one you clear here later stays cleared. A problem with the
 * settings, or one not written, leaves it there for next time. */
function takeOldBranchPrefix(file: string, gitFile: string): void {
  const kept = readGitFile(gitFile);
  if (!("branchPrefix" in kept)) return;
  const { settings, problem } = readSettings(file);
  if (problem) return;
  if (typeof kept.branchPrefix === "string" && valueAt(settings, [...GIT_SETTINGS.branchPrefix]) === undefined
    && writeSettings(settings!, [{ path: [...GIT_SETTINGS.branchPrefix], value: kept.branchPrefix }], file).status !== 200) return;
  const { branchPrefix: _taken, ...rest } = kept;
  writePrivate(gitFile, JSON.stringify(rest));
}

/** As the box starts: the branch prefix a box from before kept, taken into its settings, once they
 * are its own (else when a Mac moves its Settings › Git here, `moveGitSettings`). */
export function keepOldBranchPrefix(file = CONFIG_FILE, lock = CONFIG_LOCK, gitFile = BRANCH_PREFIX_FILE): void {
  if (!("branchPrefix" in readGitFile(gitFile)) || !ownsSettings()) return;
  try {
    locked(lock, () => takeOldBranchPrefix(file, gitFile));
  } catch {}
}

/** What `kuvo/git/settings/move` answers: whether this box took them now, and its settings as they are. */
export type Moved = { status: 200; moved: boolean } | { status: 400 | 409 | 500; message: string };

// COMPAT(0.7 mac-git-settings): a Mac's Settings › Git from before boxes kept their own, moved to each box once. Goes 3 months after 0.8.0.
/** A Mac's Settings › Git from before, given to this box: each kept where this box has none of its
 * own yet, the first time any is taken only (`box/git.json`'s `moved`), so a later one from
 * another Mac, or after you cleared one here, changes nothing. */
export function moveGitSettings(given: unknown, file = CONFIG_FILE, lock = CONFIG_LOCK, gitFile = BRANCH_PREFIX_FILE): Moved {
  if (!isObject(given)) return { status: 400, message: "Send {branchPrefix?, commitInstructions?, pullRequestInstructions?}." };
  const offered = (Object.keys(GIT_SETTINGS) as GitSetting[]).filter(key => key in given && given[key] !== null);
  if (offered.some(key => typeof given[key] !== "string")) return { status: 400, message: "Each is text." };
  if (!ownsSettings()) return { status: 409, message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." };
  return locked(lock, () => {
    // (This box's own from before first, as it would have taken it as it started had its settings
    // been its own then.)
    takeOldBranchPrefix(file, gitFile);
    const { settings, problem } = readSettings(file);
    if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}` };
    if (readGitFile(gitFile).moved === true) return { status: 200, moved: false };
    const changes: SettingChange[] = offered
      .filter(key => valueAt(settings, [...GIT_SETTINGS[key]]) === undefined)
      .map(key => ({ path: [...GIT_SETTINGS[key]], value: key === "branchPrefix" ? given[key] : (given[key] as string).trim() }))
      // (No instructions is what a box without any has already.)
      .filter(change => change.value !== "" || change.path[0] === GIT_SETTINGS.branchPrefix[0]);
    // Nothing taken (a Mac with only empty instructions, or none this box hasn't its own of): a
    // later Mac's may still move.
    if (!changes.length) return { status: 200, moved: false };
    const written = writeSettings(settings!, changes, file);
    if (written.status !== 200) return { status: written.status, message: written.message };
    keepInGitFile({ moved: true }, gitFile);
    return { status: 200, moved: true };
  });
}
