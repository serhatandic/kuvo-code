// Also Apply (PROTOCOL.md, "kuvo/config/apply")
// Changes made to another computer's settings, made to this box's too, when you ask ("Also Apply
// to…"): each as it was made there, {path, before, after} (absent or null: nothing). A list of
// rules (Settings › Permissions' rules and blocks, an agent's) gets what was added there and loses
// what was taken out, keeping the rest of this box's own; anything else (another list, like a
// server's command, too) is set as it is there. What each computer keeps its own (its shell, a
// worktrees folder on its disk) stays as it is; a server that uses a Mac's own apps stays off
// machines; and a field of a server, agent, command or provider this box doesn't have isn't made.

import fs from "node:fs";
import { isObject, sameJSON } from "../../shared/json";
import type { Body } from "../../shared/json";
import { locked } from "../files";
import { CONFIG_LOCK, IS_MAC } from "../home";
import type { ConfigApplied } from "../../shared/routes/settings";
import { CONFIG_FILE, keysNamedHere, readSettings, settingAt, valueAt, writeSettings } from "./config";
import type { SettingChange, Settings, SettingsChanged } from "./config";
import { CATALOG_FILE } from "./mcp-catalog";

/** A change made to another computer's settings, as Also Apply sends it: the path of keys it's at,
 * and the value there before and after (absent or null: nothing). */
export interface ChangeMade {
  path: string[];
  before?: unknown;
  after?: unknown;
}

/** What `translateSettings` makes of the changes here: each made, at its path; the entries this
 * box doesn't have that some were to; the paths it keeps its own; and the servers that stay on Macs. */
export interface Translated {
  made: SettingChange[];
  leftOut: string[][];
  kept: string[][];
  macOnly: string[];
}

/** What `applySettings` answers: what was made (or would be, with `dry`), with the keys those name,
 * whether something was, and the settings now; or why nothing was. */
export type SettingsApplied = ({ status: 200 } & ConfigApplied) | SettingsChanged;

// The engine's own agents, on every computer whether its settings name them or not.
const BUILT_IN_AGENTS = ["build", "plan", "general", "explore", "compaction", "title", "summary"];
const isRules = (keys: string[]) => ["permissions", "policies"].includes(keys[keys.length - 1]);

// Something each computer keeps its own: its shell (each picks from its own), and a worktrees
// folder on its disk (one relative to each project goes).
function keptOwn(change: ChangeMade): boolean {
  if (sameJSON(change.path, ["shell"])) return true;
  if (!sameJSON(change.path, ["worktree", "directory"])) return false;
  const folder = typeof change.after === "string" ? change.after : typeof change.before === "string" ? change.before : null;
  return folder !== null && (folder.startsWith("/") || folder.startsWith("~"));
}

// The named entry (an MCP server, an agent, a command, a provider) `keys` is a field of, when it's
// one a computer may not have (the engine's own agents it always has).
function entryOf(keys: string[]): string[] | null {
  if (keys[0] === "mcp" && keys.length >= 4 && keys[1] === "servers") return keys.slice(0, 3);
  if (keys[0] === "agents" && keys.length >= 3 && BUILT_IN_AGENTS.includes(keys[1])) return null;
  if (["agents", "commands", "providers"].includes(keys[0]) && keys.length >= 3) return keys.slice(0, 2);
  return null;
}

// What a computer needs to have for `change` to be made there: the entry it's a field of, or the
// agent `default_agent` names.
function neededFor(change: ChangeMade): string[] | null {
  if (sameJSON(change.path, ["default_agent"]) && typeof change.after === "string" && !BUILT_IN_AGENTS.includes(change.after)) return ["agents", change.after];
  return entryOf(change.path);
}

// The servers that use a Mac's own apps, as a Mac's catalog names them (its `macOnly`, and the
// servers it marks so).
function macOnlyServers(file = CATALOG_FILE): Set<string> {
  try {
    const catalog: { macOnly?: unknown; servers?: { id?: unknown; macOnly?: unknown }[] } = JSON.parse(fs.readFileSync(file, "utf8"));
    const named = [...(Array.isArray(catalog.macOnly) ? catalog.macOnly : []), ...(catalog.servers ?? []).filter(server => server?.macOnly).map(server => server.id)];
    return new Set(named.filter(id => typeof id === "string"));
  } catch {
    return new Set();
  }
}

// The keys `value` names: integrations' shared keys, not a bot's own.
function keyNamesIn(value: unknown, names: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") for (const [name] of value.matchAll(/KUVO_KEY_[A-Z0-9_]+/g)) { if (!name.includes("__")) names.add(name); }
  else if (Array.isArray(value)) value.forEach(each => keyNamesIn(each, names));
  else if (isObject(value)) Object.values(value).forEach(each => keyNamesIn(each, names));
  return names;
}

// What `changes` make of `settings`, here: {made: [{path, value}], leftOut: [entry], kept: [path],
// macOnly: [server]}: what's made; the entries it doesn't have that some were to; what it keeps its
// own; and the servers that stay on Macs.
export function translateSettings(changes: ChangeMade[], settings: Settings, { mac = IS_MAC, macOnly = macOnlyServers() }: { mac?: boolean; macOnly?: Set<string> } = {}): Translated {
  let here = settings;
  const made: SettingChange[] = [], leftOut: string[][] = [], kept: string[][] = [], stayed: string[] = [];
  const has = (list: unknown[], item: unknown) => list.some(each => sameJSON(each, item));
  for (const change of changes) {
    const keys = change.path;
    if (!mac && keys.length >= 3 && keys[0] === "mcp" && keys[1] === "servers" && macOnly.has(keys[2])) {
      if (!stayed.includes(keys[2])) stayed.push(keys[2]);
      continue;
    }
    if (keptOwn(change)) {
      if (!has(kept, keys)) kept.push(keys);
      continue;
    }
    // A field of something this box doesn't have, or the mode new sessions start in when it's an
    // agent it doesn't have: none made with only that (adding or removing a whole one still goes).
    const entry = neededFor(change);
    if (entry && valueAt(here, entry) === undefined) {
      if (!has(leftOut, entry)) leftOut.push(entry);
      continue;
    }
    const before = change.before ?? null, after = change.after ?? null;
    let value = keysNamedHere(after);
    // Rules: none is an empty list, so the first one added (or the last taken out) joins (or
    // leaves) this box's own, rather than standing in for them.
    if (isRules(keys) && (Array.isArray(before) || Array.isArray(after)) && (before === null || Array.isArray(before)) && (after === null || Array.isArray(after))) {
      const was = (before ?? []).map(keysNamedHere), now = (after ?? []).map(keysNamedHere);
      const current = Array.isArray(valueAt(here, keys)) ? valueAt(here, keys) as unknown[] : [];
      const removed = was.filter(item => !has(now, item));
      const added = now.filter(item => !has(was, item));
      const staying = current.filter(item => !has(removed, item));
      const merged = [...staying, ...added.filter(item => !has(staying, item))];
      value = merged.length ? merged : null;
    }
    made.push({ path: keys, value });
    here = settingAt(here, keys, value);
  }
  return { made, leftOut, kept, macOnly: stayed };
}

// `POST kuvo/config/apply` with {changes: [{path, before?, after?}], dry?}: the changes made here
// as `translateSettings` makes them, in one write (none with `dry`). {status, made, leftOut, kept,
// macOnly, keys, applied, settings}: `keys`, those `made` names, for a client to bring along first
// where this box hasn't its own; `applied`, something was made, or every change was already so.
export function applySettings(body: Body<"changes" | "dry">, file = CONFIG_FILE, lock = CONFIG_LOCK, options: { mac?: boolean; macOnly?: Set<string> } = {}): SettingsApplied {
  const changes = body?.changes;
  const fits = Array.isArray(changes) && changes.length >= 1 && changes.length <= 100 && changes.every(change =>
    Array.isArray(change?.path) && change.path.length >= 1 && change.path.length <= 16
    && change.path.every((key: unknown) => typeof key === "string" && key.length >= 1 && key.length <= 200));
  if (!fits) return { status: 400, message: "Send {\"changes\": [{\"path\": [keys…], \"before\": …, \"after\": …}]}." };
  return locked(lock, (): SettingsApplied => {
    // (Its settings are there whenever there's no problem.)
    const { settings, problem } = readSettings(file) as { settings: Settings; problem?: string };
    if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
    // (Changes as `fits` checked them: each a path of keys.)
    const result = translateSettings(changes as ChangeMade[], settings, options);
    if (result.made.some(change => change.path.slice(0, -1).some((_, at) => {
      const above = valueAt(settings, change.path.slice(0, at + 1));
      return above !== undefined && !isObject(above);
    }))) return { status: 400, message: "A path goes through objects only; send a list whole, at its own path." };
    const keys = [...keyNamesIn(result.made.map(change => change.value))].sort();
    const applied = result.made.length > 0 || (!result.leftOut.length && !result.kept.length && !result.macOnly.length);
    if (body!.dry === true || !result.made.length) return { status: 200, ...result, keys, applied, settings } satisfies { status: 200 } & ConfigApplied;
    const written = writeSettings(settings, result.made, file);
    if (written.status !== 200) return written;
    return { status: 200, ...result, keys, applied, settings: written.settings } satisfies { status: 200 } & ConfigApplied;
  });
}
