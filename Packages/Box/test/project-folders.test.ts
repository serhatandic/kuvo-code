import "./safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// A project's other folders reach each of its sessions as it next runs (PROTOCOL.md, "Projects",
// `projects.folders`): whichever client changed them, and a session made before they did, gets the
// rule allowing each and the note naming them as its run starts. One whose folders are as set, a
// subagent's and a group chat's seat are left alone: a write would make each the newest.

const home = process.env.KUVO_HOME!
const shop = join(home, "work", "shop")
const docs = join(home, "work", "docs")
const tree = join(home, "trees", "brave-otter")
// The shop by another name: a link, as `/home` is on some Linux machines.
const linked = join(home, "linked-shop")
for (const folder of [shop, docs, tree]) mkdirSync(folder, { recursive: true })
symlinkSync(shop, linked)
mkdirSync(join(home, "box"), { recursive: true })
const keep = (folders: string[]) => writeFileSync(join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: shop, folders }] }))
keep([docs])
writeFileSync(join(home, "box", "worktrees.json"), JSON.stringify({ worktrees: [{ project: shop, root: tree, folder: tree, branch: "kuvo/brave-otter" }] }))
afterAll(() => { for (const name of ["projects.json", "worktrees.json"]) rmSync(join(home, "box", name), { force: true }); rmSync(linked, { force: true }) })

const asks = { action: "shell", resource: "*", effect: "ask" }
const docsRule = { action: "external_directory", resource: join(docs, "*"), effect: "allow" }
type Session = { id: string; parentID?: string; location: { directory: string }; permissions: unknown[]; metadata: Record<string, unknown> }
const sessions: Record<string, Session> = {
  ses_stale: { id: "ses_stale", location: { directory: shop }, permissions: [asks], metadata: {} },
  ses_given: { id: "ses_given", location: { directory: shop }, permissions: [asks, docsRule], metadata: {} },
  ses_seat: { id: "ses_seat", location: { directory: shop }, permissions: [asks], metadata: { kuvo: { seat: "grp_1" } } },
  ses_helper: { id: "ses_helper", parentID: "ses_given", location: { directory: shop }, permissions: [asks], metadata: {} },
  ses_tree: { id: "ses_tree", location: { directory: tree }, permissions: [asks], metadata: {} },
  ses_linked: { id: "ses_linked", location: { directory: linked }, permissions: [asks, docsRule], metadata: { kuvo: { filed: { folder: linked, project: shop } } } },
}
const written: string[] = []
const notes: Record<string, string | null> = {}
let noted: (id: string) => void = () => {}
let send: (event: unknown) => void = () => {}
let following: () => void = () => {}
const followed = new Promise<void>(done => { following = done })
const engine = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/event") {
      return new Response(new ReadableStream({ start(stream) {
        send = event => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        following()
      } }), { headers: { "content-type": "text/event-stream" } })
    }
    const entry = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries\/kuvo\.project-folders$/)
    if (entry) {
      notes[entry[1]!] = request.method === "DELETE" ? null : ((await request.json()) as { value: string }).value
      noted(entry[1]!)
      return Response.json({})
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/)
    const session = one ? sessions[one[1]!] : undefined
    if (session && request.method === "GET") return Response.json({ data: session })
    if (session && request.method === "PATCH") {
      written.push(session.id)
      Object.assign(session, await request.json())
      return Response.json({ data: session })
    }
    return Response.json({ message: "Not here." }, { status: 404 })
  },
})
const target = { port: engine.port, password: "pw" } as never
afterAll(() => engine.stop(true))

test("a session whose project's folders changed gets them as its run starts", async () => {
  const { watchEvents } = await import("../src/link/engine/watch")
  const stop = new AbortController()
  const told = new Promise<void>(done => { noted = id => { if (id === "ses_stale") done() } })
  try {
    void watchEvents(() => target, () => true, stop.signal, () => {}, { work: "engine" })
    await followed
    send({ type: "session.execution.started", data: { sessionID: "ses_stale" } })
    await told
    expect(sessions.ses_stale!.permissions).toEqual([asks, docsRule])
    expect(notes.ses_stale).toContain(`- docs: ${docs}`)
  } finally {
    stop.abort()
  }
})

test("one whose folders are as set, a subagent's and a group chat's seat aren't written", async () => {
  const { giveFolders } = await import("../src/link/areas/projects")
  written.length = 0
  for (const id of ["ses_given", "ses_helper", "ses_seat"]) expect(await giveFolders(target, id, { whenChanged: true })).toBe(true)
  expect(written).toEqual([])
  expect(notes.ses_given).toBeUndefined()
  expect(sessions.ses_seat!.permissions).toEqual([asks])
})

test("a worktree's session gets its project's folders; one in the project by another name keeps them; once they go, rule and note go", async () => {
  const { giveFolders } = await import("../src/link/areas/projects")
  expect(await giveFolders(target, "ses_tree", { whenChanged: true })).toBe(true)
  expect(sessions.ses_tree!.permissions).toEqual([asks, docsRule])
  expect(notes.ses_tree).toContain(`- docs: ${docs}`)

  written.length = 0
  expect(await giveFolders(target, "ses_linked", { whenChanged: true })).toBe(true)
  expect(written).toEqual([])

  keep([])
  try {
    for (const id of ["ses_tree", "ses_stale"]) {
      expect(await giveFolders(target, id, { whenChanged: true })).toBe(true)
      expect(sessions[id]!.permissions).toEqual([asks])
      expect(notes[id]).toBeNull()
    }
  } finally {
    keep([docs])
  }
})

test("a folder Settings › Permissions names stays allowed when a session's project folders are given (Auto allows what it asks about)", async () => {
  const { giveFolders } = await import("../src/link/areas/projects")
  const outside = join(home, "work", "shared")
  const settings = join(home, "box", "opencode.json")
  writeFileSync(settings, JSON.stringify({ permissions: [{ action: "external_directory", resource: join(outside, "*"), effect: "ask" }] }))
  const allowsOutside = { action: "external_directory", resource: join(outside, "*"), effect: "allow" }
  sessions.ses_auto = { id: "ses_auto", location: { directory: shop }, permissions: [asks, allowsOutside], metadata: {} }
  try {
    expect(await giveFolders(target, "ses_auto", { whenChanged: true })).toBe(true)
    expect(sessions.ses_auto!.permissions).toEqual([asks, allowsOutside, docsRule])
  } finally {
    rmSync(settings, { force: true })
  }
})
