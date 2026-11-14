import "./safety"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { takeInAppBrowserData } from "../src/link/browser/from-app"
import { forgetHistory, HISTORY_LIMIT, iconOf, readHistory } from "../src/link/browser/history"
import { changeBrowserSettings, readBrowserSettings } from "../src/link/browser/settings"
import { browserSites, removeSiteData, siteSignInsHere, siteOf } from "../src/link/browser/sites"
import { offShape } from "./route-answer"

// The browser's data on a box (PROTOCOL.md, "The browser's data"), on a box's `browser` folder of the
// test's own, with Chrome stopped (no keeper runs: its `run` folder is the test's too). Chrome is
// stood in by what it leaves: its profile's `Cookies` database, in its own schema, and the keeper's
// notes of the pages that loaded (`visits.jsonl`). No real profile, box or app is read.

let root = ""
let folder = ""
let run = ""
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-browser-data-")))
  folder = join(root, "browser")
  run = join(root, "run")
  mkdirSync(folder, { recursive: true })
  mkdirSync(run, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const DAY = 86_400_000
/** A tiny PNG's first bytes: what the box keeps as an icon. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex")

/** What the keeper notes as a page loads, and an icon Chrome fetched for one. */
function noted(...lines: object[]) {
  writeFileSync(join(folder, "visits.jsonl"), lines.map(line => JSON.stringify(line) + "\n").join(""), { flag: "a" })
}

test("pages that loaded are kept as sites, front pages naming them, most suggested first, at most a few hundred", () => {
  const now = Date.UTC(2026, 10, 14)
  noted(
    { url: "https://www.github.com/kuvo/issues/3", title: "Issue 3", at: now - 3 * DAY },
    { url: "https://github.com/", title: "GitHub", at: now - 2 * DAY },
    { url: "https://github.com/kuvo", title: "kuvo", at: now - DAY },
    { url: "http://localhost:3000/", title: "http://localhost:3000/", at: now - 40 * DAY },
    { url: "about:blank", title: "", at: now },
    { url: "https://news.example.org/a", title: "A story", at: now },
    { url: "https://github.com/", icon: PNG.toString("base64"), at: now },
    { url: "https://news.example.org/a", icon: Buffer.from("<svg/>").toString("base64"), at: now },
  )
  const history = readHistory(folder, now)
  expect(offShape("GET", "kuvo/browser/history", 200, history)).toBeNull()
  expect(history.sites.map(site => site.host)).toEqual(["github.com", "news.example.org", "localhost:3000"])
  expect(history.sites[0]).toEqual({ host: "github.com", url: "https://github.com/", title: "GitHub", visits: 3, lastVisit: now - DAY, icon: true })
  // A page with no title of its own (Chrome says its address) has none.
  expect(history.sites[2]!.title).toBe("")
  // Not a picture (an SVG) isn't kept as an icon.
  expect(history.sites[1]!.icon).toBe(false)
  expect(iconOf("github.com", folder)).toEqual({ bytes: PNG, type: "image/png" })
  // Taken in once: the notes are gone, and asking again changes nothing.
  expect(existsSync(join(folder, "visits.jsonl"))).toBe(false)
  expect(readHistory(folder, now)).toEqual(history)

  // More sites than it keeps: the oldest go.
  noted(...Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ url: `https://site${i}.example.com/`, title: `Site ${i}`, at: now + i })))
  const full = readHistory(folder, now + HISTORY_LIMIT)
  expect(full.sites.length).toBe(HISTORY_LIMIT)
  expect(full.sites.some(site => site.host === "localhost:3000")).toBe(false)
})

test("a site taken out of the history goes with its icon, and Clear takes everything, notes not yet taken in too", () => {
  const now = Date.now()
  noted({ url: "https://github.com/", title: "GitHub", at: now }, { url: "https://github.com/", icon: PNG.toString("base64"), at: now }, { url: "https://example.org/", title: "Example", at: now })
  readHistory(folder)
  forgetHistory("github.com", folder)
  expect(readHistory(folder).sites.map(site => site.host)).toEqual(["example.org"])
  expect(iconOf("github.com", folder)).toBeNull()

  // Visited again: back.
  noted({ url: "https://github.com/", title: "GitHub", at: now })
  noted({ url: "https://kuvo.run/", title: "Kuvo", at: now })
  forgetHistory(null, folder)
  expect(readHistory(folder).sites).toEqual([])
  expect(existsSync(join(folder, "history.json"))).toBe(false)
})

/** The app's panel's history as Kuvo Code 0.5–0.7 kept it (`Browser/history.json`, Swift's dates:
 * seconds since 2001), its icons, and its preferences, in a Mac's folders of the test's own. */
function appBefore(): { app: string; files: string[] } {
  const library = join(root, "Library")
  const app = join(library, "Application Support", "run.kuvo.code.test")
  mkdirSync(join(app, "Browser", "Icons"), { recursive: true })
  const since2001 = (ms: number) => ms / 1000 - 978_307_200
  writeFileSync(join(app, "Browser", "history.json"), JSON.stringify([
    { host: "github.com", url: "https://github.com/", title: "GitHub", visits: 12, lastVisit: since2001(Date.UTC(2026, 9, 1)) },
    { host: "localhost:5173", url: "http://localhost:5173/", title: "Vite", visits: 4, lastVisit: since2001(Date.UTC(2026, 9, 2)) },
    { host: "broken" },
  ]))
  writeFileSync(join(app, "Browser", "Icons", "github.com.png"), PNG)
  writeFileSync(join(app, "Browser", "Icons", "elsewhere.com.png"), PNG)
  const files = [join(app, "Browser", "history.json"), join(app, "Browser", "Icons", "github.com.png")]
  if (process.platform === "darwin") {
    mkdirSync(join(library, "Preferences"), { recursive: true })
    const plist = join(library, "Preferences", "run.kuvo.code.test.plist")
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>browser.searchEngine</key><string>duckDuckGo</string>
<key>panel.tidiesAgentTabs</key><false/>
<key>passwords.offersToSave</key><false/>
<key>passwords.never</key><array><string>bank.example.com</string><string>mail.example.com</string></array>
<key>window.frame</key><data>AAEC</data>
</dict></plist>`)
    // (As macOS keeps them: binary.)
    execFileSync("/usr/bin/plutil", ["-convert", "binary1", plist])
    files.push(plist)
  }
  return { app, files }
}

test("this Mac's box takes in what its app's panel kept, once, and leaves the app's copy as it was", () => {
  // The box's own browser opened GitHub once already.
  noted({ url: "https://github.com/kuvo", title: "kuvo", at: Date.UTC(2026, 10, 1) })
  const { app, files } = appBefore()
  const before = files.map(file => [readFileSync(file), statSync(file).mtimeMs])

  takeInAppBrowserData(app, folder)
  const history = readHistory(folder, Date.UTC(2026, 10, 2))
  const github = history.sites.find(site => site.host === "github.com")!
  expect(github).toMatchObject({ visits: 13, lastVisit: Date.UTC(2026, 10, 1), icon: true })
  expect(history.sites.find(site => site.host === "localhost:5173")).toEqual({ host: "localhost:5173", url: "http://localhost:5173/", title: "Vite", visits: 4, lastVisit: Date.UTC(2026, 9, 2), icon: false })
  expect(history.sites.length).toBe(2)
  if (process.platform === "darwin") {
    expect(readBrowserSettings(folder)).toMatchObject({ searchEngine: "duckDuckGo", tidiesAgentTabs: false, offersToSave: false, never: ["bank.example.com", "mail.example.com"] })
  }
  // The app's own files untouched.
  expect(files.map(file => [readFileSync(file), statSync(file).mtimeMs])).toEqual(before)

  // Once: what the app keeps later (it still uses its own until this Mac's box runs its browser) isn't taken again.
  writeFileSync(join(app, "Browser", "history.json"), JSON.stringify([{ host: "later.example.com", url: "https://later.example.com/", title: "Later", visits: 1, lastVisit: 0 }]))
  takeInAppBrowserData(app, folder)
  expect(readHistory(folder).sites.some(site => site.host === "later.example.com")).toBe(false)
})

test("a box with settings of its own keeps them when the app's are taken in", () => {
  expect(changeBrowserSettings({ searchEngine: "kagi" }, folder)).toBeNull()
  const { app } = appBefore()
  takeInAppBrowserData(app, folder)
  expect(readBrowserSettings(folder)).toMatchObject({ searchEngine: "kagi", tidiesAgentTabs: true, offersToSave: true, never: [] })
})

test("the settings: each checked, kept, and the search engine's address beside it for the keeper", () => {
  const settings = readBrowserSettings(folder)
  expect(offShape("GET", "kuvo/browser/settings", 200, settings)).toBeNull()
  expect(settings).toMatchObject({ searchEngine: "google", tidiesAgentTabs: true, offersToSave: true, never: [] })
  expect(changeBrowserSettings({ searchEngine: "altavista" }, folder)).toContain("search engine")
  expect(changeBrowserSettings({ colour: "blue" }, folder)).toContain("colour")
  expect(changeBrowserSettings({ never: ["https://Bank.example.com/login", "bank.example.com"] }, folder)).toBeNull()
  expect(changeBrowserSettings({ searchEngine: "ecosia", tidiesAgentTabs: false, offersToSave: false }, folder)).toBeNull()
  expect(readBrowserSettings(folder)).toMatchObject({ searchEngine: "ecosia", tidiesAgentTabs: false, offersToSave: false, never: ["bank.example.com"] })
  // What the keeper reads: the engine's address, and the file it has always read for agents' tabs.
  expect(JSON.parse(readFileSync(join(folder, "settings.json"), "utf8")).searchURL).toBe("https://www.ecosia.org/search?q=%s")
  expect(existsSync(join(folder, "keeps-agent-tabs"))).toBe(true)
  expect(changeBrowserSettings({ tidiesAgentTabs: true }, folder)).toBeNull()
  expect(existsSync(join(folder, "keeps-agent-tabs"))).toBe(false)
})

/** Chrome's profile as it leaves it stopped: its `Cookies` database (in its own schema, values
 * encrypted), and a site's IndexedDB. */
function profile(rows: { host: string; name: string; expires: number | null; persistent: boolean }[]) {
  const file = join(folder, "profile", "Default", "Network", "Cookies")
  mkdirSync(join(folder, "profile", "Default", "Network"), { recursive: true })
  const db = new Database(file, { create: true })
  db.run(`CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
    encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,
    last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL,
    source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL, last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL, has_cross_site_ancestor INTEGER NOT NULL)`)
  const chrome = (ms: number) => (ms + 11_644_473_600_000) * 1000
  for (const row of rows) {
    db.run("INSERT INTO cookies VALUES (0, ?, '', ?, '', x'763130aa', '/', ?, 1, 1, 0, ?, ?, 1, 0, 2, 443, 0, 0, 0)",
      [row.host, row.name, row.expires === null ? 0 : chrome(row.expires), row.expires === null ? 0 : 1, row.persistent ? 1 : 0])
  }
  db.close()
  for (const name of ["https_x.com_0.indexeddb.leveldb", "https_www.example.org_0.indexeddb.leveldb"]) mkdirSync(join(folder, "profile", "Default", "IndexedDB", name), { recursive: true })
}

const CATALOG = [
  { id: "x", signInCookie: { domain: "x.com", name: "auth_token" } },
  { id: "linkedin", signInCookie: { domain: "linkedin.com", name: "li_at" } },
  { id: "reddit", signInCookie: { domain: "reddit.com", name: "reddit_session" } },
  { id: "discord" },
]

test("which sites the browser is signed in to, from its cookie file: a sign-in kept and unexpired counts, one that ended or ends with the browser doesn't", async () => {
  const now = Date.now()
  profile([
    { host: ".x.com", name: "auth_token", expires: now + 30 * DAY, persistent: true },
    { host: ".www.linkedin.com", name: "li_at", expires: now - DAY, persistent: true },
    { host: ".reddit.com", name: "reddit_session", expires: null, persistent: false },
    { host: "www.example.org", name: "theme", expires: now + DAY, persistent: true },
  ])
  expect(await siteSignInsHere(CATALOG, folder, run)).toEqual({ x: true, linkedin: false, reddit: false })
  // No browser here yet: it can't be told.
  expect(await siteSignInsHere(CATALOG, join(root, "nothing"), run)).toBeNull()
})

test("removing a site's data with the browser stopped signs it out of that site, and leaves the others", async () => {
  const now = Date.now()
  profile([
    { host: ".x.com", name: "auth_token", expires: now + 30 * DAY, persistent: true },
    { host: "api.x.com", name: "ct0", expires: now + 30 * DAY, persistent: true },
    { host: ".reddit.com", name: "reddit_session", expires: now + 30 * DAY, persistent: true },
    { host: "www.example.org", name: "theme", expires: now + DAY, persistent: true },
  ])
  const before = await browserSites(folder, run)
  expect(offShape("GET", "kuvo/browser/sites", 200, before)).toBeNull()
  expect(before.sites).toEqual([
    { site: "example.org", kinds: ["cookies", "storage"] },
    { site: "reddit.com", kinds: ["cookies"] },
    { site: "x.com", kinds: ["cookies", "storage"] },
  ])

  await removeSiteData(["x.com"], folder, run)
  expect(await siteSignInsHere(CATALOG, folder, run)).toEqual({ x: false, linkedin: false, reddit: true })
  expect((await browserSites(folder, run)).sites.map(site => site.site)).toEqual(["example.org", "reddit.com"])
  expect(existsSync(join(folder, "profile", "Default", "IndexedDB", "https_x.com_0.indexeddb.leveldb"))).toBe(false)
  // What's left for Chrome to clear as it starts: the site's other stored data.
  expect(JSON.parse(readFileSync(join(folder, "clear-sites.json"), "utf8")).sort()).toEqual(["api.x.com", "x.com"])

  await removeSiteData("all", folder, run)
  expect((await browserSites(folder, run)).sites).toEqual([])
  expect(await siteSignInsHere(CATALOG, folder, run)).toEqual({ x: false, linkedin: false, reddit: false })
})

test("a host's site, as near as can be told without the public suffix list", () => {
  expect(siteOf(".accounts.google.com")).toBe("google.com")
  expect(siteOf("www.bbc.co.uk")).toBe("bbc.co.uk")
  expect(siteOf("localhost")).toBe("localhost")
  expect(siteOf("192.168.1.10")).toBe("192.168.1.10")
})
