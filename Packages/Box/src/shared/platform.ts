// Where macOS and Linux differ, for the box's code, which runs on both: this Mac's box and each
// machine's. Everything else is the same code on both; what differs is decided here, each side
// tested (test/platform.test.ts) on whichever system runs the tests.
//
// Also the same rule elsewhere, in shell: the update's restore script tells the link it started
// by its command line where there's /proc, and by its being alive where there isn't
// (`keepForRollback`'s `restore.sh`, link/updates/update.ts).

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Whether process `pid` is alive (and ours to signal). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` runs `name` (a program's file, `kuvo-agents`, `kuvo-link.js`), not whatever took
 * its number after a crash. Linux: its command line says so. macOS, which has no /proc: that it's
 * alive (this Mac's app removes the records that name its processes as they stop). `proc`: where
 * /proc is (a test's own).
 */
export function processRuns(pid: unknown, name: string, proc = "/proc"): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 1 || !alive(pid as number)) return false;
  try {
    return fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8").includes(name);
  } catch {
    return !fs.existsSync(proc);
  }
}

/**
 * The folders in a home folder that the system asks you about before an app looks into them:
 * on a Mac, its privacy prompts (so a folder list from the home folder doesn't look inside
 * them); none on Linux.
 */
export function promptedFolders(platform: NodeJS.Platform = process.platform): ReadonlySet<string> {
  return platform === "darwin" ? new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"]) : new Set();
}

/**
 * The shell you log in with, whose startup files set up your PATH. macOS: `$SHELL`, else zsh (a
 * new account's). Linux: `$SHELL`, unless it's missing or cron's plain `/bin/sh` (a start after a
 * restart), then your account's own (`getent passwd`), else sh.
 */
export function loginShell(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  const given = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : undefined;
  if (platform === "darwin") return given ?? "/bin/zsh";
  if (given && given !== "/bin/sh") return given;
  try {
    const entry = execFileSync("getent", ["passwd", String(process.getuid?.() ?? "")], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    const shell = entry.trim().split(":")[6];
    if (shell && path.isAbsolute(shell)) return shell;
  } catch {}
  return given ?? "/bin/sh";
}

const LOGIN_PATH_MARKERS = ["__KUVO_PATH__", "__KUVO_END__"] as const;

/**
 * The PATH your login shell sets up (`~/.local/bin` from your profile, nvm's node from .bashrc or
 * .zshrc), which a command over SSH, cron or launchd doesn't get: what the engine and the agents'
 * programs need to find what you installed. Read as a terminal would have it, an interactive login
 * shell, then a login shell only (one whose startup files hang or fail), in a login's environment
 * (none of the box's own folders or keys); undefined when neither answers in time. What its
 * startup files start in the background is stopped with it.
 */
export async function loginPath(options: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform; interactive?: number; login?: number } = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const shell = loginShell(env, options.platform);
  // nushell takes no POSIX flags.
  if (shell.endsWith("/nu")) return undefined;
  const kept = Object.entries(env).filter(([name, value]) => value !== undefined && (/^(HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TERM|TMPDIR|PATH)$/.test(name)));
  const login: Record<string, string> = { ...Object.fromEntries(kept as [string, string][]), SHELL: shell, DISABLE_AUTO_UPDATE: "true" };
  for (const [flags, timeout] of [["-ilc", options.interactive ?? 15_000], ["-lc", options.login ?? 5_000]] as const) {
    const found = await new Promise<string | undefined>(resolve => {
      let output = "";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(shell, [flags, `printf '%s%s%s' ${LOGIN_PATH_MARKERS[0]} "$PATH" ${LOGIN_PATH_MARKERS[1]}`], { cwd: login.HOME, env: login, detached: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return resolve(undefined);
      }
      const done = (value: string | undefined) => {
        clearTimeout(timer);
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
        resolve(value);
      };
      const timer = setTimeout(() => done(undefined), timeout);
      child.stdout?.on("data", chunk => {
        output += chunk;
        const at = output.indexOf(LOGIN_PATH_MARKERS[0]);
        const end = at < 0 ? -1 : output.indexOf(LOGIN_PATH_MARKERS[1], at);
        // Each folder once (a profile that adds one again).
        if (end >= 0) done([...new Set(output.slice(at + LOGIN_PATH_MARKERS[0].length, end).trim().split(":").filter(Boolean))].join(":") || undefined);
      });
      child.on("error", () => done(undefined));
      child.on("close", () => done(undefined));
    });
    if (found) return found;
  }
  return undefined;
}
