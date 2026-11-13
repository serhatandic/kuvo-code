// Keep-awake (PROTOCOL.md, "Work › A night"): while a night runs on this Mac's box, the Mac doesn't
// sleep, on power only (`caffeinate -s`, which macOS honors only on power), and sleeps again once
// the night ends or the box stops (`-w`, the box's own process). A machine has nothing to do here:
// a Linux server doesn't sleep, and a Mac's keeper holds it awake while the box runs
// (`RemoteServer`'s `kuvo-start`).
//
// And Keep This Mac Awake (PROTOCOL.md, "Work › Keeping this Mac awake"): a Mac's box in a home of
// its own keeps its Mac from falling asleep by itself while agents work there, as its setting says
// (`keepsAwake` in `box/work.json`, on unless you turn it off), where its app's keeper did by the
// app's. Its `kuvo-start` holds nothing for it while it does (`box/kind`, `WORK_AWAKE_FILE`).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { alive } from "../../shared/platform";
import { writePrivate } from "../files";
import { IS_MAC, OWN_HOME_MAC, RUN } from "../home";
import { keepsAwakeSetting } from "./settings";

let held: ChildProcess | null = null;

/** Whether this box keeps its computer awake for a night (a Mac's does). */
export const keepsAwake = () => IS_MAC && process.platform === "darwin";

/** Keep this Mac awake (`on`), or let it sleep again; nothing on a machine. */
export function keepAwake(on: boolean): void {
  if (!keepsAwake()) return;
  if (on) {
    if (held && held.exitCode === null && !held.killed) return;
    try {
      const child = spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" });
      child.on("error", () => { if (held === child) held = null; });
      child.on("exit", () => { if (held === child) held = null; });
      child.unref();
      held = child;
    } catch {
      held = null;
    }
    return;
  }
  gone = held;
  held?.kill();
  held = null;
}

/** Whether it's kept awake now. */
export const keptAwake = () => held !== null;

/** Once what kept it awake has gone (at once when nothing does). */
export function letGo(): Promise<void> {
  const child = held ?? gone;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  // (Waited on, it keeps this process going till then.)
  child.ref();
  return new Promise(done => child.once("exit", () => done()));
}
let gone: ChildProcess | null = null;

// What `onPower` last found, for half a minute: a card's checks are read at every change.
let power: { at: number; on: boolean | null } | null = null;

/** Whether this Mac runs on power now (null on a machine, or when it can't tell). */
export function onPower(): boolean | null {
  if (!keepsAwake()) return null;
  if (power && Date.now() - power.at < 30_000) return power.on;
  let on: boolean | null = null;
  try {
    const said = execFileSync("/usr/bin/pmset", ["-g", "batt"], { encoding: "utf8", timeout: 5000 });
    if (/AC Power/.test(said)) on = true;
    else if (/Battery Power/.test(said)) on = false;
  } catch {}
  power = { at: Date.now(), on };
  return on;
}

/** Whether this box keeps its Mac awake while agents work, by its own setting: a Mac's in a home of
 * its own (in its app's folder, its app's keeper does, by the app's). */
export const keepsMacAwakeItself = () => OWN_HOME_MAC && process.platform === "darwin";

/** What holds the Mac awake while agents work: `caffeinate -i` (idle sleep, on battery too, as the
 * app's setting always did), tied to this process. A test gives its own (a program named so). */
export interface WorkHold {
  command: string;
  args: string[];
}
const WORK_HOLD: WorkHold = { command: "/usr/bin/caffeinate", args: ["-i", "-w", String(process.pid)] };

/** Where the process that keeps the Mac awake for agents' work (`serve`) says so, for every other
 * process (a client's `box route`) and the keeper (`kuvo-start`, which holds it awake itself while
 * nothing here does): `{"by": <its pid>, "hold": <caffeinate's pid> | null}`. */
export const WORK_AWAKE_FILE = path.join(RUN, "work-awake.json");

let working: ChildProcess | null = null;

const holding = () => working !== null && working.exitCode === null && working.signalCode === null;

let noted = "";
/** Said for every process, when it changed (or went). */
function noteHold(): void {
  const now = JSON.stringify({ by: process.pid, hold: holding() ? working!.pid ?? null : null });
  if (now === noted && fs.existsSync(WORK_AWAKE_FILE)) return;
  try { writePrivate(WORK_AWAKE_FILE, now); noted = now; } catch {}
}

/** Whether the Mac is held awake for agents' work now, by whichever of this box's processes holds
 * it (as it says, `WORK_AWAKE_FILE`). */
export function awakeForWork(): boolean {
  try {
    const said = JSON.parse(fs.readFileSync(WORK_AWAKE_FILE, "utf8"));
    const running = (pid: unknown) => Number.isInteger(pid) && (pid as number) > 1 && alive(pid as number);
    return running(said?.by) && running(said?.hold);
  } catch {
    return false;
  }
}

/** Holds the Mac awake (`on`) or lets it sleep again, for agents' work. */
export function holdForWork(on: boolean, hold: WorkHold = WORK_HOLD): void {
  if (on && !holding()) {
    try {
      const child = spawn(hold.command, hold.args, { stdio: "ignore" });
      child.on("error", () => { if (working === child) { working = null; noteHold(); } });
      child.on("exit", () => { if (working === child) { working = null; noteHold(); } });
      child.unref();
      working = child;
    } catch {
      working = null;
    }
  } else if (!on && working) {
    working.kill();
    working = null;
  }
  noteHold();
}

/** How long a hold stays while whether anything works can't be told, before it's let go. */
export const UNTOLD_FOR = 5 * 60_000;
let untoldSince: number | null = null;

/** One look: held while the setting's on and something's at work (`busy`: null when that can't be
 * told, a recorded engine not answering), let go otherwise; where it can't be told, as it was, for
 * five minutes at most (`UNTOLD_FOR`). The setting's read again once `busy` answers, so one turned
 * off meanwhile is never undone. */
export async function lookAtWork(busy: () => Promise<boolean | null>, hold: WorkHold = WORK_HOLD, setting = keepsAwakeSetting, now = Date.now()): Promise<boolean> {
  const busyNow = setting() ? await busy().catch(() => null) : false;
  if (busyNow === null) {
    untoldSince ??= now;
    if (now - untoldSince < UNTOLD_FOR) {
      noteHold();
      return holding();
    }
  } else {
    untoldSince = null;
  }
  holdForWork(busyNow === true && setting(), hold);
  return holding();
}

let looking: ReturnType<typeof setTimeout> | null = null;
/** Looked at every ten seconds while this box runs (`serve`), as the app's keeper looked: a change
 * to the setting holds or lets go by the next look. */
export function keepAwakeWhileWorking(busy: () => Promise<boolean | null>, every = 10_000): void {
  if (!keepsMacAwakeItself() || looking) return;
  const round = async () => {
    await lookAtWork(busy).catch(() => {});
    looking = setTimeout(() => void round(), every);
    looking.unref?.();
  };
  looking = setTimeout(() => void round(), 0);
  looking.unref?.();
}
