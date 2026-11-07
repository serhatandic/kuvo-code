// Bots' own keys (PROTOCOL.md, "Bots' own keys"): keys a bot here has of its own for the
// integrations you bring a key for, kept where this box keeps its keys (`<variable>__<BOT>`: a
// machine's in `box/bot-keys`, this Mac's in its Keychain, through the app) and named by a settings
// file of its folder's own, so only its conversation uses them. A bot that works in a project uses
// that project's.

import fs from "node:fs";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import type { Body } from "../../shared/json";
import type { EngineRecord } from "../../shared/records";
import type { BotKeyKept, BotKeys, BotKeyValues } from "../../shared/routes/bots";
import { soon } from "../../shared/wait";
import { botHere } from "../bots/here";
import { listOf, textOf, writePrivate } from "../files";
import { APP_KEY_FILES, BOTS, shownRoot } from "../home";
import { KeysUnavailable } from "../host-interface";
import { botVariable, deleteKey, keyNames, keyWork, readKey, STORED_KEY, writeKey } from "../keys";
import type { AnswerPiece, JSONAnswer, RouteContext } from "../server/context";
import { integrationCatalog, INTEGRATIONS_FILE } from "./integrations";
import type { CatalogIntegration } from "./integrations";

/** An integration a bot can have keys of its own for: one you bring a key for, its server's
 * `settings` and each of its keys' `variables` (all stored keys' names). */
export type KeyedIntegration = CatalogIntegration & { variables: Record<string, string> };

/** A bot's folder's settings (`workspace/.opencode/opencode.json`): what this reads of them, its
 * MCP servers, and the rest as they are. */
export interface BotFolderSettings {
  mcp?: { servers?: Record<string, unknown>; [more: string]: unknown };
  [more: string]: unknown;
}

/** Its folder's settings as they are, and where; `problem` when they aren't plain JSON. */
export type BotSettings =
  | { folder: string; file: string; settings: BotFolderSettings; problem?: undefined }
  | { folder: string; file: string; settings?: undefined; problem: string };

/** What writing a bot's folder's settings came to: done, or why not. */
export type BotSettingsWritten = { status: 200; message?: undefined } | { status: 409; message: string };

/** What runs something a moment later (`soon`, or a test's own). */
export type Later = (run: () => void, ms: number) => unknown;

/** What `kuvo/bots/<id>/keys…` answers: its integrations, one's keys, one's just kept, `{}` for
 * done (or nothing to say), or why not. */
export type BotKeysAnswer = JSONAnswer<BotKeys | BotKeyValues | BotKeyKept | { message: string } | Record<string, never>>;

/** Where the engine reads a bot's own keys, as its settings name the folder: this Mac's app's
 * (`KUVO_KEYS`, where it keeps each key in a file named by its variable), or a machine's
 * `box/bot-keys`. */
const BOT_KEY_FOLDER = APP_KEY_FILES;
const botKeyFolder = () => BOT_KEY_FOLDER ?? `${shownRoot}/box/bot-keys`;

/** The integrations a bot can have keys of its own for: those you bring a key for. */
const botKeyed = (catalog: CatalogIntegration[]): KeyedIntegration[] => catalog.filter(entry => ["token", "package"].includes(entry.way) && entry.settings && Object.keys(entry.variables ?? {}).length
  && Object.values(entry.variables!).every(variable => typeof variable === "string" && STORED_KEY.test(variable))) as KeyedIntegration[];

/** Whether `bot` has every key of its own for `entry`, among the keys kept (`names`). */
const hasOwnKeys = (bot: string, entry: KeyedIntegration, names: string[]): boolean => Object.values(entry.variables).every(variable => names.includes(botVariable(variable, bot)));

/** `entry`'s server as `bot`'s conversation runs it: each of its keys (`{file:<a folder>/<variable>}`)
 * the bot's own in its place (`{file:<bot keys' folder>/<variable>__<BOT>}`). */
function botServer(entry: KeyedIntegration, bot: string): unknown {
  const folder = botKeyFolder();
  const swapped = (value: unknown): unknown => {
    if (typeof value === "string") {
      return Object.values(entry.variables).reduce((text, variable) =>
        text.replace(new RegExp(`\\{file:[^{}]*/${variable}\\}`, "g"), () => `{file:${folder}/${botVariable(variable, bot)}}`), value);
    }
    if (Array.isArray(value)) return value.map(swapped);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, swapped(inner)]));
    return value;
  };
  return swapped(entry.settings);
}

/** Its folder's settings as they are, and where; `problem` when they aren't plain JSON (left alone). */
function botSettings(bot: string): BotSettings {
  const folder = path.join(BOTS, bot, "workspace", ".opencode");
  const file = path.join(folder, "opencode.json");
  const text = textOf(file);
  if (text === null || !text.trim()) return { folder, file, settings: {} };
  let settings: BotFolderSettings | undefined;
  try { settings = JSON.parse(text); } catch {}
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(settings) || (settings.mcp !== undefined && !isObject(settings.mcp)) || (settings.mcp?.servers !== undefined && !isObject(settings.mcp.servers))) {
    return { folder, file, problem: "Its folder's settings aren't plain JSON, so its own keys can't be named there." };
  }
  return { folder, file, settings };
}

/** Its folder's settings naming a server for each integration it has its own keys for (among the
 * keys kept, `names`), and no longer one for those it had them for; the rest of the file as it was
 * (the Mac's BotKeys.change). */
function writeBotSettings(bot: string, catalog: CatalogIntegration[], names: string[]): BotSettingsWritten {
  const { folder, file, settings: old, problem } = botSettings(bot);
  if (problem) return { status: 409, message: problem };
  const suffix = botVariable("", bot);
  const usesOwn = (server: unknown): boolean => (JSON.stringify(server).match(/KUVO_KEY_[A-Z0-9_]+/g) ?? []).some(name => name.endsWith(suffix));
  const servers = Object.fromEntries(Object.entries(old!.mcp?.servers ?? {}).filter(([, server]) => !usesOwn(server)));
  for (const entry of botKeyed(catalog)) if (hasOwnKeys(bot, entry, names)) servers[entry.id] = botServer(entry, bot);
  const mcp: NonNullable<BotFolderSettings["mcp"]> = { ...(old!.mcp ?? {}) };
  if (Object.keys(servers).length) mcp.servers = servers;
  else delete mcp.servers;
  const next: BotFolderSettings = { ...old };
  if (Object.keys(mcp).length) next.mcp = mcp;
  else delete next.mcp;
  if (JSON.stringify(next) === JSON.stringify(old)) return { status: 200 };
  if (Object.keys(next).length) {
    writePrivate(file, JSON.stringify(next, null, 2) + "\n");
  } else {
    fs.rmSync(file, { force: true });
    try { fs.rmdirSync(folder); } catch {}
  }
  return { status: 200 };
}

/** Each bot here: its folder's settings as its keys and this box's integrations are now (a
 * server's newer version, say, or settings that came with it from another computer naming its
 * keys there). As the box starts, and from a client (`POST kuvo/bots/keys/refresh`). */
export function refreshBotsKeys(file = INTEGRATIONS_FILE): Promise<void> {
  return keyWork(() => refreshingBotsKeys(file));
}

async function refreshingBotsKeys(file: string): Promise<void> {
  const bots = listOf(BOTS).filter(bot => {
    const here = botHere(bot);
    return here && !here.described.project;
  });
  if (!bots.length) return;
  const catalog = integrationCatalog(file);
  const names = await keyNames();
  for (const bot of bots) writeBotSettings(bot, catalog, names);
}

/** Its server, connected again in the bot's folder a moment later, with the keys it has now. */
function reconnectForBot(engine: EngineRecord | null, id: string, bot: string, later: Later): void {
  if (!engine?.port) return;
  const folder = path.join(BOTS, bot, "workspace");
  later(() => fetch(`http://127.0.0.1:${engine.port}/api/experimental/mcp/${encodeURIComponent(id)}/connect`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(folder) },
  }).catch(() => {}), 2_000);
}

/** `kuvo/bots/<id>/keys…`, for a bot that lives on this box. `later` runs what waits a moment (a
 * test's own). Where its keys are kept can't be reached (this Mac's app not answering): `503 {"message"}`. */
/** A bot's own keys gone from this box, by their names, whether it's here or not (one that moved
 * away, its folder in the trash): whether they are now. */
export async function forgetBotKeys(bot: string): Promise<boolean> {
  try {
    return await keyWork(async () => {
      for (const name of (await keyNames()).filter(each => each.endsWith(botVariable("", bot)))) await deleteKey(name);
      return true;
    });
  } catch {
    return false;
  }
}

export async function answerBotKeys(method: string, requestPath: string, body: Body<"keys">, engine: EngineRecord | null, file = INTEGRATIONS_FILE, later: Later = soon): Promise<BotKeysAnswer> {
  try {
    return await keyWork(() => botKeysAnswer(method, requestPath, body, engine, file, later));
  } catch (error) {
    if (error instanceof KeysUnavailable) return { status: 503, value: { message: error.message } };
    throw error;
  }
}

async function botKeysAnswer(method: string, requestPath: string, body: Body<"keys">, engine: EngineRecord | null, file: string, later: Later): Promise<BotKeysAnswer> {
  const parts = requestPath.split("?")[0].split("/").map(part => { try { return decodeURIComponent(part); } catch { return null; } });
  const message = (text: string) => ({ message: text });
  // (A string, once it's a bot here.)
  const bot = parts[2]!;
  const here = botHere(bot);
  if (!here) return { status: 404, value: message("That bot isn’t on this computer.") };
  if (here.described.project) return { status: 409, value: message(`${here.described.name} works in a project, so it uses the keys that project's sessions use.`) };
  const catalog = integrationCatalog(file);
  const keyed = botKeyed(catalog);
  // Which keys are kept, by name: whether it has its own, and whether the box has shared ones, never
  // reading a key to say so.
  const names = await keyNames();
  const shared = (entry: KeyedIntegration): boolean => Object.values(entry.variables).every(variable => names.includes(variable));
  const without = (gone: string[]): string[] => names.filter(name => !gone.includes(name));
  if (parts.length === 4) {
    // Each with what Edit Bot shows of it: its name, symbol, the keys it takes and where to get them.
    if (method === "GET") return { status: 200, value: { keys: keyed.map(entry => ({ integration: entry.id, own: hasOwnKeys(bot, entry, names), shared: shared(entry),
      title: entry.title, symbol: entry.symbol, keys: (entry.keys ?? []).map(({ name, label, prompt }) => ({ name, label, prompt })), ...(entry.help ? { help: entry.help } : {}) })) } satisfies BotKeys };
    if (method !== "DELETE") return { status: 405, value: {} };
    // All of them, as it leaves this box: what it moved with goes with it, and any left from
    // integrations no longer here.
    const had = keyed.filter(entry => hasOwnKeys(bot, entry, names));
    const own = names.filter(name => name.endsWith(botVariable("", bot)));
    // Its settings without them first, so none names a key that's gone if one can't be taken away.
    const written = writeBotSettings(bot, catalog, without(own));
    for (const name of own) await deleteKey(name);
    for (const entry of had) reconnectForBot(engine, entry.id, bot, later);
    return written.status === 200 ? { status: 200, value: {} } : { status: written.status, value: message(written.message) };
  }
  if (parts.length !== 5) return { status: 404, value: {} };
  const entry = keyed.find(each => each.id === parts[4]);
  if (!entry) return { status: 404, value: message("A bot can't have a key of its own for that here.") };
  const fields = Object.keys(entry.variables);
  const variableOf = (name: string): string => botVariable(entry.variables[name], bot);
  switch (method) {
    case "GET": {
      if (!hasOwnKeys(bot, entry, names)) return { status: 404, value: {} };
      const keys: Record<string, string> = {};
      for (const name of fields) keys[name] = (await readKey(variableOf(name))) ?? "";
      return { status: 200, value: { keys } satisfies BotKeyValues };
    }
    case "PUT": {
      const given = body?.keys && typeof body.keys === "object" ? body.keys as Record<string, unknown> : {};
      if (!fields.every(name => typeof given[name] === "string" && given[name].trim())) {
        const labels = (entry.keys ?? []).map(key => key.label).join(" and ") || fields.join(" and ");
        return { status: 400, value: message(`${entry.title} needs ${labels}: send them as {"keys": {"${fields[0]}": …}}.`) };
      }
      // Its folder's settings are checked first: none are written where they can't be named.
      const { problem } = botSettings(bot);
      if (problem) return { status: 409, value: message(problem) };
      for (const name of fields) await writeKey(variableOf(name), (given[name] as string).trim());
      writeBotSettings(bot, catalog, [...names, ...fields.map(variableOf)]);
      reconnectForBot(engine, entry.id, bot, later);
      return { status: 200, value: { integration: entry.id, own: true, shared: shared(entry) } satisfies BotKeyKept };
    }
    case "DELETE": {
      if (!hasOwnKeys(bot, entry, names)) return { status: 404, value: {} };
      // Its folder's settings are checked first: its key stays while they can't say it's gone.
      const { problem } = botSettings(bot);
      if (problem) return { status: 409, value: message(problem) };
      const own = fields.map(variableOf);
      const written = writeBotSettings(bot, catalog, without(own));
      for (const name of own) await deleteKey(name);
      reconnectForBot(engine, entry.id, bot, later);
      return written.status === 200 ? { status: 200, value: {} } : { status: written.status, value: message(written.message) };
    }
    default:
      return { status: 405, value: {} };
  }
}

// Its bots' folders' settings as their keys and this box's integrations are now, as a client
// asks after it changes them (before the bot keys' route, which would take "keys" for a bot).
export async function* botKeysRefreshRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  try {
    await refreshBotsKeys();
  } catch (error) {
    if (!(error instanceof KeysUnavailable)) throw error;
    return yield* json(503, { message: error.message });
  }
  return yield* json(200, {});
}

// A bot's keys of its own, as Edit Bot shows and changes them.
export async function* botKeysRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, json } = context;
  let engine: EngineRecord | null = null;
  try { engine = readEngine(); } catch {}
  const { status, value } = await answerBotKeys(request.method.toUpperCase(), request.path, parsed(request.body) as Body<"keys">, engine);
  return yield* json(status, value);
}
