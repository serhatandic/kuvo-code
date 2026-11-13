// Removing Kuvo Code from this computer (#333 piece 3; PROTOCOL.md, "Uninstalling"): the box's own
// command, which the app runs (Settings, once it's there) or you run in a Terminal, on a Mac and on
// Linux alike. `kuvo-link.js uninstall`: nothing of it starts again, at login or after a restart,
// and nothing of it runs (its keeper, engine, coding agents, link, server and browser). Its folder
// stays for you to remove (or move to the Trash): the command only says where it is.
// `uninstall --check` changes nothing, and says what it would stop.
//
// What starts the box from outside its folder is only taken away for the real `~/.kuvo-code`: the
// launch agent (`~/Library/LaunchAgents/run.kuvo.code.machine.plist`, which launchd lets go of
// first) and its line in your crontab (by its mark, the rest of it kept). A test's home names stand-
// ins for `launchctl` and `crontab` (KUVO_TEST_UNINSTALL_TOOLS), else leaves both alone; a demo or
// test copy's never added either.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { processRuns } from "../shared/platform";
import { allWakes } from "./areas/wakes";
import { listBots } from "./bots/list";
import { APP_FOLDER, IN_TEST_FOLDER, K, REAL_BOX, RUN, accountHome, homeFolder, located, recordedKind } from "./home";
import { peersOf } from "./peers/known";
import { readLink } from "./state";

/** The launch agent that starts the box at login on a Mac (RemoteEngine.swift's `launchAgent`; the
 * helper's after #333 piece 4): one per computer, whatever set it up. */
export const LAUNCH_AGENT = "run.kuvo.code.machine";
/** The mark on the crontab line that starts the box after a restart (RemoteEngine.swift's `rebootTag`). */
export const REBOOT_TAG = "# kuvo-code: starts its engine again after a restart";

/** Where `launchctl` and `crontab` are, and the folder the launch agent's file is in: the real ones
 * for the real `~/.kuvo-code` alone, a test's stand-ins for a test's home, else none. */
function outside(): { launchctl: string; crontab: string; agents: string } | null {
  if (REAL_BOX && located(K) === located(path.join(accountHome(), ".kuvo-code"))) {
    return { launchctl: "/bin/launchctl", crontab: "crontab", agents: path.join(accountHome(), "Library", "LaunchAgents") };
  }
  const tools = IN_TEST_FOLDER ? process.env.KUVO_TEST_UNINSTALL_TOOLS : undefined;
  if (!tools || !path.isAbsolute(tools)) return null;
  return { launchctl: path.join(tools, "launchctl"), crontab: path.join(tools, "crontab"), agents: path.join(homeFolder(), "Library", "LaunchAgents") };
}

const run = (program: string, args: string[], input?: string) =>
  spawnSync(program, args, { input, encoding: "utf8", timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });

/** This user's crontab, or null where there's none to read (no `crontab`, or it can't be read: then
 * it's left alone, never written over). */
function crontab(tools: { crontab: string }): string | null {
  const listed = run(tools.crontab, ["-l"]);
  if (listed.error) return null;
  if (listed.status === 0) return listed.stdout;
  return /no crontab/i.test(listed.stderr ?? "") ? "" : null;
}

/** What starts the box from outside its folder: the launch agent's file, and its crontab line. */
function starts() {
  const tools = outside();
  if (!tools) return { launchAgent: false, crontab: false, checked: false };
  const table = crontab(tools);
  return {
    launchAgent: process.platform === "darwin" && fs.existsSync(path.join(tools.agents, `${LAUNCH_AGENT}.plist`)),
    crontab: table !== null && table.includes(REBOOT_TAG),
    checked: true,
  };
}

/** A process recorded in `run` (`{"pid":…}` or a bare number), when it runs `name`. */
function recorded(file: string, name: string): number | null {
  let text = "";
  try { text = fs.readFileSync(path.join(RUN, file), "utf8"); } catch { return null; }
  let pid: unknown = Number(text.trim());
  if (!Number.isInteger(pid)) try { pid = JSON.parse(text)?.pid; } catch {}
  return processRuns(pid, name) ? pid as number : null;
}

/** What runs of the box now, by its records. */
function running(): string[] {
  const records: [string, string, string][] = [["box.pid", "kuvo-start", "keeper"], ["engine.json", path.join(K, "engine"), "engine"], ["agents.pid", "kuvo-agents", "coding agents"],
    ["link.pid", "kuvo-link", "link"], ["serve.json", "kuvo-link", "server"], ["browser.pid", "kuvo-browser", "browser"]];
  return records.filter(([file, name]) => recorded(file, name) !== null).map(([, , what]) => what);
}

/** What uninstalling stops, as facts for whoever asks to say: what runs, what starts it, its bots
 * and wake-ups, the phones that reach it and your other computers it talks to. */
export function uninstallCheck() {
  const link = readLink();
  const wakes = allWakes().reduce((count, each) => count + each.wakes.length + each.watches.length, 0);
  return {
    folder: K,
    kind: recordedKind() ?? "machine",
    running: running(),
    starts: starts(),
    bots: listBots().length,
    wakes,
    phones: (link?.phones ?? []).length,
    computers: peersOf(link).length,
  };
}

/** Removes what starts and runs the box: what it did, and what's left (its folder). */
export function uninstall(): { stopped: boolean; launchAgent: boolean; crontab: boolean; left: string[]; message: string } {
  const tools = outside();
  let launchAgent = false;
  let crontabLine = false;
  // Its start at login first, so nothing starts it again as it stops.
  if (tools && process.platform === "darwin") {
    const plist = path.join(tools.agents, `${LAUNCH_AGENT}.plist`);
    if (fs.existsSync(plist)) {
      const uid = process.getuid?.() ?? 0;
      run(tools.launchctl, ["bootout", `gui/${uid}/${LAUNCH_AGENT}`]);
      fs.rmSync(plist, { force: true });
      launchAgent = true;
    }
  }
  if (tools) {
    const table = crontab(tools);
    if (table !== null && table.includes(REBOOT_TAG)) {
      const kept = table.split("\n").filter(line => !line.includes(REBOOT_TAG)).join("\n");
      crontabLine = run(tools.crontab, ["-"], kept.endsWith("\n") || !kept ? kept : `${kept}\n`).status === 0;
    }
  }
  // Then everything it runs, by its own keeper (`kuvo-start off`: marked off, so nothing starts it
  // meanwhile), and what that doesn't stop: its server for clients and its browser.
  for (const file of ["serve.needed", "link.needed"]) fs.rmSync(path.join(RUN, file), { force: true });
  const keeper = path.join(K, "bin", "kuvo-start");
  let stopped = true;
  if (fs.existsSync(keeper)) {
    const off = spawnSync("sh", [keeper, "off"], { cwd: K, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: homeFolder() } });
    stopped = off.status === 0;
  } else {
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(RUN, "off"), "");
  }
  const told: [number, string][] = [];
  for (const [file, name] of [["serve.json", "kuvo-link"], ["browser.pid", "kuvo-browser"], ["link.pid", "kuvo-link"]] as const) {
    const pid = recorded(file, name);
    if (pid && pid !== process.pid) try { process.kill(pid, "SIGTERM"); told.push([pid, name]); } catch {}
  }
  // (A moment for those to end, ten seconds at most.)
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 200 && told.some(([pid, name]) => processRuns(pid, name)); waited++) Atomics.wait(pause, 0, 0, 50);
  const left = running();
  stopped &&= left.length === 0;
  const where = K.startsWith(homeFolder() + "/") ? "~" + K.slice(homeFolder().length) : K;
  const message = stopped
    ? `Kuvo Code is stopped on this computer and won't start again. Its folder stays, with your sessions and settings: remove ${where} to remove them too.`
    : `Kuvo Code won't start again on this computer, but ${left.length ? `its ${left.join(", ")} still ran` : "it couldn't stop everything"} just now. Run this again in a moment.`;
  return { stopped, launchAgent, crontab: crontabLine, left: [K], message };
}

/** `uninstall [--check]`: prints one JSON line, says what it did on stderr, and exits 0 when it's
 * done, 1 when it was refused or couldn't stop everything, 2 for what it doesn't know. */
export function uninstallCommand(args: string[]): number {
  const unknown = args.filter(arg => arg !== "--check");
  if (unknown.length) {
    console.error("Usage: kuvo-link.js uninstall [--check]");
    return 2;
  }
  // This Mac's box in its app's folder (however it was started): the app's own keeper runs it,
  // which only the app removes.
  if (APP_FOLDER || path.basename(path.dirname(path.resolve(K))).toLowerCase().startsWith("run.kuvo.code")) {
    const message = "This Mac's box runs in Kuvo Code's own folder: remove Kuvo Code itself (its background work goes with it).";
    console.log(JSON.stringify({ result: "refused", message }));
    console.error(message);
    return 1;
  }
  if (args.includes("--check")) {
    console.log(JSON.stringify(uninstallCheck()));
    return 0;
  }
  const done = uninstall();
  console.log(JSON.stringify({ result: done.stopped ? "uninstalled" : "unfinished", ...done }));
  console.error(done.message);
  return done.stopped ? 0 : 1;
}
