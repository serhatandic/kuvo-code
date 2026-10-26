// @ts-nocheck
// Integrations (PROTOCOL.md, "Integrations"), as the Mac's Settings › Integrations has them.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { soon } from "../../shared/wait";
import { call } from "../engine/client";
import { listOf, writePrivate } from "../files";
import { BOTS, INTEGRATION_DATA, IS_MAC, K, SCRIPT } from "../home";
import { KeysUnavailable, siteSignIns } from "../host-interface";
import { deleteKey, keyNames, keyWork, STORED_KEY, writeKey } from "../keys";
import { changeSettings, readSettings, SERVERS, valueAt } from "./config";

export const INTEGRATIONS_FILE = path.join(K, "bin", "integrations.json");

/** The integrations this box offers, from the catalog its Mac leaves in `bin` (this Mac's app, as it
 * starts its box): on a machine, not those that use a Mac's own apps. */
export function integrationCatalog(file = INTEGRATIONS_FILE) {
  try { return (JSON.parse(fs.readFileSync(file, "utf8")).integrations ?? []).filter(each => typeof each?.id === "string" && (IS_MAC || !each.macOnly)); } catch { return []; }
}

/** How it's doing here, as Settings › Integrations says it: `off`, turned off in MCP Servers, so it
 * won't start until it's turned on. Just turned on, while the engine still says it's off, it's
 * starting. A server that signs in by itself with a code the first time it's used (Outlook's,
 * `signInFile` in the catalog) waits for that code until its sign-in is there. */
function integrationHealth(entry, server, off, signedIn) {
  if (off) return "disabled";
  let health = { connected: "connected", needs_auth: "needsSignIn", failed: "failed" }[server?.status?.status] ?? "starting";
  if (health === "connected" && server?.integrationID && !signedIn.has(server.integrationID) && ["official", "app"].includes(entry.way)) health = "needsSignIn";
  if (health === "connected" && typeof entry.signInFile === "string" && !fs.existsSync(path.join(INTEGRATION_DATA, entry.id, path.basename(entry.signInFile)))) health = "waitsForCode";
  return health;
}

/** Each as `kuvo/integrations` lists it, from the catalog, with how it's doing on this machine. */
/** Each as `kuvo/integrations` lists it, and whether its engine couldn't say how they're doing
 * (`engineDown`: not running, or not answering), when an added one's `health` is left out. */
async function integrationEntries(catalog, engine, signal) {
  const { settings } = readSettings();
  let servers = null;
  let signedIn = new Set();
  if (engine) {
    servers = await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => null);
    const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => []);
    signedIn = new Set((Array.isArray(credentials) ? credentials : []).filter(each => each?.active && each?.value?.type === "oauth").map(each => each.integrationID));
  }
  const engineDown = !Array.isArray(servers);
  // Which keys it keeps, by name, never reading one (left unsaid where they can't be reached now).
  let names = null;
  try {
    names = await keyNames();
  } catch (error) {
    if (!(error instanceof KeysUnavailable)) throw error;
  }
  const sites = catalog.some(entry => entry.way === "browser") ? await siteSignIns() : null;
  const entries = catalog.map(({ settings: _, variables, signInFile, ...entry }) => {
    const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
    const shown = { ...entry, added };
    if (variables && names) shown.keysSaved = Object.values(variables).every(name => names.includes(name));
    if (entry.way === "browser" && typeof sites?.[entry.id] === "boolean") shown.siteSignedIn = sites[entry.id];
    if (added) {
      const off = valueAt(settings ?? {}, [...SERVERS, entry.id, "disabled"]) === true;
      const server = (servers ?? []).find(each => each?.name === entry.id);
      // Without its engine, only one turned off can be told: it won't start whatever the engine says.
      if (!engineDown || off) shown.health = integrationHealth({ ...entry, signInFile }, server, off, signedIn);
      if (server?.integrationID) shown.signIn = server.integrationID;
    }
    return shown;
  });
  return { entries, engineDown };
}

/** Its bots' own keys for it (`KUVO_KEY_<ID>_<NAME>__<BOT>`) and their folders' settings naming its server, gone. */
function dropBotsIntegration(entry) {
  return keyWork(() => droppingBotsIntegration(entry));
}

async function droppingBotsIntegration(entry) {
  const own = Object.values(entry.variables ?? {}).filter(variable => STORED_KEY.test(variable));
  // Their settings first, so none names a key that's gone if one can't be taken away.
  const named = [];
  for (const variable of own) named.push(...await keyNames({ prefix: `${variable}__` }));
  for (const bot of listOf(BOTS)) {
    const folder = path.join(BOTS, bot, "workspace", ".opencode");
    const file = path.join(folder, "opencode.json");
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    // Only its server as the bot's own keys made it, as the Mac's BotKeys has it: one written
    // there by hand stays.
    const server = settings?.mcp?.servers?.[entry.id];
    if (!server || !own.some(variable => JSON.stringify(server).includes(`${variable}__`))) continue;
    delete settings.mcp.servers[entry.id];
    if (!Object.keys(settings.mcp.servers).length) delete settings.mcp.servers;
    if (!Object.keys(settings.mcp).length) delete settings.mcp;
    if (Object.keys(settings).length) writePrivate(file, JSON.stringify(settings));
    else {
      fs.rmSync(file, { force: true });
      try { fs.rmdirSync(folder); } catch {}
    }
  }
  for (const name of named) await deleteKey(name);
}

/** Whether this box keeps every one of `variables`. */
async function keepsAll(variables) {
  const kept = await keyNames();
  return variables.every(variable => kept.includes(variable));
}


// Set by `box route`, a command that answers once and ends: what waits a moment goes in a process
// of its own, which outlives it.
let answersOnce = false;
export function answerOnce() {
  answersOnce = true;
}

/** Its server connected again a moment after its keys changed, once the engine has read them. */
function reconnectLater(engine, id, later) {
  if (!engine) return;
  if (answersOnce && later === soon) {
    spawn(process.execPath, [SCRIPT, "box", "reconnect", id], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
    return;
  }
  later(() => reconnectEverywhere(engine, id), 2_000);
}

/** An MCP server connected again everywhere its engine runs a copy: its own, and each folder it
 * has open (`api/debug/location`), as sessions and bots there each have theirs. */
export async function reconnectEverywhere(engine, id) {
  const connect = `/api/experimental/mcp/${encodeURIComponent(id)}/connect`;
  await call(engine, "POST", connect).catch(() => {});
  const open = await call(engine, "GET", "/api/debug/location").catch(() => []);
  const folders = new Set((Array.isArray(open) ? open : []).map(each => each?.directory).filter(folder => typeof folder === "string" && folder));
  for (const folder of folders) await call(engine, "POST", connect, undefined, undefined, folder).catch(() => {});
}

/** `kuvo/integrations…`, for this box's own, its keys where it keeps them (a machine's files, this
 * Mac's Keychain through its app). `later` runs what waits a moment (a test's own). */
export async function answerIntegrations(method, requestPath, body, engine, signal, file = INTEGRATIONS_FILE, later = soon) {
  try {
    return await integrationsAnswer(method, requestPath, body, engine, signal, file, later);
  } catch (error) {
    if (error instanceof KeysUnavailable) return { status: 503, value: { message: error.message } };
    throw error;
  }
}

async function integrationsAnswer(method, requestPath, body, engine, signal, file, later) {
  const parts = requestPath.split("?")[0].split("/").map(part => { try { return decodeURIComponent(part); } catch { return ""; } });
  const catalog = integrationCatalog(file);
  if (parts.length === 2) {
    if (method !== "GET") return { status: 405, value: {} };
    const { problem } = readSettings();
    const { entries, engineDown } = await integrationEntries(catalog, engine, signal);
    return { status: 200, value: { integrations: entries, ...(engineDown ? { engineDown } : {}), ...(problem ? { problem } : {}) } };
  }
  const entry = parts.length === 3 ? catalog.find(each => each.id === parts[2]) : null;
  if (!entry) return { status: 404, value: {} };
  const { settings, problem } = readSettings();
  if (problem) return { status: 409, value: { message: `The engine's settings file can't be changed from here: ${problem}` } };
  const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
  if (method === "POST") {
    if (entry.way === "browser" || !entry.settings) return { status: 409, value: { message: `The agent uses ${entry.title} on its site: sign in to it in the browser on ${IS_MAC ? "this Mac" : "this machine"}.` } };
    const variables = entry.variables ?? {};
    const given = body?.keys && typeof body.keys === "object" ? body.keys : {};
    const names = Object.keys(variables);
    if (!Object.values(variables).every(variable => typeof variable === "string" && STORED_KEY.test(variable))) {
      return { status: 409, value: { message: `${entry.title} can't be added here: its keys aren't named as Kuvo Code names them.` } };
    }
    let newKeys = false;
    if (names.length) {
      if (names.every(name => typeof given[name] === "string" && given[name].trim())) {
        // All of them, one change at a time with any other key work here.
        await keyWork(async () => {
          for (const name of names) await writeKey(variables[name], given[name].trim());
        });
        newKeys = true;
      } else if (!(await keepsAll(names.map(name => variables[name])))) {
        const labels = (entry.keys ?? []).map(key => key.label).join(" and ");
        return { status: 400, value: { message: `${entry.title} needs ${labels}: send them as {"keys": {"${names[0]}": …}}.` } };
      }
    }
    // One there already is written again as it is (the engine reads its keys again).
    const value = added ? valueAt(settings, [...SERVERS, entry.id]) : entry.settings;
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value }]);
    if (changed.status !== 200) return { status: changed.status, value: { message: changed.message } };
    // The engine reads its keys as it reads its settings again: its server connects again a
    // moment later, with the new ones, in every folder the engine has open.
    if (newKeys) reconnectLater(engine, entry.id, later);
    const { entries: [listed] } = await integrationEntries([entry], engine, signal);
    return { status: 200, value: { integration: listed } };
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
    let signIn;
    if (engine) signIn = (await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => [])).find?.(each => each?.name === entry.id)?.integrationID;
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value: null }]);
    if (changed.status !== 200) return { status: changed.status, value: { message: changed.message } };
    if (engine && signIn) {
      const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => []);
      for (const each of Array.isArray(credentials) ? credentials : []) {
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
