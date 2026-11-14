// The browser's history on this box (PROTOCOL.md, "The browser's data"): the sites its browser
// opened, a site per host (and port: two dev servers on localhost are two), at most a few hundred,
// for a new tab page's suggestions, with each site's icon. What the keeper (`kuvo-browser.js host`)
// notes as pages load, it only appends to `browser/visits.jsonl`, a line a visit (or an icon Chrome
// fetched); the box folds those in here, so how history is kept is said once, in this file:
// `browser/history.json`, and `browser/icons/<host>`.

import fs from "node:fs";
import path from "node:path";
import type { BrowserHistory, HistorySite } from "../../shared/routes/browser";
import { listOf, locked, writePrivate } from "../files";
import { K } from "../home";

/** The browser's folder on this box, where every file of its data is. */
export const BROWSER_FOLDER = path.join(K, "browser");

/** At most this many sites: the oldest go first. */
export const HISTORY_LIMIT = 300;
/** An icon bigger than this isn't kept. */
const ICON_LIMIT = 128 * 1024;

/** A site as `history.json` keeps it (`HistorySite` without `icon`, which the folder says). */
export type KeptSite = Omit<HistorySite, "icon">;

const historyFile = (folder: string) => path.join(folder, "history.json");
const iconsFolder = (folder: string) => path.join(folder, "icons");
const journal = (folder: string) => path.join(folder, "visits.jsonl");
const lock = (folder: string) => path.join(folder, ".history.lock");

/** A page's site in the history: its host without `www.`, with its port where the address names one;
 * null for an address that isn't a web page's (`about:`, `file:`, `data:`). */
export function siteKey(address: string): string | null {
  let url: URL;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:" || !url.hostname) return null;
  const host = url.hostname.replace(/^www\./, "");
  return url.port ? `${host}:${url.port}` : host;
}

/** Whether `key` names a site safely as a file of its own (`icons/<key>`): letters, digits, dots and
 * dashes, and a port. (One that doesn't, an IPv6 address say, is kept without an icon.) */
export const isIconName = (key: string): boolean => /^[a-z0-9][a-z0-9.-]{0,252}(:\d{1,5})?$/.test(key) && !key.includes("..");

/** How strongly a site is suggested now: its visits, fading over a few weeks. */
const score = (site: KeptSite, now: number) => site.visits / (1 + (now - site.lastVisit) / 86_400_000 / 14);

function isKept(value: unknown): value is KeptSite {
  const site = value as KeptSite;
  return typeof site?.host === "string" && typeof site.url === "string" && typeof site.title === "string"
    && Number.isFinite(site.visits) && Number.isFinite(site.lastVisit);
}

function readKept(folder: string): KeptSite[] {
  try {
    const sites = JSON.parse(fs.readFileSync(historyFile(folder), "utf8"))?.sites;
    return Array.isArray(sites) ? sites.filter(isKept) : [];
  } catch {
    return [];
  }
}

function writeKept(folder: string, sites: KeptSite[]): void {
  writePrivate(historyFile(folder), JSON.stringify({ sites }));
}

/** `sites` with the oldest gone past the limit. */
export function limited(sites: KeptSite[]): KeptSite[] {
  return sites.length > HISTORY_LIMIT ? [...sites].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, HISTORY_LIMIT) : sites;
}

/** A page that loaded at `at`, in `sites`: a visit more to its site, whose front page names it best
 * (its address and title kept once seen, or until the site has a title). */
export function visited(sites: KeptSite[], address: string, title: string, at: number): KeptSite[] {
  const host = siteKey(address);
  if (!host) return sites;
  // (A page without a title of its own: Chrome says its address.)
  const named = title.trim() === address ? "" : title.trim().slice(0, 300);
  const url = address.slice(0, 2000);
  const found = sites.find(site => site.host === host);
  if (!found) return limited([...sites, { host, url, title: named, visits: 1, lastVisit: at }]);
  found.visits += 1;
  found.lastVisit = Math.max(found.lastVisit, at);
  let front = false;
  try { front = new URL(address).pathname.length <= 1; } catch {}
  if (front || !found.title) {
    found.url = url;
    found.title = named;
  }
  return sites;
}

/** What an icon's bytes are, by their first bytes: PNG, ICO, JPEG, GIF or WebP, else null (an SVG,
 * or not a picture at all, isn't kept). */
export function iconType(bytes: Uint8Array): string | null {
  const starts = (...head: number[]) => head.every((byte, i) => bytes[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** `bytes` kept as `key`'s icon, if they're a picture of a size to keep. */
export function keepIcon(folder: string, key: string, bytes: Uint8Array): boolean {
  if (!isIconName(key) || bytes.length === 0 || bytes.length > ICON_LIMIT || !iconType(bytes)) return false;
  writePrivate(path.join(iconsFolder(folder), key), bytes);
  return true;
}

/** Within the lock: the keeper's notes since the last fold, taken in. A journal left by a fold
 * that was cut off is taken first. */
function folding(folder: string): KeptSite[] {
  let sites = readKept(folder);
  const taking = `${journal(folder)}.folding-${process.pid}-${Date.now()}`;
  try { fs.renameSync(journal(folder), taking); } catch {}
  const taken = listOf(folder).filter(name => name.startsWith("visits.jsonl.folding-")).sort().map(name => path.join(folder, name));
  if (!taken.length) return sites;
  for (const file of taken) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch {}
    for (const line of text.split("\n")) {
      let note: { url?: unknown; title?: unknown; at?: unknown; icon?: unknown };
      try { note = JSON.parse(line); } catch { continue; }
      if (typeof note?.url !== "string") continue;
      const at = typeof note.at === "number" && Number.isFinite(note.at) ? note.at : Date.now();
      if (typeof note.icon === "string") {
        const key = siteKey(note.url);
        if (key) try { keepIcon(folder, key, Buffer.from(note.icon, "base64")); } catch {}
      } else {
        sites = visited(sites, note.url, typeof note.title === "string" ? note.title : "", at);
      }
    }
  }
  writeKept(folder, sites);
  for (const file of taken) fs.rmSync(file, { force: true });
  return sites;
}

/** The history as `kuvo/browser/history` gives it: what the keeper noted taken in first, most
 * suggested first. */
export function readHistory(folder = BROWSER_FOLDER, now = Date.now()): BrowserHistory {
  const sites = fs.existsSync(folder) ? locked(lock(folder), () => folding(folder)) : [];
  const icons = new Set(listOf(iconsFolder(folder)));
  return {
    sites: [...sites].sort((a, b) => score(b, now) - score(a, now) || b.lastVisit - a.lastVisit)
      .map(site => ({ ...site, icon: icons.has(site.host) })),
  };
}

/** The history taken in (`kuvo-link.js browser fold`, which the keeper runs once its notes grow). */
export function foldHistory(folder = BROWSER_FOLDER): void {
  if (fs.existsSync(folder)) locked(lock(folder), () => { folding(folder); });
}

/** A site gone from the history (until it's visited again), with its icon; or every site, with what
 * the keeper noted and hasn't been taken in yet. */
export function forgetHistory(host: string | null, folder = BROWSER_FOLDER): void {
  if (!fs.existsSync(folder)) return;
  locked(lock(folder), () => {
    if (host === null) {
      for (const name of listOf(folder)) if (name === "visits.jsonl" || name.startsWith("visits.jsonl.folding-")) fs.rmSync(path.join(folder, name), { force: true });
      fs.rmSync(historyFile(folder), { force: true });
      fs.rmSync(iconsFolder(folder), { recursive: true, force: true });
      return;
    }
    writeKept(folder, folding(folder).filter(site => site.host !== host));
    if (isIconName(host)) fs.rmSync(path.join(iconsFolder(folder), host), { force: true });
  });
}

/** A site's icon, with its type; null when there's none. */
export function iconOf(host: string, folder = BROWSER_FOLDER): { bytes: Buffer; type: string } | null {
  if (!isIconName(host)) return null;
  let bytes: Buffer;
  try { bytes = fs.readFileSync(path.join(iconsFolder(folder), host)); } catch { return null; }
  const type = iconType(bytes);
  return type ? { bytes, type } : null;
}

/** Sites from elsewhere (the app's history, read once) taken into this box's: a site it has already
 * gets their visits added, and keeps its own address and title unless it has none. */
export function mergeHistory(from: KeptSite[], folder = BROWSER_FOLDER): number {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return locked(lock(folder), () => {
    const sites = folding(folder);
    for (const each of from) {
      const found = sites.find(site => site.host === each.host);
      if (!found) {
        sites.push({ ...each });
        continue;
      }
      found.visits += each.visits;
      found.lastVisit = Math.max(found.lastVisit, each.lastVisit);
      if (!found.title) Object.assign(found, { url: each.url, title: each.title });
    }
    writeKept(folder, limited(sites));
    return from.length;
  });
}
