// The browser's data on a box (PROTOCOL.md, "The browser's data"): its history and site icons, the
// sites that keep data in it, and its settings. Every box keeps its own, in its `browser` folder,
// and they never leave it but in these answers.

import { BYTES, bool, type Infer, list, number, object, type RouteShape, string, words } from "../shape";

/** The search engines the browser offers, by id, with their names and their addresses (`%s` for the
 * words): what you type that isn't an address searches there. */
export const SEARCH_ENGINES = [
  { id: "google", title: "Google", url: "https://www.google.com/search?q=%s" },
  { id: "duckDuckGo", title: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  { id: "bing", title: "Bing", url: "https://www.bing.com/search?q=%s" },
  { id: "brave", title: "Brave Search", url: "https://search.brave.com/search?q=%s" },
  { id: "kagi", title: "Kagi", url: "https://kagi.com/search?q=%s" },
  { id: "ecosia", title: "Ecosia", url: "https://www.ecosia.org/search?q=%s" },
] as const;

export const SEARCH_ENGINE = words("google", "duckDuckGo", "bing", "brave", "kagi", "ecosia");

/** A site in the history: its key (`host`, without `www.`, with a port where the address names one),
 * the address that names it best (its front page's, once seen) and that page's title, how many
 * times it was opened, when last (ms since 1970), and whether the box keeps its icon. */
export const HISTORY_SITE = object({ host: string, url: string, title: string, visits: number, lastVisit: number, icon: bool });

/** The history, most suggested first: visits count, and fade over a few weeks (a new tab page shows
 * the first few). */
export const BROWSER_HISTORY = object({ sites: list(HISTORY_SITE) });

/** A site that keeps data in the browser (its registrable domain, as `example.co.uk`), and what it
 * keeps: `cookies` (sign-ins among them), `storage` (what pages store: databases, local storage). */
export const DATA_SITE = object({ site: string, kinds: list(words("cookies", "storage")) });

/** The sites that keep data in the browser, by name. */
export const BROWSER_SITES = object({ sites: list(DATA_SITE) });

/** The browser's settings: its search engine (and those it offers, in order, each with its name);
 * whether agents' tabs no one has looked at close an hour after their last use; whether it offers
 * to save a password you sign in with, and the sites you said Never to. */
export const BROWSER_SETTINGS = object({
  searchEngine: SEARCH_ENGINE,
  searchEngines: list(object({ id: SEARCH_ENGINE, title: string })),
  tidiesAgentTabs: bool,
  offersToSave: bool,
  never: list(string),
});

export type SearchEngine = Infer<typeof SEARCH_ENGINE>;
export type HistorySite = Infer<typeof HISTORY_SITE>;
export type BrowserHistory = Infer<typeof BROWSER_HISTORY>;
export type DataSite = Infer<typeof DATA_SITE>;
export type BrowserSites = Infer<typeof BROWSER_SITES>;
export type BrowserSettings = Infer<typeof BROWSER_SETTINGS>;

export const BROWSER_ROUTES: RouteShape[] = [
  { route: "GET kuvo/browser/history", answers: { 200: BROWSER_HISTORY } },
  { route: "DELETE kuvo/browser/history", answers: { 200: BROWSER_HISTORY } },
  { route: "DELETE kuvo/browser/history/:host", answers: { 200: BROWSER_HISTORY } },
  { route: "GET kuvo/browser/icons/:host", answers: { 200: BYTES } },
  { route: "GET kuvo/browser/sites", answers: { 200: BROWSER_SITES } },
  { route: "DELETE kuvo/browser/sites", answers: { 200: BROWSER_SITES } },
  { route: "DELETE kuvo/browser/sites/:site", answers: { 200: BROWSER_SITES } },
  { route: "GET kuvo/browser/settings", answers: { 200: BROWSER_SETTINGS } },
  { route: "PATCH kuvo/browser/settings", answers: { 200: BROWSER_SETTINGS } },
];
