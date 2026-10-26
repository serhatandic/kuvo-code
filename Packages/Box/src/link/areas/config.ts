// @ts-nocheck
// This box's own settings (PROTOCOL.md, "kuvo/config")
// The engine's settings file, which the engine reloads when it changes: this box's own, changed
// from any client (the Mac app, a phone) by the same rules. Each computer keeps its own; nothing
// copies them between computers but you ("Also Apply to…", `applySettings`). Writes take
// `run/.config.lock`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOX, BOX_KEYS, CONFIG_LOCK, ENGINE_CONFIG, IS_MAC, K, RUN } from "../home";
import { deleteKey, keyNames, keyWork, readKey, writeKey } from "../keys";
import { isObject, sameJSON, sortedJSON } from "../../shared/json";
import { KeysUnavailable, STORED_KEY } from "../host";
import { locked, writePrivate } from "../files";

export const CONFIG_FILE = IS_MAC ? path.join(ENGINE_CONFIG, "opencode", "opencode.json") : path.join(BOX, "opencode.json");
const OWN_MARK = IS_MAC ? null : CONFIG_FILE;
// What a Mac's start used to write: its settings in the global file, the rest beside its keys.
const GLOBAL_FILE = path.join(K, "config", "opencode", "opencode.json");
const MAC_SETTINGS = path.join(K, "keys", "settings.json");
const MAC_KEYS = path.join(K, "keys");
const LAUNCH_LOCK = path.join(RUN, ".launching");
// Settings › MCP Servers' popular servers, as the Mac lists them, which it puts here as it connects.
export const CATALOG_FILE = path.join(K, "bin", "mcp-catalog.json");
export const SERVERS = ["mcp", "servers"];

// COMPAT(0.7 settings): the routes answer 409 until a Mac adopts the settings an older Mac's start left. Goes 3 months after 0.8.0.
export const ownsSettings = (mark = OWN_MARK) => mark === null || fs.existsSync(mark);

const sortedKeys = value => Array.isArray(value) ? value.map(sortedKeys)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;

// The file's settings: {settings}, none for a file that isn't there yet, or {problem} for one that
// can't be read (not plain JSON, a link to a file that isn't there, no permission), left alone:
// a write would put something else in its place.
export function readSettings(file = CONFIG_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    let link = false;
    try { link = fs.lstatSync(file).isSymbolicLink(); } catch {}
    if (error?.code === "ENOENT" && !link) return { settings: {} };
    return { problem: link && error?.code === "ENOENT"
      ? "It's a link to a file that isn't there, so Kuvo Code leaves it alone."
      : `It couldn't be read, so Kuvo Code leaves it alone (${error?.code ?? error?.message}).` };
  }
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (!isObject(parsed)) throw new Error("not an object");
    return { settings: parsed };
  } catch {
    return { problem: "It isn't plain JSON, so Kuvo Code leaves it alone. (Comments aren't supported here.)" };
  }
}

export const valueAt = (object, keys) => keys.reduce((current, key) => isObject(current) ? current[key] : undefined, object);

// `object` with `value` at `keys` (nil removes it, and an object it leaves empty).
export function settingAt(object, keys, value) {
  const [key, ...rest] = keys;
  const next = { ...object };
  if (!rest.length) {
    if (value === null || value === undefined) delete next[key]; else next[key] = value;
    return next;
  }
  const inner = settingAt(isObject(next[key]) ? next[key] : {}, rest, value);
  if (Object.keys(inner).length) next[key] = inner; else delete next[key];
  return next;
}

// `PATCH kuvo/config`'s changes ({path, value, was?}), made in one write: {status, settings} or
// {status, message}, as the Mac answers.
export function changeSettings(changes, file = CONFIG_FILE, lock = CONFIG_LOCK) {
  const fits = Array.isArray(changes) && changes.length >= 1 && changes.length <= 100 && changes.every(change =>
    Array.isArray(change?.path) && change.path.length >= 1 && change.path.length <= 16
    && change.path.every(key => typeof key === "string" && key.length >= 1 && key.length <= 200) && "value" in change);
  if (!fits) return { status: 400, message: "Send {\"changes\": [{\"path\": [keys…], \"value\": …}]}." };
  return locked(lock, () => {
    const { settings, problem } = readSettings(file);
    if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
    // Keys go through objects only: one through a list or a plain value would replace it whole.
    if (changes.some(change => change.path.slice(0, -1).some((_, at) => {
      const above = valueAt(settings, change.path.slice(0, at + 1));
      return above !== undefined && !isObject(above);
    }))) return { status: 400, message: "A path goes through objects only; send a list whole, at its own path." };
    if (changes.some(change => "was" in change && sortedJSON(valueAt(settings, change.path) ?? null) !== sortedJSON(change.was))) {
      return { status: 409, message: "It changed since you read it." };
    }
    return writeSettings(settings, changes, file);
  });
}

// `changes` ({path, value}) made to `settings` and written, under the settings' lock: {status,
// settings}, or {status, message}.
export function writeSettings(settings, changes, file) {
  let next = settings;
  for (const change of changes) next = settingAt(next, change.path, keysNamedHere(change.value));
  // Through a link (to a dotfiles folder, say) to the file it names, so the link stays a link.
  const target = linkTarget(file);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(sortedKeys(next), null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    // Nothing half written left beside it.
    fs.rmSync(temporary, { force: true });
    return { status: 500, message: `It couldn't be saved: ${error.message}` };
  }
  return { status: 200, settings: next };
}

// The file a link names, link after link; `file` itself when it isn't a link.
function linkTarget(file) {
  let target = file;
  for (let i = 0; i < 8; i++) {
    let destination;
    try { destination = fs.readlinkSync(target); } catch { break; }
    target = path.resolve(path.dirname(target), destination);
  }
  return target;
}

// Objects merged key by key, `over` winning; a list or a plain value is replaced whole.
export function deepMerged(under, over) {
  if (!isObject(under) || !isObject(over)) return over === undefined ? under : over;
  const merged = { ...under };
  for (const [key, value] of Object.entries(over)) merged[key] = key in under ? deepMerged(under[key], value) : value;
  return merged;
}

// The box's folder as its settings name it: "~/.kuvo-code", as the Mac's start wrote key paths.
const home = os.homedir();
export const shownRoot = K.startsWith(home + "/") ? "~" + K.slice(home.length) : K;

// Key paths the Mac's start wrote (`<root>/keys/KUVO_KEY_…`), as the box keeps its keys now.
function boxKeyPaths(value) {
  if (typeof value === "string") {
    return value.split(`{file:${shownRoot}/keys/KUVO_KEY_`).join(`{file:${shownRoot}/box/keys/KUVO_KEY_`)
      .split(`{file:${K}/keys/KUVO_KEY_`).join(`{file:${shownRoot}/box/keys/KUVO_KEY_`);
  }
  if (Array.isArray(value)) return value.map(boxKeyPaths);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, boxKeyPaths(inner)]));
  return value;
}

const KEY_NAME = /^KUVO_KEY_[A-Za-z0-9_]+$/;

// Where this box's settings name its keys: its own keys' folder, or on a Mac the files the app
// writes its Keychain's keys to (KUVO_KEYS).
const KEYS_NAMED = IS_MAC && process.env.KUVO_KEYS ? process.env.KUVO_KEYS.replace(/\/+$/, "") : `${shownRoot}/box/keys`;

// A key named where another computer keeps its keys (`{file:<its folder>/KUVO_KEY_…}`, from Also
// Apply), named where this box keeps them.
export function keysNamedHere(value) {
  if (typeof value === "string") return value.replace(/\{file:[^{}]*?(KUVO_KEY_[A-Za-z0-9_]+)\}/g, (_, name) => `{file:${KEYS_NAMED}/${name}}`);
  if (Array.isArray(value)) return value.map(keysNamedHere);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, keysNamedHere(inner)]));
  return value;
}


// Makes the machine's settings its own, once (a box of its own: PROTOCOL.md, "Settings per box"):
// what it runs with now, as its Mac's start left them (the global file under the Mac's own, which
// wins), with the keys beside them, goes in its box; or, on a machine with none, `seed` ({settings,
// keys}: the Mac's, as it would have sent them). The launch's lines for them go, so no start writes
// them back. An engine running now keeps reading what it started with, untouched; the next start
// reads the box, and clears what's below it (`global-adopted` says the global file came in whole).
// Under the launch's lock and the settings' own, so no start or change comes between.
// {status: "own" | "adopted", seeded, settings}.
// COMPAT(0.7 settings): makes the settings an older Mac's start left the box's own. Goes 3 months after 0.8.0.
export function adoptBox(seed) {
  return locked(LAUNCH_LOCK, () => locked(CONFIG_LOCK, () => {
    if (fs.existsSync(CONFIG_FILE)) {
      addDefaultRules();
      return { status: "own", settings: readSettings().settings ?? {} };
    }
    const global = readSettings(GLOBAL_FILE);
    const mac = readSettings(MAC_SETTINGS);
    const before = deepMerged(global.settings ?? {}, mac.settings ?? {});
    const seeded = !Object.keys(before).length && isObject(seed?.settings);
    const settings = boxKeyPaths(seeded ? seed.settings : before);
    fs.mkdirSync(BOX_KEYS, { recursive: true, mode: 0o700 });
    fs.chmodSync(BOX, 0o700);
    if (seeded) {
      for (const [name, value] of Object.entries(isObject(seed.keys) ? seed.keys : {})) {
        if (KEY_NAME.test(name) && typeof value === "string") writePrivate(path.join(BOX_KEYS, name), value);
      }
    } else {
      // The shared keys; a bot's own (`…__<bot>`) stay where its folder names them.
      let names = [];
      try { names = fs.readdirSync(MAC_KEYS); } catch {}
      for (const name of names) {
        if (!KEY_NAME.test(name) || name.includes("__")) continue;
        try { writePrivate(path.join(BOX_KEYS, name), fs.readFileSync(path.join(MAC_KEYS, name), "utf8")); } catch {}
      }
    }
    // What it was made from, kept beside it.
    const kept = path.join(BOX, "adopted-from");
    fs.mkdirSync(kept, { recursive: true, mode: 0o700 });
    for (const [file, name] of [[GLOBAL_FILE, "opencode.json"], [MAC_SETTINGS, "settings.json"]]) {
      try { writePrivate(path.join(kept, name), fs.readFileSync(file, "utf8")); } catch {}
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
  }, { stale: 300_000, wait: 120_000 }));
}

// What a box starts its engine with, unless its settings set it, each once (`defaults-added` names
// those done), so one you take out stays out:
// - bots' memory, theirs to write in any mode (Plan changes no files): a rule in Settings ›
//   Permissions you see and can take out (`bot-memory`);
// - on a Mac, web search through Exa, which needs no key (the engine has none chosen, and every
//   search fails): in settings that are new or empty, or never given it (`websearch`); and once,
//   Exa in place of "random", as Kuvo Code chose it before (`search-exa`). (A machine's came with
//   the Mac's settings it started from.)
// Under the settings' lock.
export const BOT_MEMORY_RULE = { action: "edit", resource: "*/bots/bot_*/MEMORY.md", effect: "allow" };
const DEFAULTS_ADDED = path.join(BOX, "defaults-added");
function addDefaultRules(mac = IS_MAC, file = CONFIG_FILE, marks = DEFAULTS_ADDED) {
  let done = [];
  try { done = fs.readFileSync(marks, "utf8").split("\n").filter(Boolean); } catch {}
  const wanted = mac ? ["bot-memory", "websearch", "search-exa"] : ["bot-memory"];
  if (wanted.every(mark => done.includes(mark))) return;
  const { settings, problem } = readSettings(file);
  if (problem) return;
  const changes = [];
  const exa = { provider: "exa" };
  if (mac && (!Object.keys(settings).length || !done.includes("websearch"))) {
    if (settings.websearch === undefined) changes.push({ path: ["websearch"], value: exa });
    done.push("websearch", "search-exa");
  } else if (mac && !done.includes("search-exa")) {
    if (sameJSON(settings.websearch, { provider: "random" })) changes.push({ path: ["websearch"], value: exa });
    done.push("search-exa");
  }
  if (!done.includes("bot-memory")) {
    const rules = Array.isArray(settings.permissions) ? settings.permissions : [];
    if (!rules.some(rule => sameJSON(rule, BOT_MEMORY_RULE))) changes.push({ path: ["permissions"], value: [...rules, BOT_MEMORY_RULE] });
    done.push("bot-memory");
  }
  if (changes.length && writeSettings(settings, changes, file).status !== 200) return;
  writePrivate(marks, [...new Set(done)].join("\n") + "\n");
}

// This Mac's box, as it starts: its defaults, before any client reads its settings.
export function addMacDefaults(file = CONFIG_FILE, marks = DEFAULTS_ADDED) {
  locked(CONFIG_LOCK, () => addDefaultRules(true, file, marks));
}

// `kuvo/keys…`: the box's integrations' keys, through its key store (`keyNames`, `readKey`…), a
// bot's own not among them; where they can't be reached now (this Mac's app not answering), `503`.
export async function answerKeys(method, route, body) {
  try {
    if (route === "kuvo/keys") return method === "GET" ? { status: 200, value: { keys: (await keyNames()).filter(name => !name.includes("__")) } } : { status: 405, value: {} };
    const parts = route.split("/");
    let name = "";
    try { name = parts.length === 3 ? decodeURIComponent(parts[2]) : ""; } catch {}
    if (!STORED_KEY.test(name) || name.includes("__")) return { status: 400, value: { message: "That isn't a key's name." } };
    switch (method) {
      case "GET": {
        const value = await readKey(name);
        return value == null ? { status: 404, value: {} } : { status: 200, value: { value } };
      }
      case "PUT": {
        const value = body?.value;
        if (typeof value !== "string" || !value) return { status: 400, value: { message: "Send {\"value\": \"…\"}." } };
        await keyWork(() => writeKey(name, value));
        return { status: 200, value: {} };
      }
      case "DELETE":
        await keyWork(() => deleteKey(name));
        return { status: 200, value: {} };
      default:
        return { status: 405, value: {} };
    }
  } catch (error) {
    if (error instanceof KeysUnavailable) return { status: 503, value: { message: error.message } };
    throw error;
  }
}

// A key of the box's own, set (`value`) or removed (null): integrations' servers read it there.
export function setBoxKey(name, value) {
  if (!KEY_NAME.test(String(name)) || String(name).includes("__")) return { status: 400, message: "That isn't a key's name." };
  return locked(CONFIG_LOCK, () => {
    if (value == null) fs.rmSync(path.join(BOX_KEYS, name), { force: true });
    else writePrivate(path.join(BOX_KEYS, name), String(value));
    return { status: 200 };
  });
}

// The popular servers, as this box has them: on a machine, those that use the Mac's own apps left out.
export function mcpCatalog(settings, file = CATALOG_FILE, mac = IS_MAC) {
  let servers = [];
  try { servers = JSON.parse(fs.readFileSync(file, "utf8")).servers ?? []; } catch {}
  return {
    servers: servers.filter(server => typeof server?.id === "string" && (mac || !server.macOnly)).map(server => {
      const added = valueAt(settings, [...SERVERS, server.id]) !== undefined;
      return { id: server.id, title: String(server.title ?? ""), summary: String(server.summary ?? ""), access: String(server.access ?? "open"),
        added, integration: added && Boolean(server.integration), macOnly: mac && Boolean(server.macOnly) };
    }),
  };
}

// One of them added, as its Add button does; one already there stays as it is.
export function addFromCatalog(id, file = CONFIG_FILE, catalog = CATALOG_FILE, lock = CONFIG_LOCK, mac = IS_MAC) {
  let servers = [];
  try { servers = JSON.parse(fs.readFileSync(catalog, "utf8")).servers ?? []; } catch {}
  const server = servers.find(each => each?.id === id && (mac || !each.macOnly));
  if (!server || !isObject(server.settings)) return { status: 404 };
  const { settings, problem } = readSettings(file);
  if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
  if (valueAt(settings, [...SERVERS, id]) !== undefined) return { status: 200, settings };
  return changeSettings([{ path: [...SERVERS, id], value: { codemode: false, ...server.settings } }], file, lock);
}
