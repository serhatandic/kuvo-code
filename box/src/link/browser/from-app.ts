// This Mac's box takes in, once, what its app's panel browser kept before the box had a browser of
// its own (PROTOCOL.md, "The browser's data"): the app's history and site icons (`Browser/` in the
// app's folder), and its browser settings (in the app's preferences: the search engine, closing
// agents' tabs, offering to save passwords, the Never sites). Read only: the app's copy stays as it
// is. Done once a box (`browser/app-data-read` says when, and what it took).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { SEARCH_ENGINES } from "../../shared/routes/browser";
import { listOf, writePrivate } from "../files";
import { APP_FOLDER, K } from "../home";
import { readRecord } from "../rehome/state";
import { BROWSER_FOLDER, isIconName, keepIcon, type KeptSite, limited, mergeHistory } from "./history";
import { changeBrowserSettings, hasSettings } from "./settings";

/** Seconds from 1970 to 2001, when the app's dates count from (Swift's `JSONEncoder` default). */
const FROM_2001 = 978_307_200;

const markFile = (folder: string) => path.join(folder, "app-data-read");

/** The app's own folder for this Mac's box: the one it lives in, or the one it moved from (#333). */
export function thisMacsAppFolder(): string | null {
  if (APP_FOLDER) return APP_FOLDER;
  const from = readRecord(K).from;
  return typeof from === "string" && from ? from : null;
}

/** The app's history (`Browser/history.json`: `[{host, url, title, visits, lastVisit}]`, dates in
 * seconds since 2001), as this box keeps it. */
function appHistory(appFolder: string): KeptSite[] {
  let sites: unknown;
  try { sites = JSON.parse(fs.readFileSync(path.join(appFolder, "Browser", "history.json"), "utf8")); } catch { return []; }
  if (!Array.isArray(sites)) return [];
  return limited(sites.filter((site): site is { host: string; url: string; title: string; visits: number; lastVisit: number } =>
    isObject(site) && typeof site.host === "string" && site.host.length > 0 && site.host.length < 300 && typeof site.url === "string"
    && typeof site.title === "string" && Number.isFinite(site.visits) && Number.isFinite(site.lastVisit))
    .map(site => ({ host: site.host, url: site.url.slice(0, 2000), title: site.title.slice(0, 300), visits: Math.max(1, Math.round(site.visits)), lastVisit: Math.round((site.lastVisit + FROM_2001) * 1000) })));
}

/** The app's browser settings, from its preferences (`~/Library/Preferences/<its bundle id>.plist`,
 * beside its folder in Application Support), as `plutil` reads them; nothing where there are none. */
export function appPreferences(appFolder: string): { searchEngine?: string; tidiesAgentTabs?: boolean; offersToSave?: boolean; never?: string[] } {
  if (process.platform !== "darwin") return {};
  const file = path.join(path.dirname(path.dirname(appFolder)), "Preferences", `${path.basename(appFolder)}.plist`);
  if (!fs.existsSync(file)) return {};
  let xml = "";
  try { xml = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", file], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { return {}; }
  const unescape = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const after = (key: string) => {
    const at = xml.indexOf(`<key>${key}</key>`);
    return at < 0 ? null : xml.slice(at + key.length + 11).trimStart();
  };
  const bool = (key: string) => {
    const rest = after(key);
    return rest?.startsWith("<true/>") ? true : rest?.startsWith("<false/>") ? false : undefined;
  };
  const read: ReturnType<typeof appPreferences> = {};
  const engine = /^<string>([^<]*)<\/string>/.exec(after("browser.searchEngine") ?? "")?.[1];
  if (engine !== undefined) read.searchEngine = unescape(engine);
  const tidies = bool("panel.tidiesAgentTabs");
  if (tidies !== undefined) read.tidiesAgentTabs = tidies;
  const offers = bool("passwords.offersToSave");
  if (offers !== undefined) read.offersToSave = offers;
  const never = /^<array>([\s\S]*?)<\/array>|^<array\/>/.exec(after("passwords.never") ?? "");
  if (never) read.never = [...(never[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map(match => unescape(match[1]!));
  return read;
}

/** What the app kept, taken in once (nothing again once `app-data-read` is there): its history merged
 * into this box's, its icons for the sites taken, and its settings, where this box has none of its
 * own yet. `appFolder` null (a box that never had an app's): nothing to take, and noted so. */
export function takeInAppBrowserData(appFolder: string | null, folder = BROWSER_FOLDER): void {
  if (fs.existsSync(markFile(folder))) return;
  const took: Record<string, unknown> = { at: Date.now(), from: appFolder };
  if (appFolder) {
    const sites = appHistory(appFolder);
    if (sites.length) took.sites = mergeHistory(sites, folder);
    let icons = 0;
    const own = new Set(sites.map(site => site.host));
    const from = path.join(appFolder, "Browser", "Icons");
    for (const name of listOf(from)) {
      const host = name.replace(/\.png$/, "");
      if (!name.endsWith(".png") || !own.has(host) || !isIconName(host) || fs.existsSync(path.join(folder, "icons", host))) continue;
      try { if (keepIcon(folder, host, fs.readFileSync(path.join(from, name)))) icons++; } catch {}
    }
    if (icons) took.icons = icons;
    if (!hasSettings(folder)) {
      const read = appPreferences(appFolder);
      const change: Record<string, unknown> = {};
      if (SEARCH_ENGINES.some(engine => engine.id === read.searchEngine)) change.searchEngine = read.searchEngine;
      if (read.tidiesAgentTabs !== undefined) change.tidiesAgentTabs = read.tidiesAgentTabs;
      if (read.offersToSave !== undefined) change.offersToSave = read.offersToSave;
      if (read.never) change.never = read.never.filter(site => /^[a-z0-9.:[\]-]{1,260}$/i.test(site.trim()));
      if (Object.keys(change).length && changeBrowserSettings(change, folder) === null) took.settings = Object.keys(change).sort();
    }
  }
  writePrivate(markFile(folder), JSON.stringify(took));
}
