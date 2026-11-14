import "./safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ask } from "./route-answer"

// What "@" and "&" suggest as you type (PROTOCOL.md, "Mentions"): the box ranks the conversation's
// files and the agents "&" can name as the Mac's composer did, so every client shows the same list.
// Only the engine is a stand-in, listing the box's sessions.

const { engineHandler } = await import("../src/link/server/router")

const kuvo = process.env.KUVO_HOME!
// The conversation's folder (no repository: walked), and its project's other folder.
const root = mkdtempSync(join(kuvo, "mentions-"))
const app = join(root, "app")
const api = join(root, "api")
const files: [string, number][] = [
  ["app/App.swift", 10], ["app/src/App.swift", 40], ["app/src/AppDelegate.swift", 30], ["app/docs/app-notes.md", 20], ["app/lib/map.ts", 50], ["api/README.md", 60],
]
for (const [file, at] of files) {
  mkdirSync(join(root, file, ".."), { recursive: true })
  writeFileSync(join(root, file), "")
  utimesSync(join(root, file), at, at)
}
mkdirSync(join(kuvo, "box"), { recursive: true })
writeFileSync(join(kuvo, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: app, folders: [api], name: "App" }] }))

// The engine's sessions: the conversation typed in, and others "&" can name (newest first).
const session = (id: string, title: string, directory: string, updated: number) => ({ id, title, location: { directory }, time: { created: updated, updated } })
const sessions = [
  session("ses_here", "Here", app, 100),
  session("ses_fix", "Fix login", app, 90),
  session("ses_fixture", "Fixture cleanup", app, 80),
  session("ses_word", "Login fix", app, 70),
  session("ses_prefix", "Prefix tests", app, 60),
  session("ses_cafe", "Café menu", app, 50),
  session("ses_docs", "Docs", join(root, "fixes"), 40),
]
const engine = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/session") return Response.json({ data: sessions })
    const one = sessions.find(each => url.pathname === `/api/session/${each.id}`)
    if (url.pathname === "/api/session/ses_broken") return Response.json({ message: "Busy." }, { status: 500 })
    return one ? Response.json({ data: one }) : Response.json({ message: "No such session." }, { status: 404 })
  },
})
const handler = engineHandler(() => ({ port: engine.port, password: "pw" }) as any, { name: "test" }, () => { throw new Error("none") })
afterAll(() => {
  engine.stop(true)
  rmSync(root, { recursive: true, force: true })
  rmSync(join(kuvo, "box", "projects.json"), { force: true })
})

const suggest = async (query: string) => (await ask(handler, "GET", `kuvo/sessions/ses_here/mentions?${query}`)).json.mentions

test("\"@\" ranks the name itself, then names starting with it, containing it, then paths", async () => {
  const shown = await suggest("for=files&q=app")
  // (Among equals, shorter paths first: app-notes.md before AppDelegate.swift.)
  expect(shown.map((each: any) => each.text)).toEqual(["@app/", "@App.swift", "@src/App.swift", "@docs/app-notes.md", "@src/AppDelegate.swift", "@lib/map.ts"])
  expect(shown[0]).toEqual({ text: "@app/", title: "app", detail: null, kind: "folder", session: null })
  expect(shown[2]).toEqual({ text: "@src/App.swift", title: "App.swift", detail: "app/src", kind: "file", session: null })
  // The project's other folder, by its name; at most what's asked.
  expect((await suggest("for=files&q=readme"))[0]).toEqual({ text: "@api/README.md", title: "README.md", detail: "api", kind: "file", session: null })
  expect(await suggest("for=files&q=swift&limit=2")).toHaveLength(2)
})

test("\"@\" with nothing typed: the folders, then the newest files", async () => {
  expect((await suggest("for=files&q=")).map((each: any) => each.text)).toEqual(["@app/", "@api/", "@api/README.md", "@lib/map.ts", "@src/App.swift", "@src/AppDelegate.swift", "@docs/app-notes.md", "@App.swift"])
})

test("\"&\" ranks the agents as the Mac did, case and accents aside, and never offers the conversation itself", async () => {
  expect((await suggest("for=agents&q=FIX")).map((each: any) => each.title)).toEqual(["Fix login", "Fixture cleanup", "Login fix", "Prefix tests", "Docs"])
  // Past a space, only names that go on that way.
  expect((await suggest("for=agents&q=fix%20l")).map((each: any) => each.title)).toEqual(["Fix login"])
  expect((await suggest("for=agents&q=cafe"))[0]).toEqual({ text: "&Café menu", title: "Café menu", detail: "App", kind: "session", session: "ses_cafe" })
  // Nothing typed: the list's first.
  const first = await suggest("for=agents&q=&limit=3")
  expect(first.map((each: any) => each.session)).toEqual(["ses_fix", "ses_fixture", "ses_word"])
})

test("without what's suggested, for no such conversation, or one whose place doesn't answer, it says so", async () => {
  expect((await ask(handler, "GET", "kuvo/sessions/ses_here/mentions?q=a")).status).toBe(400)
  expect((await ask(handler, "GET", "kuvo/sessions/ses_none/mentions?for=files")).status).toBe(404)
  expect((await ask(handler, "GET", "kuvo/sessions/ses_broken/mentions?for=agents")).status).toBe(503)
})

test("a listing shared by two requests goes on for the one still waiting when the first stops", async () => {
  const { filesFor } = await import("../src/link/areas/mentions")
  const first = new AbortController()
  const second = new AbortController()
  const roots = [join(root, "api")]
  const one = filesFor(roots, false, first.signal)
  const two = filesFor(roots, false, second.signal)
  first.abort()
  expect((await two).map(file => file.path)).toEqual(["README.md"])
  await one.catch(() => {})
})
