// Whether this box runs agents' commands in the sandbox, and setting it up: the box writes the
// sandbox's files itself as it starts (the launcher, each system's rules, the engine's plugin), on
// this Mac and on each machine alike, checks that a command in it really can't reach what it
// hides, and only then sends commands through it. `fenceState().on` is what others go by (the
// vault opens to agents, bots work on their own): true only when every command the engine runs
// here goes through the sandbox, checked.
//
// The coding agents' own programs (Claude Code, Codex…) run their commands themselves, not
// through the engine: `on` says nothing of them (`agents` does, false until they're sandboxed too).

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listOf, textOf, writePrivate } from "../files";
import { processRuns, sandboxGeneration } from "../../shared/platform";
import { BOTS, BRIDGE_FILE, CHATS, ENGINE_CONFIG, ENGINE_FILE, K, RUN, SANDBOX_NOTE, SESSION_WAKES, SOCKET_KEY_FILE, SSH_AGENTS, SSH_FOR } from "../home";
import { tellLauncher } from "./allowed";
import { agentShellScript, agentsNote, launcherScript, pluginScript, type FencePlaces } from "./files";
import { LANDLOCK_RUNNER, landlockPolicy } from "./landlock";
import { fencePolicy, realish } from "./policy";
import { seatbeltProfile } from "./seatbelt";

export interface FenceState {
  /** Every command the engine runs on this box goes through the sandbox, checked. */
  on: boolean;
  /** Why not, in words for the box's page in Settings. */
  why?: string;
  /** This computer can sandbox commands at all. */
  able: boolean;
  /** Every coding agent's process here runs in it too: none started before it was on still runs. */
  agents: boolean;
  /** Why not, for a client to map without reading `why`, and what you can do about it. */
  reason?: FenceReason;
  action?: FenceAction;
  /** The box's route that does it, where there's one. */
  route?: string;
  /** What this computer needs first (`kernel`): "Linux 5.13". */
  needs?: string;
  /** Which part of the check failed (`checkFailed`). */
  check?: FenceCheck;
  /** Checks failed in a row (`checkFailed`, `checking`). */
  failures?: number;
}

export type FenceReason = "kernel" | "macos" | "engineMissing" | "checking" | "checkFailed" | "plugin" | "engineDown" | "waiting";
export type FenceAction = "help" | "softwareUpdate" | "retry" | "fix" | "restartEngine";
export type FenceCheck = "folder" | "tempFiles" | "readsOwn" | "writesOwn" | "didntRun" | "setup";

const CHECK = "POST kuvo/sandbox/check";
const RESTART = "POST kuvo/engine/restart";

const FOLDER = realish(path.join(RUN, "fence"));
const PLUGIN = path.join(ENGINE_CONFIG || path.join(K, "config"), "opencode", "plugins", "kuvo-sandbox.js");
const NOTE = path.join(FOLDER, "engine.json");
const PROBE = path.join(FOLDER, "probe");
// Tells kuvo-wake its watches' checks run in the sandbox, as commands do: there while the engine has
// the plugin.
const ON = path.join(FOLDER, "on");
// And that it's set up and checked here, so a check waits while it isn't on yet rather than run
// without it (where the box can't set it up, commands run as before, and checks with them).
const READY = path.join(FOLDER, "ready");
const platform: "darwin" | "linux" = process.platform === "darwin" ? "darwin" : "linux";

const places: FencePlaces = {
  folder: FOLDER,
  launcher: path.join(K, "bin", "kuvo-fence"),
  runner: path.join(K, "bin", "kuvo-fence.js"),
  inside: [realish(BOTS), realish(CHATS)],
  probe: PROBE,
  bots: BOTS,
  wakes: SESSION_WAKES,
  key: SOCKET_KEY_FILE,
  sshFor: SSH_FOR,
  sshAgents: SSH_AGENTS,
  platform,
};
const VERSION = crypto.createHash("sha256")
  .update(launcherScript(places)).update(LANDLOCK_RUNNER).update(pluginScript(places, ""))
  .digest("hex").slice(0, 16);

/** The sandbox is on wherever it can run, with no switch: only Kuvo Code's own kill switch, for a
 * rollout (`KUVO_SANDBOX=off` in the box's environment as it starts), turns it off. */
export function fenceWanted(): boolean {
  return process.env.KUVO_SANDBOX !== "off";
}

type Checked = { able: boolean; passed: boolean; why?: string; reason?: FenceReason; needs?: string; check?: FenceCheck };
let checked: Checked = { able: false, passed: false, why: "It hasn't been checked yet.", reason: "checking" };
let failures = 0;
let lastProfiles = "";

/** Whether the sandbox is on here: read each time from what the box knows, without waiting. */
export function fenceState(): FenceState {
  const base = { able: checked.able, agents: agentsAllInside() };
  // Kuvo Code's own kill switch: no reason a client shows, as there's nothing you can do.
  if (!fenceWanted()) return { ...base, on: false, why: "Kuvo Code has it turned off on this computer for now." };
  if (!checked.passed) return { ...base, on: false, ...cannot(checked) };
  return { ...base, ...loaded() };
}

/** Whether the engine has the sandbox's plugin, as it is now: on, or why not. */
function loaded(): Pick<FenceState, "on" | "why" | "reason" | "action" | "route"> {
  if (textOf(PLUGIN) !== pluginScript(places, VERSION)) return { on: false, why: "Its plugin for the engine was changed or removed.", reason: "plugin", action: "fix", route: CHECK };
  let engine: { pid?: number } = {};
  try { engine = JSON.parse(fs.readFileSync(ENGINE_FILE, "utf8")); } catch {
    return { on: false, why: "The engine isn't running.", reason: "engineDown", action: "restartEngine", route: RESTART };
  }
  let note: { pid?: number; version?: string } = {};
  try { note = JSON.parse(fs.readFileSync(NOTE, "utf8")); } catch {}
  if (note.pid === engine.pid && note.version === VERSION) return { on: true };
  // An engine that started after the plugin was there loads it for each folder it opens, before
  // any command runs in it.
  try {
    if (fs.statSync(PLUGIN).mtimeMs <= fs.statSync(ENGINE_FILE).mtimeMs) return { on: true };
  } catch {}
  return { on: false, why: "Waiting for the engine to load it.", reason: "waiting", action: "restartEngine", route: RESTART };
}

/** Whether the engine's commands run in the sandbox now, as any of the box's processes can tell
 * (only the one that set it up knows why not): set up and checked (`run/fence/on`, which goes as a
 * check fails), and loaded by the engine. */
export function engineCommandsInSandbox(): boolean {
  return fenceWanted() && fs.existsSync(ON) && loaded().on;
}

/** Whether the coding agents' own programs (Claude Code, Codex, Cursor, Grok, Antigravity, whose
 * commands don't go through the engine) run in it: each runs whole in it, as the bridge starts
 * it, while it's set up and checked (`run/fence/on`, which the bridge reads too). One begun before
 * finishes its turn as it started; the next starts it again in it. */
export const agentsCommandsInSandbox = (): boolean => fenceWanted() && fs.existsSync(ON);

/** Whether every coding agent's process here runs in it now: the agents bridge says so for the
 * sandbox as it is (`run/fence/agents`; none it started before it was on still runs), or none runs.
 * What opens the vault to agents. */
export function agentsAllInside(): boolean {
  if (!agentsCommandsInSandbox()) return false;
  let bridge: { pid?: number } | null = null;
  try { bridge = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8")); } catch {}
  if (!bridge?.pid || !processRuns(bridge.pid, "kuvo-agents")) return true;
  try {
    const said = JSON.parse(fs.readFileSync(path.join(FOLDER, "agents"), "utf8"));
    const on = sandboxGeneration(ON);
    return Boolean(on) && said.pid === bridge.pid && said.on === on;
  } catch {
    return false;
  }
}

// Why a box doesn't have it on, and what you can do.
function cannot(why: Checked): Partial<FenceState> {
  const said = why.why ? { why: why.why } : {};
  switch (why.reason) {
    case "kernel": return { ...said, reason: "kernel", action: "help", needs: why.needs };
    case "macos": return { ...said, reason: "macos", action: "softwareUpdate" };
    case "engineMissing": return { ...said, reason: "engineMissing", action: "retry", route: CHECK };
    case "checkFailed": return { ...said, reason: "checkFailed", check: why.check, action: "retry", route: CHECK, failures };
    default: return { ...said, reason: "checking", action: "retry", route: CHECK, failures };
  }
}

/** Kuvo Code's own servers here, whose ports the sandbox refuses where the system can (macOS). */
let ownPort: number | null = null;
export function fenceOwnPort(port: number) {
  ownPort = port;
}
function kuvoPorts(): number[] {
  const ports = new Set<number>();
  const add = (value: unknown) => { if (Number.isInteger(value) && (value as number) > 0) ports.add(value as number); };
  for (const file of [ENGINE_FILE, BRIDGE_FILE]) {
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      add(record.port);
      add(record.agentsPort);
    } catch {}
  }
  try { add(Number(new URL(JSON.parse(fs.readFileSync(path.join(RUN, "host.json"), "utf8")).url).port)); } catch {}
  // The app's own server for Kuvo Code's tools (run/tools.json, as the agents bridge notes it).
  try { add(JSON.parse(fs.readFileSync(path.join(RUN, "tools.json"), "utf8")).port); } catch {}
  add(ownPort);
  return [...ports].sort((a, b) => a - b);
}

/** Bun, to run the Linux script: the box's own when it runs on the engine's (a machine's does),
 * else the engine's. */
function runtime(): string | null {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return process.execPath;
  try {
    const version = JSON.parse(fs.readFileSync(ENGINE_FILE, "utf8")).version;
    const engine = path.join(K, "engine", String(version), "opencode");
    if (fs.existsSync(engine)) return engine;
  } catch {}
  return null;
}

function writeProfiles(): void {
  const policy = fencePolicy(platform === "darwin" ? kuvoPorts() : []);
  // (policy.json on both: Linux's sandbox reads it, and the coding agents' bridge gives each agent
  // the same rules in its own terms.)
  const files: [string, string][] = platform === "darwin"
    ? [["project.sb", seatbeltProfile(policy, { inside: false })], ["inside.sb", seatbeltProfile(policy, { inside: true })],
        ["project-agent.sb", seatbeltProfile(policy, { inside: false, agent: true })], ["inside-agent.sb", seatbeltProfile(policy, { inside: true, agent: true })], ["policy.json", landlockPolicy(policy)]]
    : [["policy.json", landlockPolicy(policy)], ["runtime", runtime() ?? ""]];
  const text = files.map(([name, body]) => name + body).join("");
  if (text === lastProfiles) return;
  for (const [name, body] of files) writePrivate(path.join(FOLDER, name), body);
  lastProfiles = text;
}

function writeExecutable(file: string, text: string): void {
  if (textOf(file) === text) return;
  writePrivate(file, text);
  fs.chmodSync(file, 0o700);
}

/** Whether this computer can sandbox commands at all, and why not. */
function able(): Checked {
  if (platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec") ? { able: true, passed: false } : { able: false, passed: false, why: "macOS's sandbox isn't on this Mac.", reason: "macos" };
  if (!runtime()) return { able: false, passed: false, why: "The engine isn't installed here yet.", reason: "engineMissing" };
  if (!fs.existsSync("/sys/kernel/security/landlock") && !/landlock/.test(textOf("/sys/kernel/security/lsm") ?? "landlock")) {
    return { able: false, passed: false, why: `Linux ${os.release().split("-")[0]} can't sandbox commands: it needs Landlock (Linux 5.13 or later, with it on).`, reason: "kernel", needs: "Linux 5.13" };
  }
  return { able: true, passed: false };
}

/**
 * Runs one command through the launcher, as the engine would, and checks what the sandbox must
 * do: it writes in its folder and its temporary folder, and can neither read nor write Kuvo Code's.
 */
function probe(): { passed: boolean; why?: string; check?: FenceCheck } {
  fs.rmSync(PROBE, { recursive: true, force: true });
  fs.mkdirSync(PROBE, { recursive: true, mode: 0o700 });
  const hidden = path.join(FOLDER, "hidden");
  const escaped = path.join(FOLDER, "escaped");
  writePrivate(hidden, "hidden\n");
  fs.rmSync(escaped, { force: true });
  const script = [
    `cd "$0" || exit 10`,
    `echo ok > written && [ "$(cat written)" = ok ] || exit 11`,
    `echo ok > "$TMPDIR/probe" || exit 12`,
    `cat "$1" >/dev/null 2>&1 && exit 13`,
    `(echo escaped > "$2") 2>/dev/null`,
    `exit 0`,
  ].join("\n");
  const env: Record<string, string> = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: os.userInfo().homedir, KUVO_FENCE_SHELL: "/bin/sh", KUVO_FENCE_WORK: PROBE };
  const bun = runtime();
  if (bun) env.KUVO_FENCE_RUNTIME = bun;
  const run = spawnSync(places.launcher, ["-c", script, PROBE, hidden, escaped], { env, encoding: "utf8", timeout: 20_000 });
  const reasons: Record<number, [FenceCheck, string]> = {
    10: ["folder", "a command couldn't go to its own folder"], 11: ["folder", "a command couldn't write in its own folder"],
    12: ["tempFiles", "a command couldn't write its temporary files"], 13: ["readsOwn", "a command could read Kuvo Code's own files"],
  };
  try {
    if (fs.existsSync(escaped)) return { passed: false, check: "writesOwn", why: "Its check failed: a command could write in Kuvo Code's own folder." };
    if (run.status === 0) return { passed: true };
    const [check, reason] = (run.status !== null ? reasons[run.status] : undefined) ?? ["didntRun", undefined];
    const said = (run.stderr || "").trim().split("\n").pop();
    return { passed: false, check, why: `Its check failed: ${reason ?? said ?? run.error?.message ?? "the command didn't run"}.` };
  } finally {
    fs.rmSync(PROBE, { recursive: true, force: true });
    fs.rmSync(escaped, { force: true });
    fs.rmSync(hidden, { force: true });
  }
}

// What the engine tells its agents of the sandbox, as the engine watches the file it was named: what
// it does once commands really run in it (the engine has loaded its plugin), and nothing until then.
export function tellAgents(on = fenceState().on): void {
  const note = on ? agentsNote(platform) : "";
  if (textOf(SANDBOX_NOTE) !== note) writePrivate(SANDBOX_NOTE, note);
}

/** The engine's plugin taken away, and kuvo-wake and agents told: commands run as before. What the
 * engine noted of the plugin goes too, so it's on again only once the engine has loaded it again. */
function withdraw(): void {
  try { tellAgents(false); } catch {}
  fs.rmSync(PLUGIN, { force: true });
  fs.rmSync(ON, { force: true });
  fs.rmSync(READY, { force: true });
  fs.rmSync(NOTE, { force: true });
}

/**
 * Sets the sandbox up: its files written and checked, then its plugin given to the engine; where it
 * can't run or the check fails (or with the kill switch), the plugin taken away, so commands run as
 * before rather than not at all.
 */
export function setUpFence(): FenceState {
  // Whether it can be on here, known while it's off too.
  const can = able();
  if (!fenceWanted()) {
    withdraw();
    checked = can;
    return fenceState();
  }
  if (!can.able) {
    withdraw();
    checked = can;
    return fenceState();
  }
  try {
    fs.mkdirSync(path.join(FOLDER, "tmp"), { recursive: true, mode: 0o700 });
    writeExecutable(places.launcher, launcherScript(places));
    if (platform === "linux") writeExecutable(places.runner, LANDLOCK_RUNNER);
    // The launcher as the coding agents' bridge runs an agent whole in the sandbox (the shells a
    // box before put beside it for Claude Code's commands go: Claude Code runs whole too).
    fs.mkdirSync(path.join(FOLDER, "shell"), { recursive: true, mode: 0o700 });
    for (const name of ["zsh", "bash"]) fs.rmSync(path.join(FOLDER, "shell", name), { force: true });
    writeExecutable(path.join(FOLDER, "shell", "run"), agentShellScript(places));
    lastProfiles = "";
    writeProfiles();
    tellLauncher();
    const result = probe();
    checked = { able: true, ...result, ...(result.passed ? {} : { reason: "checkFailed" as const }) };
    failures = result.passed ? 0 : failures + 1;
    if (!result.passed) {
      withdraw();
      return fenceState();
    }
    if (!fs.existsSync(READY)) writePrivate(READY, "");
    const plugin = pluginScript(places, VERSION);
    if (textOf(PLUGIN) !== plugin) {
      fs.rmSync(NOTE, { force: true });
      writePrivate(PLUGIN, plugin);
    }
    // Which setup this is, for the agents bridge's note (and an empty one, an older box's, given one).
    if (!textOf(ON)?.trim()) writePrivate(ON, crypto.randomUUID());
  } catch (error) {
    withdraw();
    checked = { able: true, passed: false, why: `It couldn't be set up: ${(error as Error).message}`, reason: "checkFailed", check: "setup" };
    failures += 1;
  }
  return fenceState();
}

/**
 * The launcher makes each conversation's wake folder as it first runs a command there (kuvo-wake
 * can't, in the sandbox): those that never got a wake-up or a watch go a day after their last use.
 */
// Whether a folder has anything but empty folders in it (a link counts).
function holdsFiles(folder: string): boolean {
  return fs.readdirSync(folder, { withFileTypes: true }).some(entry => !entry.isDirectory() || holdsFiles(path.join(folder, entry.name)));
}

export function sweepWakeFolders(now = Date.now()): void {
  // And commands' temporary folders, a week after their conversation's last command.
  const tmp = path.join(FOLDER, "tmp");
  for (const name of listOf(tmp)) {
    const folder = path.join(tmp, name);
    try { if (now - fs.statSync(folder).mtimeMs > 7 * 24 * 60 * 60 * 1000) fs.rmSync(folder, { recursive: true, force: true }); } catch {}
  }
  let names: string[] = [];
  try { names = fs.readdirSync(SESSION_WAKES); } catch { return; }
  for (const name of names) {
    if (!/^ses_[A-Za-z0-9_]+$/.test(name)) continue;
    const folder = path.join(SESSION_WAKES, name);
    try {
      const kept = fs.readdirSync(folder);
      // (Held while its conversation's archived: nothing's waiting all the same.)
      if (kept.includes("paused") && textOf(path.join(folder, "paused")) !== "archived") continue;
      if (kept.some(entry => !["session", "directory", "wakes", "watches", "inbox", "paused"].includes(entry))) continue;
      const parts = ["wakes", "watches", "inbox"].filter(part => kept.includes(part)).map(part => path.join(folder, part));
      if (parts.some(holdsFiles)) continue;
      const used = Math.max(...[folder, ...parts].map(where => fs.statSync(where).mtimeMs));
      if (now - used < 24 * 60 * 60 * 1000) continue;
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {}
  }
}

/** Set up as the box starts, and kept so: Kuvo Code's servers' ports in its rules as they change
 * (macOS), its plugin put back if it went, what agents are told as it's on or not, and the wake
 * folders no one used cleared away. */
export function keepFence(): void {
  try { setUpFence(); } catch {}
  try { tellAgents(); } catch {}
  let rounds = 0;
  setInterval(() => {
    const round = rounds++;
    if (round % 60 === 0) sweepWakeFolders();
    // Agents told once the engine has loaded the plugin, and no longer once it's gone.
    try { tellAgents(); } catch {}
    if (!fenceWanted()) return;
    try {
      if (checked.passed) writeProfiles();
      // A failed check, tried again each minute (it holds the box up while it runs).
      if (checked.passed ? textOf(PLUGIN) !== pluginScript(places, VERSION) : round % 6 === 0) setUpFence();
    } catch {}
  }, 10_000).unref?.();
}

export const fenceFiles = { folder: FOLDER, plugin: PLUGIN, launcher: places.launcher, version: VERSION };
