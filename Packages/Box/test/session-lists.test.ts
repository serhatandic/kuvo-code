import "./safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Every client's session lists come from the box (PROTOCOL.md, "Session lists"): what each session
// is, the project it's filed under and the projects shown, as the Mac's sidebar worked them out
// (Packages/KuvoLink/Vectors/session-lists.json, which KuvoClient's tests hold the drawing to); kept
// as the engine's events come, and resumed from where a client was after its stream dropped.

const { factsOf, listedProjects } = await import("../src/link/lists/rule")
const { keepList, listPlaceHeard, noteListEvent, workOut, LIST_FILE } = await import("../src/link/lists/sessions")
const { engineHandler } = await import("../src/link/server/router")

const vectors = JSON.parse(readFileSync(new URL("../../KuvoLink/Vectors/session-lists.json", import.meta.url), "utf8"))

const placeOf = (box: any) => ({
  isChatsFolder: (folder: string) => folder === box.chats,
  botsFolder: box.bots,
  botSessions: new Set<string>(box.botSessions),
  filed: box.filed,
  projects: box.projects,
  running: new Set<string>(box.running),
  asked: new Map<string, number>(Object.entries(box.asked)),
  away: new Set<string>(box.away),
})

test.each(vectors.cases.map((each: any) => [each.name, each]))("%s", (_, each: any) => {
  const place = placeOf(each.box)
  const sessions = Object.fromEntries(each.sessions.map((session: any) => [session.id, factsOf(session, place)]))
  expect(sessions).toEqual(each.expect.sessions)
  expect(listedProjects(sessions, place)).toEqual(each.expect.projects)
})

// What a client draws from the facts alone, as a client not in Swift would: the vectors' sidebar
// follows from the box's answer.
test("the sidebar the vectors expect follows from the facts alone", () => {
  for (const each of vectors.cases.filter((one: any) => one.expect.sidebar)) {
    const facts: Record<string, any> = each.expect.sessions
    const projects: Record<string, any> = each.expect.projects
    const shown = Object.entries(facts).filter(([, one]) => (one.kind === "project" || one.kind === "chat") && !one.archived)
    const newest = (ids: [string, any][]) => ids.sort((a, b) => b[1].updated - a[1].updated).map(([id]) => id)
    const name = (folder: string) => projects[folder]?.name ?? folder.split("/").pop()!
    const finder = new Intl.Collator("en", { numeric: true, sensitivity: "base" })
    const groups = Object.keys(projects).map(directory => ({ directory, sessions: newest(shown.filter(([, one]) => one.kind === "project" && one.project === directory)) }))
    const top = (group: { sessions: string[] }) => (group.sessions[0] ? facts[group.sessions[0]].updated : 0)
    groups.sort((a, b) => top(b) - top(a) || finder.compare(name(a.directory), name(b.directory)))
    expect({
      pinned: newest(shown.filter(([, one]) => one.pinned)),
      chats: newest(shown.filter(([, one]) => one.kind === "chat")),
      projects: groups,
    }).toEqual(each.expect.sidebar)
  }
})

// A fake engine: its sessions and those at work, as `api/session` pages and `api/session/active`.
const home = process.env.KUVO_HOME!
const work = join(home, "lists-work")
const chats = join(home, "chats")
mkdirSync(join(home, "box"), { recursive: true })
mkdirSync(work, { recursive: true })
writeFileSync(join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: work, folders: [], name: "Work" }] }))
const sessions = new Map<string, any>()
const active = new Set<string>()
const add = (id: string, directory: string, updated: number, extra: Record<string, unknown> = {}) => sessions.set(id, { id, location: { directory }, time: { created: updated, updated }, ...extra })
let listReads = 0
const engine = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/session") {
      listReads += 1
      // Two to a page, so the list is read page after page.
      const all = [...sessions.values()].sort((a, b) => b.time.updated - a.time.updated)
      const from = Number(url.searchParams.get("cursor") ?? 0)
      const limit = Number(url.searchParams.get("limit"))
      const page = all.slice(from, from + Math.min(limit, 2))
      return Response.json({ data: page, cursor: { next: String(from + page.length) } })
    }
    if (url.pathname === "/api/session/active") return Response.json({ data: Object.fromEntries([...active].map(id => [id, { type: "busy" }])) })
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/)
    if (one && sessions.has(one[1]!)) return Response.json({ data: sessions.get(one[1]!) })
    return Response.json({ message: "Not here." }, { status: 404 })
  },
})
const target = { port: engine.port, password: "pw" } as any
afterAll(() => {
  engine.stop(true)
  for (const file of [join(home, "box", "projects.json"), LIST_FILE]) rmSync(file, { force: true })
})

const handler = engineHandler(() => target, { name: "test" }, () => { throw new Error("none") })
async function ask(path: string): Promise<{ status: number; lines: any[] }> {
  const stop = new AbortController()
  let status = 0
  let text = ""
  for await (const piece of handler({ method: "GET", path, headers: {}, fromApp: true }, undefined, stop.signal)) {
    if ("head" in piece) status = piece.head.status
    if ("body" in piece) text += Buffer.from(piece.body).toString()
    // (A stream's first line is what's asked of it here.)
    if (path.includes("/events") && text.includes("\n")) { stop.abort(); break }
  }
  return { status, lines: text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) }
}

test("a route answered alone reads the engine itself, whole", async () => {
  add("ses_a", work, 100)
  add("ses_chat", chats, 50, { metadata: { kuvo: { chat: chats } } })
  const { status, lines } = await ask("kuvo/sessions/list")
  expect(status).toBe(200)
  expect(lines[0].full).toBe(true)
  expect(lines[0].sessions.ses_a).toEqual({ kind: "project", project: work, directory: work, created: 100, updated: 100 })
  expect(lines[0].sessions.ses_chat.kind).toBe("chat")
  expect(lines[0].projects).toEqual({ [work]: { name: "Work", updated: 100 } })
  // (No list kept for `since` here: whole again.)
  expect((await ask(`kuvo/sessions/list?since=${lines[0].at}`)).lines[0].full).toBe(true)
})

test("kept as events come: a client resumes from where it was, and one from before the box restarted reads it all", async () => {
  const stop = keepList(1)
  try {
    active.add("ses_a")
    await listPlaceHeard("engine", target)
    const first = (await ask("kuvo/sessions/list")).lines[0]
    expect(first.full).toBe(true)
    expect(Object.keys(first.sessions).sort()).toEqual(["ses_a", "ses_chat"])
    expect(first.sessions.ses_a.running).toBe(true)

    // A session made, one renamed and pinned, one's run ending, one deleted: each as its event comes.
    add("ses_b", work, 300)
    await noteListEvent("engine", target, { type: "session.created", data: { sessionID: "ses_b" } })
    await noteListEvent("engine", target, { type: "session.execution.succeeded", data: { sessionID: "ses_a" } })
    sessions.get("ses_chat").title = "Ideas"
    sessions.get("ses_chat").metadata["kuvo.pinned"] = true
    await noteListEvent("engine", target, { type: "session.metadata.updated", data: { sessionID: "ses_chat" } })
    const between = (await ask(`kuvo/sessions/list?since=${first.at}`)).lines[0]
    expect(between.full).toBeUndefined()
    expect(Object.keys(between.sessions).sort()).toEqual(["ses_a", "ses_b", "ses_chat"])
    expect(between.sessions.ses_a.running).toBeUndefined()
    expect(between.sessions.ses_chat).toMatchObject({ kind: "chat", title: "Ideas", pinned: true })
    expect(between.projects[work].updated).toBe(300)

    sessions.delete("ses_b")
    await noteListEvent("engine", target, { type: "session.deleted", data: { sessionID: "ses_b" } })
    workOut()
    const after = (await ask(`kuvo/sessions/list/events?since=${between.at}`)).lines[0]
    expect(after.sessions).toEqual({})
    expect(after.gone).toEqual(["ses_b"])
    expect(after.projects[work].updated).toBe(100)
    // Nothing changed since: nothing but where it's at.
    const same = (await ask(`kuvo/sessions/list?since=${after.at}`)).lines[0]
    expect(same).toEqual({ at: after.at, sessions: {}, projects: after.projects })
    // Kept for a route answered in a process of its own.
    expect(JSON.parse(readFileSync(LIST_FILE, "utf8")).seq).toBe(Number(after.at.split(".")[1]))

    // A cursor of another epoch (the box restarted), or from ahead of it: all of it, said so.
    for (const since of ["zz-1.3", `${after.at.split(".")[0]}.999`, "nonsense"]) {
      const whole = (await ask(`kuvo/sessions/list?since=${since}`)).lines[0]
      expect(whole.full).toBe(true)
      expect(Object.keys(whole.sessions).sort()).toEqual(["ses_a", "ses_chat"])
      expect(whole.gone).toBeUndefined()
    }

    // An event it can't read the session of (gone meanwhile): dropped.
    await noteListEvent("engine", target, { type: "session.renamed", data: { sessionID: "ses_nowhere" } })
    expect((await ask(`kuvo/sessions/list?since=${after.at}`)).lines[0].sessions).toEqual({})
  } finally {
    stop()
  }
})

test("its projects changing changes what's filed where, with no engine read", async () => {
  const stop = keepList(2)
  try {
    const tree = join(home, "lists-tree")
    add("ses_tree", tree, 400)
    await listPlaceHeard("engine", target)
    const before = (await ask("kuvo/sessions/list")).lines[0]
    expect(before.sessions.ses_tree.project).toBe(tree)
    const reads = listReads
    writeFileSync(join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: work, folders: [tree], name: "Work" }] }))
    workOut()
    const after = (await ask(`kuvo/sessions/list?since=${before.at}`)).lines[0]
    expect(Object.keys(after.sessions)).toEqual(["ses_tree"])
    expect(after.sessions.ses_tree.project).toBe(work)
    expect(listReads).toBe(reads)
  } finally {
    stop()
    sessions.delete("ses_tree")
    writeFileSync(join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: work, folders: [], name: "Work" }] }))
  }
})

test("a stream tells each change as a line of what changed", async () => {
  const stop = keepList(3)
  const reading = new AbortController()
  try {
    await listPlaceHeard("engine", target)
    const stream = handler({ method: "GET", path: "kuvo/sessions/list/events", headers: {}, fromApp: true }, undefined, reading.signal)
    const line = async () => {
      for (;;) {
        const { value } = await stream.next()
        if (value && "body" in value) return JSON.parse(Buffer.from(value.body).toString())
      }
    }
    const first = await line()
    expect(first.full).toBe(true)
    add("ses_new", work, 500, { title: "Fresh" })
    const next = line()
    await noteListEvent("engine", target, { type: "session.created", data: { sessionID: "ses_new" } })
    const changed = await next
    expect(changed.full).toBeUndefined()
    expect(Object.keys(changed.sessions)).toEqual(["ses_new"])
    expect(changed.sessions.ses_new).toMatchObject({ kind: "project", project: work, title: "Fresh" })
    reading.abort()
    await stream.return(undefined)
  } finally {
    stop()
    sessions.delete("ses_new")
  }
})

test("only GET", async () => {
  expect((await ask("kuvo/sessions/list")).status).toBe(200)
  const pieces: any[] = []
  for await (const piece of handler({ method: "POST", path: "kuvo/sessions/list", headers: {}, fromApp: true }, undefined)) pieces.push(piece)
  expect(pieces[0]!.head!.status).toBe(405)
})
