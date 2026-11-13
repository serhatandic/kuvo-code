// COMPAT(0.7 settings): makes the settings an older Mac's start left the box's own. Goes 3 months after 0.8.0.
// A Mac with Kuvo Code 0.7 or before left a machine's settings in the global file and its keys in
// `keys/` as its start wrote them (PROTOCOL.md, "For released Macs": its settings). The first Mac
// with boxes makes them the box's own (`kuvo-link.js box adopt`), once.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { addDefaultRules, CONFIG_FILE, deepMerged, KEY_NAME, readSettings, sortedKeys } from "../areas/config";
import { locked, writePrivate, writeSecret } from "../files";
import { BOX, BOX_KEYS, CONFIG_LOCK, IS_MAC, K, RUN, shownRoot } from "../home";
import { launchLocked } from "./launch-lock";

// What a Mac's start used to write: its settings in the global file, the rest beside its keys.
const GLOBAL_FILE = path.join(K, "config", "opencode", "opencode.json");
const MAC_SETTINGS = path.join(K, "keys", "settings.json");
const MAC_KEYS = path.join(K, "keys");

// Key paths the Mac's start wrote (`<root>/keys/KUVO_KEY_…`), as the box keeps its keys now.
function boxKeyPaths(value: unknown): unknown {
  if (typeof value === "string") {
    return value.split(`{file:${shownRoot}/keys/KUVO_KEY_`).join(`{file:${shownRoot}/box/keys/KUVO_KEY_`)
      .split(`{file:${K}/keys/KUVO_KEY_`).join(`{file:${shownRoot}/box/keys/KUVO_KEY_`);
  }
  if (Array.isArray(value)) return value.map(boxKeyPaths);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, boxKeyPaths(inner)]));
  return value;
}

// Makes the machine's settings its own, once (a box of its own: PROTOCOL.md, "Settings per box"):
// what it runs with now, as its Mac's start left them (the global file under the Mac's own, which
// wins), with the keys beside them, goes in its box; or, on a machine with none, `seed` ({settings,
// keys}: the Mac's, as it would have sent them). The launch's lines for them go, so no start writes
// them back. An engine running now keeps reading what it started with, untouched; the next start
// reads the box, and clears what's below it (`global-adopted` says the global file came in whole).
// Under the launch's lock (as the box's scripts take it: a start takes three minutes at most, and one
// whose holder runs is waited for) and the settings' own, so no start or change comes between.
// {status: "own" | "adopted", seeded, settings}.
// COMPAT(0.7 settings): makes the settings an older Mac's start left the box's own. Goes 3 months after 0.8.0.
export function adoptBox(seed: { settings?: unknown; keys?: unknown } | null | undefined): { status: "own" | "adopted"; seeded?: boolean; settings: unknown } {
  return launchLocked(() => locked(CONFIG_LOCK, () => {
    // A Mac's box has had its own from the start: in a home of its own, its settings file is the one
    // a machine's older Mac wrote (`config`), so nothing's taken in from there.
    if (IS_MAC || fs.existsSync(CONFIG_FILE)) {
      addDefaultRules();
      return { status: "own", settings: readSettings().settings ?? {} };
    }
    const global = readSettings(GLOBAL_FILE);
    const mac = readSettings(MAC_SETTINGS);
    const before = deepMerged(global.settings ?? {}, mac.settings ?? {});
    const seeded = !Object.keys(before as object).length && isObject(seed?.settings);
    const settings = boxKeyPaths(seeded ? seed!.settings : before);
    fs.mkdirSync(BOX_KEYS, { recursive: true, mode: 0o700 });
    fs.chmodSync(BOX, 0o700);
    if (seeded) {
      for (const [name, value] of Object.entries(isObject(seed!.keys) ? seed!.keys : {})) {
        if (KEY_NAME.test(name) && typeof value === "string") writeSecret(path.join(BOX_KEYS, name), value);
      }
    } else {
      // The shared keys; a bot's own (`…__<bot>`) stay where its folder names them.
      let names: string[] = [];
      try { names = fs.readdirSync(MAC_KEYS); } catch {}
      for (const name of names) {
        if (!KEY_NAME.test(name) || name.includes("__")) continue;
        try { writeSecret(path.join(BOX_KEYS, name), fs.readFileSync(path.join(MAC_KEYS, name), "utf8")); } catch {}
      }
    }
    // What it was made from, kept beside it.
    const kept = path.join(BOX, "adopted-from");
    fs.mkdirSync(kept, { recursive: true, mode: 0o700 });
    for (const [file, name] of [[GLOBAL_FILE, "opencode.json"], [MAC_SETTINGS, "settings.json"]] as const) {
      try { writeSecret(path.join(kept, name), fs.readFileSync(file, "utf8")); } catch {}
    }
    writePrivate(CONFIG_FILE, JSON.stringify(sortedKeys(settings), null, 2) + "\n");
    addDefaultRules();
    // The global file came in whole: the next start empties it (one you edited by hand, with
    // comments, it leaves as it is).
    if (!global.problem) writePrivate(path.join(BOX, "global-adopted"), "");
    const launchEnv = path.join(RUN, "launch.env");
    try {
      const lines = fs.readFileSync(launchEnv, "utf8").split("\n").filter(line => !/^KUVO_(PRIVATE_)?SETTINGS=/.test(line));
      writePrivate(launchEnv, lines.join("\n"));
    } catch {}
    return { status: "adopted", seeded, settings: readSettings().settings ?? settings };
  }));
}
