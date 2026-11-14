// The browser's settings on this box (PROTOCOL.md, "The browser's data"): its search engine, whether
// agents' tabs no one looked at close by themselves, and offering to save passwords (with the sites
// you said Never to). Kept in `browser/settings.json`, which the agents' tools (`kuvo-browser.js`) read
// the search engine from; whether agents' tabs are left open is the
// file the keeper has always read, `browser/keeps-agent-tabs`, which a Mac before this writes too.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { type BrowserSettings, SEARCH_ENGINES, type SearchEngine } from "../../shared/routes/browser";
import { writePrivate } from "../files";
import { BROWSER_FOLDER } from "./history";

const settingsFile = (folder: string) => path.join(folder, "settings.json");
const keepsTabsFile = (folder: string) => path.join(folder, "keeps-agent-tabs");

/** What `settings.json` keeps: each setting changed from its default. */
interface Kept {
  searchEngine?: SearchEngine;
  offersToSave?: boolean;
  never?: string[];
}

const isEngine = (value: unknown): value is SearchEngine => SEARCH_ENGINES.some(engine => engine.id === value);

function readKept(folder: string): Kept {
  try {
    const kept = JSON.parse(fs.readFileSync(settingsFile(folder), "utf8"));
    return isObject(kept) ? kept as Kept : {};
  } catch {
    return {};
  }
}

/** Whether this box has settings of its own for its browser yet. */
export const hasSettings = (folder = BROWSER_FOLDER): boolean => fs.existsSync(settingsFile(folder));

/** The settings as `kuvo/browser/settings` gives them. */
export function readBrowserSettings(folder = BROWSER_FOLDER): BrowserSettings {
  const kept = readKept(folder);
  return {
    searchEngine: isEngine(kept.searchEngine) ? kept.searchEngine : "google",
    searchEngines: SEARCH_ENGINES.map(({ id, title }) => ({ id, title })),
    tidiesAgentTabs: !fs.existsSync(keepsTabsFile(folder)),
    offersToSave: kept.offersToSave !== false,
    never: Array.isArray(kept.never) ? kept.never.filter(each => typeof each === "string") : [],
  };
}

/** A site you said Never to, as kept: its host, in small letters, without a scheme or path. */
function neverSite(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  try { if (host.includes("://")) host = new URL(host).host; } catch { return null; }
  return /^[a-z0-9.:[\]-]{1,260}$/.test(host) ? host : null;
}

/** A change to the settings (any of `searchEngine`, `tidiesAgentTabs`, `offersToSave`, `never`, the
 * whole list), checked first: why not, or null once it's kept. */
export function changeBrowserSettings(change: unknown, folder = BROWSER_FOLDER): string | null {
  if (!isObject(change)) return "Send the settings to change, as an object.";
  const known = ["searchEngine", "tidiesAgentTabs", "offersToSave", "never"];
  const unknown = Object.keys(change).find(key => !known.includes(key));
  if (unknown) return `There's no browser setting ${JSON.stringify(unknown)}.`;
  if ("searchEngine" in change && !isEngine(change.searchEngine)) return `The search engine is one of ${SEARCH_ENGINES.map(engine => engine.id).join(", ")}.`;
  for (const key of ["tidiesAgentTabs", "offersToSave"]) if (key in change && typeof change[key] !== "boolean") return `${key} is true or false.`;
  let never: string[] | undefined;
  if ("never" in change) {
    if (!Array.isArray(change.never) || change.never.length > 1000) return "never is a list of sites.";
    const sites = change.never.map(neverSite);
    if (sites.some(each => each === null)) return "never is a list of sites, each a host (example.com).";
    never = [...new Set(sites as string[])].sort();
  }
  const kept = readKept(folder);
  if (isEngine(change.searchEngine)) kept.searchEngine = change.searchEngine;
  if (typeof change.offersToSave === "boolean") kept.offersToSave = change.offersToSave;
  if (never) kept.never = never;
  writePrivate(settingsFile(folder), JSON.stringify(kept));
  if (change.tidiesAgentTabs === true) fs.rmSync(keepsTabsFile(folder), { force: true });
  if (change.tidiesAgentTabs === false) writePrivate(keepsTabsFile(folder), "");
  return null;
}
