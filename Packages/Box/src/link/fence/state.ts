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
import { textOf, writePrivate } from "../files";
import { BOTS, BOX, BRIDGE_FILE, CHATS, ENGINE_CONFIG, ENGINE_FILE, K, RUN } from "../home";
import { launcherScript, pluginScript, type FencePlaces } from "./files";
import { LANDLOCK_RUNNER, landlockPolicy } from "./landlock";
import { fencePolicy, realish } from "./policy";
import { seatbeltProfile } from "./seatbelt";

export interface FenceState {
  /** Every command the engine runs on this box goes through the sandbox, checked. */
  on: boolean;
  /** Why not, in words for the box's page in Settings. */
  why?: string;
  /** You want it on (Settings › Permissions › Sandbox). */
  wanted: boolean;
  /** This computer can sandbox commands at all. */
  able: boolean;
  /** The coding agents' own programs' commands are sandboxed too. Not yet. */
  agents: boolean;
}

const FOLDER = realish(path.join(RUN, "fence"));
const SETTING = path.join(BOX, "sandbox.json");
const PLUGIN = path.join(ENGINE_CONFIG || path.join(K, "config"), "opencode", "plugins", "kuvo-sandbox.js");
const NOTE = path.join(FOLDER, "engine.json");
const PROBE = path.join(FOLDER, "probe");
const platform: "darwin" | "linux" = process.platform === "darwin" ? "darwin" : "linux";

const places: FencePlaces = {
  folder: FOLDER,
  launcher: path.join(K, "bin", "kuvo-fence"),
  runner: path.join(K, "bin", "kuvo-fence.js"),
  inside: [realish(BOTS), realish(CHATS)],
  probe: PROBE,
  platform,
};
const VERSION = crypto.createHash("sha256")
  .update(launcherScript(places)).update(LANDLOCK_RUNNER).update(pluginScript(places, ""))
  .digest("hex").slice(0, 16);

/** You want the sandbox on (off until you turn it on, for now). */
export function fenceWanted(): boolean {
  try { return JSON.parse(fs.readFileSync(SETTING, "utf8")).on === true; } catch { return false; }
}

let checked: { able: boolean; passed: boolean; why?: string } = { able: false, passed: false, why: "It hasn't been checked yet." };
let lastProfiles = "";

/** Whether the sandbox is on here: read each time from what the box knows, without waiting. */
export function fenceState(): FenceState {
  const wanted = fenceWanted();
  const base = { wanted, able: checked.able, agents: false };
  if (!wanted) return { ...base, on: false, why: "It's off." };
  if (!checked.passed) return { ...base, on: false, why: checked.why };
  if (textOf(PLUGIN) !== pluginScript(places, VERSION)) return { ...base, on: false, why: "Its plugin for the engine was changed or removed." };
  let engine: { pid?: number } = {};
  try { engine = JSON.parse(fs.readFileSync(ENGINE_FILE, "utf8")); } catch {
    return { ...base, on: false, why: "The engine isn't running." };
  }
  let note: { pid?: number; version?: string } = {};
  try { note = JSON.parse(fs.readFileSync(NOTE, "utf8")); } catch {}
  if (note.pid === engine.pid && note.version === VERSION) return { ...base, on: true };
  // An engine that started after the plugin was there loads it for each folder it opens, before
  // any command runs in it.
  try {
    if (fs.statSync(PLUGIN).mtimeMs <= fs.statSync(ENGINE_FILE).mtimeMs) return { ...base, on: true };
  } catch {}
  return { ...base, on: false, why: "Waiting for the engine to load it." };
}

/** Turns the sandbox on or off here (kept on the box), and sets it up as it says. */
export function setFenceWanted(on: boolean): FenceState {
  writePrivate(SETTING, JSON.stringify({ on }) + "\n");
  setUpFence();
  return fenceState();
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
  const files: [string, string][] = platform === "darwin"
    ? [["project.sb", seatbeltProfile(policy, { inside: false })], ["inside.sb", seatbeltProfile(policy, { inside: true })]]
    : [["policy.json", landlockPolicy(policy)]];
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
function able(): { able: boolean; why?: string } {
  if (platform === "darwin") return fs.existsSync("/usr/bin/sandbox-exec") ? { able: true } : { able: false, why: "macOS's sandbox isn't on this Mac." };
  if (!runtime()) return { able: false, why: "The engine isn't installed here yet." };
  if (!fs.existsSync("/sys/kernel/security/landlock") && !/landlock/.test(textOf("/sys/kernel/security/lsm") ?? "landlock")) {
    return { able: false, why: `Linux ${os.release().split("-")[0]} can't sandbox commands: it needs Landlock (Linux 5.13 or later, with it on).` };
  }
  return { able: true };
}

/**
 * Runs one command through the launcher, as the engine would, and checks what the sandbox must
 * do: it writes in its folder and its temporary folder, and can neither read nor write Kuvo Code's.
 */
function probe(): { passed: boolean; why?: string } {
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
  const reasons: Record<number, string> = {
    10: "a command couldn't go to its own folder", 11: "a command couldn't write in its own folder",
    12: "a command couldn't write its temporary files", 13: "a command could read Kuvo Code's own files",
  };
  try {
    if (fs.existsSync(escaped)) return { passed: false, why: "Its check failed: a command could write in Kuvo Code's own folder." };
    if (run.status === 0) return { passed: true };
    const reason = run.status !== null ? reasons[run.status] : undefined;
    const said = (run.stderr || "").trim().split("\n").pop();
    return { passed: false, why: `Its check failed: ${reason ?? said ?? run.error?.message ?? "the command didn't run"}.` };
  } finally {
    fs.rmSync(PROBE, { recursive: true, force: true });
    fs.rmSync(escaped, { force: true });
    fs.rmSync(hidden, { force: true });
  }
}

/**
 * Sets the sandbox up as you want it: on, its files written and checked, then its plugin given to
 * the engine; off (or when the check fails), the plugin taken away, so commands run as before
 * rather than not at all.
 */
export function setUpFence(): FenceState {
  if (!fenceWanted()) {
    fs.rmSync(PLUGIN, { force: true });
    return fenceState();
  }
  const can = able();
  if (!can.able) {
    fs.rmSync(PLUGIN, { force: true });
    checked = { able: false, passed: false, why: can.why };
    return fenceState();
  }
  try {
    fs.mkdirSync(path.join(FOLDER, "tmp"), { recursive: true, mode: 0o700 });
    writeExecutable(places.launcher, launcherScript(places));
    if (platform === "linux") writeExecutable(places.runner, LANDLOCK_RUNNER);
    lastProfiles = "";
    writeProfiles();
    const result = probe();
    checked = { able: true, ...result };
    if (!result.passed) {
      fs.rmSync(PLUGIN, { force: true });
      return fenceState();
    }
    const plugin = pluginScript(places, VERSION);
    if (textOf(PLUGIN) !== plugin) writePrivate(PLUGIN, plugin);
  } catch (error) {
    fs.rmSync(PLUGIN, { force: true });
    checked = { able: true, passed: false, why: `It couldn't be set up: ${(error as Error).message}` };
  }
  return fenceState();
}

/** Set up as the box starts, and kept so: Kuvo Code's servers' ports in its rules as they change
 * (macOS), and its plugin put back if it went. */
export function keepFence(): void {
  try { setUpFence(); } catch {}
  setInterval(() => {
    if (!fenceWanted()) return;
    try {
      if (checked.passed) writeProfiles();
      if (!checked.passed || textOf(PLUGIN) !== pluginScript(places, VERSION)) setUpFence();
    } catch {}
  }, 10_000).unref?.();
}

export const fenceFiles = { folder: FOLDER, plugin: PLUGIN, setting: SETTING, launcher: places.launcher, version: VERSION };
