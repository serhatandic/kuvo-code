// Commands the box runs itself, outside the sandbox, for an agent: the vault's `vault_run` (with
// values from the vault) and an Allow Once of the sandbox's (fence/outside.ts). With the user's
// shell, in the conversation's folder, without what only the box's own process should have.

import { spawn } from "node:child_process";
import fs from "node:fs";

// What the box's own process has that no command it runs should.
const PRIVATE = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_HOST_VAULT_SECRET", "KUVO_VAULT_FILE_KEY", "BUN_BE_BUN"];
// What's kept of a command's output: its last few megabytes.
const MOST_KEPT = 4 * 1024 * 1024;

/** The environment a command gets: the box's, without its own passwords and keys. */
export function commandEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !PRIVATE.includes(name)) env[name] = value;
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
    child.on("error", error => take(Buffer.from(String(error.message))));
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      running.delete(name);
      resolve({ output: output.toString("utf8"), code, timedOut });
    });
  });
}
