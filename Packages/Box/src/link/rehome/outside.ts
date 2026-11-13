// What names the box's folders outside them (#333 §3.4, piece 0's trials 3, 5 and 6), fixed once
// the box is in place, each change journaled first so going back puts it back:
//
// - worktrees' git links: `git worktree repair` run from the repository, with the link files it
//   writes outside the box kept as they were (a prune before the repair would lose the worktree, and
//   the old place is still there until it's cleared, so nothing prunes it);
// - Claude Code's history of a folder (`<its settings folder>/projects/<slug>`), in your own
//   `~/.claude`, and an added account's sign-in (the Keychain item named by its folder's path),
//   copied under the new name with `/usr/bin/security` (which the item trusts: nothing's asked);
// - Grok's sessions of a folder (`<its home>/sessions/<URL-encoded path>`), in your own `~/.grok`.
//
// What's inside the box (an added account's own history, Cursor's records of its agents' folders)
// is rewritten in the staged copy instead (`rewriteAgents`).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Act } from "./state";
import { claudeKeychainService, claudeSlug, grokSessionsName, mapJSON, mapped, moves, type PathMap } from "./paths";

const exists = (file: string): boolean => { try { fs.lstatSync(file); return true; } catch { return false; } };
const listOf = (folder: string): string[] => { try { return fs.readdirSync(folder); } catch { return []; } };
const isFolder = (file: string): boolean => { try { return fs.lstatSync(file).isDirectory(); } catch { return false; } };
const inside = (file: string, folder: string) => file === folder || file.startsWith(folder + "/");

// Git

/** A linked worktree in place, by its `.git` file, and its repository's record of it. */
interface WorktreeLink {
  /** Its folder. */
  worktree: string;
  /** Its record in its repository (`<repository>/.git/worktrees/<name>`), as its `.git` file names it. */
  record: string;
}

/** Folders not looked into for git's links: what's large and never a worktree. */
const NOT_WORKTREES = new Set(["node_modules", ".git", "snapshot", "log", "engine", "cache", "kept", "staging"]);

/** Each worktree and repository in `folder` (as deep as `depth`), by its `.git`: a file for a
 * linked worktree, a folder for a repository. */
function gitIn(folder: string, depth: number, found: { worktrees: string[]; repositories: string[] }): void {
  const git = path.join(folder, ".git");
  let kind: fs.Stats | null = null;
  try { kind = fs.lstatSync(git); } catch {}
  if (kind?.isFile()) found.worktrees.push(folder);
  if (kind?.isDirectory()) found.repositories.push(folder);
  if (kind || depth <= 0) return;
  for (const name of listOf(folder)) {
    if (NOT_WORKTREES.has(name)) continue;
    const each = path.join(folder, name);
    if (isFolder(each)) gitIn(each, depth - 1, found);
  }
}

/** Where a `.git` file says its record is (relative to it, or whole). */
function recordOf(worktree: string): string | null {
  let text = "";
  try { text = fs.readFileSync(path.join(worktree, ".git"), "utf8"); } catch { return null; }
  const found = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return found ? path.resolve(worktree, found[1]) : null;
}

/** A repository's common folder (`.git`), from a worktree's record (its `commondir`). */
function commonOf(record: string): string {
  let common = "../..";
  try { common = fs.readFileSync(path.join(record, "commondir"), "utf8").trim() || common; } catch {}
  return path.resolve(record, common);
}

/** `act` journaled, then `file` written: what it held kept in the journal, to put back. */
function rewriteKept(file: string, write: () => void, journal: (act: Act) => void): void {
  let was: string | null = null;
  try { was = fs.readFileSync(file, "utf8"); } catch {}
  if (was === null) return;
  journal({ act: "wrote", path: file, was });
  write();
}

const git = (args: string[]) => spawnSync("git", args, { encoding: "utf8", timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/** Every worktree link between what's in place (`placed`, the folders the box was put in) and
 * repositories anywhere, repaired from the repository's place now: the files git writes outside
 * what's placed journaled first. */
export function repairWorktrees(placed: readonly string[], map: PathMap, journal: (act: Act) => void): string[] {
  const found = { worktrees: [] as string[], repositories: [] as string[] };
  for (const folder of placed) if (isFolder(folder)) gitIn(folder, 6, found);
  const isPlaced = (file: string) => placed.some(folder => inside(file, folder));
  const links: WorktreeLink[] = [];
  // Worktrees that moved: their records may name where they were, in a repository that moved too or not.
  for (const worktree of found.worktrees) {
    const record = recordOf(worktree);
    if (record) links.push({ worktree, record: mapped(record, map) });
  }
  // Repositories that moved: their worktrees elsewhere name where the repository was.
  for (const repository of found.repositories) {
    for (const name of listOf(path.join(repository, ".git", "worktrees"))) {
      const record = path.join(repository, ".git", "worktrees", name);
      let gitdir = "";
      try { gitdir = fs.readFileSync(path.join(record, "gitdir"), "utf8").trim(); } catch { continue; }
      const worktree = path.dirname(mapped(path.resolve(record, gitdir), map));
      if (!isPlaced(worktree) && exists(path.join(worktree, ".git"))) links.push({ worktree, record });
    }
  }
  const repaired: string[] = [];
  for (const { worktree, record } of links) {
    if (!exists(record)) continue;
    // What git rewrites that's outside the box's folders, kept to put back.
    const gitdirFile = path.join(record, "gitdir"), gitFile = path.join(worktree, ".git");
    let before: { gitdir: string | null; git: string | null } = { gitdir: null, git: null };
    try { before.gitdir = fs.readFileSync(gitdirFile, "utf8"); } catch {}
    try { before.git = fs.readFileSync(gitFile, "utf8"); } catch {}
    for (const file of [gitdirFile, gitFile]) if (!isPlaced(file)) rewriteKept(file, () => {}, journal);
    const common = commonOf(record);
    const result = git(["-C", common, "worktree", "repair", worktree]);
    if (result.status !== 0) throw new Error(`The worktree ${worktree} couldn't be linked again: ${`${result.stderr}`.trim().slice(0, 300)}`);
    // (Unchanged files needn't be journaled; harmless where they are.)
    void before;
    repaired.push(worktree);
  }
  return repaired;
}

// Claude Code

/** The Keychain it's asked of: your own, or a test's (`KUVO_TEST_REHOME_KEYCHAIN`, a test keychain
 * file, never your login keychain). */
const keychain = (): string[] => (process.env.KUVO_TEST_REHOME_KEYCHAIN ? [process.env.KUVO_TEST_REHOME_KEYCHAIN] : []);
const security = (args: string[]) => spawnSync("/usr/bin/security", [...args, ...keychain()], { encoding: "utf8", timeout: 60_000 });

/** An item's account and value (as Claude Code wrote it), or null where there's none. */
function readItem(service: string): { account: string; value: string } | null {
  const found = security(["find-generic-password", "-s", service]);
  if (found.status !== 0) return null;
  const account = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(found.stdout)?.[1];
  if (account === undefined) return null;
  const value = security(["find-generic-password", "-s", service, "-a", account, "-w"]);
  if (value.status !== 0) throw new Error(`Claude Code's sign-in (${service}) couldn't be read.`);
  return { account, value: value.stdout.replace(/\n$/, "") };
}

/** An item written as Claude Code writes it (`-U`, the value in hex). */
export function writeItem(service: string, account: string, value: string): void {
  const written = security(["add-generic-password", "-U", "-a", account, "-s", service, "-X", Buffer.from(value, "utf8").toString("hex")]);
  if (written.status !== 0) throw new Error(`Claude Code's sign-in (${service}) couldn't be written: ${written.stderr.trim().slice(0, 200)}`);
}

export function deleteItem(service: string): void {
  security(["delete-generic-password", "-s", service]);
}

/** An added Claude Code account's sign-in, copied to the name its folder has now (the original kept
 * until the move's done, `clearClaudeSignIns`): journaled first, so going back deletes the copy. */
export function copyClaudeSignIns(accounts: readonly string[], map: PathMap, journal: (act: Act) => void): number {
  if (process.platform !== "darwin") return 0;
  let copied = 0;
  for (const folder of accounts) {
    const from = claudeKeychainService(folder), to = claudeKeychainService(mapped(folder, map));
    if (from === to) continue;
    const item = readItem(from);
    if (!item) continue;
    const there = readItem(to);
    journal({ act: "keychain", service: to, account: item.account, ...(there ? { was: there.value } : {}) });
    writeItem(to, item.account, item.value);
    const back = readItem(to);
    if (back?.value !== item.value) throw new Error(`Claude Code's sign-in for ${path.basename(folder)} didn't read back as it was written.`);
    copied++;
  }
  return copied;
}

/** The originals of the sign-ins copied, deleted once the move's done (no older Kuvo Code finds them). */
export function clearClaudeSignIns(accounts: readonly string[], map: PathMap): void {
  if (process.platform !== "darwin") return;
  for (const folder of accounts) {
    const from = claudeKeychainService(folder), to = claudeKeychainService(mapped(folder, map));
    if (from !== to && readItem(to)) deleteItem(from);
  }
}

/** A copy's undoing: the item deleted, or what was there put back. */
export function undoKeychain(act: { service: string; account: string; was?: string }): void {
  if (act.was !== undefined) writeItem(act.service, act.account, act.was);
  else deleteItem(act.service);
}

/** Each folder's history in a Claude Code settings folder (`projects/<slug>`) renamed to its new
 * folder's: `rename` journals each, where it's outside the box. */
export function renameClaudeHistory(settings: string, folders: Iterable<string>, map: PathMap, rename: (from: string, to: string) => void): number {
  const projects = path.join(settings, "projects");
  if (!isFolder(projects)) return 0;
  let renamed = 0;
  for (const folder of folders) {
    if (!moves(folder, map)) continue;
    const from = path.join(projects, claudeSlug(folder)), to = path.join(projects, claudeSlug(mapped(folder, map)));
    if (from === to || !exists(from)) continue;
    // (One there already under the new name: both kept, the one moved beside it.)
    if (exists(to)) continue;
    rename(from, to);
    renamed++;
  }
  return renamed;
}

/** Grok's sessions of each folder (`sessions/<URL-encoded path>`) renamed to the new folder's. A
 * name too long for a folder's (a slug and a sum of Grok's own) stays, and is said as left. */
export function renameGrokSessions(home: string, map: PathMap, rename: (from: string, to: string) => void): number {
  const sessions = path.join(home, "sessions");
  let renamed = 0;
  for (const name of listOf(sessions)) {
    let folder: string;
    try { folder = decodeURIComponent(name); } catch { continue; }
    if (!path.isAbsolute(folder) || !moves(folder, map)) continue;
    const to = path.join(sessions, grokSessionsName(mapped(folder, map)));
    if (Buffer.byteLength(path.basename(to)) > 255 || exists(to)) continue;
    rename(path.join(sessions, name), to);
    renamed++;
  }
  return renamed;
}

/** Your own settings folders for Claude Code and Grok (the default accounts', which a Mac's box
 * keeps in your home, as the agents do). */
export function ownAgentHomes(): { claude: string; grok: string } {
  const home = os.homedir();
  const grok = process.env.GROK_HOME?.trim();
  return {
    claude: process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude"),
    grok: grok ? (grok === "~" ? home : grok.startsWith("~/") ? path.join(home, grok.slice(2)) : grok) : path.join(home, ".grok"),
  };
}

// In the staged copy

/** The coding agents' bridge's folder as staged (`agents`): each added account's history and
 * sessions renamed for its folders' new places, and Cursor's records of its agents' folders
 * (`agents.ndjson`'s `cwd`) rewritten. */
export function rewriteAgents(staged: string, folders: Iterable<string>, map: PathMap): void {
  const list = [...folders];
  for (const name of listOf(path.join(staged, "claude", "accounts"))) {
    renameClaudeHistory(path.join(staged, "claude", "accounts", name), list, map, (from, to) => fs.renameSync(from, to));
  }
  for (const name of listOf(path.join(staged, "grok", "accounts"))) {
    renameGrokSessions(path.join(staged, "grok", "accounts", name), map, (from, to) => fs.renameSync(from, to));
  }
  // Cursor's: its own (`cursor/agents`) and each added account's.
  const records = [path.join(staged, "cursor", "agents", "agents.ndjson"),
    ...listOf(path.join(staged, "cursor", "accounts")).map(name => path.join(staged, "cursor", "accounts", name, "agents", "agents.ndjson"))];
  for (const file of records) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = text.split("\n").map(line => {
      if (!line.trim()) return line;
      try {
        const { value, changed } = mapJSON(JSON.parse(line), map);
        return changed ? JSON.stringify(value) : line;
      } catch {
        return line;
      }
    });
    const next = lines.join("\n");
    if (next !== text) fs.writeFileSync(file, next);
  }
}

/** The added Claude Code accounts' folders in a bridge's folder (`claude/accounts/<id>`), by where
 * they were. */
export function claudeAccounts(agents: string): string[] {
  return listOf(path.join(agents, "claude", "accounts")).map(name => path.join(agents, "claude", "accounts", name)).filter(isFolder);
}
