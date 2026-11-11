// Where macOS and Linux differ, for the box's code, which runs on both: this Mac's box and each
// machine's. Everything else is the same code on both; what differs is decided here, each side
// tested (test/platform.test.ts) on whichever system runs the tests.
//
// Also the same rule elsewhere, in shell: the update's restore script tells the link it started
// by its command line, in /proc or from `ps` (`keepForRollback`'s `restore.sh`,
// link/updates/update.ts).

import { execFile, execFileSync, spawn } from "node:child_process";
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
 * its number after a crash or a restart: its command line says so. Linux: in /proc. A Mac, which has
 * no /proc: `ps` (kept a moment, as this is asked often), or if that doesn't answer, that it's alive.
 * This Mac's app's box and its bridge take its being alive anyway: the app removes the records that
 * name its processes as they stop. `proc`: where /proc is (a test's own).
 */
export function processRuns(pid: unknown, name: string, proc = "/proc"): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 1 || !alive(pid as number)) return false;
  try {
    return fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8").includes(name);
  } catch {
    if (fs.existsSync(proc)) return false;
    if (process.env.KUVO_BOX === "mac" || (process.env.KUVO_AGENTS_HOME && !process.env.KUVO_AGENTS_REMOTE)) return true;
    return commandLine(pid as number)?.includes(name) ?? true;
  }
}

const commandLines = new Map<number, { line: string | undefined; at: number }>();
const COMMAND_LINE_KEPT = 2_000;

/** `pid`'s command line as `ps` says (undefined: it couldn't be asked, in a sandbox, say). */
function commandLine(pid: number): string | undefined {
  const now = performance.now();
  const kept = commandLines.get(pid);
  if (kept && now - kept.at < COMMAND_LINE_KEPT) return kept.line;
  let line: string | undefined;
  try {
    line = execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {}
  if (commandLines.size > 200) commandLines.clear();
  commandLines.set(pid, { line, at: now });
  return line;
}

/** `pid`'s command line: Linux's /proc (its words joined by spaces), a Mac's `ps`; undefined when
 * it can't be read (it's gone, a sandbox refuses `ps`). */
export function commandLineOf(pid: number, proc = "/proc"): string | undefined {
  try {
    return fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    if (fs.existsSync(proc)) return undefined;
    return commandLine(pid)?.trim() || undefined;
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
 * restart), then your account's own (its passwd entry), else sh.
 */
export function loginShell(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  const given = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : undefined;
  if (platform === "darwin") return given ?? "/bin/zsh";
  if (given && given !== "/bin/sh") return given;
  const own = accountShell();
  return own ?? given ?? "/bin/sh";
}

/** Your account's shell on Linux, from its passwd entry: /etc/passwd, else the directory's (`getent`, LDAP). Not `os.userInfo()`, which Bun answers from `$SHELL`. */
function accountShell(): string | undefined {
  const uid = String(process.getuid?.() ?? "");
  const shellOf = (entries: string) => entries.split("\n").map(line => line.split(":")).find(fields => fields[2] === uid)?.[6]?.trim();
  let shell: string | undefined;
  try {
    shell = shellOf(fs.readFileSync("/etc/passwd", "utf8"));
  } catch {}
  if (!shell) {
    try {
      shell = shellOf(execFileSync("getent", ["passwd", uid], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }));
    } catch {}
  }
  return shell && path.isAbsolute(shell) ? shell : undefined;
}

const LOGIN_PATH_MARKERS = ["__KUVO_PATH__", "__KUVO_END__"] as const;

/**
 * Runs the shell (`$0`, with its flags and command) under a watch in its process group: once the
 * read is over (`loginPath` closes the watch's input), or the box's process is gone before it is
 * (stopped, crashed: the pipe closes with it), the watch kills all of it, and the group the shell
 * may have moved into of its own as it started (interactive fish). An interactive shell takes no
 * notice of SIGTERM, and one whose startup files hang would otherwise run on, with nothing left
 * to stop it.
 */
const WATCHED = 'exec 3<&0 </dev/null; "$0" "$@" 3<&- & s=$!; { read -r _ <&3; kill -9 -$s; kill -9 0; } >/dev/null 2>&1 & exec 3<&-; wait $s; kill -9 -$s 2>/dev/null; kill -9 0';

/** Folders as one PATH, each once, the first place it's named. */
export function joinPath(...folders: (string | undefined)[]): string {
  return [...new Set(folders.flatMap(list => (list ?? "").split(":")).filter(Boolean))].join(":");
}

/**
 * The PATH your login shell sets up (`~/.local/bin` from your profile, nvm's node from .bashrc or
 * .zshrc), which a command over SSH, cron or launchd doesn't get: what the engine and the agents'
 * programs need to find what you installed. Read as a terminal would have it, an interactive login
 * shell, then a login shell only (one whose startup files hang, fail or exit), in a login's
 * environment (none of the box's own folders or keys, but your SSH agent's socket); then the
 * folders `env`'s PATH had that it doesn't, after its own (a profile may set PATH outright).
 * Undefined when neither answers in time, or with a shell that takes no POSIX flags (nushell, csh).
 * What its startup files start in the background is stopped with it, and what leaves it (a daemon,
 * like an `ssh-agent` a .bashrc starts when there's none) is let go: each read can leave one, so
 * read it once and keep it (`saveLoginPath`). Nor does it outlive the box's process (`WATCHED`).
 */
export async function loginPath(env: Record<string, string | undefined> = process.env, wait = { interactive: 6_000, login: 2_000 }): Promise<string | undefined> {
  const shell = loginShell(env);
  if (/\/(nu|csh|tcsh)$/.test(shell)) return undefined;
  const kept = Object.entries(env).filter(([name, value]) => value !== undefined && (/^(HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TERM|TMPDIR|PATH|SSH_AUTH_SOCK)$/.test(name)));
  const login: Record<string, string> = { ...Object.fromEntries(kept as [string, string][]), SHELL: shell, DISABLE_AUTO_UPDATE: "true" };
  for (const [flags, timeout] of [["-ilc", wait.interactive], ["-lc", wait.login]] as const) {
    const found = await new Promise<string | undefined>(resolve => {
      let output = "";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("/bin/sh", ["-c", WATCHED, shell, flags, `printf '%s%s%s' ${LOGIN_PATH_MARKERS[0]} "$PATH" ${LOGIN_PATH_MARKERS[1]}`], { cwd: login.HOME, env: login, detached: true, stdio: ["pipe", "pipe", "ignore"] });
      } catch {
        return resolve(undefined);
      }
      let settled = false;
      let gone: ReturnType<typeof setTimeout> | undefined;
      const done = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(gone);
        // The watch stops it all; should the watch not be there to (stopped itself), its group is.
        child.stdin?.destroy();
        setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 1_000).unref();
        // What left its group (a daemon) may still hold its output open: let go of it, so it never
        // keeps this running.
        child.stdout?.destroy();
        child.unref();
        resolve(value);
      };
      const timer = setTimeout(() => done(undefined), timeout);
      child.stdout?.on("data", chunk => {
        output += chunk;
        const at = output.indexOf(LOGIN_PATH_MARKERS[0]);
        const end = at < 0 ? -1 : output.indexOf(LOGIN_PATH_MARKERS[1], at);
        if (end >= 0) done(joinPath(output.slice(at + LOGIN_PATH_MARKERS[0].length, end).trim()) || undefined);
      });
      child.on("error", () => done(undefined));
      child.on("close", () => done(undefined));
      // The shell gone without saying (it exec'd away, or exited) while something it started holds
      // its output: what it printed is read by a moment after.
      child.on("exit", () => { if (!settled) gone = setTimeout(() => done(undefined), 300); });
    });
    if (found) return joinPath(found, env.PATH);
  }
  return undefined;
}

/** Where a box keeps the PATH its engine's start read (`run/login-path` in its folder). */
const savedPathFile = (home: string) => path.join(home, "run", "login-path");

/** The PATH the box's engine started with, as its start read it, if it did. */
export function savedLoginPath(home: string): string | undefined {
  try {
    const saved = fs.readFileSync(savedPathFile(home), "utf8").trim();
    return saved.startsWith("/") ? saved : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a PATH read, for what starts after (the link, the agents' bridge) to use rather than read again. */
export function saveLoginPath(home: string, value: string): void {
  try {
    fs.mkdirSync(path.dirname(savedPathFile(home)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(savedPathFile(home) + ".new", value + "\n", { mode: 0o600 });
    fs.renameSync(savedPathFile(home) + ".new", savedPathFile(home));
  } catch {}
}

/**
 * Which setup of the box's sandbox its `on` file is (a token written as it's set up, a new one each
 * time): what the agents bridge's note that its agents all run in it is for. "" when it isn't set up.
 */
export function sandboxGeneration(on: string): string {
  try {
    return fs.readFileSync(on, "utf8").trim();
  } catch {
    return "";
  }
}

/** How a process and what it started are using the computer, at one moment. */
export interface ProcessUse {
  command: string;
  /** All its threads are asleep, waiting for something: none running, held up on a disk, or paused by someone. */
  waiting: boolean;
  /** Its own CPU time so far, in seconds. */
  seconds: number;
  /** All that it started's, in seconds, and whether any of that is running (or on a disk) now. */
  below: { seconds: number; running: boolean };
}

interface ProcessRow {
  pid: number;
  ppid: number;
  state: string;
  seconds: number;
}

/** `row`'s tree, by its parents' numbers. */
function useOf(rows: ProcessRow[], pid: number, command: string, asleep: string): ProcessUse | null {
  const own = rows.find(row => row.pid === pid);
  if (!own) return null;
  const below = { seconds: 0, running: false };
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  const seen = new Set([pid]);
  const left = [...(children.get(pid) ?? [])];
  while (left.length) {
    const row = left.pop()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    below.seconds += row.seconds;
    if (!asleep.includes(row.state) && row.state !== "Z") below.running = true;
    left.push(...(children.get(row.pid) ?? []));
  }
  return { command, waiting: asleep.includes(own.state), seconds: own.seconds, below };
}

/** Linux: from /proc (`proc`, a test's own), each process's state and CPU time; `stat`'s fields after its name, its name being anything. The system counts time in hundredths of a second for every program. */
function linuxUse(pid: number, proc: string): ProcessUse | null {
  const rows: ProcessRow[] = [];
  for (const name of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`${proc}/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // (A process's own, and for those it started, those that have ended too.)
      const [utime, stime, cutime, cstime] = fields.slice(11, 15).map(Number);
      rows.push({ pid: Number(name), ppid: Number(fields[1]), state: fields[0], seconds: (utime + stime + (Number(name) === pid ? 0 : cutime + cstime)) / 100 });
    } catch {}
  }
  let command = "";
  try { command = fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(); } catch { return null; }
  const use = useOf(rows, pid, command, "S");
  // A process's own state is only its main thread's here (macOS's `ps` goes by all of them).
  return use && { ...use, waiting: use.waiting && threadsAsleep(pid, proc) };
}

/** Whether all a process's threads are asleep, as far as can be told. */
function threadsAsleep(pid: number, proc: string): boolean {
  try {
    return fs.readdirSync(`${proc}/${pid}/task`).every(thread => {
      const stat = fs.readFileSync(`${proc}/${pid}/task/${thread}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).startsWith("S");
    });
  } catch {
    return false;
  }
}

/** A `ps` time, `[[dd-]hh:]mm:ss[.cc]`, in seconds; NaN when it isn't one. */
export function cpuSeconds(time: string): number {
  const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
  const parts = clock.split(":").map(Number);
  if (!/^\d+$/.test(days) || parts.length < 2 || parts.length > 3 || parts.some(Number.isNaN)) return NaN;
  return Number(days) * 86_400 + parts.reduce((total, part) => total * 60 + part, 0);
}

/** macOS, which has no /proc: `ps`'s table, as `ps -A -o pid=,ppid=,state=,time=,command=` prints it. */
export function macUse(table: string, pid: number): ProcessUse | null {
  const rows: ProcessRow[] = [];
  let command = "";
  for (const line of table.split("\n")) {
    const found = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    const seconds = found ? cpuSeconds(found[4]) : NaN;
    if (!found || Number.isNaN(seconds)) continue;
    rows.push({ pid: Number(found[1]), ppid: Number(found[2]), state: found[3][0], seconds });
    if (Number(found[1]) === pid) command = found[5];
  }
  return useOf(rows, pid, command, "SI");
}

/**
 * How `pid` and what it started are using the computer now; null when that can't be told (it's gone,
 * or this computer has neither /proc nor `ps`). `proc`: where /proc is (a test's own).
 */
export async function processUse(pid: number, proc = "/proc"): Promise<ProcessUse | null> {
  if (fs.existsSync(proc)) {
    try { return linuxUse(pid, proc); } catch { return null; }
  }
  const table = await new Promise<string | null>(resolve => {
    execFile("/bin/ps", ["-A", "-o", "pid=,ppid=,state=,time=,command="], { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (error, output) => resolve(error ? null : output));
  });
  return table === null ? null : macUse(table, pid);
}
