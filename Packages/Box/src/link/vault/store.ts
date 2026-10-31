// The vault's store (PROTOCOL.md, "Vault"): its items without their values in `box/vault/items.json`,
// and their values where this box keeps secrets: this Mac's Keychain, through its app (the host
// interface's `vault/…` calls), or a machine's own encrypted files (`box/vault/values/<id>`,
// AES-256-GCM), whose key is only ever in this process's memory. A machine's store key is kept on
// disk wrapped by the unlock key, which only your clients keep: after a restart the store is locked
// until one of them sends it (`kuvo/vault/unlock`, or any client request that carries it).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { newID, oneLine } from "../../shared/text";
import { GRANT_HOWS, ITEM_KINDS, type VaultGrant, type VaultItem, type VaultState, type VaultWho } from "../../shared/routes/vault";
import { locked, textOf, writePrivate } from "../files";
import { BOX, KEYS_ON_HOST, MAC_VAULT_FILE_KEY, RUN } from "../home";
import { appHost, askHost, KeysUnavailable, NOT_ANSWERING } from "../host-interface";
import { listBots } from "../bots/list";
import { agentsUseVault, agentsWaitForOlder } from "./gate";

export const VAULT_FOLDER = path.join(BOX, "vault");
const ITEMS = path.join(VAULT_FOLDER, "items.json");
const GRANTS = path.join(VAULT_FOLDER, "grants.json");
const PAUSED = path.join(VAULT_FOLDER, "paused.json");
const KEY_FILE = path.join(VAULT_FOLDER, "key.json");
const VALUES = path.join(VAULT_FOLDER, "values");
const LOCK = path.join(RUN, ".vault.lock");

/** Activity is kept this long (D14). */
export const KEPT_DAYS = 365;

/** Why the vault can't do something now, said plainly: a route answers `status {message}` with it. */
export class VaultRefusal extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 423 | 503, message: string) {
    super(message);
  }
}

export const LOCKED = "This computer's vault is locked since it started again. Open Kuvo Code on your Mac or iPhone to unlock it.";

// A machine's store key and unlock key while it's unlocked: in this process's memory only.
let storeKey: Buffer | null = null;
let unlockKey: Buffer | null = null;

/** Forgets the keys (a test's restart, or the process ending). */
export function forgetKeys() {
  storeKey = null;
  unlockKey = null;
}

const readJSON = <T>(file: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; }
};

// ── Signed files ──────────────────────────────────────────────────────────────────────────────
// Items (with their sites), grants and Pause decide what an agent may use, and an agent's command
// can write any file this box can: so each is signed with a key no agent can read (a machine's
// from its store key, in memory while it's unlocked; this Mac's from its Keychain, which its app
// gives this box alone), and one that isn't signed, or was changed, counts for nothing.

export const TAMPERED = "The vault's files were changed outside Kuvo Code, so it uses none of them. Add its items again.";

/** The key files are signed with now; null while a machine's vault is locked, or on a Mac whose app gave none. */
const fileKey = (): Buffer | null => {
  if (onHost()) return MAC_VAULT_FILE_KEY;
  return storeKey ? crypto.createHmac("sha256", storeKey).update("kuvo-vault-files").digest() : null;
};

const signatureOf = (key: Buffer, file: string, generation: number, data: unknown) =>
  crypto.createHmac("sha256", key).update(`${path.basename(file)}\0${generation}\0${JSON.stringify(data)}`).digest("base64url");

// Files found changed since this process started (said in the state until they're written again),
// and each one's newest generation seen: an older copy put back (with grants you took away since)
// is changed too. (Across a restart, a machine's is checked from its first read on.)
const tampered = new Set<string>();
const newest = new Map<string, number>();

// This Mac's newest generations are kept by its app too, in the Keychain, so a copy put back while
// the box was stopped is caught as it starts: until they're read from it, agents' use waits.
let primed = false;
const STARTING = "This Mac's vault is starting. Try again in a moment.";
// Why the generations couldn't be read (its Keychain locked, say), said while agents wait.
let primeTrouble: string | null = null;
/** Notes why this Mac's generations couldn't be read. */
export const notePrimeTrouble = (why: string) => {
  primeTrouble = why;
};

/** This Mac's newest generations, from its app (once, as the box starts). */
export async function primeGenerations(): Promise<void> {
  if (!onHost() || primed) return;
  const answer = await asHost(() => askHost(host(), "vault/generations", {}));
  const kept = isObject(answer?.generations) ? answer.generations : {};
  for (const file of [ITEMS, GRANTS, PAUSED]) {
    const generation = kept[path.basename(file, ".json")];
    const onDisk = Number(readJSON<{ gen?: unknown } | null>(file, null)?.gen) || 0;
    if (typeof generation === "number") newest.set(file, Math.max(newest.get(file) ?? 0, generation));
    // None kept yet by an older app: the files' own, taken once, and kept from now on.
    else if (answer?.adopt === true && onDisk > 0) {
      newest.set(file, onDisk);
      rememberGeneration(file, onDisk);
    }
    // A file there whose generation the app doesn't have (it was taken out of the Keychain):
    // not taken as a first run, but as changed.
    else if (fs.existsSync(file)) newest.set(file, Number.MAX_SAFE_INTEGER);
  }
  primed = true;
  primeTrouble = null;
}

// What's been told to this Mac's app, in order: a change is answered once its app has it. One it
// couldn't keep pauses agents' use until one is kept (a copy put back then couldn't be caught).
let told: Promise<unknown> = Promise.resolve();
const unkept = new Set<string>();
const UNKEPT = "This Mac's vault couldn't keep what it changed last in the Keychain. Try again in a moment.";

/** Tells this Mac's app a file's newest generation. */
const rememberGeneration = (file: string, generation: number) => {
  if (!onHost()) return;
  const found = appHost();
  if (!found) {
    unkept.add(file);
    return;
  }
  told = told
    .then(() => askHost(found, "vault/generations", { file: path.basename(file, ".json"), generation }))
    .then(() => { unkept.delete(file); }, () => { unkept.add(file); });
};

/** Once this Mac's app has every generation told it so far. */
export const generationsTold = () => told;

/** Each signed file's generation now, for a client to remember and check (a machine's). */
export const generations = (): Record<string, number> =>
  Object.fromEntries([ITEMS, GRANTS, PAUSED].map(file => [path.basename(file, ".json"), Number(readJSON<{ gen?: unknown } | null>(file, null)?.gen) || 0]));

/** A signed file's data: `fallback` when there's none, or it can't be checked now (locked), or it
 * wasn't signed with this vault's key. */
function readSigned<T>(file: string, fallback: T): T {
  const kept = readJSON<{ gen?: unknown; data?: T; sig?: unknown } | null>(file, null);
  if (!kept) return fallback;
  const key = fileKey();
  if (!key) return fallback;
  const generation = typeof kept.gen === "number" ? kept.gen : -1;
  const given = Buffer.from(typeof kept.sig === "string" ? kept.sig : "");
  const expected = Buffer.from(signatureOf(key, file, generation, kept.data));
  if (kept.data === undefined || given.length !== expected.length || !crypto.timingSafeEqual(given, expected) || generation < (newest.get(file) ?? 0)) {
    tampered.add(file);
    return fallback;
  }
  newest.set(file, generation);
  return kept.data;
}

function keepSigned(file: string, data: unknown) {
  const key = fileKey();
  if (!key) throw onHost() ? new VaultRefusal(503, "Kuvo Code on this Mac didn't give its vault its key. Quit Kuvo Code and open it again.") : new VaultRefusal(423, LOCKED);
  const generation = Math.max(newest.get(file) ?? 0, readJSON<{ gen?: unknown } | null>(file, null)?.gen as number || 0) + 1;
  keepJSON(file, { v: 2, gen: generation, data, sig: signatureOf(key, file, generation, data) });
  newest.set(file, generation);
  rememberGeneration(file, generation);
  tampered.delete(file);
}

const keepJSON = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writePrivate(file, JSON.stringify(value, null, 1) + "\n");
};

/** One change at a time, whoever makes it. */
export const vaultWork = <T>(work: () => T): T => {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  return locked(LOCK, work);
};

// ── The unlock key ────────────────────────────────────────────────────────────────────────────

/** Whether its values are this Mac's Keychain's (through its app), not a machine's own files. */
export const onHost = () => KEYS_ON_HOST;

/** Whether there's a vault here yet: this Mac's always is; a machine's once a client made one. */
export const isMade = () => onHost() || fs.existsSync(KEY_FILE);

/** Whether it's made but locked: a machine's after a restart, until a client sends its key. */
export const isLocked = () => !onHost() && isMade() && !storeKey;

const sealed = (key: Buffer, plain: Buffer, aad: string): string => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
};

const opened = (key: Buffer, text: string, aad: string): Buffer => {
  const all = Buffer.from(text, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, all.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(all.subarray(12, 28));
  return Buffer.concat([decipher.update(all.subarray(28)), decipher.final()]);
};

const checkOf = (key: Buffer) => crypto.createHmac("sha256", key).update("kuvo-vault-check").digest("base64");

/** A machine's vault made: its store key, wrapped by a new unlock key, which is given back once
 * for the client that made it to keep (and to every client after, while it's unlocked). */
export function makeVault(): string {
  if (onHost()) throw new VaultRefusal(409, "This Mac's vault is its Keychain: there's nothing to make.");
  return vaultWork(() => {
    if (fs.existsSync(KEY_FILE)) throw new VaultRefusal(409, "This computer has a vault already.");
    const store = crypto.randomBytes(32);
    const unlock = crypto.randomBytes(32);
    keepJSON(KEY_FILE, { v: 1, wrapped: sealed(unlock, store, "kuvo-vault-key"), check: checkOf(unlock) });
    storeKey = store;
    unlockKey = unlock;
    return unlock.toString("base64url");
  });
}

/** Whether `given` is this vault's unlock key; unlocks it if it's locked. */
export function unlockWith(given: unknown): boolean {
  if (onHost() || typeof given !== "string" || !given) return false;
  const key = Buffer.from(given, "base64url");
  if (key.length !== 32) return false;
  if (unlockKey) return crypto.timingSafeEqual(key, unlockKey);
  const kept = readJSON<{ wrapped?: unknown; check?: unknown } | null>(KEY_FILE, null);
  if (typeof kept?.wrapped !== "string" || typeof kept?.check !== "string") return false;
  const check = Buffer.from(checkOf(key));
  const expected = Buffer.from(kept.check);
  if (check.length !== expected.length || !crypto.timingSafeEqual(check, expected)) return false;
  try {
    storeKey = opened(key, kept.wrapped, "kuvo-vault-key");
    unlockKey = key;
    return true;
  } catch {
    return false;
  }
}

/** What holding the unlock key proves about `nonce` (`tag` says who proves it): null while it isn't
 * held here (a locked vault, or this Mac's). */
export const unlockProof = (tag: string, nonce: string, key: Buffer | null = unlockKey): string | null =>
  key ? crypto.createHmac("sha256", key).update(`kuvo-vault-${tag}\0${nonce}`).digest("base64url") : null;

/** Whether `given` is what holding the unlock key proves about `nonce`. */
export function provesUnlock(tag: string, nonce: string, given: unknown): boolean {
  const expected = unlockProof(tag, nonce);
  if (!expected || typeof given !== "string" || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** The unlock key, for a client that's proved itself, while it's unlocked; null for this Mac's
 * vault (its Keychain needs none) or a locked one. */
export const currentUnlockKey = (): string | null => (unlockKey ? unlockKey.toString("base64url") : null);

// ── Values ────────────────────────────────────────────────────────────────────────────────────

/** Values, by field: a sign-in's `password`, a key's own fields, a file's `file` (base64), a note's `text`. */
export type Values = Record<string, string>;

const host = () => {
  const found = appHost();
  if (!found) throw new VaultRefusal(503, NOT_ANSWERING);
  return found;
};

const asHost = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KeysUnavailable) throw new VaultRefusal(503, error.message);
    throw error;
  }
};

const checkedID = (id: string) => {
  if (!/^v_[a-z0-9]{10}$/.test(id)) throw new VaultRefusal(400, "That isn't an item.");
  return id;
};

/** An item's values, as kept. */
export async function valuesOf(id: string): Promise<Values> {
  checkedID(id);
  if (onHost()) {
    const answer = await asHost(() => askHost(host(), "vault/get", { id }, true));
    const values = answer?.values;
    if (!isObject(values)) return {};
    return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  if (!storeKey) throw new VaultRefusal(423, LOCKED);
  const text = textOf(path.join(VALUES, id));
  if (!text) return {};
  try {
    return JSON.parse(opened(storeKey, text, id).toString("utf8"));
  } catch {
    throw new VaultRefusal(409, "This item's values can't be read: they were changed outside Kuvo Code.");
  }
}

async function keepValues(id: string, values: Values): Promise<void> {
  if (onHost()) return void await asHost(() => askHost(host(), "vault/set", { id, values }));
  if (!storeKey) throw new VaultRefusal(423, LOCKED);
  fs.mkdirSync(VALUES, { recursive: true, mode: 0o700 });
  writePrivate(path.join(VALUES, id), sealed(storeKey, Buffer.from(JSON.stringify(values)), id));
}

async function dropValues(id: string): Promise<void> {
  if (onHost()) return void await asHost(() => askHost(host(), "vault/delete", { id }));
  fs.rmSync(path.join(VALUES, id), { force: true });
}

// ── Items ─────────────────────────────────────────────────────────────────────────────────────

export const readItems = (): VaultItem[] => readSigned<VaultItem[]>(ITEMS, []);
const keepItems = (items: VaultItem[]) => keepSigned(ITEMS, items);

export const itemByID = (id: string): VaultItem | undefined => readItems().find(item => item.id === id);

/** An item an agent names: by its id, or its name (case aside), or null. */
export function itemNamed(named: unknown): VaultItem | null {
  if (typeof named !== "string" || !named.trim()) return null;
  const items = readItems();
  const wanted = named.trim().toLowerCase();
  return items.find(item => item.id === named.trim()) ?? items.find(item => item.name.toLowerCase() === wanted) ?? null;
}

/** A site or host as an item keeps it: lowercased, without its scheme, path or port. */
export function siteOf(given: unknown): string | null {
  if (typeof given !== "string") return null;
  let text = given.trim().toLowerCase();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = "https://" + text;
  try {
    const host = new URL(text).hostname.replace(/\.$/, "");
    // A name on your network without dots (`nas`) too.
    return /^[a-z0-9.-]+$/.test(host) && /[a-z0-9]/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** Whether `host` (where a page really is) is one of `item`'s sites: the site itself or one under
 * it. A name without dots (`nas`) is only itself: under `com` would be every .com site. */
export const usableOn = (item: VaultItem, host: string): boolean =>
  item.sites.some(site => host === site || (site.includes(".") && host.endsWith("." + site)));

/** What a client sends to make or change an item. */
export interface GivenItem {
  kind?: unknown;
  name?: unknown;
  sites?: unknown;
  username?: unknown;
  fileName?: unknown;
  readable?: unknown;
  /** A sign-in only filled in to sign in, in the browser: never handed to a command or another field. */
  signInOnly?: unknown;
  /** Values by field; null takes one away (a change only). */
  values?: unknown;
}

const FIELD = /^[a-z][a-z0-9_]{0,39}$/;
const SHORTEST_VALUE = 4;

function givenValues(given: unknown, change: boolean): Record<string, string | null> {
  if (given == null) return {};
  if (!isObject(given)) throw new VaultRefusal(400, "Send the values as {\"field\": \"value\"}.");
  const values: Record<string, string | null> = {};
  for (const [field, value] of Object.entries(given)) {
    if (!FIELD.test(field)) throw new VaultRefusal(400, `“${oneLine(field, 40)}” isn't a field's name: use lowercase letters, digits and _.`);
    if (value === null && change) values[field] = null;
    // One shorter than what's hidden from agents in what they read back (mask.ts) couldn't be.
    else if (typeof value === "string" && value.length < SHORTEST_VALUE) throw new VaultRefusal(400, `A value needs at least ${SHORTEST_VALUE} characters, so it can be hidden from agents.`);
    else if (typeof value === "string" && value.length <= 1_000_000) values[field] = value;
    else throw new VaultRefusal(400, "A value is text, at most a megabyte.");
  }
  return values;
}

function givenSites(given: unknown): string[] {
  if (given == null) return [];
  if (!Array.isArray(given)) throw new VaultRefusal(400, "Send its sites as a list.");
  const sites: string[] = [];
  for (const each of given) {
    const site = siteOf(each);
    if (!site) throw new VaultRefusal(400, `“${oneLine(each, 80)}” isn't a site.`);
    if (!sites.includes(site)) sites.push(site);
  }
  return sites;
}

const cleanName = (given: unknown): string => {
  const name = oneLine(typeof given === "string" ? given : "", 120).trim();
  if (!name) throw new VaultRefusal(400, "Give it a name.");
  return name;
};

// Changes to items, one at a time: each reads the item and its values, waits on the Keychain or
// the disk, then writes; two at once would each write over the other's.
let itemQueue: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
  const run = itemQueue.then(work, work);
  itemQueue = run.catch(() => {});
  return run;
};

/** A new item, kept with its values. */
export const addItem = (given: GivenItem) => oneAtATime(() => addOne(given));
/** An item changed: what's given, its values merged (null takes one away). */
export const changeItem = (id: string, given: GivenItem) => oneAtATime(() => changeOne(id, given));
/** An item gone, with its values and grants. */
export const removeItem = (id: string) => oneAtATime(() => removeOne(id));

async function addOne(given: GivenItem): Promise<VaultItem> {
  // Its Pause file with the first item, so one deleted later reads as paused.
  if (!fs.existsSync(PAUSED)) vaultWork(() => keepSigned(PAUSED, {}));
  if (!ITEM_KINDS.includes(given.kind as never)) throw new VaultRefusal(400, `An item is one of: ${ITEM_KINDS.join(", ")}.`);
  const kind = given.kind as VaultItem["kind"];
  const name = cleanName(given.name);
  if (readItems().some(item => item.name.toLowerCase() === name.toLowerCase())) throw new VaultRefusal(409, `There's an item called “${name}” already.`);
  const sites = givenSites(given.sites);
  if (kind === "login" && !sites.length) throw new VaultRefusal(400, "A sign-in needs the site it's for.");
  const values = Object.fromEntries(Object.entries(givenValues(given.values, false)).filter((entry): entry is [string, string] => entry[1] !== null));
  const now = Date.now();
  const item: VaultItem = {
    id: newID("v_"),
    kind,
    name,
    sites,
    ...(typeof given.username === "string" && given.username.trim() ? { username: oneLine(given.username, 200).trim() } : {}),
    fields: Object.keys(values).sort(),
    ...(kind === "file" && typeof given.fileName === "string" && given.fileName.trim() ? { fileName: path.basename(oneLine(given.fileName, 200).trim()) } : {}),
    ...(kind === "note" && given.readable === true ? { readable: true } : {}),
    ...(kind === "login" && given.signInOnly === true ? { signInOnly: true } : {}),
    created: now,
    changed: now,
  };
  await keepValues(item.id, values);
  vaultWork(() => keepItems([...readItems(), item]));
  return item;
}

async function changeOne(id: string, given: GivenItem): Promise<VaultItem> {
  checkedID(id);
  const before = itemByID(id);
  if (!before) throw new VaultRefusal(404, "That item isn't in this vault.");
  const item: VaultItem = { ...before, changed: Date.now() };
  if (given.name !== undefined) {
    item.name = cleanName(given.name);
    if (readItems().some(other => other.id !== id && other.name.toLowerCase() === item.name.toLowerCase())) throw new VaultRefusal(409, `There's an item called “${item.name}” already.`);
  }
  if (given.sites !== undefined) {
    item.sites = givenSites(given.sites);
    if (item.kind === "login" && !item.sites.length) throw new VaultRefusal(400, "A sign-in needs the site it's for.");
  }
  if (given.username !== undefined) {
    if (typeof given.username === "string" && given.username.trim()) item.username = oneLine(given.username, 200).trim();
    else delete item.username;
  }
  if (given.fileName !== undefined && item.kind === "file") {
    if (typeof given.fileName === "string" && given.fileName.trim()) item.fileName = path.basename(oneLine(given.fileName, 200).trim());
    else delete item.fileName;
  }
  if (given.readable !== undefined && item.kind === "note") {
    if (given.readable === true) item.readable = true;
    else delete item.readable;
  }
  if (given.signInOnly !== undefined && item.kind === "login") {
    if (given.signInOnly === true) item.signInOnly = true;
    else delete item.signInOnly;
  }
  const changes = givenValues(given.values, true);
  if (Object.keys(changes).length) {
    const values = { ...(await valuesOf(id)) };
    for (const [field, value] of Object.entries(changes)) {
      if (value === null) delete values[field];
      else values[field] = value;
    }
    await keepValues(id, values);
    item.fields = Object.keys(values).sort();
  }
  vaultWork(() => keepItems(readItems().map(each => (each.id === id ? { ...item, ...(each.used ? { used: each.used } : {}) } : each))));
  return item;
}

async function removeOne(id: string): Promise<VaultItem> {
  checkedID(id);
  const item = itemByID(id);
  if (!item) throw new VaultRefusal(404, "That item isn't in this vault.");
  await dropValues(id);
  vaultWork(() => {
    keepItems(readItems().filter(each => each.id !== id));
    keepSigned(GRANTS, readGrants().filter(grant => grant.item !== id));
  });
  return item;
}

/** Notes when an item was last used. */
export const noteUsed = (id: string) => vaultWork(() => keepItems(readItems().map(item => (item.id === id ? { ...item, used: Date.now() } : item))));

// ── Grants ────────────────────────────────────────────────────────────────────────────────────

export const readGrants = (): VaultGrant[] => readSigned<VaultGrant[]>(GRANTS, []);

/** Who a grant is for, as given; null for one that names nobody. */
export function givenWho(given: unknown): VaultWho | null {
  if (!isObject(given)) return null;
  if (typeof given.bot === "string" && /^bot_[A-Za-z0-9]+$/.test(given.bot)) return { bot: given.bot };
  if (typeof given.project === "string" && given.project.startsWith("/")) return { project: path.resolve(given.project) };
  if (given.everyone === true) return { everyone: true };
  return null;
}

export const sameWho = (a: VaultWho, b: VaultWho) => a.bot === b.bot && a.project === b.project && Boolean(a.everyone) === Boolean(b.everyone);

/** A grant set (`how`), or taken away (null). */
export function setGrant(itemID: string, who: VaultWho, how: unknown): VaultGrant[] {
  checkedID(itemID);
  if (!itemByID(itemID)) throw new VaultRefusal(404, "That item isn't in this vault.");
  if (how !== null && !GRANT_HOWS.includes(how as never)) throw new VaultRefusal(400, "A grant is “own” (on its own) or “ask” (asks each time), or null to take it away.");
  return vaultWork(() => {
    const grants = readGrants().filter(grant => !(grant.item === itemID && sameWho(grant.who, who)));
    if (how !== null) grants.push({ item: itemID, who, how: how as VaultGrant["how"], at: Date.now() });
    keepSigned(GRANTS, grants);
    return grants;
  });
}

// ── Pause ─────────────────────────────────────────────────────────────────────────────────────

interface Paused {
  all?: boolean;
  /** Bots paused, by id, and conversations that aren't a bot's, by their root session: why. */
  bots?: Record<string, string>;
}

// While its file can't be read (a machine's vault locked, or this Mac's app gave no key), or was
// changed: every agent's use is paused, rather than one you paused going on.
const readPaused = (): Paused => {
  // Gone once there was one (Pause can't be undone by deleting its file): paused.
  if (!fs.existsSync(PAUSED)) return newest.has(PAUSED) || fs.existsSync(ITEMS) ? (tampered.add(PAUSED), { all: true }) : {};
  return readSigned<Paused>(PAUSED, { all: true });
};

/** Pauses (or lets go again) every agent's use, or one bot's or conversation's (`who`), with why. */
export function setPaused(paused: boolean, who?: string, why = "Paused by you."): void {
  vaultWork(() => {
    const now = fs.existsSync(PAUSED) ? readSigned<Paused>(PAUSED, {}) : {};
    if (who) {
      const bots = { ...(now.bots ?? {}) };
      if (paused) bots[who] = oneLine(why, 300);
      else delete bots[who];
      keepSigned(PAUSED, { ...now, bots });
    } else {
      keepSigned(PAUSED, { ...now, all: paused });
    }
  });
}

/** Why agents can't use the vault now, for a bot or a conversation (its root session): null when they may. */
export function pausedFor(bot: string | undefined, root?: string): string | null {
  if (onHost() && !primed) return primeTrouble ?? STARTING;
  if (onHost() && unkept.size) return UNKEPT;
  const now = readPaused();
  if (now.all) return tampered.has(PAUSED) ? TAMPERED : "The user paused the vault on this computer.";
  if (bot && now.bots?.[bot]) return `The user paused this bot's use of the vault: ${now.bots[bot]}`;
  if (root && now.bots?.[root]) return `The user paused this conversation's use of the vault: ${now.bots[root]}`;
  return null;
}

export function vaultState(): VaultState {
  const paused = readPaused();
  const here = new Set(listBots().map(bot => bot.id));
  return {
    made: isMade(),
    locked: isLocked(),
    paused: Boolean(paused.all),
    // (A bot's only while it's on this computer: one deleted or moved away is no one to let go on.)
    pausedBots: Object.fromEntries(Object.entries(paused.bots ?? {}).filter(([who]) => !who.startsWith("bot_") || here.has(who))),
    store: onHost() ? "keychain" : "encrypted",
    keptDays: KEPT_DAYS,
    agents: agentsUseVault(),
    ...(agentsWaitForOlder() ? { agentsWaiting: true } : {}),
    ...(tampered.size ? { tampered: true } : {}),
    generations: generations(),
  };
}

