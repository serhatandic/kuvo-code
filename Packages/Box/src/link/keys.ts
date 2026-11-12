// Where keys are kept (PROTOCOL.md, "Host interface"): integrations' keys by their variable's
// name (`KUVO_KEY_<ID>_<NAME>`, a bot's own `…__<BOT>`). A machine keeps them in files only you can
// read (its shared ones in `box/keys`, its bots' own in `box/bot-keys`); this Mac's box asks its
// app, which keeps them in the Keychain and writes the files its engine reads them from.

import fs from "node:fs";
import path from "node:path";
import { textOf, listOf, locked, writeSecret } from "./files";
import { BOT_KEYS, BOX_KEYS, CONFIG_LOCK, KEYS_ON_HOST } from "./home";
import { KeysUnavailable, NOT_ANSWERING, appHost, askHost } from "./host-interface";

/** The only names the box ever asks for. */
export const STORED_KEY = /^KUVO_KEY_[A-Z0-9_]+$/;

/** The app that keeps this box's keys, or null for its files; this Mac's box without its app says so. */
function keyHost() {
  const host = appHost();
  if (KEYS_ON_HOST && !host) throw new KeysUnavailable(NOT_ANSWERING);
  return host;
}

// Key work, one change at a time: on this Mac each key is a round trip to the app, and two changes
// (a phone's and Edit Bot's, or a save during the refresh at start) would each write a bot's
// settings from the names they read before the other's.
let keyQueue: Promise<unknown> = Promise.resolve();
export function keyWork<T>(work: () => T | Promise<T>): Promise<T> {
  const run = keyQueue.then(work, work);
  keyQueue = run.catch(() => {});
  return run;
}

const checkedKeyName = (name: unknown): string => {
  if (typeof name !== "string" || !STORED_KEY.test(name)) throw new KeysUnavailable("That isn't a key's name.");
  return name;
};

/** The file one is kept in on a machine: a bot's own beside the others, the shared ones in `box/keys`. */
const keyFile = (name: string) => path.join(checkedKeyName(name).includes("__") ? BOT_KEYS : BOX_KEYS, name);

/** The names of the keys kept, those that begin with `prefix` and end with `suffix`, sorted. */
export async function keyNames({ prefix = "", suffix = "" }: { prefix?: string; suffix?: string } = {}): Promise<string[]> {
  if (typeof prefix !== "string" || typeof suffix !== "string" || (prefix && !/^KUVO_KEY_[A-Z0-9_]*$/.test(prefix)) || (suffix && !/^[A-Z0-9_]+$/.test(suffix))) {
    throw new KeysUnavailable("That isn't a part of a key's name.");
  }
  const host = keyHost();
  let names: unknown[];
  if (host) {
    const answer = await askHost(host, "keys/names", { ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) });
    // An answer without its list isn't "no keys" (a refresh would take every bot's servers away).
    if (!Array.isArray(answer.names)) throw new KeysUnavailable("This Mac's keys couldn't be read.");
    names = answer.names;
  } else {
    names = [...listOf(BOX_KEYS).filter(name => !name.includes("__")), ...listOf(BOT_KEYS).filter(name => name.includes("__"))];
  }
  return [...new Set(names.filter((name): name is string => typeof name === "string" && STORED_KEY.test(name) && name.startsWith(prefix) && name.endsWith(suffix)))].sort();
}

/** One key's value as it's kept; null for one there isn't. */
export async function readKey(name: string): Promise<string | null> {
  checkedKeyName(name);
  const host = keyHost();
  if (!host) return textOf(keyFile(name));
  const answer = await askHost(host, "keys/get", { name }, true);
  return typeof answer?.value === "string" ? answer.value : null;
}

/** One key kept, in place of one there was. */
export async function writeKey(name: string, value: unknown): Promise<void> {
  checkedKeyName(name);
  if (typeof value !== "string") throw new KeysUnavailable("A key is text.");
  const host = keyHost();
  if (host) return void await askHost(host, "keys/set", { name, value });
  // A shared one under the settings' lock, as a Mac making the machine's settings its own copies them.
  if (name.includes("__")) writeSecret(keyFile(name), value);
  else locked(CONFIG_LOCK, () => writeSecret(keyFile(name), value));
}

/** One key gone (nothing for one there wasn't). */
export async function deleteKey(name: string): Promise<void> {
  checkedKeyName(name);
  const host = keyHost();
  if (host) return void await askHost(host, "keys/delete", { name });
  if (name.includes("__")) fs.rmSync(keyFile(name), { force: true });
  else locked(CONFIG_LOCK, () => fs.rmSync(keyFile(name), { force: true }));
}

/** A bot's own variable for one of an integration's, as the Mac's IntegrationKeys names it. */
export const botVariable = (variable: string, bot: string) => `${variable}__${String(bot).toUpperCase().replace(/[^\p{L}\p{N}]/gu, "_")}`;
