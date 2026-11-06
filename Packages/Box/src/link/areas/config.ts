// This box's own settings (PROTOCOL.md, "kuvo/config")
// The engine's settings file, which the engine reloads when it changes: this box's own, changed
// from any client (the Mac app, a phone) by the same rules. Each computer keeps its own; nothing
// copies them between computers but you ("Also Apply to…", `applySettings`). Writes take
// `run/.config.lock`.

import fs from "node:fs";
import path from "node:path";
import { isObject, sameJSON, sortedJSON } from "../../shared/json";
import { locked, writePrivate } from "../files";
import { APP_KEY_FILES, BOX, CONFIG_LOCK, ENGINE_CONFIG, IS_MAC, shownRoot } from "../home";

export const CONFIG_FILE = IS_MAC ? path.join(ENGINE_CONFIG!, "opencode", "opencode.json") : path.join(BOX, "opencode.json");
const OWN_MARK = IS_MAC ? null : CONFIG_FILE;
export const SERVERS = ["mcp", "servers"];

/** The engine's settings, as its file has them: a JSON object. */
export type Settings = Record<string, unknown>;

/** The settings file read: its settings, or why it's left alone. */
export type SettingsRead = { settings: Settings; problem?: undefined } | { settings?: undefined; problem: string };

/** One change to the settings (`PATCH kuvo/config`): the value at a path of keys (null removes
 * it), and with `was`, only while the value there is still that. */
export interface SettingChange {
  path: string[];
  value: unknown;
  was?: unknown;
}

/** The settings as a change left them, or why it wasn't made (with a file's `problem`, for one
 * left alone). */
export type SettingsChanged = { status: 200; settings: Settings } | { status: 400 | 409 | 500; message: string; problem?: string };

// COMPAT(0.7 settings): the routes answer 409 until a Mac adopts the settings an older Mac's start left. Goes 3 months after 0.8.0.
export const ownsSettings = (mark: string | null = OWN_MARK): boolean => mark === null || fs.existsSync(mark);

export const sortedKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortedKeys)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;

// The file's settings: {settings}, none for a file that isn't there yet, or {problem} for one that
// can't be read (not plain JSON, a link to a file that isn't there, no permission), left alone:
// a write would put something else in its place.
export function readSettings(file = CONFIG_FILE): SettingsRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    let link = false;
    try { link = fs.lstatSync(file).isSymbolicLink(); } catch {}
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && !link) return { settings: {} };
    return { problem: link && (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? "It's a link to a file that isn't there, so Kuvo Code leaves it alone."
      : `It couldn't be read, so Kuvo Code leaves it alone (${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.message}).` };
  }
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (!isObject(parsed)) throw new Error("not an object");
    return { settings: parsed };
  } catch {
    return { problem: "It isn't plain JSON, so Kuvo Code leaves it alone. (Comments aren't supported here.)" };
  }
}

export const valueAt = (object: unknown, keys: string[]): unknown => keys.reduce((current: unknown, key) => isObject(current) ? current[key] : undefined, object);

// `object` with `value` at `keys` (nil removes it, and an object it leaves empty).
export function settingAt(object: Settings, keys: string[], value: unknown): Settings {
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
// {status, message}, as the Mac answers. (Whatever a client sent, checked here.)
export function changeSettings(changes: unknown, file = CONFIG_FILE, lock = CONFIG_LOCK): SettingsChanged {
  const fits = Array.isArray(changes) && changes.length >= 1 && changes.length <= 100 && changes.every(change =>
    Array.isArray(change?.path) && change.path.length >= 1 && change.path.length <= 16
    && change.path.every((key: unknown) => typeof key === "string" && key.length >= 1 && key.length <= 200) && "value" in change);
  if (!fits) return { status: 400, message: "Send {\"changes\": [{\"path\": [keys…], \"value\": …}]}." };
  return locked(lock, () => {
    const { settings, problem } = readSettings(file);
    if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
    // Keys go through objects only: one through a list or a plain value would replace it whole.
    // (Changes as `fits` checked them: each a path of keys and a value.)
    if ((changes as SettingChange[]).some(change => change.path.slice(0, -1).some((_, at) => {
      const above = valueAt(settings, change.path.slice(0, at + 1));
      return above !== undefined && !isObject(above);
    }))) return { status: 400, message: "A path goes through objects only; send a list whole, at its own path." };
    if ((changes as SettingChange[]).some(change => "was" in change && sortedJSON(valueAt(settings, change.path) ?? null) !== sortedJSON(change.was))) {
      return { status: 409, message: "It changed since you read it." };
    }
    return writeSettings(settings!, changes as SettingChange[], file);
  });
}

// `changes` ({path, value}) made to `settings` and written, under the settings' lock: {status,
// settings}, or {status, message}.
export function writeSettings(settings: Settings, changes: SettingChange[], file: string): SettingsChanged {
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
    return { status: 500, message: `It couldn't be saved: ${(error as Error).message}` };
  }
  return { status: 200, settings: next };
}

// The file a link names, link after link; `file` itself when it isn't a link.
function linkTarget(file: string): string {
  let target = file;
  for (let i = 0; i < 8; i++) {
    let destination: string;
    try { destination = fs.readlinkSync(target); } catch { break; }
    target = path.resolve(path.dirname(target), destination);
  }
  return target;
}

// Objects merged key by key, `over` winning; a list or a plain value is replaced whole.
export function deepMerged(under: unknown, over: unknown): unknown {
  if (!isObject(under) || !isObject(over)) return over === undefined ? under : over;
  const merged = { ...under };
  for (const [key, value] of Object.entries(over)) merged[key] = key in under ? deepMerged(under[key], value) : value;
  return merged;
}

export const KEY_NAME = /^KUVO_KEY_[A-Za-z0-9_]+$/;

// Where this box's settings name its keys: its own keys' folder, or on a Mac the files the app
// writes its Keychain's keys to (KUVO_KEYS).
const KEYS_NAMED = IS_MAC && APP_KEY_FILES ? APP_KEY_FILES : `${shownRoot}/box/keys`;

// `value` with each key that `named` finds named where this box keeps them.
const namingKeysHere = (named: RegExp) => {
  const rename = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(named, (_, name) => `{file:${KEYS_NAMED}/${name}}`);
    if (Array.isArray(value)) return value.map(rename);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, rename(inner)]));
    return value;
  };
  return rename;
};

// A key named where another computer keeps its keys (`{file:<its folder>/KUVO_KEY_…}`, from Also
// Apply), named where this box keeps them.
export const keysNamedHere = namingKeysHere(/\{file:[^{}]*?(KUVO_KEY_[A-Za-z0-9_]+)\}/g);
// The same, and one an earlier version named in the engine's environment (`{env:KUVO_KEY_…}`).
export const olderKeysNamedHere = namingKeysHere(/\{(?:env|file):[^{}]*?(KUVO_KEY_[A-Za-z0-9_]+)\}/g);


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
export function addDefaultRules(mac = IS_MAC, file = CONFIG_FILE, marks = DEFAULTS_ADDED): void {
  let done: string[] = [];
  try { done = fs.readFileSync(marks, "utf8").split("\n").filter(Boolean); } catch {}
  const wanted = mac ? ["bot-memory", "websearch", "search-exa"] : ["bot-memory"];
  if (wanted.every(mark => done.includes(mark))) return;
  const { settings, problem } = readSettings(file);
  if (problem) return;
  const changes: SettingChange[] = [];
  const exa = { provider: "exa" };
  if (mac && (!Object.keys(settings!).length || !done.includes("websearch"))) {
    if (settings!.websearch === undefined) changes.push({ path: ["websearch"], value: exa });
    done.push("websearch", "search-exa");
  } else if (mac && !done.includes("search-exa")) {
    if (sameJSON(settings!.websearch, { provider: "random" })) changes.push({ path: ["websearch"], value: exa });
    done.push("search-exa");
  }
  if (!done.includes("bot-memory")) {
    const rules = Array.isArray(settings!.permissions) ? settings!.permissions : [];
    if (!rules.some(rule => sameJSON(rule, BOT_MEMORY_RULE))) changes.push({ path: ["permissions"], value: [...rules, BOT_MEMORY_RULE] });
    done.push("bot-memory");
  }
  if (changes.length && writeSettings(settings!, changes, file).status !== 200) return;
  writePrivate(marks, [...new Set(done)].join("\n") + "\n");
}

// This Mac's box, as it starts: its defaults, before any client reads its settings.
export function addMacDefaults(file = CONFIG_FILE, marks = DEFAULTS_ADDED): void {
  locked(CONFIG_LOCK, () => addDefaultRules(true, file, marks));
}
