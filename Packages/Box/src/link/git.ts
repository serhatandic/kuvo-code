// @ts-nocheck
// git as the box runs it in your folders: never asking anything, taking no locks it needn't, and
// what takes a while without holding up the bridge.

import { execFile, spawnSync } from "node:child_process";

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/** git in `folder`: what it printed (trimmed), or null when it failed. */
export function gitIn(folder, args) {
  const ran = spawnSync("git", args, { cwd: folder, encoding: "utf8", env: GIT_ENV, timeout: 60_000 });
  return ran.status === 0 ? String(ran.stdout ?? "").trim() : null;
}

/** The same without holding up the bridge, for what takes a while in a big worktree. */
export function gitLater(folder, args) {
  return new Promise(resolve => {
    execFile("git", args, { cwd: folder, encoding: "utf8", env: GIT_ENV, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout ?? "").trim()));
  });
}

/** The room `folder` takes, in bytes; undefined when `du` can't say. */
export function sizeLater(folder) {
  return new Promise(resolve => {
    execFile("du", ["-sk", folder], { encoding: "utf8", timeout: 60_000 }, (error, stdout) => {
      const kilobytes = Number(String(stdout ?? "").split(/\s/)[0]);
      resolve(!error && Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined);
    });
  });
}
