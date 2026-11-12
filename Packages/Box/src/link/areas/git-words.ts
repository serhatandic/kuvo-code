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

/** What `box/git.json` keeps: the branch prefix a client last gave (before boxes kept their own
 * in their settings), and whether a Mac's settings from before moved here (`moved`). */
function readGitFile(file = BRANCH_PREFIX_FILE): Record<string, unknown> {
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(kept) ? kept : {};
  } catch {
    return {};
  }
}

/** `box/git.json` with `change` made, the rest as it was. */
export function keepInGitFile(change: Record<string, unknown>, file = BRANCH_PREFIX_FILE): void {
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
 * else the one a client last gave (an older Mac sends its own with each worktree), or `kuvo/`. */
export function branchPrefixHere(file = CONFIG_FILE, gitFile = BRANCH_PREFIX_FILE): string {
  const set = valueAt(settingsHere(file), [...GIT_SETTINGS.branchPrefix]);
  if (typeof set === "string") return cleanBranchPrefix(set);
  const kept = readGitFile(gitFile).branchPrefix;
  return typeof kept === "string" ? cleanBranchPrefix(kept) : DEFAULT_BRANCH_PREFIX;
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

/** What `kuvo/git/settings/move` answers: whether this box took them now, and its settings as they are. */
export type Moved = { status: 200; moved: boolean; settings: Record<string, unknown> } | { status: 400 | 409 | 500; message: string };

// COMPAT(0.7 mac-git-settings): a Mac's Settings › Git from before boxes kept their own, moved to each box once. Goes 3 months after 0.8.0.
/** A Mac's Settings › Git from before, given to this box: each kept where this box has none of its
 * own yet, the first time only (`box/git.json`'s `moved`), so a later one from another Mac, or
 * after you cleared one here, changes nothing. */
export function moveGitSettings(given: unknown, file = CONFIG_FILE, lock = CONFIG_LOCK, gitFile = BRANCH_PREFIX_FILE): Moved {
  if (!isObject(given)) return { status: 400, message: "Send {branchPrefix?, commitInstructions?, pullRequestInstructions?}." };
  const offered = (Object.keys(GIT_SETTINGS) as GitSetting[]).filter(key => key in given && given[key] !== null);
  if (offered.some(key => typeof given[key] !== "string" || (given[key] as string).length > 10_000)) return { status: 400, message: "Each is text." };
  if (!ownsSettings()) return { status: 409, message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." };
  return locked(lock, () => {
    const { settings, problem } = readSettings(file);
    if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}` };
    if (readGitFile(gitFile).moved === true) return { status: 200, moved: false, settings: settings! };
    const changes: SettingChange[] = offered
      .filter(key => valueAt(settings, [...GIT_SETTINGS[key]]) === undefined)
      .map(key => ({ path: [...GIT_SETTINGS[key]], value: key === "branchPrefix" ? given[key] : (given[key] as string).trim() }))
      // (No instructions is what a box without any has already.)
      .filter(change => change.value !== "" || change.path[0] === GIT_SETTINGS.branchPrefix[0]);
    const written = changes.length ? writeSettings(settings!, changes, file) : { status: 200 as const, settings: settings! };
    if (written.status !== 200) return { status: written.status, message: written.message };
    keepInGitFile({ moved: true }, gitFile);
    return { status: 200, moved: changes.length > 0, settings: written.settings };
  });
}
