// Integrations (PROTOCOL.md, "Integrations"), as the Mac's Settings › Integrations has them.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isObject, parsed, sameJSON } from "../../shared/json";
import type { Body } from "../../shared/json";
import type { EngineRecord, Target } from "../../shared/records";
import type { Integration, IntegrationAdded, IntegrationHealth, Integrations } from "../../shared/routes/integrations";
import { soon } from "../../shared/wait";
import { call } from "../engine/client";
import { listOf, locked, writePrivate } from "../files";
import { BOTS, CONFIG_LOCK, INTEGRATION_DATA, IS_MAC, K, OWN_HOME_MAC, OWN_RUNTIME, SCRIPT } from "../home";
import { answeringOnce } from "../once";
import { KeysUnavailable, siteSignIns } from "../host-interface";
import { deleteKey, keyNames, keyWork, STORED_KEY, writeKey } from "../keys";
import type { AnswerPiece, JSONAnswer, RouteContext } from "../server/context";
import { updateOnTrial } from "../updates/update";
import { CATALOG_FILE } from "./mcp-catalog";
import { changeSettings, CONFIG_FILE, olderKeysNamedHere, ownsSettings, readSettings, SERVERS, valueAt, writeSettings } from "./config";
import type { SettingChange, Settings } from "./config";
import type { EngineCredential } from "./accounts";

/** The catalog a Mac's box in a home of its own reads (#333 piece 6a): every integration, those that
 * use a Mac's own apps too, with their keys named where it keeps them (`box/keys`), as its release
 * brings it (the app wrote the box's in its folder before, `MachineBox.writeMacCatalog`). */
export const MAC_INTEGRATIONS = path.join(K, "bin", "integrations-mac.json");
export const INTEGRATIONS_FILE = OWN_HOME_MAC && fs.existsSync(MAC_INTEGRATIONS) ? MAC_INTEGRATIONS : path.join(K, "bin", "integrations.json");

/** An integration as its Mac's catalog has it (`bin/integrations.json`): what `kuvo/integrations`
 * lists of it, then what adding it takes: the server's `settings` it adds, its keys' `variables`
 * (each key's name, as a client sends it, to the variable its server reads), and `signInFile`, the
 * file a server that signs in by itself with a code keeps once it has. */
export type CatalogIntegration = Omit<Integration, "added" | "keysSaved" | "siteSignedIn" | "health" | "signIn"> & {
  settings?: unknown;
  variables?: Record<string, string>;
  signInFile?: string;
};

/** An MCP server as the engine lists it (`api/mcp`): what this reads of it. */
interface EngineServer {
  name?: string;
  status?: { status?: string };
  integrationID?: string;
}

/** What `kuvo/integrations…` answers: the list, one just added, `{}` for done (or nothing to say),
 * or why not. */
export type IntegrationsAnswer = JSONAnswer<Integrations | IntegrationAdded | { message: string } | Record<string, never>>;

/** The integrations this box offers, from the catalog its Mac leaves in `bin` (this Mac's app, as it
 * starts its box): on a machine, not those that use a Mac's own apps. */
export function integrationCatalog(file = INTEGRATIONS_FILE): CatalogIntegration[] {
  try { return (JSON.parse(fs.readFileSync(file, "utf8")).integrations ?? []).filter((each: CatalogIntegration) => typeof each?.id === "string" && (IS_MAC || !each.macOnly)); } catch { return []; }
}

// What runs a package's server, and what tells it to run apart from the project.
const LAUNCHER = "kuvo-npx";
const APART = "KUVO_NPX_APART";
// Kuvo Code's own browser tools: not yours to change.
const OWN_SERVER = "kuvo-browser";
// Chrome DevTools as Settings › MCP Servers offers it, with the options it's started with and what
// says the opposite of each.
const DEVTOOLS = "chrome-devtools";
const DEVTOOLS_PACKAGE = "chrome-devtools-mcp";
const DEVTOOLS_FLAGS = [["--no-usage-statistics", "--usage-statistics"], ["--isolated", "--no-isolated"]];

/** "@scope/name" of "@scope/name@1.2.3", "name" of "name@1.2.3". */
function packageName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Whether its settings still run the package of one whose maker now has its own server (Figma's). */
const leftForItsMaker = (entry: CatalogIntegration, server: Record<string, unknown>): boolean =>
  entry.way === "official" && isObject(entry.settings) && Array.isArray(server.command) && server.command[0] === LAUNCHER;

const kept = (server: Record<string, unknown>, names: string[]) => Object.fromEntries(names.filter(name => server[name] !== undefined).map(name => [name, server[name]]));

/** An added integration's settings as `entry` has them now: the maker's server, for one it left a
 * package for, still off if you turned it off and with the Code Mode you chose; else its tools plain
 * tools, its package started as it's pinned now and its keys named where this box reads them, with
 * whatever else you set on it. */
function broughtUpToDate(entry: CatalogIntegration, server: Record<string, unknown>): unknown {
  if (leftForItsMaker(entry, server)) return { ...entry.settings as object, ...kept(server, ["disabled", "codemode"]) };
  const next = { ...server };
  if (next.codemode === undefined) next.codemode = false;
  const pinned = isObject(entry.settings) ? entry.settings.command : undefined;
  const old = server.command;
  if (entry.way === "package" && Array.isArray(pinned) && typeof pinned[1] === "string" && Array.isArray(old) && old[0] === LAUNCHER
    && typeof old[1] === "string" && packageName(old[1]) === packageName(pinned[1])) {
    next.command = pinned;
    const environment = server.environment === undefined ? {} : server.environment;
    if (isObject(environment) && environment[APART] === undefined) next.environment = { ...environment, [APART]: "1" };
  }
  return olderKeysNamedHere(next);
}

/** "1.9.9" is before "chrome-devtools-mcp@1.12.0", by number; unpinned or "latest" is before any. */
function isOlderVersion(version: string | undefined, pinned: string): boolean {
  if (!version || version === "latest") return true;
  const numbers = (text: string) => text.split(".").map(part => parseInt(part, 10) || 0);
  const mine = numbers(version), theirs = numbers(pinned.slice(pinned.lastIndexOf("@") + 1));
  for (let index = 0; index < Math.max(mine.length, theirs.length); index++) {
    const a = mine[index] ?? 0, b = theirs[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/** Chrome DevTools as an older version added it (through npx, unpinned, an older version), as it's
 * offered now: a newer version you chose stays, and so do your options (--no-isolated keeps a profile
 * of its own) and anything else set on it. `server` itself when there's nothing to change. */
function devToolsUpToDate(server: Record<string, unknown>, offered: Record<string, unknown>): Record<string, unknown> {
  const pinned = Array.isArray(offered.command) ? offered.command[1] : undefined;
  if (!Array.isArray(server.command) || typeof pinned !== "string") return server;
  const words = server.command.filter((word): word is string => typeof word === "string");
  const at = words.findIndex(word => word === DEVTOOLS_PACKAGE || word.startsWith(`${DEVTOOLS_PACKAGE}@`));
  if (at < 0) return server;
  const version = words[at].includes("@") ? words[at].slice(words[at].indexOf("@") + 1) : undefined;
  const options = words.slice(at + 1);
  for (const [flag, opposite] of DEVTOOLS_FLAGS) {
    if (!options.some(word => word === flag || word === opposite || word.startsWith(`${opposite}=`))) options.unshift(flag);
  }
  const command = [LAUNCHER, isOlderVersion(version, pinned) ? pinned : words[at], ...options];
  const before = isObject(server.environment) ? server.environment : {};
  const environment = { ...before };
  for (const [name, value] of Object.entries(isObject(offered.environment) ? offered.environment : {})) {
    if (environment[name] === undefined || name === APART) environment[name] = value;
  }
  if (sameJSON(command, words) && sameJSON(environment, before)) return server;
  return { ...server, command, environment };
}

/** Chrome DevTools' settings as this box offers it: a Mac's, as it uses a Mac's own apps. */
function devToolsOffered(file: string, mac: boolean): Record<string, unknown> | null {
  if (!mac) return null;
  try {
    const servers: unknown = JSON.parse(fs.readFileSync(file, "utf8")).servers;
    const server = Array.isArray(servers) ? servers.find(each => isObject(each) && each.id === DEVTOOLS) : null;
    return isObject(server) && isObject(server.settings) ? server.settings : null;
  } catch { return null; }
}

/** What bringing `settings` up to date changes; nothing when they are. One left for its maker only
 * among `keysGone`. Other servers get what integrations do: their tools plain tools, unless they say. */
function upgradeChanges(settings: Settings, catalog: CatalogIntegration[], keysGone: Set<string>, popular: Record<string, unknown> | null): SettingChange[] {
  const servers = valueAt(settings, SERVERS);
  if (!isObject(servers)) return [];
  const changes: SettingChange[] = [];
  for (const [id, server] of Object.entries(servers)) {
    if (!isObject(server)) continue;
    const entry = catalog.find(each => each.id === id);
    if (!entry) {
      const next = id === DEVTOOLS && popular ? devToolsUpToDate(server, popular) : server;
      if (next !== server) changes.push({ path: [...SERVERS, id], value: { ...next, codemode: next.codemode ?? false } });
      else if (id !== OWN_SERVER && server.codemode === undefined) changes.push({ path: [...SERVERS, id, "codemode"], value: false });
      continue;
    }
    if (leftForItsMaker(entry, server) && !keysGone.has(id)) continue;
    const next = broughtUpToDate(entry, server);
    if (!sameJSON(next, server)) changes.push({ path: [...SERVERS, id], value: next });
  }
  return changes;
}

/** Writes what bringing the settings up to date changes, worked out under the settings' lock so a
 * client's change meanwhile stays. */
function writeUpgrade(catalog: CatalogIntegration[], popular: Record<string, unknown> | null, keysGone: Set<string>, file: string, lock: string): void {
  locked(lock, () => {
    const { settings, problem } = readSettings(file);
    const changes = settings ? upgradeChanges(settings, catalog, keysGone, popular) : [];
    const written = changes.length ? writeSettings(settings!, changes, file) : null;
    // Not a word from here otherwise, and the settings may name a key that's gone until the next start.
    const trouble = problem ?? (written?.status === 200 ? undefined : written?.message);
    if (trouble && (keysGone.size || written)) console.error(`Integrations couldn't be brought up to date: ${trouble}`);
  });
}

/** All that needs no key taken away, at once: for before this Mac's box says where it is, as its
 * engine starts only after that, and its app may not answer until then. */
export function upgradeBeforeEngine(catalogFile = INTEGRATIONS_FILE, file = CONFIG_FILE, lock = CONFIG_LOCK, popularFile = CATALOG_FILE, mac = IS_MAC): void {
  writeUpgrade(integrationCatalog(catalogFile), devToolsOffered(popularFile, mac), new Set(), file, lock);
}

/** Added integrations and MCP servers brought up to date from the catalogs this box has now, by the
 * box and only the box, with or without a client there.
 *
 * A package's key goes before its maker's server takes its place, as nothing names the key after, and
 * its bots' own keys for it with it: where they can't be taken away now (this Mac's app not answering),
 * that one waits for the next start. So does it while an update is on trial, as a key can't come back
 * if the keeper puts the version before back (the box does this again once its update is confirmed).
 * What's left can be undone: that version's catalog puts it back, if it brings them up to date too. */
export function upgradeIntegrations(catalogFile = INTEGRATIONS_FILE, file = CONFIG_FILE, lock = CONFIG_LOCK, popularFile = CATALOG_FILE, mac = IS_MAC): Promise<void> {
  return keyWork(async () => {
    const catalog = integrationCatalog(catalogFile);
    const { settings: before } = readSettings(file);
    const keysGone = new Set<string>();
    for (const entry of updateOnTrial() ? [] : catalog) {
      const server = valueAt(before, [...SERVERS, entry.id]);
      if (!isObject(server) || !leftForItsMaker(entry, server)) continue;
      const variables = [...new Set(JSON.stringify(server).match(/KUVO_KEY_[A-Z0-9_]+/g) ?? [])];
      try {
        await droppingBotsKeys(entry.id, variables);
        for (const name of variables) await deleteKey(name);
        keysGone.add(entry.id);
      } catch {}
    }
    writeUpgrade(catalog, devToolsOffered(popularFile, mac), keysGone, file, lock);
  });
}

/** How it's doing here, as Settings › Integrations says it: `off`, turned off in MCP Servers, so it
 * won't start until it's turned on. Just turned on, while the engine still says it's off, it's
 * starting. A server that signs in by itself with a code the first time it's used (Outlook's,
 * `signInFile` in the catalog) waits for that code until its sign-in is there. */
function integrationHealth(entry: CatalogIntegration, server: EngineServer | undefined, off: boolean, signedIn: Set<string> | null): IntegrationHealth {
  if (off) return "disabled";
  let health: IntegrationHealth = ({ connected: "connected", needs_auth: "needsSignIn", failed: "failed" } as Record<string, IntegrationHealth>)[server?.status?.status as string] ?? "starting";
  if (health === "connected" && server?.integrationID && signedIn && !signedIn.has(server.integrationID) && ["official", "app"].includes(entry.way)) health = "needsSignIn";
  if (health === "connected" && typeof entry.signInFile === "string" && !fs.existsSync(path.join(INTEGRATION_DATA, entry.id, path.basename(entry.signInFile)))) health = "waitsForCode";
  return health;
}

/** Each as `kuvo/integrations` lists it, from the catalog, with how it's doing here, and whether
 * its engine couldn't say how they're doing (`engineDown`: not running, or not answering), when an
 * added one's `health` is left out. */
async function integrationEntries(catalog: CatalogIntegration[], engine: EngineRecord | null, signal: AbortSignal | undefined): Promise<{ entries: Integration[]; engineDown: boolean }> {
  const { settings } = readSettings();
  let servers: EngineServer[] | null = null;
  // Null where the engine didn't say (busy, or not answering): not the same as none.
  let signedIn: Set<string> | null = new Set();
  // Integrations it has had a sign-in for, in use or not: one of them needing a sign-in had one that ended.
  let hadSignIn: Set<string> = new Set();
  if (engine) {
    // (As the engine answers it: its MCP servers, a list.)
    servers = await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => null) as EngineServer[] | null;
    const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => null);
    const oauth = (Array.isArray(credentials) ? credentials as EngineCredential[] : []).filter(each => each?.value?.type === "oauth");
    signedIn = Array.isArray(credentials) ? new Set(oauth.filter(each => each.active).map(each => each.integrationID)) : null;
    hadSignIn = new Set(oauth.map(each => each.integrationID));
  }
  const engineDown = !Array.isArray(servers);
  // Which keys it keeps, by name, never reading one (left unsaid where they can't be reached now).
  let names: string[] | null = null;
  try {
    names = await keyNames();
  } catch (error) {
    if (!(error instanceof KeysUnavailable)) throw error;
  }
  const sites = catalog.some(entry => entry.way === "browser") ? await siteSignIns() : null;
  const entries = catalog.map(({ settings: _, variables, signInFile, ...entry }) => {
    const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
    const shown: Integration = { ...entry, added };
    if (variables && names) shown.keysSaved = Object.values(variables).every(name => names.includes(name));
    if (entry.way === "browser" && typeof sites?.[entry.id] === "boolean") shown.siteSignedIn = sites![entry.id] as boolean;
    if (added) {
      const off = valueAt(settings ?? {}, [...SERVERS, entry.id, "disabled"]) === true;
      const server = (servers ?? []).find(each => each?.name === entry.id);
      // Without its engine, only one turned off can be told: it won't start whatever the engine says.
      if (!engineDown || off) shown.health = integrationHealth({ ...entry, signInFile }, server, off, signedIn);
      if (server?.integrationID) shown.signIn = server.integrationID;
      if (shown.health === "needsSignIn" && server?.integrationID && hadSignIn.has(server.integrationID)) shown.signInEnded = true;
    }
    return shown;
  });
  return { entries, engineDown };
}

/** Its bots' own keys for it (`KUVO_KEY_<ID>_<NAME>__<BOT>`) and their folders' settings naming its server, gone. */
function dropBotsIntegration(entry: CatalogIntegration): Promise<void> {
  return keyWork(() => droppingBotsIntegration(entry));
}

async function droppingBotsIntegration(entry: CatalogIntegration): Promise<void> {
  await droppingBotsKeys(entry.id, Object.values(entry.variables ?? {}).filter(variable => STORED_KEY.test(variable)));
}

/** Within `keyWork`: bots' own keys for `own`, and their folders' settings naming server `id`, gone. */
async function droppingBotsKeys(id: string, own: string[]): Promise<void> {
  // Their settings first, so none names a key that's gone if one can't be taken away.
  const named: string[] = [];
  for (const variable of own) named.push(...await keyNames({ prefix: `${variable}__` }));
  for (const bot of listOf(BOTS)) {
    const folder = path.join(BOTS, bot, "workspace", ".opencode");
    const file = path.join(folder, "opencode.json");
    let settings: { mcp?: { servers?: Record<string, unknown>; [more: string]: unknown }; [more: string]: unknown };
    try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    // Only its server as the bot's own keys made it, as the Mac's BotKeys has it: one written
    // there by hand stays.
    const server = settings?.mcp?.servers?.[id];
    if (!server || !own.some(variable => JSON.stringify(server).includes(`${variable}__`))) continue;
    // (Its servers are there: it has this one.)
    delete settings.mcp!.servers![id];
    if (!Object.keys(settings.mcp!.servers!).length) delete settings.mcp!.servers;
    if (!Object.keys(settings.mcp!).length) delete settings.mcp;
    if (Object.keys(settings).length) writePrivate(file, JSON.stringify(settings));
    else {
      fs.rmSync(file, { force: true });
      try { fs.rmdirSync(folder); } catch {}
    }
  }
  for (const name of named) await deleteKey(name);
}

/** Whether this box keeps every one of `variables`. */
async function keepsAll(variables: string[]): Promise<boolean> {
  const kept = await keyNames();
  return variables.every(variable => kept.includes(variable));
}


// (`box route` answers once and ends: what waits a moment goes in a process of its own, which
// outlives it, `once.ts`.)
export { answerOnce } from "../once";

/** Its server connected again a moment after its keys changed, once the engine has read them. */
function reconnectLater(engine: EngineRecord | null, id: string, later: typeof soon): void {
  if (!engine) return;
  if (answeringOnce() && later === soon) {
    spawn(process.execPath, [...OWN_RUNTIME, SCRIPT, "box", "reconnect", id], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
    return;
  }
  later(() => reconnectEverywhere(engine, id), 2_000);
}

/** An MCP server connected again everywhere its engine runs a copy: its own, and each folder it
 * has open (`api/debug/location`), as sessions and bots there each have theirs. */
export async function reconnectEverywhere(engine: Target, id: string): Promise<void> {
  const connect = `/api/experimental/mcp/${encodeURIComponent(id)}/connect`;
  await call(engine, "POST", connect).catch(() => {});
  const open = await call(engine, "GET", "/api/debug/location").catch(() => []);
  const folders = new Set((Array.isArray(open) ? open as ({ directory?: string } | null)[] : []).map(each => each?.directory).filter(folder => typeof folder === "string" && folder));
  for (const folder of folders) await call(engine, "POST", connect, undefined, undefined, folder).catch(() => {});
}

/** `kuvo/integrations…`, for this box's own, its keys where it keeps them (a machine's files, this
 * Mac's Keychain through its app). `later` runs what waits a moment (a test's own). */
export async function answerIntegrations(method: string, requestPath: string, body: Body<"keys">, engine: EngineRecord | null, signal: AbortSignal | undefined, file = INTEGRATIONS_FILE, later = soon): Promise<IntegrationsAnswer> {
  try {
    return await integrationsAnswer(method, requestPath, body, engine, signal, file, later);
  } catch (error) {
    if (error instanceof KeysUnavailable) return { status: 503, value: { message: error.message } };
    throw error;
  }
}

async function integrationsAnswer(method: string, requestPath: string, body: Body<"keys">, engine: EngineRecord | null, signal: AbortSignal | undefined, file: string, later: typeof soon): Promise<IntegrationsAnswer> {
  const parts = requestPath.split("?")[0].split("/").map(part => { try { return decodeURIComponent(part); } catch { return ""; } });
  const catalog = integrationCatalog(file);
  if (parts.length === 2) {
    if (method !== "GET") return { status: 405, value: {} };
    const { problem } = readSettings();
    const { entries, engineDown } = await integrationEntries(catalog, engine, signal);
    return { status: 200, value: { integrations: entries, ...(engineDown ? { engineDown } : {}), ...(problem ? { problem } : {}) } satisfies Integrations };
  }
  const entry = parts.length === 3 ? catalog.find(each => each.id === parts[2]) : null;
  if (!entry) return { status: 404, value: {} };
  const { settings, problem } = readSettings();
  if (problem) return { status: 409, value: { message: `The engine's settings file can't be changed from here: ${problem}` } };
  const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
  if (method === "POST") {
    if (entry.way === "browser" || !entry.settings) return { status: 409, value: { message: `The agent uses ${entry.title} on its site: sign in to it in the browser on ${IS_MAC ? "this Mac" : "this machine"}.` } };
    const variables = entry.variables ?? {};
    const given = body?.keys && typeof body.keys === "object" ? body.keys as Record<string, unknown> : {};
    const names = Object.keys(variables);
    if (!Object.values(variables).every(variable => typeof variable === "string" && STORED_KEY.test(variable))) {
      return { status: 409, value: { message: `${entry.title} can't be added here: its keys aren't named as Kuvo Code names them.` } };
    }
    let newKeys = false;
    if (names.length) {
      // Those sent saved (Change Key may send only the one you changed), the rest kept already.
      const sent = names.filter(name => typeof given[name] === "string" && given[name].trim());
      if (sent.length < names.length && !(await keepsAll(names.filter(name => !sent.includes(name)).map(name => variables[name])))) {
        const labels = (entry.keys ?? []).map(key => key.label).join(" and ");
        return { status: 400, value: { message: `${entry.title} needs ${labels}: send them as {"keys": {"${names[0]}": …}}.` } };
      }
      if (sent.length) {
        // One change at a time with any other key work here.
        await keyWork(async () => {
          for (const name of sent) await writeKey(variables[name], (given[name] as string).trim());
        });
        newKeys = true;
      }
    }
    // One there already is written again as it is now, with what another client changed while its
    // keys were saved (the engine reads its keys again); one removed meanwhile stays removed.
    const now = valueAt(readSettings().settings ?? {}, [...SERVERS, entry.id]);
    if (added && now === undefined) return { status: 409, value: { message: `${entry.title} was removed meanwhile.` } };
    const value = now ?? entry.settings;
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value }]);
    if (changed.status !== 200) return { status: changed.status, value: { message: changed.message } };
    // The engine reads its keys as it reads its settings again: its server connects again a
    // moment later, with the new ones, in every folder the engine has open.
    if (newKeys) reconnectLater(engine, entry.id, later);
    const { entries: [listed] } = await integrationEntries([entry], engine, signal);
    return { status: 200, value: { integration: listed } satisfies IntegrationAdded };
  }
  if (method === "DELETE") {
    if (!added) {
      // Its keys, left by a Remove that couldn't take them away: they go now. Nothing left, 404.
      const own = Object.values(entry.variables ?? {}).filter(variable => STORED_KEY.test(variable));
      const kept = own.length ? (await keyNames()).filter(name => own.includes(name)) : [];
      if (!kept.length) return { status: 404, value: {} };
      await keyWork(async () => {
        for (const name of kept) await deleteKey(name);
      });
      return { status: 200, value: {} };
    }
    // Bots here with keys of their own for it stop using it first: where their keys can't be taken
    // away, nothing goes, rather than leave a bot using an integration you removed.
    try {
      await dropBotsIntegration(entry);
    } catch (error) {
      if (!(error instanceof KeysUnavailable)) throw error;
      return { status: 503, value: { message: `${entry.title} wasn't removed: its bots' own keys for it couldn't be taken away. ${error.message}` } };
    }
    // Its sign-in as the engine has it, asked before it leaves the settings.
    let signIn: string | undefined;
    if (engine) {
      const servers = await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => []);
      signIn = (Array.isArray(servers) ? servers as EngineServer[] : []).find(each => each?.name === entry.id)?.integrationID;
    }
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value: null }]);
    if (changed.status !== 200) return { status: changed.status, value: { message: changed.message } };
    if (engine && signIn) {
      const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => []);
      for (const each of Array.isArray(credentials) ? credentials as EngineCredential[] : []) {
        if (each?.integrationID === signIn) await call(engine, "DELETE", `/api/credential/${encodeURIComponent(each.id)}`, undefined, signal).catch(() => {});
      }
    }
    // What its server kept: its own folder (and the file it once kept).
    for (const name of [entry.id, `${entry.id}.json`]) fs.rmSync(path.join(INTEGRATION_DATA, name), { recursive: true, force: true });
    try {
      await keyWork(async () => {
        for (const variable of Object.values(entry.variables ?? {})) if (STORED_KEY.test(variable)) await deleteKey(variable);
      });
    } catch (error) {
      if (!(error instanceof KeysUnavailable)) throw error;
      return { status: 503, value: { message: `${entry.title} is removed, but its key is still kept. ${error.message}` } };
    }
    return { status: 200, value: {} };
  }
  return { status: 405, value: {} };
}

// Settings › Integrations (PROTOCOL.md, "Integrations"): this machine's own, added and removed
// here from the catalog the Mac leaves (`bin/integrations.json`), with the Mac closed too.
export async function* integrationsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, readEngine, json } = context;
  if (!ownsSettings()) return yield* json(409, { message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." });
  let engine: EngineRecord | null = null;
  try { engine = readEngine(); } catch {}
  const { status, value } = await answerIntegrations(request.method.toUpperCase(), request.path, parsed(request.body) as Body<"keys">, engine, signal);
  return yield* json(status, value);
}
