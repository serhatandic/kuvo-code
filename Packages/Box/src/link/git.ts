// git as the box runs it in your folders: never asking anything, taking no locks it needn't,
// starting nothing the repository's own settings name (`../shared/git`), and what takes a
// while without holding up the bridge.

import { execFile, spawnSync } from "node:child_process";
import { askedArgs, ownArgs, ownArgsLater } from "../shared/git";

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

function ranIn(folder: string, args: string[] | undefined, env: Record<string, string>): string | null {
  if (!args) return null;
  const ran = spawnSync("git", args, { cwd: folder, encoding: "utf8", env: { ...GIT_ENV, ...env }, timeout: 60_000 });
  return ran.status === 0 ? String(ran.stdout ?? "").trim() : null;
}

/** git in `folder`, by the box itself: what it printed (trimmed), or null when it failed. `env`:
 * more of its environment (a scratch index, say). */
export function gitIn(folder: string, args: string[], env: Record<string, string> = {}): string | null {
  return ranIn(folder, ownArgs(args, folder), env);
}

/** git in `folder` doing what you asked for (a worktree, merging one back): the repository's
 * hooks and filters run, as in your terminal. */
export function gitAsked(folder: string, args: string[], env: Record<string, string> = {}): string | null {
  return ranIn(folder, askedArgs(args), env);
}

/** [gitIn] without holding up the bridge, for what takes a while in a big worktree. */
export async function gitLater(folder: string, args: string[]): Promise<string | null> {
  const own = await ownArgsLater(args, folder);
  if (!own) return null;
  return new Promise(resolve => {
    execFile("git", own, { cwd: folder, encoding: "utf8", env: GIT_ENV, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout ?? "").trim()));
  });
}

/** The room `folder` takes, in bytes; undefined when `du` can't say. */
export function sizeLater(folder: string): Promise<number | undefined> {
  return new Promise(resolve => {
    execFile("du", ["-sk", folder], { encoding: "utf8", timeout: 60_000 }, (error, stdout) => {
      const kilobytes = Number(String(stdout ?? "").split(/\s/)[0]);
      resolve(!error && Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined);
    });
  });
}
