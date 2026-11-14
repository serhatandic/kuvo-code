// The sites that keep data in this box's browser (PROTOCOL.md, "The browser's data"), removing a
// site's data (which signs you out of it), and which sites the browser is signed in to: from its
// cookies, as Chrome says them while it runs (through its keeper), else as its profile keeps them
// (the `Cookies` database, read only: names, hosts and expiry are plain there; values aren't).

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { BrowserSites, DataSite } from "../../shared/routes/browser";
import { lockedWhile, writePrivate } from "../files";
import { RUN } from "../home";
import { BROWSER_FOLDER } from "./history";
import { keeperRuns, withKeeper, type KeeperCall } from "./keeper-client";

/** A cookie as the box reads it: its domain (a leading dot for a whole domain's), name and path,
 * when it ends (ms since 1970; null for one that ends with the browser), and whether it outlives
 * the browser (`persistent`). */
export interface BrowserCookie {
  domain: string;
  name: string;
  path: string;
  expires: number | null;
  persistent: boolean;
  /** Chrome's own description of it, as it said it (while it runs): what deleting it takes. */
  live?: Record<string, unknown>;
}

/** The browser's cookies now, and whether they're Chrome's own (it runs: `live`) or the profile's
 * file (up to 30 seconds behind while Chrome runs, without the cookies that end with it). */
export interface Cookies {
  live: boolean;
  cookies: BrowserCookie[];
}

/** The profile's cookie database: where Chrome keeps it now (`Default/Network/Cookies`), or before. */
export function cookieFile(folder = BROWSER_FOLDER): string | null {
  const found = ["Network/Cookies", "Cookies"].map(name => path.join(folder, "profile", "Default", name)).filter(file => fs.existsSync(file));
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

/** Microseconds since 1601 (Chrome's `expires_utc`) as ms since 1970. */
const FROM_1601 = 11_644_473_600_000;
export const chromeTime = (microseconds: number): number => microseconds / 1000 - FROM_1601;

interface Statement { all(...values: unknown[]): any[]; run(...values: unknown[]): unknown }
interface Database { query(sql: string): Statement; close(): void }

/** SQLite as the engine's Bun has it (`bun:sqlite`); null under anything else. */
function sqlite(file: string, readonly: boolean): Database | null {
  let made: { Database: new (file: string, options?: object) => Database };
  try { made = createRequire(import.meta.url)(["bun", "sqlite"].join(":")); } catch { return null; }
  // (Busy while Chrome writes: tried again a few times, a moment apart.)
  for (let attempt = 0; ; attempt++) {
    try {
      return new made.Database(file, readonly ? { readonly: true } : { readwrite: true });
    } catch (error) {
      if (attempt >= 4 || !/busy|locked/i.test(String(error))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** `work` with the database open, tried again shortly while it's busy. */
function inDatabase<T>(file: string, readonly: boolean, work: (db: Database) => T): T | null {
  for (let attempt = 0; ; attempt++) {
    let db: Database | null = null;
    try {
      db = sqlite(file, readonly);
      if (!db) return null;
      return work(db);
    } catch (error) {
      if (attempt >= 4 || !/busy|locked/i.test(String(error))) return null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    } finally {
      try { db?.close(); } catch {}
    }
  }
}

/** The cookies in the profile's file; null when there's none, or it can't be read. */
export function fileCookies(folder = BROWSER_FOLDER): BrowserCookie[] | null {
  const file = cookieFile(folder);
  if (!file) return null;
  return inDatabase(file, true, db => db.query("SELECT host_key, name, path, expires_utc, has_expires, is_persistent FROM cookies").all().map(row => ({
    domain: String(row.host_key),
    name: String(row.name),
    path: String(row.path ?? "/"),
    expires: Number(row.has_expires) && Number(row.expires_utc) > 0 ? chromeTime(Number(row.expires_utc)) : null,
    persistent: Number(row.is_persistent) === 1,
  })));
}

/** Chrome's own cookies, as its keeper passes on `Storage.getCookies`. */
async function liveCookies(call: KeeperCall): Promise<BrowserCookie[]> {
  const answer = await call("Storage.getCookies");
  return (Array.isArray(answer?.cookies) ? answer.cookies : []).filter((each: any) => typeof each?.name === "string" && typeof each?.domain === "string").map((each: any) => ({
    domain: each.domain,
    name: each.name,
    path: typeof each.path === "string" ? each.path : "/",
    expires: each.session || typeof each.expires !== "number" || each.expires <= 0 ? null : each.expires * 1000,
    persistent: !each.session,
    live: each,
  }));
}

/** The browser's cookies: Chrome's while it runs, else its profile's file; null when there are none to read. */
export async function browserCookies(folder = BROWSER_FOLDER, run = RUN): Promise<Cookies | null> {
  if (keeperRuns(run)) {
    const live = await withKeeper(liveCookies, { run, wait: 5_000 });
    if (live) return { live: true, cookies: live };
  }
  const kept = fileCookies(folder);
  return kept ? { live: false, cookies: kept } : null;
}

/** A host's site: its registrable domain, as near as can be told without the public suffix list
 * (`accounts.example.co.uk` is `example.co.uk`); an address or a name without dots as it is. */
export function siteOf(host: string): string {
  const name = host.replace(/^\./, "").toLowerCase();
  if (!name.includes(".") || /^[\d.]+$/.test(name) || name.includes(":")) return name;
  const labels = name.split(".");
  const second = labels[labels.length - 2] ?? "";
  const country = (labels[labels.length - 1] ?? "").length === 2;
  const keep = labels.length >= 3 && country && ["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "mil", "nic"].includes(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/** Whether `host` (a cookie's domain, a leading dot or not) is `site` or one of its own. */
export const onSite = (host: string, site: string): boolean => {
  const name = host.replace(/^\./, "").toLowerCase();
  return name === site || name.endsWith("." + site);
};

/** Hosts with stored data in the profile's own folders (its IndexedDB, `<scheme>_<host>_0.indexeddb.*`). */
function storageHosts(folder: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const indexed = path.join(folder, "profile", "Default", "IndexedDB");
  let names: string[] = [];
  try { names = fs.readdirSync(indexed); } catch {}
  for (const name of names) {
    const match = /^(https?)_(.+)_\d+\.indexeddb\.(leveldb|blob)$/.exec(name);
    if (!match) continue;
    const host = match[2]!;
    found.set(host, [...(found.get(host) ?? []), path.join(indexed, name)]);
  }
  return found;
}

/** The sites that keep data in the browser, by name, and what each keeps. */
export async function browserSites(folder = BROWSER_FOLDER, run = RUN): Promise<BrowserSites> {
  const now = Date.now();
  const kinds = new Map<string, Set<DataSite["kinds"][number]>>();
  const add = (host: string, kind: DataSite["kinds"][number]) => {
    const site = siteOf(host);
    if (!site) return;
    kinds.set(site, (kinds.get(site) ?? new Set()).add(kind));
  };
  for (const cookie of (await browserCookies(folder, run))?.cookies ?? []) if (cookie.expires === null || cookie.expires > now) add(cookie.domain, "cookies");
  for (const host of storageHosts(folder).keys()) add(host, "storage");
  return {
    sites: [...kinds].sort(([a], [b]) => a.localeCompare(b)).map(([site, each]) => ({ site, kinds: (["cookies", "storage"] as const).filter(kind => each.has(kind)) })),
  };
}

/** Sites whose other stored data the keeper clears as Chrome next starts (`browser/clear-sites.json`):
 * what can't be taken from the profile's files while it's stopped. */
const pendingFile = (folder: string) => path.join(folder, "clear-sites.json");
/** Held while the box changes the profile's files with Chrome stopped: the keeper starts Chrome once
 * it's gone (`kuvo-browser.js host`). */
const editingLock = (folder: string) => path.join(folder, ".profile-editing");

/** Every site's data, or these sites' (by `siteOf`'s names), gone from the browser: its cookies (so it's
 * signed out of them) and what its pages stored. While Chrome runs, through it; else from its profile's
 * files, with what's left there for the keeper to clear as Chrome starts. */
export async function removeSiteData(sites: string[] | "all", folder = BROWSER_FOLDER, run = RUN): Promise<void> {
  if (!fs.existsSync(path.join(folder, "profile"))) return;
  const wanted = (host: string) => sites === "all" || sites.some(site => onSite(host, site));
  if (keeperRuns(run) && (await removeLive(wanted, folder, run))) return;
  // Stopped: the profile's files, with the keeper kept from starting Chrome meanwhile (and if it
  // started a moment ago, through it after all).
  const done = await lockedWhile(editingLock(folder), async () => {
    if (keeperRuns(run)) return false;
    const file = cookieFile(folder);
    const hosts = new Set<string>();
    if (file) {
      inDatabase(file, false, db => {
        const all = db.query("SELECT DISTINCT host_key FROM cookies").all().map(row => String(row.host_key));
        const removed = all.filter(wanted);
        for (const host of removed) {
          db.query("DELETE FROM cookies WHERE host_key = ?").run(host);
          hosts.add(host.replace(/^\./, ""));
        }
      });
    }
    for (const [host, folders] of storageHosts(folder)) {
      if (!wanted(host)) continue;
      for (const each of folders) fs.rmSync(each, { recursive: true, force: true });
      hosts.add(host);
    }
    if (hosts.size || sites === "all") {
      let pending: string[] = [];
      try { pending = JSON.parse(fs.readFileSync(pendingFile(folder), "utf8")); } catch {}
      const next = [...new Set([...(Array.isArray(pending) ? pending.filter(each => typeof each === "string") : []), ...hosts, ...(sites === "all" ? [] : sites)])];
      writePrivate(pendingFile(folder), JSON.stringify(next));
    }
    return true;
  }, { stale: 30_000, wait: 10_000 });
  if (!done) await removeLive(wanted, folder, run);
}

/** Through Chrome while it runs: the cookies that fit, deleted one by one in a page of its (each
 * exactly as Chrome said it: a whole domain's, or one host's), then what each of their hosts stored.
 * False when Chrome couldn't be reached. */
async function removeLive(wanted: (host: string) => boolean, folder: string, run: string): Promise<boolean> {
  const done = await withKeeper(async call => {
    const cookies = (await liveCookies(call)).filter(cookie => wanted(cookie.domain));
    const hosts = new Set([...cookies.map(cookie => cookie.domain.replace(/^\./, "")), ...[...storageHosts(folder).keys()].filter(wanted)]);
    if (!hosts.size) return true;
    // (Network's calls need a page: the first there is, or one opened for this and closed after.)
    const targets = await call("Target.getTargets");
    let page = (Array.isArray(targets?.targetInfos) ? targets.targetInfos : []).find((each: any) => each?.type === "page")?.targetId as string | undefined;
    let opened = false;
    if (!page) {
      page = (await call("Target.createTarget", { url: "about:blank", newWindow: true }))?.targetId;
      opened = true;
    }
    const sessionId = (await call("Target.attachToTarget", { targetId: page, flatten: true }))?.sessionId as string;
    try {
      for (const cookie of cookies) {
        const live = cookie.live ?? {};
        await call("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path, ...(live.partitionKey ? { partitionKey: live.partitionKey } : {}) }, sessionId);
      }
      for (const host of hosts) {
        for (const scheme of ["https", "http"]) {
          await call("Storage.clearDataForOrigin", { origin: `${scheme}://${host}`, storageTypes: "all" }, sessionId).catch(() => {});
        }
      }
    } finally {
      await call("Target.detachFromTarget", { sessionId }).catch(() => {});
      if (opened && page) await call("Target.closeTarget", { targetId: page }).catch(() => {});
    }
    return true;
  }, { run });
  return done === true;
}

/** The cookie a site keeps while you're signed in to it, as the integrations' catalog names it
 * (`signInCookie`). */
export interface SignInCookie {
  domain: string;
  name: string;
}

/** Whether `cookies` have the sign-in `wanted` names, unexpired. From the profile's file, only one
 * that outlives the browser counts (one that ends with it is gone as Chrome starts again). */
export function signedIn(cookies: Cookies, wanted: SignInCookie, now = Date.now()): boolean {
  return cookies.cookies.some(cookie => onSite(cookie.domain, wanted.domain.replace(/^\./, "").toLowerCase()) && cookie.name === wanted.name
    && (cookies.live || cookie.persistent) && (cookie.expires === null ? cookies.live : cookie.expires > now));
}

/** Whether this box's browser is signed in to each site the catalog names a sign-in cookie for, by
 * integration; null when there's no browser profile here to tell from. */
export async function siteSignInsHere(entries: { id: string; signInCookie?: unknown }[], folder = BROWSER_FOLDER, run = RUN): Promise<Record<string, boolean> | null> {
  const named = entries.filter((each): each is { id: string; signInCookie: SignInCookie } => {
    const cookie = each.signInCookie as SignInCookie | undefined;
    return typeof cookie?.domain === "string" && cookie.domain.length > 0 && typeof cookie.name === "string" && cookie.name.length > 0;
  });
  if (!named.length) return null;
  const cookies = await browserCookies(folder, run);
  if (!cookies) return fs.existsSync(path.join(folder, "profile")) ? Object.fromEntries(named.map(each => [each.id, false])) : null;
  return Object.fromEntries(named.map(each => [each.id, signedIn(cookies, each.signInCookie)]));
}
