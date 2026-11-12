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
import { accountHome, BOTS, BRIDGE_FILE, CHATS, ENGINE_CONFIG, ENGINE_DATA, ENGINE_FILE, K, RUN, SANDBOX_NOTE, SESSION_WAKES, SOCKET_KEY_FILE, SSH_AGENTS, SSH_FOR } from "../home";
import { tellLauncher } from "./allowed";
import { agentShellScript, agentsNote, launcherScript, pluginScript, type FencePlaces } from "./files";
import { LANDLOCK_RUNNER, landlockPolicy, namespaceReadOnlyFailed, ownNamespace, ownNamespaceLater, UNSHARE } from "./landlock";
import { appTemporary, fencePolicy, realish, sandboxCaches, whenReadLate } from "./policy";
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
  /** An agent's process started before it was on still runs outside it (`POST kuvo/sandbox/restart` restarts it in it). */
  outside?: boolean;
  /** The box asks you, once, to restart the agents started before it was on (`POST kuvo/sandbox/restart`). */
  restart?: boolean;
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
  /** While it's on, what it can't keep commands from on this computer: `services`, the services
   * your login runs (systemd, your keyring, your SSH agent), and git's own files in the repositories
   * they write (fence/landlock.ts, KEEP_GIT), where commands can't have a namespace of their own
   * (`needs` says what for). The vault isn't open to agents there, nor do goals go on
   * alone: `fenceWhole`. */
  gaps?: FenceGap[];
}

export type FenceReason = "kernel" | "namespaces" | "macos" | "engineMissing" | "checking" | "checkFailed" | "plugin" | "engineDown" | "waiting";
export type FenceAction = "help" | "softwareUpdate" | "retry" | "fix" | "restartEngine";
export type FenceGap = "services";
export type FenceCheck = "folder" | "tempFiles" | "readsOwn" | "writesOwn" | "services" | "didntRun" | "setup";

const CHECK = "POST kuvo/sandbox/check";
const RESTART = "POST kuvo/engine/restart";

const FOLDER = realish(path.join(RUN, "fence"));
const PLUGIN = path.join(ENGINE_CONFIG || path.join(K, "config"), "opencode", "plugins", "kuvo-sandbox.js");
const NOTE = path.join(FOLDER, "engine.json");
const PROBE = path.join(FOLDER, "probe");
/** Each command's namespace's own folder, empty (fence/landlock.ts, HIDE), which the check uses too:
 * so it makes nothing outside Kuvo Code's folder, as often as it's tried. */
const NAMESPACE_FOLDER = path.join(FOLDER, "ns");
// Tells kuvo-wake its watches' checks run in the sandbox, as commands do: there while the engine has
// the plugin.
const ON = path.join(FOLDER, "on");
// And that it's set up and checked here, so a check waits while it isn't on yet rather than run
// without it (where the box can't set it up, commands run as before, and checks with them).
const READY = path.join(FOLDER, "ready");
// That this box, as it runs now, has set it up or found it can't run here (its pid): the agents
// bridge waits for it before it starts any coding agent.
const DECIDED = path.join(FOLDER, "decided");
const platform: "darwin" | "linux" = process.platform === "darwin" ? "darwin" : "linux";

const places: FencePlaces = {
  folder: FOLDER,
  launcher: path.join(K, "bin", "kuvo-fence"),
  runner: path.join(K, "bin", "kuvo-fence.js"),
  ...conversationPlaces(),
  probe: PROBE,
  bots: BOTS,
  wakes: SESSION_WAKES,
  key: SOCKET_KEY_FILE,
  sshFor: SSH_FOR,
  sshAgents: SSH_AGENTS,
  caches: sandboxCaches(),
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
  // `agents`: every coding agent's process here runs in it, or none runs (what opens the vault to agents).
  const said = bridgeSays();
  const base = { able: checked.able, agents: said === "none" || said === "inside", ...(said === "outside" ? { outside: true } : {}), ...(asksToRestart() ? { restart: true } : {}) };
  // Kuvo Code's own kill switch: no reason a client shows, as there's nothing you can do.
  if (!fenceWanted()) return { ...base, on: false, why: "Kuvo Code has it turned off on this computer for now." };
  if (!checked.passed) return { ...base, on: false, ...cannot(checked) };
  const now = loaded();
  return { ...base, ...now, ...(now.on && withoutNamespace ? { gaps: ["services"], needs: withoutNamespace } : {}) };
}

/** Whether commands here are kept from all it hides, Kuvo Code's own included, by the sandbox as
 * any of the box's processes can tell: a Mac's always; a Linux machine's only where each command
 * has a namespace of its own (`run/fence/namespace` names its unshare), or one could have the
 * services your login runs start anything outside it (`systemd-run --user`). What the vault and a
 * goal going on alone ask for besides `on`. */
export function fenceWhole(): boolean {
  return platform === "darwin" || (textOf(path.join(FOLDER, "namespace")) ?? "").startsWith("/");
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

/** What the agents bridge says of its agents' processes, for the sandbox as it is now: all inside
 * it, some started before it was on still running (`outside`), none running, or nothing yet (it
 * hasn't looked since it was set up, or the sandbox isn't on). */
function bridgeSays(): "inside" | "outside" | "none" | undefined {
  if (!agentsCommandsInSandbox()) return undefined;
  let bridge: { pid?: number } | null = null;
  try { bridge = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8")); } catch {}
  if (!bridge?.pid || !processRuns(bridge.pid, "kuvo-agents")) return "none";
  try {
    const said = JSON.parse(fs.readFileSync(path.join(FOLDER, "agents"), "utf8"));
    const on = sandboxGeneration(ON);
    if (!on || said.pid !== bridge.pid || said.on !== on) return undefined;
    return said.outside === true ? "outside" : "inside";
  } catch {
    return undefined;
  }
}

/** Whether every coding agent's process here runs in the sandbox, or none runs, as any of the box's
 * processes can tell. */
export const agentsInSandbox = (): boolean => {
  const said = bridgeSays();
  return said === "none" || said === "inside";
};

// Asked once whether to restart them: the first time it's on with some still outside it (or was
// once the bridge said all were in it, when there was nothing to ask; none running yet, as while
// the bridge starts, settles nothing).
const RESTART_ASKED = path.join(FOLDER, "restart-asked");

/**
 * Whether the box asks you to restart the agents started before the sandbox was on (it does once,
 * the first time it's on with some still running), noting that it's past once none is left.
 */
export function asksToRestart(): boolean {
  if (fs.existsSync(RESTART_ASKED)) return false;
  // `agents`: every coding agent's process here runs in it, or none runs (what opens the vault to agents).
  const said = bridgeSays();
  if (said === "outside") return true;
  if (said === "inside") answeredRestart();
  return false;
}

/** Whether it's no longer to ask here: answered, or there was nothing to ask. */
export function restartSettled(): boolean {
  return fs.existsSync(RESTART_ASKED);
}

/** You answered whether to restart them (or there was nothing to ask): never asked again here. */
export function answeredRestart(): void {
  try { writePrivate(RESTART_ASKED, ""); } catch {}
}

// Why a box doesn't have it on, and what you can do.
function cannot(why: Checked): Partial<FenceState> {
  const said = why.why ? { why: why.why } : {};
  switch (why.reason) {
    case "kernel": return { ...said, reason: "kernel", action: "help", needs: why.needs };
    case "namespaces": return { ...said, reason: "namespaces", action: "help", needs: why.needs };
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
    : [["policy.json", landlockPolicy(policy)], ["runtime", runtime() ?? ""], ["namespace", namespace ?? "-"], ["sockets", (policy.sockets ?? []).map(each => each + "\n").join("")]];
  if (platform === "linux") fs.mkdirSync(NAMESPACE_FOLDER, { recursive: true, mode: 0o700 });
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

/**
 * Where a Linux machine doesn't let commands have a namespace of their own (fence/landlock.ts,
 * `ownNamespace`): "off", the sandbox isn't on there, so commands go to the ask as where it can't
 * run; "without" (the user's choice, 2026-11-01), it runs without one, and commands can still reach
 * your session's services: the state says so (`gaps`), and what needs it whole waits (`fenceWhole`).
 */
const WITHOUT_NAMESPACE: "off" | "without" = "without";
/** The `unshare` each command's namespace comes from, as `able` last found it (Linux). */
let namespace: string | null = null;
// Whether it's been looked for yet (a box without its engine at first doesn't).
let namespaceKnown = false;
/** Where it runs without one, what the machine needs for it (`FenceState.needs`). */
let withoutNamespace: string | null = null;
const namespaceHere = (): string | null => {
  fs.mkdirSync(NAMESPACE_FOLDER, { recursive: true, mode: 0o700 });
  return ownNamespace(NAMESPACE_FOLDER);
};

/** Whether this computer can sandbox commands at all, and why not; `found`, whether commands can
 * have a namespace of their own, where that's just been found (otherwise it's tried now). */
function able(found?: string | null): Checked {
  if (platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec") ? { able: true, passed: false } : { able: false, passed: false, why: "macOS's sandbox isn't on this Mac.", reason: "macos" };
  if (!runtime()) return { able: false, passed: false, why: "The engine isn't installed here yet.", reason: "engineMissing" };
  if (!fs.existsSync("/sys/kernel/security/landlock") && !/landlock/.test(textOf("/sys/kernel/security/lsm") ?? "landlock")) {
    return { able: false, passed: false, why: `Linux ${os.release().split("-")[0]} can't sandbox commands: it needs Landlock (Linux 5.13 or later, with it on).`, reason: "kernel", needs: "Linux 5.13" };
  }
  namespace = found === undefined ? namespaceHere() : found;
  namespaceKnown = true;
  withoutNamespace = namespace ? null : namespaceReadOnlyFailed() ? "read-only mounts" : UNSHARE.some(each => fs.existsSync(each)) ? "user namespaces" : "util-linux";
  if (withoutNamespace && WITHOUT_NAMESPACE === "off") {
    const services = "which the sandbox needs to keep commands from the services your login runs: systemd, your keyring, your agents";
    return withoutNamespace === "user namespaces"
      ? { able: false, passed: false, why: `This machine doesn't let commands have a namespace of their own (it restricts unprivileged user namespaces, as Ubuntu 24.04 and later do), ${services}.`, reason: "namespaces", needs: withoutNamespace }
      : { able: false, passed: false, why: `This machine has no unshare (util-linux's), ${services}.`, reason: "namespaces", needs: withoutNamespace };
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
    `printf '%s\n' "$TMPDIR"`,
    `echo ok > written && [ "$(cat written)" = ok ] || exit 11`,
    `echo ok > "$TMPDIR/probe" || exit 12`,
    `cat "$1" >/dev/null 2>&1 && exit 13`,
    // (In its namespace, your session's folder is empty.)
    ...(namespace ? [`[ -z "$(ls -A "/run/user/$(id -u)" 2>/dev/null)" ] || exit 14`] : []),
    `(echo escaped > "$2") 2>/dev/null`,
    `exit 0`,
  ].join("\n");
  const env: Record<string, string> = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: accountHome(), KUVO_FENCE_SHELL: "/bin/sh", KUVO_FENCE_WORK: PROBE };
  const bun = runtime();
  if (bun) env.KUVO_FENCE_RUNTIME = bun;
  const run = spawnSync(places.launcher, ["-c", script, PROBE, hidden, escaped], { env, encoding: "utf8", timeout: 20_000 });
  const reasons: Record<number, [FenceCheck, string]> = {
    10: ["folder", "a command couldn't go to its own folder"], 11: ["folder", "a command couldn't write in its own folder"],
    12: ["tempFiles", "a command couldn't write its temporary files"], 13: ["readsOwn", "a command could read Kuvo Code's own files"],
    14: ["services", "a command could reach your session's services"],
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
    // And its temporary folder.
    const used = (run.stdout ?? "").split("\n")[0]!.replace(/\/$/, "");
    try {
      if ([path.join(FOLDER, "tmp"), TEMPORARY].includes(path.dirname(used))) fs.rmSync(used, { recursive: true, force: true });
    } catch {}
  }
}

// What the engine tells its agents of the sandbox, as the engine watches the file it was named: what
// it does once commands really run in it (the engine has loaded its plugin), and nothing until then.
export function tellAgents(on = fenceState().on): void {
  const note = on ? agentsNote(platform, fitsTmux(appTemporary() ?? TEMPORARY), platform === "linux" && namespaceKnown && !withoutNamespace) : "";
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
 * Commands' temporary folders on a box that isn't this Mac's (which has the app's own): `t` in its
 * folder, as near its top as it can be, so a socket fits in them under a home folder's path that's
 * long too. Commands can't list it, and on Linux each one's namespace has only its own
 * conversation's in it (fence/landlock.ts's HIDE); on a Mac, the sandbox's rules let each reach only
 * its own.
 */
const TEMPORARY = realish(path.join(K, "t"));

/** Whether tmux's socket fits in a command's temporary folder in `root` (its name, 8 letters): a
 * socket's path is at most 107 letters on Linux (103 on macOS), and a command's tmux makes
 * `/tmux-<uid>/default` there. In `t`, under a home folder's path of up to 67 letters or so; where
 * it isn't, agents are told why tmux fails (`agentsNote`). */
const SOCKET_PATH = platform === "darwin" ? 103 : 107;
const fitsTmux = (root: string) => Buffer.byteLength(realish(root)) + "/12345678".length + `/tmux-${process.getuid?.() ?? 0}/default`.length <= SOCKET_PATH;

/**
 * Where commands' temporary folders go (`temporary`, which the launcher and the agents' bridge
 * read), and the key their short names are made from, kept while it's the same folder so a
 * conversation keeps its own: on this Mac's box, the app's own temporary folder; elsewhere `t` in
 * Kuvo Code's folder.
 */
function writeTemporary(): void {
  const file = path.join(FOLDER, "temporary");
  const root = appTemporary() ?? TEMPORARY;
  const [had, key] = (textOf(file) ?? "").split("\n");
  if (had === root && /^[0-9a-f]{64}$/.test(key ?? "")) return;
  // (Those from before, in the sandbox's own folder, stay for what a command may still have running
  // in one, as a build or a tmux server, and go a week after their last command: sweepWakeFolders.)
  writePrivate(file, `${root}\n${crypto.randomBytes(32).toString("hex")}\n`);
}

/**
 * The temporary folder a conversation's commands are given (their TMPDIR), as the launcher names it
 * from the conversation's folder (`work`, through its links): in the folder `temporary` names, by
 * the key there; in the sandbox's own `tmp` where the box hasn't named one. Itself, never through a
 * link: null for one that is a link (which the launcher takes away before a command runs), or for a
 * folder that isn't there.
 */
export function commandTemporary(work: string): string | null {
  let real: string;
  try { real = fs.realpathSync(work); } catch { return null; }
  const sum = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
  const [root, key] = (textOf(path.join(FOLDER, "temporary")) ?? "").split("\n");
  const tmp = root?.startsWith("/") && key?.length === 64 ? path.join(realish(root), sum(`${key}\n${real}`).slice(0, 8)) : path.join(FOLDER, "tmp", sum(real).slice(0, 32));
  return fs.lstatSync(tmp, { throwIfNoEntry: false })?.isSymbolicLink() ? null : tmp;
}

/** Where Kuvo Code keeps conversations' own folders inside its own, which their commands get whole
 * in the sandbox: each folder in bots' and in the engine's worktrees (`inside`), and Chats', itself
 * too (`shared`). (And their commands' temporary folders: `commandTemporary`.) A test's own
 * folders as `at` names them. */
export function conversationPlaces(at = { bots: BOTS, engineData: ENGINE_DATA, chats: CHATS }): { inside: string[]; shared: string[] } {
  return { inside: [realish(at.bots), realish(path.join(at.engineData, "worktree"))], shared: [realish(at.chats)] };
}

/**
 * Sets the sandbox up: its files written and checked, then its plugin given to the engine; where it
 * can't run or the check fails (or with the kill switch), the plugin taken away, so commands run as
 * before rather than not at all. `found`: as `able`'s.
 */
export function setUpFence(found?: string | null): FenceState {
  // Whether it can be on here, known while it's off too.
  const can = able(found);
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
    writeTemporary();
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
  for (const tmp of [path.join(FOLDER, "tmp"), TEMPORARY]) {
    for (const name of listOf(tmp)) {
      const folder = path.join(tmp, name);
      try { if (now - fs.statSync(folder).mtimeMs > 7 * 24 * 60 * 60 * 1000) fs.rmSync(folder, { recursive: true, force: true }); } catch {}
    }
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
 * folders no one used cleared away. `every`: what runs its round every 10 seconds (a test's runs
 * each by hand, and awaits what it set going: the minute's namespace check). */
export function keepFence(every: (round: () => Promise<void>) => void = round => { setInterval(round, 10_000).unref?.(); }): void {
  // (A file of yours the walls are read from that waited on macOS, read since: written in at once.)
  whenReadLate(() => {
    try { if (fenceWanted() && checked.passed) writeProfiles(); } catch {}
  });
  try { setUpFence(); } catch {}
  try { tellAgents(); } catch {}
  // Set up, or found it can't run here: the agents bridge starts the coding agents from now, never
  // before (it may have started first: this Mac's app starts it as the engine starts).
  try { writePrivate(DECIDED, JSON.stringify({ pid: process.pid })); } catch {}
  // And no longer once it stops: a bridge started before the next box waits for that one.
  process.once("exit", () => {
    try { if (JSON.parse(fs.readFileSync(DECIDED, "utf8")).pid === process.pid) fs.rmSync(DECIDED, { force: true }); } catch {}
  });
  let rounds = 0;
  let trying = false;
  every(async () => {
    const round = rounds++;
    if (round % 60 === 0) sweepWakeFolders();
    // Agents told once the engine has loaded the plugin, and no longer once it's gone.
    try { tellAgents(); } catch {}
    if (!fenceWanted()) return;
    let checking: Promise<void> | undefined;
    try {
      if (checked.passed) writeProfiles();
      // A failed check, tried again each minute (it holds the box up while it runs), with commands'
      // namespace as last found.
      if (checked.passed ? textOf(PLUGIN) !== pluginScript(places, VERSION) : round % 6 === 0) setUpFence(namespaceKnown ? namespace : undefined);
      // And on Linux, set up again once commands can have a namespace of their own after all
      // (allowed since), or no longer can (each would fail at unshare): found while the box goes on
      // answering, one try at a time.
      if (platform === "linux" && round % 6 === 5 && !trying) {
        fs.mkdirSync(NAMESPACE_FOLDER, { recursive: true, mode: 0o700 });
        trying = true;
        checking = ownNamespaceLater(NAMESPACE_FOLDER)
          .then(found => { if (fenceWanted() && !found !== !namespace) setUpFence(found); })
          .catch(() => {})
          .finally(() => { trying = false; });
      }
    } catch {}
    await checking;
  });
}

export const fenceFiles = { folder: FOLDER, plugin: PLUGIN, launcher: places.launcher, version: VERSION };
