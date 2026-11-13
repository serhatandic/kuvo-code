import "./safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Every client's session lists come from the box (PROTOCOL.md, "Session lists"): what each session
// is, the project it's filed under and the projects shown, as the Mac's sidebar worked them out
// (Packages/KuvoLink/Vectors/session-lists.json, which KuvoClient's tests hold the drawing to); kept
// as the engine's events come, and resumed from where a client was after its stream dropped.

const { factsOf, listedProjects } = await import("../src/link/lists/rule")
const { commit, keepList, keptList, listFollowers, listPlaceHeard, listRoute, noteListEvent, readList, workOut, LIST_FILE } = await import("../src/link/lists/sessions")
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
// Held: the list's next page waits until the test lets it go, as a slow engine's.
let held: Promise<void> | null = null
let heldAsked: () => void = () => {}
// Held: the next read of one session, until the test lets it go.
const holdOne = new Map<string, { asked: () => void; until: Promise<void> }>()
function holdRead(id: string): { asked: Promise<void>; letGo: () => void } {
  let letGo: () => void = () => {}
  let asked: () => void = () => {}
  const wasAsked = new Promise<void>(done => { asked = done })
  holdOne.set(id, { asked, until: new Promise<void>(done => { letGo = done }) })
  return { asked: wasAsked, letGo }
}
const engine = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/session") {
      // (Reads of the whole list, page after page: counted once.)
      if (!url.searchParams.get("cursor")) listReads += 1
      // Two to a page, so the list is read page after page.
      const all = [...sessions.values()].sort((a, b) => b.time.updated - a.time.updated)
      const from = Number(url.searchParams.get("cursor") ?? 0)
      const limit = Number(url.searchParams.get("limit"))
      const page = all.slice(from, from + Math.min(limit, 2))
      // (As it was when asked.)
      if (held) { heldAsked(); await held }
      return Response.json({ data: page, cursor: { next: from + page.length < all.length ? String(from + page.length) : null } })
    }
    if (url.pathname === "/api/session/active") return Response.json({ data: Object.fromEntries([...active].map(id => [id, { type: "busy" }])) })
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/)
    // (As it was when asked: a held read answers late with what was there then.)
    const answer = one && sessions.has(one[1]!) ? Response.json({ data: structuredClone(sessions.get(one[1]!)) }) : null
    const hold = one ? holdOne.get(one[1]!) : undefined
    if (hold) { holdOne.delete(one![1]!); hold.asked(); await hold.until }
    if (answer) return answer
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

test("a route answered in a process of its own reads the engine itself, and resumes from the list kept", async () => {
  add("ses_a", work, 100)
  add("ses_chat", chats, 50, { metadata: { kuvo: { chat: chats } } })
  // Three pages of two, each as far as the engine says it goes on.
  for (const n of [1, 2, 3]) add(`ses_page${n}`, work, 10 + n, { metadata: { kuvo: { archived: true } } })
  const { status, lines } = await ask("kuvo/sessions/list")
  expect(status).toBe(200)
  expect(lines[0].full).toBe(true)
  expect(Object.keys(lines[0].sessions).sort()).toEqual(["ses_a", "ses_chat", "ses_page1", "ses_page2", "ses_page3"])
  expect(lines[0].sessions.ses_a).toEqual({ kind: "project", project: work, directory: work, created: 100, updated: 100 })
  expect(lines[0].sessions.ses_chat.kind).toBe("chat")
  expect(lines[0].projects).toEqual({ [work]: { name: "Work", updated: 100 } })
  // Kept for the next read, whichever process makes it: nothing changed since.
  const again = (await ask(`kuvo/sessions/list?since=${lines[0].at}`)).lines[0]
  expect(again).toEqual({ at: lines[0].at, sessions: {}, projects: lines[0].projects })
  for (const n of [1, 2, 3]) sessions.delete(`ses_page${n}`)
})

test("just started, it reads its places before it answers, rather than say there's nothing", async () => {
  const stop = keepList()
  try {
    const { status, lines } = await ask("kuvo/sessions/list/events")
    expect(status).toBe(200)
    expect(Object.keys(lines[0].sessions).sort()).toEqual(["ses_a", "ses_chat"])
  } finally {
    stop()
  }
})

test("a session deleted while its place is read whole stays gone", async () => {
  const stop = keepList()
  try {
    await listPlaceHeard("engine", target)
    add("ses_short", work, 600)
    let letGo: () => void = () => {}
    held = new Promise(done => { letGo = done })
    const asked = new Promise<void>(done => { heldAsked = done })
    const reading = listPlaceHeard("engine", target)
    // (The page it's reading has it; the event says it's gone meanwhile.)
    await asked
    sessions.delete("ses_short")
    await noteListEvent("engine", target, { type: "session.deleted", data: { sessionID: "ses_short" } })
    held = null
    letGo()
    await reading
    expect(Object.keys((await ask("kuvo/sessions/list")).lines[0].sessions)).not.toContain("ses_short")
  } finally {
    held = null
    stop()
  }
})

test("a read for an earlier event that answers after the session's deleted doesn't bring it back", async () => {
  const stop = keepList()
  try {
    add("ses_brief", work, 610)
    await listPlaceHeard("engine", target)
    const read = holdRead("ses_brief")
    const updated = noteListEvent("engine", target, { type: "session.updated", data: { sessionID: "ses_brief" } })
    await read.asked
    sessions.delete("ses_brief")
    await noteListEvent("engine", target, { type: "session.deleted", data: { sessionID: "ses_brief" } })
    read.letGo()
    await updated
    workOut()
    expect(Object.keys(keptList()!.sessions)).not.toContain("ses_brief")
  } finally {
    sessions.delete("ses_brief")
    stop()
  }
})

test("two reads of one session that answer out of order leave it as the later says", async () => {
  const stop = keepList()
  try {
    add("ses_twice", work, 620, { title: "First" })
    await listPlaceHeard("engine", target)
    const read = holdRead("ses_twice")
    const earlier = noteListEvent("engine", target, { type: "session.updated", data: { sessionID: "ses_twice" } })
    await read.asked
    sessions.get("ses_twice").title = "Second"
    await noteListEvent("engine", target, { type: "session.renamed", data: { sessionID: "ses_twice" } })
    read.letGo()
    await earlier
    workOut()
    expect(keptList()!.sessions.ses_twice!.facts.title).toBe("Second")
  } finally {
    sessions.delete("ses_twice")
    stop()
  }
})

test("what a session streams while a read for its pin is out doesn't undo that read", async () => {
  const stop = keepList()
  try {
    add("ses_streams", work, 630)
    await listPlaceHeard("engine", target)
    sessions.get("ses_streams").metadata = { "kuvo.pinned": true }
    const read = holdRead("ses_streams")
    const pinned = noteListEvent("engine", target, { type: "session.metadata.updated", data: { sessionID: "ses_streams" } })
    await read.asked
    await noteListEvent("engine", target, { type: "session.text.delta", data: { sessionID: "ses_streams" } })
    read.letGo()
    await pinned
    workOut()
    expect(keptList()!.sessions.ses_streams!.facts.pinned).toBe(true)
  } finally {
    sessions.delete("ses_streams")
    stop()
  }
})

test("kept as events come: a client resumes from where it was, and one from before the box restarted reads it all", async () => {
  const stop = keepList()
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

    // A cursor of another list's (its file went), or from ahead of it: all of it, said so.
    for (const since of ["zz-1.3", `${after.at.split(".")[0]}.999`, "nonsense"]) {
      const whole = (await ask(`kuvo/sessions/list?since=${since}`)).lines[0]
      expect(whole.full).toBe(true)
      expect(Object.keys(whole.sessions).sort()).toEqual(["ses_a", "ses_chat"])
      expect(whole.gone).toBeUndefined()
    }

    // An event it can't read the session of (gone meanwhile): dropped.
    await noteListEvent("engine", target, { type: "session.renamed", data: { sessionID: "ses_nowhere" } })
    expect((await ask(`kuvo/sessions/list?since=${after.at}`)).lines[0].sessions).toEqual({})
    // Kept for a route answered in a process of its own: written a moment after a change, and
    // as it stops at the latest.
    stop()
    expect(JSON.parse(readFileSync(LIST_FILE, "utf8")).seq).toBe(Number(after.at.split(".")[1]))
  } finally {
    stop()
  }
})

test("its projects changing changes what's filed where, with no engine read", async () => {
  const stop = keepList()
  try {
    const tree = join(home, "lists-tree")
    add("ses_tree", tree, 400)
    await listPlaceHeard("engine", target)
    const before = (await ask("kuvo/sessions/list")).lines[0]
    expect(before.sessions.ses_tree.project).toBe(tree)
    const reads = listReads
    // (Written as another process would: the list hears it from the system.)
    const heard = new Promise<void>(done => {
      const look = () => { if (keptList()?.sessions.ses_tree?.facts.project === work) { listFollowers.delete(look); done() } }
      listFollowers.add(look)
    })
    writeFileSync(join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: work, folders: [tree], name: "Work" }] }))
    await heard
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

test("an event while its place is first read whole says nothing's gone: the list waits for the read", async () => {
  rmSync(LIST_FILE, { force: true })
  const stop = keepList()
  try {
    let letGo: () => void = () => {}
    held = new Promise(done => { letGo = done })
    const asked = new Promise<void>(done => { heldAsked = done })
    const reading = listPlaceHeard("engine", target)
    await asked
    // (The reviewer's case: a session changing during the first read's paging.)
    await noteListEvent("engine", target, { type: "session.updated", data: { sessionID: "ses_a" } })
    workOut()
    expect(readList()).toBeNull()
    held = null
    letGo()
    await reading
    const kept = readList()!
    expect(Object.keys(kept.sessions).sort()).toEqual(["ses_a", "ses_chat"])
    expect(kept.gone).toEqual({})
  } finally {
    held = null
    stop()
  }
})

test("a place asked to be read whole again while it's read is read once more after, never twice at once", async () => {
  const stop = keepList()
  try {
    await listPlaceHeard("engine", target)
    let letGo: () => void = () => {}
    held = new Promise(done => { letGo = done })
    const asked = new Promise<void>(done => { heldAsked = done })
    const reads = listReads
    const first = listPlaceHeard("engine", target)
    await asked
    add("ses_late", work, 700)
    const second = listPlaceHeard("engine", target)
    held = null
    letGo()
    await Promise.all([first, second])
    // (The one under way, then the one asked for meanwhile, after it.)
    expect(listReads - reads).toBe(2)
    expect(Object.keys(keptList()!.sessions)).toContain("ses_late")
  } finally {
    held = null
    sessions.delete("ses_late")
    stop()
  }
})

test("a coding agents' bridge that doesn't answer holds nothing up: the engine's are listed, the bridge's as last read", async () => {
  const silent = { port: 9, password: "pw" } as any
  const pieces: any[] = []
  const context = { request: { method: "GET", path: "kuvo/sessions/list", headers: {} }, signal: undefined, readEngine: () => target, bridge: () => silent,
    json: (status: number, value: unknown) => [{ head: { status, headers: {} } }, { body: Buffer.from(JSON.stringify(value)) }] } as any
  for await (const piece of listRoute(context, "kuvo/sessions/list".match(/^kuvo\/sessions\/list(\/events)?$/)!)) pieces.push(piece)
  expect(pieces[0].head.status).toBe(200)
  const answer = JSON.parse(Buffer.from(pieces[1].body).toString())
  expect(answer.pending).toEqual(["bridge"])
  expect(Object.keys(answer.sessions)).toContain("ses_a")
  // An engine that isn't there: no list rather than one without its sessions.
  const none: any[] = []
  for await (const piece of listRoute({ ...context, readEngine: () => { throw new Error("no engine") } }, "kuvo/sessions/list".match(/^kuvo\/sessions\/list(\/events)?$/)!)) none.push(piece)
  expect((none[0] as any).head.status).toBe(503)
})

test("a stream tells each change as a line of what changed", async () => {
  const stop = keepList()
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

test("a worktree an older Mac removed, handed over, files its sessions under its project", async () => {
  const gone = join(home, "lists-gone-tree")
  add("ses_gone_tree", gone, 450)
  try {
    expect((await ask("kuvo/sessions/list")).lines[0].sessions.ses_gone_tree.project).toBe(gone)
    const pieces: any[] = []
    for await (const piece of handler({ method: "POST", path: "kuvo/worktrees/record", headers: {}, body: Buffer.from(JSON.stringify({ removed: true, folder: gone, project: work })), fromApp: true }, undefined)) pieces.push(piece)
    expect(pieces[0].head.status).toBe(200)
    expect((await ask("kuvo/sessions/list")).lines[0].sessions.ses_gone_tree.project).toBe(work)
    // More worktrees removed here since than the 200 it keeps of them: the one handed over stays.
    const { updateWorktrees } = await import("../src/link/areas/worktree-records")
    for (let n = 0; n < 201; n++) updateWorktrees(each => each, { project: work, root: join(home, `lists-later-${n}`), folder: join(home, `lists-later-${n}`), branch: "b" } as any)
    expect((await ask("kuvo/sessions/list")).lines[0].sessions.ses_gone_tree.project).toBe(work)
  } finally {
    sessions.delete("ses_gone_tree")
    rmSync(join(home, "box", "worktrees.json"), { force: true })
  }
})

// A Mac's change over SSH (`box route`, a process of its own): the long-running process keeping the
// list sees the box's files change, and lists it, though nothing in it changed them.
test("a change another process makes to the box's projects reaches the kept list at once", async () => {
  const gone = join(home, "lists-elsewhere-tree")
  add("ses_elsewhere", gone, 460)
  const stop = keepList()
  try {
    await listPlaceHeard("engine", target)
    expect(keptList()!.sessions.ses_elsewhere!.facts.project).toBe(gone)
    const listed = new Promise<void>(done => {
      const look = () => { if (keptList()?.sessions.ses_elsewhere?.facts.project === work) { listFollowers.delete(look); done() } }
      listFollowers.add(look)
    })
    const route = Bun.spawn([process.execPath, join(import.meta.dir, "../src/link/main.ts"), "box", "route"], { env: process.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    route.stdin.write(JSON.stringify({ method: "POST", path: "kuvo/worktrees/record", body: { removed: true, folder: gone, project: work } }))
    await route.stdin.end()
    expect(JSON.parse(await new Response(route.stdout).text()).status).toBe(200)
    await route.exited
    await listed
  } finally {
    stop()
    sessions.delete("ses_elsewhere")
    rmSync(join(home, "box", "worktrees.json"), { force: true })
  }
}, 20_000)

// A bot's conversation named by another process (a bot made over SSH, kuvo-wake): its folder's
// files watched, not what its agent works on in it.
test("a bot another process makes is listed as a bot's at once", async () => {
  const { BOTS } = await import("../src/link/home")
  const folder = join(BOTS, "bot_listtest")
  add("ses_botty", work, 470)
  mkdirSync(folder, { recursive: true })
  const stop = keepList()
  try {
    await listPlaceHeard("engine", target)
    expect(keptList()!.sessions.ses_botty!.facts.kind).toBe("project")
    const listed = new Promise<void>(done => {
      const look = () => { if (keptList()?.sessions.ses_botty?.facts.kind === "bot") { listFollowers.delete(look); done() } }
      listFollowers.add(look)
    })
    writeFileSync(join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_listtest", name: "Lister" }))
    writeFileSync(join(folder, "session"), "ses_botty")
    await listed
  } finally {
    stop()
    sessions.delete("ses_botty")
    rmSync(folder, { recursive: true, force: true })
  }
}, 20_000)

// The box's long-running process gone before it wrote its last changes (stopped, crashed): what
// takes the list over next (it started again, under the same process id too, or a route answering
// in its place) numbers on past them, and every client from before reads it all once, so nothing
// told and not written stays with it (a session made and deleted meanwhile, say), however often
// that happens before it's back.
test("a list taken over from a process that went is read whole by every client from before", async () => {
  mkdirSync(join(LIST_FILE, ".."), { recursive: true })
  const went = (owner: number, started?: string) => {
    const kept = JSON.parse(readFileSync(LIST_FILE, "utf8"))
    writeFileSync(LIST_FILE, JSON.stringify({ ...kept, owner, started }))
  }
  writeFileSync(LIST_FILE, JSON.stringify({ epoch: "kept", seq: 10, floor: 0, sessions: {}, gone: {}, projects: {}, owner: 999999 }))
  try {
    // Another process that went: one from before, and one from what it told unwritten.
    let stop = keepList()
    await listPlaceHeard("engine", target)
    for (const since of ["kept.10", "kept.11"]) expect((await ask(`kuvo/sessions/list?since=${since}`)).lines[0].full).toBe(true)
    const first = (await ask("kuvo/sessions/list")).lines[0].at
    expect((await ask(`kuvo/sessions/list?since=${first}`)).lines[0].full).toBeUndefined()
    stop()
    // This process id again, started anew (the file says another start): taken over too.
    went(process.pid, "an-earlier-start")
    stop = keepList()
    await listPlaceHeard("engine", target)
    expect((await ask(`kuvo/sessions/list?since=${first}`)).lines[0].full).toBe(true)
    const second = (await ask("kuvo/sessions/list")).lines[0].at
    stop()
    // A route answering in place of one that went (no process keeps it now): the same.
    went(999999)
    expect((await ask(`kuvo/sessions/list?since=${second}`)).lines[0].full).toBe(true)
  } finally {
    rmSync(LIST_FILE, { force: true })
  }
})

test("a list kept by the same start, or by routes alone, resumes: no whole read each time", async () => {
  rmSync(LIST_FILE, { force: true })
  try {
    // Routes alone (no process keeps it): each answer goes on from the last.
    const first = (await ask("kuvo/sessions/list")).lines[0].at
    expect((await ask(`kuvo/sessions/list?since=${first}`)).lines[0].full).toBeUndefined()
    // The long-running process stopped and started again within one start (written as it stopped).
    let stop = keepList()
    await listPlaceHeard("engine", target)
    const kept = (await ask("kuvo/sessions/list")).lines[0].at
    stop()
    stop = keepList()
    await listPlaceHeard("engine", target)
    expect((await ask(`kuvo/sessions/list?since=${kept}`)).lines[0].full).toBeUndefined()
    stop()
  } finally {
    rmSync(LIST_FILE, { force: true })
  }
})

test("a route never writes over the list the long-running process keeps, nor takes away its mark", async () => {
  // (A process named as the long-running one is: it started as the route read the engine.)
  const link = Bun.spawn(["/bin/sh", "-c", "while :; do sleep 1; done", "kuvo-link"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  try {
    const kept = { epoch: "kept", seq: 3, floor: 0, sessions: {}, gone: {}, projects: {}, owner: link.pid }
    mkdirSync(join(LIST_FILE, ".."), { recursive: true })
    writeFileSync(LIST_FILE, JSON.stringify(kept))
    const answered = commit({ sessions: { ses_a: { kind: "project", project: work, directory: work, created: 1, updated: 1 } }, projects: {} })
    expect(answered).toEqual(kept)
    expect(readList()).toEqual(kept)
  } finally {
    link.kill()
    await link.exited
    rmSync(LIST_FILE, { force: true })
  }
})

test("only GET", async () => {
  expect((await ask("kuvo/sessions/list")).status).toBe(200)
  const pieces: any[] = []
  for await (const piece of handler({ method: "POST", path: "kuvo/sessions/list", headers: {}, fromApp: true }, undefined)) pieces.push(piece)
  expect(pieces[0]!.head!.status).toBe(405)
})
