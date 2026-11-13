// This Mac's box's helper, Kuvo Code Box (#333 piece 4; PROTOCOL.md, "This Mac's box: its helper"):
// the signed program a Mac's box in a home of its own runs under, which macOS asks about and which
// reaches its keys in the Keychain. Its release brings it into `bin` (`bin/Kuvo Code Box.app`); this
// starts it at login, as a machine's box is started: the launch agent `run.kuvo.code.machine`, one
// per computer, whose program is the helper (a machine's is `/bin/sh`). `uninstall` takes it away.
//
// `kuvo-link.js helper install [--load] [--app <bundle ID>]` writes the launch agent's file (and with
// `--load`, has launchd start it now); `helper status` says what's there. Only for a Mac's own box
// (`box/kind` says `mac`) in the real `~/.kuvo-code`: a test's home names stand-ins for `launchctl`
// (KUVO_TEST_UNINSTALL_TOOLS, as `uninstall` does), else nothing outside the folder is touched.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { APP_FOLDER, K, recordedKind } from "./home";
import { LAUNCH_AGENT, launchTools } from "./uninstall";

export const HELPER_NAME = "Kuvo Code Box";
/** The helper in the box's `bin`, as its release brings it. */
export const helperBundle = (): string => path.join(K, "bin", `${HELPER_NAME}.app`);
export const helperProgram = (): string => path.join(helperBundle(), "Contents", "MacOS", HELPER_NAME);

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The launch agent's file: the helper, with this box's folder, at login; started again should it
 * end any other way than cleanly (it does when the box was turned off), and named under Kuvo Code
 * (`app`'s bundle ID) in Login Items while the app's there. */
export function helperPlist(app: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>${LAUNCH_AGENT}</string>
<key>ProgramArguments</key><array><string>${xml(helperProgram())}</string><string>keep</string><string>--home</string><string>${xml(K)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>AbandonProcessGroup</key><true/>
<key>AssociatedBundleIdentifiers</key><array><string>${xml(app)}</string></array>
</dict>
</plist>
`;
}

/** Why the helper's launch agent can't be put in place here, or null. */
function refusal(): string | null {
  if (process.platform !== "darwin") return "Only a Mac's own box runs under Kuvo Code Box.";
  if (APP_FOLDER || recordedKind() !== "mac") return "Only a Mac's own box in a home of its own runs under Kuvo Code Box.";
  if (!launchTools()) return "Only the box in ~/.kuvo-code starts at login.";
  if (!fs.existsSync(helperProgram())) return `${HELPER_NAME} isn't in this box's bin: its release brings it.`;
  return null;
}

/** What's there: the helper, the launch agent's file (naming this helper), and whether launchd has
 * it now (null where that couldn't be asked). */
export function helperStatus() {
  const tools = launchTools();
  const plist = tools ? path.join(tools.agents, `${LAUNCH_AGENT}.plist`) : null;
  let agent = false;
  try { agent = plist !== null && fs.readFileSync(plist, "utf8").includes(`<string>${xml(helperProgram())}</string>`); } catch {}
  let loaded: boolean | null = null;
  if (tools && process.platform === "darwin") {
    const asked = spawnSync(tools.launchctl, ["print", `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT}`], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "ignore", "ignore"] });
    loaded = asked.error ? null : asked.status === 0;
  }
  return { helper: fs.existsSync(helperProgram()), agent, loaded };
}

/** The launch agent's file written (whole, in place of any there: one per computer), and with
 * `load`, launchd told to start it now (a launch agent with that label already loaded, let go of
 * first). */
export function installHelperAgent({ load, app }: { load: boolean; app: string }): { written: boolean; loaded: boolean; message: string } {
  const why = refusal();
  if (why) return { written: false, loaded: false, message: why };
  const tools = launchTools()!;
  const plist = path.join(tools.agents, `${LAUNCH_AGENT}.plist`);
  fs.mkdirSync(tools.agents, { recursive: true });
  const temporary = `${plist}.${process.pid}.new`;
  fs.writeFileSync(temporary, helperPlist(app), { mode: 0o644 });
  fs.renameSync(temporary, plist);
  if (!load) return { written: true, loaded: false, message: `${HELPER_NAME} starts this Mac's box at login.` };
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const run = (args: string[]) => spawnSync(tools.launchctl, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  // What had the label let go of first, and waited for (its helper takes a few seconds to stop
  // what it runs): bootstrapping it before it's gone fails.
  if (run(["bootout", `${domain}/${LAUNCH_AGENT}`]).status === 0) {
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let waited = 0; waited < 100 && run(["print", `${domain}/${LAUNCH_AGENT}`]).status === 0; waited++) Atomics.wait(pause, 0, 0, 100);
  }
  let started = run(["bootstrap", domain, plist]);
  // (launchd still letting go of it: once more, a moment on.)
  for (let tries = 0; tries < 3 && started.status !== 0; tries++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    started = run(["bootstrap", domain, plist]);
  }
  const loaded = started.status === 0;
  return {
    written: true,
    loaded,
    message: loaded ? `${HELPER_NAME} runs this Mac's box now, and at login.` : `${HELPER_NAME} starts this Mac's box at login, but launchd didn't start it now: ${(started.stderr || "").trim().slice(0, 300) || "it said nothing"}.`,
  };
}

/** The helper's launch agent, loaded already, started now if it isn't running (`launchctl kickstart`,
 * which leaves one running as it is): one that found the box moving went, and launchd leaves it so
 * until it's asked. */
export function startHelperAgent(): { started: boolean; message: string } {
  const why = refusal();
  if (why) return { started: false, message: why };
  const tools = launchTools()!;
  const started = spawnSync(tools.launchctl, ["kickstart", `gui/${process.getuid?.() ?? 0}/${LAUNCH_AGENT}`], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  return started.status === 0
    ? { started: true, message: `${HELPER_NAME} runs this Mac's box.` }
    : { started: false, message: `launchd didn't start ${HELPER_NAME}: ${(started.stderr || "").trim().slice(0, 300) || "it said nothing"}.` };
}

/** `helper install [--load] [--app <bundle ID>] | start | status`: one JSON line; 0 when done. */
export function helperCommand(args: string[]): number {
  const [what, ...rest] = args;
  if (what === "status" && rest.length === 0) {
    console.log(JSON.stringify(helperStatus()));
    return 0;
  }
  if (what === "start" && rest.length === 0) {
    const done = startHelperAgent();
    console.log(JSON.stringify(done));
    if (!done.started) console.error(done.message);
    return done.started ? 0 : 1;
  }
  const appAt = rest.indexOf("--app");
  const app = appAt >= 0 ? rest[appAt + 1] : "run.kuvo.code";
  const known = rest.every((arg, index) => arg === "--load" || arg === "--app" || (index === appAt + 1 && appAt >= 0));
  if (what !== "install" || !known || !app || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(app)) {
    console.error("Usage: kuvo-link.js helper install [--load] [--app <bundle ID>] | helper start | helper status");
    return 2;
  }
  const done = installHelperAgent({ load: rest.includes("--load"), app });
  console.log(JSON.stringify(done));
  if (!done.written || (rest.includes("--load") && !done.loaded)) {
    console.error(done.message);
    return 1;
  }
  return 0;
}
