// Keep-awake (PROTOCOL.md, "Work › A night"): while a night runs on this Mac's box, the Mac doesn't
// sleep, on power only (`caffeinate -s`, which macOS honors only on power), and sleeps again once
// the night ends or the box stops (`-w`, the box's own process). A machine has nothing to do here:
// a Linux server doesn't sleep, and a Mac's keeper holds it awake while the box runs
// (`RemoteServer`'s `kuvo-start`).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { IS_MAC } from "../home";

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
