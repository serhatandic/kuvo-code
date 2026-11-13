// Commands the box runs itself, outside the sandbox, for an agent: the vault's `vault_run` (with
// values from the vault) and an Allow Once of the sandbox's (fence/outside.ts). With the user's
// shell, in the conversation's folder, without what only the box's own process should have.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { loginEnvironment } from "../shared/platform";

// What the box's own process has that no command it runs should (besides Kuvo Code's and the
// engine's own variables).
const PRIVATE = ["BUN_BE_BUN", "BUN_RUNTIME_TRANSPILER_CACHE_PATH"];
// What's kept of a command's output: its last few megabytes.
const MOST_KEPT = 4 * 1024 * 1024;

/** The environment a command gets: the box's, without its own passwords, keys and variables, and
 * with your own folders back where a machine's launch pointed them into Kuvo Code's (`KUVO_OWN_…`:
 * the value before, empty for none), as the engine's commands have them, so `gh`, git and npm find
 * their sign-ins, settings and caches. */
export function commandEnv(from: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(from)) {
    if (value === undefined || PRIVATE.includes(name) || name.startsWith("KUVO_") || name.startsWith("OPENCODE_")) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(from)) {
    if (!name.startsWith("KUVO_OWN_") || value === undefined) continue;
    const own = name.slice("KUVO_OWN_".length);
    if (!own) continue;
    if (value) env[own] = value;
    else delete env[own];
  }
  return env;
}

// What a login shell's environment has that a command you asked for never gets from it: what runs
// before a program's own code (libraries loaded into it, Node's and Bun's options: an agent's
// command can write your startup files), Kuvo Code's and the engine's own, and the shell's own
// place in its folders and nesting.
const NOT_FROM_LOGIN = /^(DYLD_|BUN_|KUVO_|OPENCODE_)|^(NODE_OPTIONS|PWD|OLDPWD|SHLVL|_)$/;
// How long a read of your login shell's environment is gone by: a commit and its push, or a few
// in a row, read it once.
const LOGIN_READ_FOR = 60_000;
let loginRead: { at: number; env: Promise<Record<string, string> | undefined> } | null = null;

/**
 * The environment for what you ask for yourself (Commit, Push, Merge into…, whose hooks and
 * sign-ins run as yours): `commandEnv`, and on a Mac your login shell's environment as it is now on
 * top, as a new terminal window has it, so what you've changed in your startup files since the box
 * started (a PATH, `GPG_TTY`) counts; read again once it's a minute old. Not on Linux, where a box
 * is started over SSH or at boot, and where a `.bashrc` that starts an `ssh-agent` would leave one
 * more running with each read (agents/proc.ts's `refreshLoginPath`): there, the environment the box
 * started with, as before. Never what `NOT_FROM_LOGIN` names.
 */
export async function askedEnv(from: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): Promise<Record<string, string>> {
  const env = commandEnv(from);
  // (Nor without a home to log in at, nor in a test's box that's told not to: its shell would be
  // the one of whoever runs the tests.)
  if (platform !== "darwin" || !from.HOME || from.KUVO_TEST_LOGIN_ENV === "off") return env;
  if (!loginRead || Date.now() - loginRead.at > LOGIN_READ_FOR) loginRead = { at: Date.now(), env: loginEnvironment(from) };
  const login = await loginRead.env;
  for (const [name, value] of Object.entries(login ?? {})) if (!NOT_FROM_LOGIN.test(name)) env[name] = value;
  return env;
}

// The commands running now, by a name of each's: stopped when this process ends (a newer box
// taking over, an update), and `ended` called for each.
const running = new Map<string, { pid: number; ended?: () => void }>();
process.once("exit", () => {
  for (const { pid, ended } of running.values()) {
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { ended?.(); } catch {}
  }
});

/** Runs `command` with the user's shell in `folder`: its output (the last few megabytes of it), its
 * exit code, and whether it ran out of time. `name` names it while it runs (`ended`: what's left of
 * it to clear away should this process end first). */
export function runCommand(command: string, folder: string, env: Record<string, string>, timeout: number, signal?: AbortSignal, name = String(Math.random()), ended?: () => void): Promise<{ output: string; code: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    const shell = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : "/bin/sh";
    const child = spawn(shell, ["-lc", command], { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    if (child.pid) running.set(name, { pid: child.pid, ended });
    let output = Buffer.alloc(0);
    const take = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MOST_KEPT) output = output.subarray(output.length - MOST_KEPT);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const stop = () => {
      try { process.kill(-child.pid!, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
      setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 3000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    let done = false;
    const end = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      running.delete(name);
      resolve({ output: output.toString("utf8"), code, timedOut });
    };
    child.on("error", error => { take(Buffer.from(String(error.message))); end(null); });
    child.on("close", end);
    // Something it started that left its group and kept its output open: done once the shell is,
    // with what came a moment after.
    child.on("exit", code => setTimeout(() => end(code), 1000).unref());
  });
}
