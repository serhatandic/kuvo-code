// Your account on this computer, as the system has it: the box and the coding agents' bridge both
// ask (a real box's folder is in your own home, never a test's).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The home folder, as its HOME names it (as the shell and the engine have it), read each time: a
 * test's own HOME counts under Bun too, which otherwise keeps the one it started with. */
export function homeFolder(): string {
  return process.env.HOME || os.homedir();
}

let account: { name: string; home: string } | undefined;
/** Your account as the system has it, whatever HOME and USER say (Bun's `os.userInfo()` follows
 * them, and a machine's keeper starts the engine with neither USER nor LOGNAME): `id -P` on macOS,
 * `getent passwd` on Linux, the password file without it. */
function accountEntry(): { name: string; home: string } {
  if (account) return account;
  // (Never `os.userInfo()` alone: it throws for an account with no passwd entry, as a container's.)
  const uid = process.getuid?.() ?? -1;
  let line: string | undefined;
  if (process.platform === "darwin") {
    line = spawnSync("/usr/bin/id", ["-P"], { encoding: "utf8", timeout: 5000 }).stdout;
  } else {
    line = spawnSync("getent", ["passwd", String(uid)], { encoding: "utf8", timeout: 5000 }).stdout;
    if (!line?.trim()) {
      try { line = fs.readFileSync("/etc/passwd", "utf8").split("\n").find(each => each.split(":")[2] === String(uid)); } catch {}
    }
  }
  const fields = line?.trim().split(":") ?? [];
  let home = fields[process.platform === "darwin" ? 8 : 5] || "";
  if (!path.isAbsolute(home)) try { home = os.userInfo().homedir; } catch { home = homeFolder(); }
  account = { name: fields[0] || "", home };
  return account;
}

/** Your account's own home folder, as the system has it, whatever HOME says. */
export function accountHome(): string {
  return accountEntry().home;
}

/** Your account's name, as the system has it (zsh's `%n`), whatever USER says: empty when it has
 * none (an account with no passwd entry). */
export function accountName(): string {
  return accountEntry().name;
}

/**
 * Whether the coding agents' bridge's folder (`KUVO_AGENTS_HOME`, `…/agents`) is a real box's: a Mac
 * app's (in `run.kuvo.code…`, any copy's) or a machine's (`~/.kuvo-code/agents`, in your account's
 * own home), as `REAL_BOX` (link/home.ts) judges the box's. Never a test's, whoever started it.
 */
export function isRealBridgeFolder(folder: string, home: string = accountHome()): boolean {
  const located = (each: string) => {
    try {
      return fs.realpathSync.native(each);
    } catch {
      return path.resolve(each);
    }
  };
  const parent = located(path.dirname(folder));
  return path.basename(parent).toLowerCase().startsWith("run.kuvo.code") || parent === located(path.join(home, ".kuvo-code"));
}
