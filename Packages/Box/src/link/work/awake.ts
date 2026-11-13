// Keep-awake (PROTOCOL.md, "Work › A night"): while a night runs on this Mac's box, the Mac doesn't
// sleep, on power only (`caffeinate -s`, which macOS honors only on power), and sleeps again once
// the night ends or the box stops (`-w`, the box's own process). A machine has nothing to do here:
// a Linux server doesn't sleep, and a Mac's keeper holds it awake while the box runs
// (`RemoteServer`'s `kuvo-start`).
//
// And Keep This Mac Awake (PROTOCOL.md, "Work › Keeping this Mac awake"): a Mac's box in a home of
// its own keeps its Mac from falling asleep by itself while agents work there, as its setting says
// (`keepsAwake` in `box/work.json`, on unless you turn it off), where its app's keeper did by the
// app's. Its `kuvo-start` holds nothing for it (`box/kind`).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { IS_MAC, OWN_HOME_MAC } from "../home";
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
export const holdsWhileWorking = () => OWN_HOME_MAC && process.platform === "darwin";

/** What holds the Mac awake while agents work: `caffeinate -i` (idle sleep, on battery too, as the
 * app's setting always did), tied to this process. A test gives its own. */
export interface WorkHold {
  command: string;
  args: string[];
}
const WORK_HOLD: WorkHold = { command: "/usr/bin/caffeinate", args: ["-i", "-w", String(process.pid)] };

let working: ChildProcess | null = null;

/** Whether it's held awake for agents' work now. */
export const awakeForWork = () => working !== null && working.exitCode === null && working.signalCode === null;

/** Holds the Mac awake (`on`) or lets it sleep again, for agents' work. */
export function holdForWork(on: boolean, hold: WorkHold = WORK_HOLD): void {
  if (on) {
    if (awakeForWork()) return;
    try {
      const child = spawn(hold.command, hold.args, { stdio: "ignore" });
      child.on("error", () => { if (working === child) working = null; });
      child.on("exit", () => { if (working === child) working = null; });
      child.unref();
      working = child;
    } catch {
      working = null;
    }
    return;
  }
  working?.kill();
  working = null;
}

/** One look: held while the setting's on and something's at work (`busy`), let go otherwise. Where
 * whether something's at work can't be told, as it was. */
export async function lookAtWork(busy: () => Promise<boolean>, hold: WorkHold = WORK_HOLD, setting = keepsAwakeSetting): Promise<boolean> {
  if (!setting()) {
    holdForWork(false, hold);
    return false;
  }
  let now: boolean;
  try { now = await busy(); } catch { return awakeForWork(); }
  holdForWork(now, hold);
  return now;
}

let looking: ReturnType<typeof setTimeout> | null = null;
/** Looked at every ten seconds while this box runs (`serve`), as the app's keeper looked. */
export function keepAwakeWhileWorking(busy: () => Promise<boolean>, every = 10_000): void {
  if (!holdsWhileWorking() || looking) return;
  const round = async () => {
    await lookAtWork(busy).catch(() => {});
    looking = setTimeout(() => void round(), every);
    looking.unref?.();
  };
  looking = setTimeout(() => void round(), 0);
  looking.unref?.();
}
