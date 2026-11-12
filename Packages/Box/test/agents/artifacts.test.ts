import "../safety"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { unified } from "../../src/agents/diff"
import { EngineLink } from "../../src/agents/engine"
import { record } from "../../src/agents/artifacts/record"
import { Recorder, type Event, type Source } from "../../src/agents/artifacts/recorder"
import { artifactRoutes, notedRoute } from "../../src/agents/artifacts/routes"
import { ArtifactStore } from "../../src/agents/artifacts/store"

// The box's record of what its agents made, as a client reads it (`kuvo/artifacts`): a bot's memory
// with what changed in it, a coding session's documents, a group chat's files by bot, versions kept
// across a restart, and older versions cleared only past the budget, still listed.

/** The engine, as far as the record asks it: its conversations, and its live feed. */
class Engine {
  sessions = new Map<string, any>()
  private feeds = new Set<ReadableStreamDefaultController<Uint8Array>>()
  private connected: (() => void)[] = []
  private server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/api/event") {
        let controller!: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>({
          start: (each) => {
            controller = each
            this.feeds.add(each)
            each.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`))
            for (const done of this.connected.splice(0)) done()
          },
          cancel: () => void this.feeds.delete(controller),
        })
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
      }
      const match = url.pathname.match(/^\/api\/session\/([^/]+)$/)
      if (match) {
        const session = this.sessions.get(decodeURIComponent(match[1]))
        return session ? Response.json({ data: session }) : Response.json({ message: "No such session." }, { status: 404 })
      }
      return Response.json({}, { status: 404 })
    },
  })
  get url() {
    return `http://127.0.0.1:${this.server.port}`
  }
  /** Once a feed is open. */
  listening(): Promise<void> {
    return this.feeds.size ? Promise.resolve() : new Promise((done) => this.connected.push(done))
  }
  send(event: Event) {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ id: "evt_" + Math.random(), ...event })}\n\n`)
    for (const feed of this.feeds) feed.enqueue(bytes)
  }
  stop() {
    this.server.stop(true)
  }
}

let root: string
let bots: string
let project: string
let engine: Engine
let link: EngineLink
let store: ArtifactStore
let recorder: Recorder
let source: Source
/** The disk the record's copies are on: plenty free, unless a test says otherwise. */
let disk = { free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }

function session(id: string, directory: string, extra: Record<string, any> = {}) {
  engine.sessions.set(id, { id, location: { directory }, ...extra })
}

/** A bot with its memory, as its box keeps it. */
function bot(id: string, memory: string) {
  const folder = join(bots, id)
  mkdirSync(join(folder, "workspace"), { recursive: true })
  writeFileSync(join(folder, "session"), "ses_" + id)
  writeFileSync(join(folder, "MEMORY.md"), memory)
  session("ses_" + id, join(folder, "workspace"))
  return folder
}

/** A tool call as the engine tells it: named, called with its input, done. */
function tool(sessionID: string, id: string, name: string, input: Record<string, unknown>, done: { metadata?: unknown; content?: unknown[] } = {}): Event[] {
  return [
    { type: "session.tool.input.started", data: { sessionID, assistantMessageID: "msg_a", id, name } },
    { type: "session.tool.called", data: { sessionID, assistantMessageID: "msg_a", id, input } },
    { type: "session.tool.success", data: { sessionID, assistantMessageID: "msg_a", id, content: done.content ?? [{ type: "text", text: "done" }], metadata: done.metadata ?? {} } },
  ]
}

function turn(sessionID: string, message: string, events: Event[]): Event[] {
  return [
    { type: "session.execution.started", data: { sessionID } },
    { type: "session.inbox.delivered", data: { sessionID, inboxID: message } },
    ...events,
    { type: "session.execution.succeeded", data: { sessionID } },
  ]
}

/** An edit as the engine makes and reports it: the file changed, with its patch in `metadata.files`. */
function edit(sessionID: string, id: string, path: string, after: string) {
  const before = readFileSync(path, "utf8")
  writeFileSync(path, after)
  return tool(sessionID, id, "edit", { filePath: path }, { metadata: { files: [{ file: path, patch: unified(before, after).patch, status: "modified" }] } })
}

async function hear(events: Event[]) {
  for (const event of events) await recorder.heard(source, event)
}

async function route(method: string, path: string, body: unknown = {}): Promise<{ status: number; value: any }> {
  const url = new URL("http://box/" + path)
  // What follows `kuvo/artifacts`, as the box's link passes it on.
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent).slice(2)
  const response = await artifactRoutes(store, method, parts, url.searchParams, async () => body)
  const type = response.headers.get("content-type") ?? ""
  return { status: response.status, value: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()).toString() }
}

beforeEach(() => {
  disk = { free: 500 * 1024 ** 3, total: 1000 * 1024 ** 3 }
  root = mkdtempSync(join(tmpdir(), "kuvo-artifacts-"))
  bots = join(root, "bots")
  project = join(root, "project")
  mkdirSync(bots, { recursive: true })
  mkdirSync(project, { recursive: true })
  engine = new Engine()
  link = new EngineLink()
  link.configure(engine.url, "x")
  store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
  recorder = new Recorder(store, { bots })
  source = {
    name: "engine",
    session: async (id) => (await link.request<any>("GET", `/api/session/${encodeURIComponent(id)}`))?.data,
    agent: () => "engine",
  }
})

afterEach(() => {
  link.configure(undefined, undefined)
  engine.stop()
  rmSync(root, { recursive: true, force: true })
})

describe("a bot's memory", () => {
  test("its edit, heard on the engine's feed, is a version of its memory, with the words that changed marked", async () => {
    const folder = bot("bot_ada", "# Ada's memory\n\nThe user likes tea in the morning.\nShips on Fridays.\n")
    link.watch((event) => void recorder.heard(source, event))
    await engine.listening()
    const recorded = new Promise<void>((done) => store.onChange((artifact) => artifact.kind === "memory" && done()))
    for (const event of turn("ses_bot_ada", "msg_you1", edit("ses_bot_ada", "call_1", join(folder, "MEMORY.md"), "# Ada's memory\n\nThe user likes coffee in the morning.\nShips on Fridays.\n"))) engine.send(event)
    await recorded

    const { value: list } = await route("GET", "kuvo/artifacts?bot=bot_ada")
    expect(list.artifacts).toHaveLength(1)
    const memory = list.artifacts[0]
    expect(memory).toMatchObject({ name: "MEMORY.md", kind: "memory", versions: 1, where: { bots: ["bot_ada"], sessions: ["ses_bot_ada"] } })
    expect(memory.latest).toMatchObject({ n: 1, by: { kind: "agent", bot: "bot_ada" }, turn: { session: "ses_bot_ada", message: "msg_you1" }, via: ["edit"], lines: { added: 1, removed: 1 } })

    // What it was before, worked out from the edit, so its first change can be shown.
    const { value: changes } = await route("GET", `kuvo/artifacts/${memory.id}/versions/1/changes`)
    expect(changes.style).toBe("words")
    const changed = changes.lines.find((line: any) => line.kind === "changed")
    expect(changed.runs).toEqual([
      { t: " ", text: "The user likes " },
      { t: "-", text: "tea" },
      { t: "+", text: "coffee" },
      { t: " ", text: " in the morning." },
    ])
    expect((await route("GET", `kuvo/artifacts/${memory.id}/versions/0`)).value).toContain("likes tea")
  })

  test("several edits in one turn are one version, and the next turn makes the next", async () => {
    const folder = bot("bot_ada", "one\n")
    const memory = join(folder, "MEMORY.md")
    // Each edit as the agent makes it: the file changes, then its call is heard.
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_bot_ada" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_bot_ada", inboxID: "msg_1" } }])
    await hear(edit("ses_bot_ada", "c1", memory, "one\ntwo\n"))
    await hear([...edit("ses_bot_ada", "c2", memory, "one\ntwo\nthree\n"), { type: "session.execution.succeeded", data: { sessionID: "ses_bot_ada" } }])
    await hear(turn("ses_bot_ada", "msg_2", edit("ses_bot_ada", "c3", memory, "one\ntwo\nthree\nfour\n")))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(memory)}`)
    const versions = value.versions.filter((version: any) => !version.before)
    expect(versions.map((version: any) => [version.n, version.edits, version.turn.message, version.lines])).toEqual([
      [1, 2, "msg_1", { added: 2, removed: 0 }],
      [2, 1, "msg_2", { added: 1, removed: 0 }],
    ])
    expect((await route("GET", `kuvo/artifacts/${value.id}/versions/1`)).value).toBe("one\ntwo\nthree\n")
  })

  test("a change made outside any turn (you, in Edit Bot) is a version by no agent", async () => {
    const folder = bot("bot_ada", "one\n")
    const memory = join(folder, "MEMORY.md")
    await hear(turn("ses_bot_ada", "msg_1", edit("ses_bot_ada", "c1", memory, "one\ntwo\n")))
    writeFileSync(memory, "one\ntwo\nmine\n")
    await store.change(memory, { by: { kind: "outside" }, via: "outside", where: { bot: "bot_ada" } })
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(memory)}`)
    expect(value.versions.at(-1)).toMatchObject({ n: 2, by: { kind: "outside" }, lines: { added: 1, removed: 0 } })
  })
})

describe("a bot's folder", () => {
  /** Its folder watched as the bridge does, with changes held until they're flushed (as its turn ends). */
  function watched() {
    const started = record(store, { bots, settle: 60_000 })
    recorder = started.recorder
    return started.folders!
  }

  test("files a command makes during the bot's turn are that turn's; its caches and tools' folders aren't kept", async () => {
    const folder = bot("bot_ada", "m\n")
    const folders = watched()
    try {
      await hear([{ type: "session.execution.started", data: { sessionID: "ses_bot_ada" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_bot_ada", inboxID: "msg_1" } }])
      const report = join(folder, "workspace", "weekly.csv")
      writeFileSync(report, "week,sales\n1,10\n")
      mkdirSync(join(folder, "workspace", "node_modules", "x"), { recursive: true })
      writeFileSync(join(folder, "workspace", "node_modules", "x", "index.js"), "x")
      folders.changed(report)
      folders.changed(join(folder, "workspace", "node_modules", "x", "index.js"))
      await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_bot_ada" } }])
      const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada")
      expect(value.artifacts.map((artifact: any) => artifact.name)).toEqual(["weekly.csv"])
      expect(value.artifacts[0]).toMatchObject({ kind: "document", where: { sessions: ["ses_bot_ada"] } })
      expect(value.artifacts[0].latest).toMatchObject({ via: ["shell"], turn: { session: "ses_bot_ada", message: "msg_1" }, by: { kind: "agent", bot: "bot_ada" } })
    } finally {
      folders.stop()
    }
  })

  test("a picture a command made and removed in the same turn keeps what it was, then its deletion", async () => {
    const folder = bot("bot_ada", "m\n")
    const folders = watched()
    try {
      await hear([{ type: "session.execution.started", data: { sessionID: "ses_bot_ada" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_bot_ada", inboxID: "msg_1" } }])
      const picture = join(folder, "workspace", "checker.png")
      writeFileSync(picture, "PNG checker")
      folders.changed(picture)
      folders.flush()
      unlinkSync(picture)
      folders.changed(picture)
      await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_bot_ada" } }])
      const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(picture)}`)
      expect(value.versions.map((version: any) => [version.n, version.status, version.kept])).toEqual([[1, "added", true], [2, "deleted", false]])
      expect((await route("GET", `kuvo/artifacts/${value.id}/versions/1`)).value).toBe("PNG checker")
    } finally {
      folders.stop()
    }
  })

  test("a file a tool deletes before the record saw it keeps what it was, from the deletion's own change", async () => {
    const folder = bot("bot_ada", "m\n")
    const notes = join(folder, "workspace", "notes.md")
    writeFileSync(notes, "# Notes\nkeep this\n")
    unlinkSync(notes)
    await hear(turn("ses_bot_ada", "msg_1", tool("ses_bot_ada", "c1", "apply_patch", { patchText: "*** Delete File" }, { metadata: { files: [{ file: notes, patch: unified("# Notes\nkeep this\n", "").patch, status: "deleted" }] } })))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(notes)}`)
    expect(value.versions.map((version: any) => [version.n, version.status, Boolean(version.before)])).toEqual([[0, "added", true], [1, "deleted", false]])
    expect((await route("GET", `kuvo/artifacts/${value.id}/versions/0`)).value).toBe("# Notes\nkeep this\n")
  })

  test("your edit to its memory, outside any turn, is by no agent and shows what changed since the watch began", async () => {
    const folder = bot("bot_ada", "Likes tea.\n")
    const folders = watched()
    try {
      writeFileSync(join(folder, "MEMORY.md"), "Likes green tea.\n")
      folders.changed(join(folder, "MEMORY.md"))
      folders.flush()
      const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada&kind=memory")
      expect(value.artifacts[0].latest).toMatchObject({ n: 1, by: { kind: "outside" }, via: ["outside"] })
      const { value: changes } = await route("GET", `kuvo/artifacts/${value.artifacts[0].id}/versions/1/changes`)
      expect(changes.lines).toEqual([{ kind: "changed", runs: [{ t: " ", text: "Likes " }, { t: "+", text: "green " }, { t: " ", text: "tea." }] }])
    } finally {
      folders.stop()
    }
  })

  test("a line it grew reads as the words it added, not as the line rewritten", async () => {
    const folder = bot("bot_ada", "Ships on Fridays.\n")
    const folders = watched()
    try {
      writeFileSync(join(folder, "MEMORY.md"), "Ships on Fridays. The 0.8 launch date is 12 November; Ben owns the press kit.\n")
      folders.changed(join(folder, "MEMORY.md"))
      folders.flush()
      const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada&kind=memory")
      const { value: changes } = await route("GET", `kuvo/artifacts/${value.artifacts[0].id}/versions/1/changes`)
      expect(changes.lines).toEqual([
        { kind: "changed", runs: [{ t: " ", text: "Ships on Fridays." }, { t: "+", text: " The 0.8 launch date is 12 November; Ben owns the press kit." }] },
      ])
    } finally {
      folders.stop()
    }
  })

  test("a file a command made that the watch never told (as it, or another watch, started) is that turn's all the same, once it looks again; what it has as it is stays untouched", async () => {
    const folder = bot("bot_ada", "m\n")
    const folders = watched()
    // Quiet from here: as the system's stream is in the moment it's made anew.
    folders.stop()
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_bot_ada" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_bot_ada", inboxID: "msg_1" } }])
    const report = join(folder, "workspace", "weekly.csv")
    writeFileSync(report, "week,sales\n1,10\n")
    folders.missed()
    // (Before its turn ends, which looks too.)
    folders.flush()
    await store.settled()
    const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada")
    expect(value.artifacts.map((artifact: any) => artifact.name)).toEqual(["weekly.csv"])
    expect(value.artifacts[0].latest).toMatchObject({ via: ["shell"], turn: { session: "ses_bot_ada", message: "msg_1" }, by: { kind: "agent", bot: "bot_ada" } })
    // Its memory, made just before the watch and as the record has it: no version, nor the turn's.
    const { value: memory } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(join(folder, "MEMORY.md"))}`)
    expect(memory.versions.map((version: any) => version.n)).toEqual([0])
    expect(memory.where.sessions).toEqual([])
  })

  test("what a command made that the watch never told, nor its looks again, is found as its turn ends", async () => {
    const folder = bot("bot_ada", "m\n")
    const folders = watched()
    folders.stop()
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_bot_ada" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_bot_ada", inboxID: "msg_1" } }])
    writeFileSync(join(folder, "workspace", "weekly.csv"), "week,sales\n1,10\n")
    await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_bot_ada" } }])
    await store.settled()
    const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada")
    expect(value.artifacts.map((artifact: any) => artifact.name)).toEqual(["weekly.csv"])
    expect(value.artifacts[0].latest).toMatchObject({ via: ["shell"], turn: { session: "ses_bot_ada", message: "msg_1" } })
  })

  // (On Linux each folder's watch is the system's own, and misses nothing as it starts.)
  test.skipIf(process.platform === "linux")("its watch looks again for what it may have missed, a moment after it starts", async () => {
    bot("bot_ada", "m\n")
    const folders = watched()
    try {
      await new Promise<void>(resolve => { folders.missed = resolve })
    } finally {
      folders.stop()
    }
  })
})

describe("files a command made", () => {
  test("without a watch (Linux, out of watches), a bot's are found as its turn ends", async () => {
    const folder = bot("bot_ada", "m\n")
    recorder = record(store, { bots, watch: false }).recorder
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_bot_ada" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_bot_ada", inboxID: "msg_1" } }])
    writeFileSync(join(folder, "workspace", "chart.csv"), "a,b\n")
    mkdirSync(join(folder, "workspace", "node_modules"))
    writeFileSync(join(folder, "workspace", "node_modules", "x.js"), "x")
    await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_bot_ada" } }])
    const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada")
    expect(value.artifacts.map((artifact: any) => [artifact.name, artifact.latest.via])).toEqual([["chart.csv", ["shell"]]])
  })

  test("what a command made is kept, but not the scratch it left in a tmp folder (a render to check its work)", async () => {
    recorder = record(store, { bots }).recorder
    spawnSync("git", ["init", "-q", project])
    session("ses_code", project)
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_code" } }])
    mkdirSync(join(project, "output", "pdf"), { recursive: true })
    writeFileSync(join(project, "output", "pdf", "moon.pdf"), "%PDF-1.4\n")
    mkdirSync(join(project, "tmp", "pdfs"), { recursive: true })
    writeFileSync(join(project, "tmp", "pdfs", "moon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    mkdirSync(join(project, "Temp"))
    writeFileSync(join(project, "Temp", "check.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_code" } }])
    expect((await route("GET", "kuvo/artifacts?session=ses_code")).value.artifacts.map((artifact: any) => artifact.name)).toEqual(["moon.pdf"])
  })

  test("scratch a command left in a tmp folder, recorded before it was left out, is gone from the record when the box starts again, unless you kept it", async () => {
    spawnSync("git", ["init", "-q", project])
    const files = { render: join(project, "tmp", "pdfs", "moon.png"), kept: join(project, "tmp", "kept.png"), shown: join(project, "tmp", "shown.png"), written: join(project, "tmp", "notes.md"), pdf: join(project, "output", "moon.pdf") }
    mkdirSync(join(project, "tmp", "pdfs"), { recursive: true })
    mkdirSync(join(project, "output"))
    writeFileSync(files.render, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]))
    writeFileSync(files.kept, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]))
    writeFileSync(files.shown, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x03]))
    writeFileSync(files.written, "# Notes\n")
    writeFileSync(files.pdf, "%PDF-1.4\n")
    // As an older box recorded a turn's end: every file a command made, scratch too.
    const made = (via: string) => ({ by: { kind: "agent" as const, session: "ses_code", agent: "codex" }, turn: { session: "ses_code" }, via, where: { project, session: "ses_code" } })
    await store.changeAll([files.render, files.kept, files.shown, files.pdf], made("shell"))
    await store.change(files.written, made("write"))
    await store.shown(files.shown, made("show_file"))
    await store.pin(ArtifactStore.idOf(files.kept), { by: "you" })
    const render = store.at(files.render)!.versions[0].hash!
    const copy = join(root, "artifacts", "copies", render.slice(7, 9), render.slice(7))
    expect(readFileSync(copy).length).toBe(5)

    for (let start = 0; start < 2; start++) {
      // And gone for good: not back as the box starts again after.
      store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
      const names = (await route("GET", "kuvo/artifacts?session=ses_code")).value.artifacts.map((artifact: any) => artifact.name).sort()
      expect(names).toEqual(["kept.png", "moon.pdf", "notes.md", "shown.png"])
      expect(() => readFileSync(copy)).toThrow()
    }
    // A command making it again later is recorded afresh, not with the versions taken off.
    await store.changeAll([files.render], made("show_file"))
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
    expect(store.at(files.render)?.versions.map((version) => version.n)).toEqual([1])
  })

  test("a file a kept reply cited as what it made, read as the box starts again, is shown then, with its versions as they were, and stays shown; a cited one in a tmp folder isn't taken off", async () => {
    spawnSync("git", ["init", "-q", project])
    mkdirSync(join(project, "output"))
    mkdirSync(join(project, "tmp"))
    const pdf = join(project, "output", "moon.pdf")
    const report = join(project, "tmp", "report.pdf")
    writeFileSync(pdf, "%PDF-1.4\n")
    writeFileSync(report, "%PDF-1.4 first\n")
    const made = { by: { kind: "agent" as const, session: "ses_code", agent: "codex" }, turn: { session: "ses_code" }, via: "shell", where: { project, session: "ses_code" } }
    await store.changeAll([pdf, report], made)
    writeFileSync(report, "%PDF-1.4 second\n")
    await store.changeAll([report], { ...made, turn: { session: "ses_code", message: "m2" } })
    // Changed by you since: not a version of the agent's.
    writeFileSync(pdf, "%PDF-1.4 yours\n")
    const versions = (path: string) => store.at(path)!.versions.map((version) => [version.n, version.hash])
    const before = { pdf: versions(pdf), report: versions(report) }
    expect(before.report.length).toBe(2)

    const cited = Date.parse("2026-10-20T10:00:00Z")
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk, shown: [{ path: pdf, at: cited }, { path: report, at: cited }] })
    for (const reopened of [false, true]) {
      if (reopened) store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
      const listed = (await route("GET", "kuvo/artifacts?session=ses_code")).value.artifacts
      expect(listed.map((artifact: any) => [artifact.name, artifact.shown]).sort()).toEqual([["moon.pdf", cited / 1000], ["report.pdf", cited / 1000]])
      expect({ pdf: versions(pdf), report: versions(report) }).toEqual(before)
      expect((await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(report)}/versions/1`)).value).toBe("%PDF-1.4 first\n")
    }
  })

  test("a project's are found as the turn ends: outside git by a walk, in git as git status lists them (not what it ignores)", async () => {
    recorder = record(store, { bots }).recorder
    session("ses_code", project)
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_code" } }])
    writeFileSync(join(project, "out.txt"), "made\n")
    await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_code" } }])
    expect((await route("GET", "kuvo/artifacts?session=ses_code")).value.artifacts.map((artifact: any) => artifact.name)).toEqual(["out.txt"])

    const repo = join(root, "repo")
    mkdirSync(repo)
    spawnSync("git", ["init", "-q", repo])
    writeFileSync(join(repo, ".gitignore"), "dist/\n")
    // Made before the turn: not its.
    utimesSync(join(repo, ".gitignore"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    session("ses_repo", repo)
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_repo" } }])
    mkdirSync(join(repo, "dist"))
    writeFileSync(join(repo, "dist", "bundle.js"), "x")
    writeFileSync(join(repo, "summary.md"), "# Summary\n")
    await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_repo" } }])
    const names = (await route("GET", "kuvo/artifacts?session=ses_repo")).value.artifacts.map((artifact: any) => artifact.name)
    expect(names).toEqual(["summary.md"])
  })

  test("in a Mac's home folder, the app's caches and logs that change meanwhile aren't the agent's", async () => {
    recorder = record(store, { bots }).recorder
    const home = join(root, "home")
    const caches = join(home, "Library", "Caches", "run.kuvo.code")
    const logs = join(home, "Library", "Logs", "Kuvo Code")
    mkdirSync(caches, { recursive: true })
    mkdirSync(logs, { recursive: true })
    const was = process.env.KUVO_OWN_FOLDERS
    const preferences = join(home, "Library", "Preferences", "run.kuvo.code.plist")
    mkdirSync(dirname(preferences), { recursive: true })
    process.env.KUVO_OWN_FOLDERS = JSON.stringify([caches, logs, preferences])
    try {
      session("ses_home", home)
      await hear([{ type: "session.execution.started", data: { sessionID: "ses_home" } }])
      writeFileSync(join(caches, "sessions.json"), "{}")
      writeFileSync(join(logs, "usage.log"), "line\n")
      writeFileSync(preferences, "plist")
      writeFileSync(join(home, "notes.txt"), "made\n")
      await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_home" } }])
      expect((await route("GET", "kuvo/artifacts?session=ses_home")).value.artifacts.map((artifact: any) => artifact.name)).toEqual(["notes.txt"])
    } finally {
      if (was === undefined) delete process.env.KUVO_OWN_FOLDERS
      else process.env.KUVO_OWN_FOLDERS = was
    }
  })

  test("in the home folder, what Kuvo Code keeps there (a file you sent with the message) isn't the agent's", async () => {
    recorder = record(store, { bots }).recorder
    const home = join(root, "home")
    const box = join(home, ".kuvo-code")
    mkdirSync(join(box, "agents"), { recursive: true })
    const was = { home: process.env.KUVO_HOME, agents: process.env.KUVO_AGENTS_HOME }
    process.env.KUVO_HOME = box
    process.env.KUVO_AGENTS_HOME = join(box, "agents")
    try {
      session("ses_home", home)
      await hear([{ type: "session.execution.started", data: { sessionID: "ses_home" } }])
      mkdirSync(join(box, "attachments", "a1"), { recursive: true })
      writeFileSync(join(box, "attachments", "a1", "photo.png"), "png")
      writeFileSync(join(home, "notes.txt"), "made\n")
      await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_home" } }])
      expect((await route("GET", "kuvo/artifacts?session=ses_home")).value.artifacts.map((artifact: any) => artifact.name)).toEqual(["notes.txt"])
    } finally {
      for (const [name, value] of [["KUVO_HOME", was.home], ["KUVO_AGENTS_HOME", was.agents]] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

describe("what the agent's browser downloads", () => {
  /** As the box's browser tells the record, once a download is done. */
  async function note(body: unknown) {
    const response = await notedRoute((session, path, via) => recorder.noted([source], session, path, via), "POST", async () => body)
    return { status: response.status, value: await response.json() }
  }

  test("is the bot's, in the turn it was downloaded in, as a download on its shelf", async () => {
    bot("bot_ada", "m\n")
    const downloads = join(root, "browser", "downloads")
    mkdirSync(downloads, { recursive: true })
    const invoice = join(downloads, "invoice.pdf")
    writeFileSync(invoice, "%PDF-1.4 invoice")
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_bot_ada" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_bot_ada", inboxID: "msg_1" } }])
    expect((await note({ path: invoice, session: "ses_bot_ada", via: "download" })).status).toBe(200)
    await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_bot_ada" } }])
    const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada&kind=download")
    expect(value.artifacts).toHaveLength(1)
    expect(value.artifacts[0]).toMatchObject({ name: "invoice.pdf", kind: "download", where: { bots: ["bot_ada"], sessions: ["ses_bot_ada"] } })
    expect(value.artifacts[0].latest).toMatchObject({ via: ["download"], turn: { session: "ses_bot_ada", message: "msg_1" }, by: { kind: "agent", bot: "bot_ada" } })
    expect((await route("GET", `kuvo/artifacts/${value.artifacts[0].id}/versions/1`)).value).toBe("%PDF-1.4 invoice")
  })

  test("cleared from the browser's folder after a week, it still opens from the record's copy, marked gone", async () => {
    bot("bot_ada", "m\n")
    const downloads = join(root, "browser", "downloads")
    mkdirSync(downloads, { recursive: true })
    const invoice = join(downloads, "invoice.pdf")
    writeFileSync(invoice, "%PDF-1.4 invoice")
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_bot_ada" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_bot_ada", inboxID: "msg_1" } }])
    await note({ path: invoice, session: "ses_bot_ada", via: "download" })
    await hear([{ type: "session.execution.succeeded", data: { sessionID: "ses_bot_ada" } }])
    // The weekly sweep: gone with no change heard.
    rmSync(downloads, { recursive: true })
    const id = ArtifactStore.idOf(invoice)
    const { value } = await route("GET", `kuvo/artifacts/${id}`)
    expect(typeof value.gone).toBe("number")
    expect(value.versions.map((version: any) => [version.n, version.status, version.kept])).toEqual([[1, "added", true]])
    expect((await route("GET", `kuvo/artifacts/${id}/versions/1`)).value).toBe("%PDF-1.4 invoice")
    expect((await route("GET", "kuvo/artifacts?bot=bot_ada&kind=download")).value.artifacts.map((artifact: any) => artifact.name)).toEqual(["invoice.pdf"])
    // Its one copy stays, cleared or not.
    await route("POST", "kuvo/artifacts/storage/clear", {})
    expect((await route("GET", `kuvo/artifacts/${id}/versions/1`)).value).toBe("%PDF-1.4 invoice")
    // Downloaded again, the same: there again, and no new version.
    mkdirSync(downloads, { recursive: true })
    writeFileSync(invoice, "%PDF-1.4 invoice")
    const again = (await route("GET", `kuvo/artifacts/${id}`)).value
    expect(again.gone).toBeNull()
    await store.change(invoice, { by: { kind: "outside" }, via: "outside" })
    expect((await route("GET", `kuvo/artifacts/${id}`)).value.versions).toHaveLength(1)
  })

  test("for a conversation this computer doesn't have, says so and records nothing", async () => {
    const file = join(root, "stray.zip")
    writeFileSync(file, "zip")
    const answer = await note({ path: file, session: "ses_nobody", via: "download" })
    expect(answer.status).toBe(404)
    expect(store.at(file)).toBeUndefined()
  })
})

describe("a coding session", () => {
  test("a report it writes and shows is listed for the session and its project, as a document that was shown", async () => {
    session("ses_code", project)
    const report = join(project, "report.md")
    writeFileSync(report, "# Report\n")
    await hear(turn("ses_code", "msg_1", [...tool("ses_code", "c1", "write", { filePath: report, content: "# Report\n" }), ...tool("ses_code", "c2", "kuvo-browser_show_file", { path: "report.md" })]))
    const { value } = await route("GET", "kuvo/artifacts?session=ses_code")
    expect(value.artifacts).toHaveLength(1)
    expect(value.artifacts[0]).toMatchObject({ name: "report.md", kind: "document", where: { project, sessions: ["ses_code"] } })
    expect(value.artifacts[0].latest.via).toEqual(["write", "show_file"])
    expect(typeof value.artifacts[0].shown).toBe("number")
    expect((await route("GET", `kuvo/artifacts?project=${encodeURIComponent(project)}`)).value.artifacts).toHaveLength(1)
  })

  test("a picture a tool made is an image, and a subagent's work is its parent's turn", async () => {
    session("ses_code", project)
    session("ses_child", project, { parentID: "ses_code" })
    const picture = join(project, "chart.png")
    writeFileSync(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_code" } }, { type: "session.inbox.delivered", data: { sessionID: "ses_code", inboxID: "msg_1" } }])
    await hear(tool("ses_child", "c1", "generate_image", { prompt: "a chart" }, { content: [{ type: "file", uri: pathToFileURL(picture).href, mime: "image/png" }] }))
    const { value } = await route("GET", "kuvo/artifacts?session=ses_code")
    expect(value.artifacts[0]).toMatchObject({ name: "chart.png", kind: "image", type: "image/png" })
    expect(value.artifacts[0].latest).toMatchObject({ by: { session: "ses_child" }, turn: { session: "ses_code", message: "msg_1" } })
  })

  test("the engine's conversation run for one of this bridge's isn't recorded twice", async () => {
    session("ses_hidden", project, { metadata: { kuvo: { engineFor: "ses_bridge" } } })
    const file = join(project, "a.txt")
    writeFileSync(file, "a\n")
    await hear(turn("ses_hidden", "msg_1", tool("ses_hidden", "c1", "write", { filePath: file, content: "a\n" })))
    expect((await route("GET", `kuvo/artifacts?project=${encodeURIComponent(project)}`)).value.artifacts).toEqual([])
  })

  test("a file the bot marks final is pinned, first in its list", async () => {
    bot("bot_ada", "m\n")
    const workspace = join(bots, "bot_ada", "workspace")
    for (const name of ["final.pdf", "draft.md"]) writeFileSync(join(workspace, name), name)
    await hear(turn("ses_bot_ada", "msg_1", [...tool("ses_bot_ada", "c1", "write", { filePath: join(workspace, "final.pdf") }), ...tool("ses_bot_ada", "c2", "mark_final", { path: "final.pdf", note: "For Friday" })]))
    await hear(turn("ses_bot_ada", "msg_2", tool("ses_bot_ada", "c3", "write", { filePath: join(workspace, "draft.md") })))
    const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada")
    expect(value.artifacts.map((artifact: any) => artifact.name)).toEqual(["final.pdf", "draft.md"])
    expect(value.artifacts[0].pinned).toMatchObject({ by: "bot", note: "For Friday" })
    // You can take it off.
    expect((await route("POST", `kuvo/artifacts/${value.artifacts[0].id}/pin`, { pinned: false })).value.pinned).toBeNull()
  })
})

describe("a group chat", () => {
  test("its bots' files are listed for the chat, each by its bot, with a hand-off marked", async () => {
    bot("bot_ada", "a\n")
    bot("bot_ben", "b\n")
    const shared = join(project, "plan.md")
    writeFileSync(shared, "Plan\n")
    session("ses_seat_ada", project, { metadata: { kuvo: { seat: { group: "grp_team", bot: "bot_ada" } } } })
    session("ses_seat_ben", project, { metadata: { kuvo: { seat: { group: "grp_team", bot: "bot_ben" } } } })
    await hear(turn("ses_seat_ada", "msg_1", tool("ses_seat_ada", "c1", "write", { filePath: shared })))
    await hear(turn("ses_seat_ben", "msg_2", edit("ses_seat_ben", "c2", shared, "Plan\nBen's part\n")))
    const { value } = await route("GET", "kuvo/artifacts?group=grp_team")
    expect(value.artifacts).toHaveLength(1)
    const { value: plan } = await route("GET", `kuvo/artifacts/${value.artifacts[0].id}`)
    expect(plan.versions.map((version: any) => [version.by.bot, version.group?.id, version.trigger, version.handoff?.from ?? null])).toEqual([
      ["bot_ada", "grp_team", "group", null],
      ["bot_ben", "grp_team", "group", "bot_ada"],
    ])
    // On both bots' shelves; a seat is the chat's, not a conversation of its own.
    expect(plan.where).toMatchObject({ bots: ["bot_ada", "bot_ben"], sessions: [], groups: ["grp_team"] })
    // Its Timeline: each version, newest first, by its bot.
    const { value: timeline } = await route("GET", "kuvo/artifacts/timeline?group=grp_team")
    expect(timeline.entries.map((entry: any) => [entry.artifact.name, entry.version.n, entry.version.by.bot])).toEqual([
      ["plan.md", 2, "bot_ben"],
      ["plan.md", 1, "bot_ada"],
    ])
    // One bot's, asked of the box (so a long chat's earlier versions count too).
    expect((await route("GET", "kuvo/artifacts/timeline?group=grp_team&by=bot_ada")).value.entries.map((entry: any) => entry.version.by.bot)).toEqual(["bot_ada"])
    // A bot's own Timeline has only what it made.
    expect((await route("GET", "kuvo/artifacts/timeline?bot=bot_ada")).value.entries.map((entry: any) => entry.version.n)).toEqual([1])
  })
})

describe("a group chat's parts", () => {
  test("what a bot makes in its own conversation for its part of a chat is the chat's too, but its other work isn't", async () => {
    const folder = bot("bot_ada", "a\n")
    const workspace = join(folder, "workspace")
    writeFileSync(join(workspace, "launch.md"), "Launch\n")
    writeFileSync(join(workspace, "notes.md"), "Notes\n")
    // The chat's wrap-up gives Ada her part, by the message that starts it.
    recorder.given("msg_part", "grp_team")
    await hear(turn("ses_bot_ada", "msg_part", tool("ses_bot_ada", "c1", "write", { filePath: join(workspace, "launch.md") })))
    await hear(turn("ses_bot_ada", "msg_own", tool("ses_bot_ada", "c2", "write", { filePath: join(workspace, "notes.md") })))
    const { value } = await route("GET", "kuvo/artifacts/timeline?group=grp_team")
    expect(value.entries.map((entry: any) => [entry.artifact.name, entry.version.by.bot, entry.version.trigger])).toEqual([["launch.md", "bot_ada", "group"]])
    // Both are on her Shelf, in her own conversation.
    const { value: shelf } = await route("GET", "kuvo/artifacts?bot=bot_ada")
    expect(shelf.artifacts.map((artifact: any) => artifact.name).sort()).toEqual(["launch.md", "notes.md"])
    expect(shelf.artifacts.every((artifact: any) => artifact.where.sessions.includes("ses_bot_ada"))).toBe(true)
  })
})

describe("keeping versions", () => {
  test("versions and their copies are there after the box starts again", async () => {
    session("ses_code", project)
    const file = join(project, "notes.md")
    writeFileSync(file, "first\n")
    await hear(turn("ses_code", "m1", tool("ses_code", "c1", "write", { filePath: file })))
    writeFileSync(file, "second\n")
    await hear(turn("ses_code", "m2", tool("ses_code", "c2", "write", { filePath: file })))
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    expect(value.versions.map((version: any) => version.n)).toEqual([1, 2])
    expect((await route("GET", `kuvo/artifacts/${value.id}/versions/1`)).value).toBe("first\n")
  })

  test("past the budget for older versions the oldest go, still listed; the newest and memory stay", async () => {
    // Older versions: "draft one" and "draft two", 10 bytes each, over a budget of 15.
    store = new ArtifactStore(join(root, "artifacts"), { bots, budget: 15, disk: () => disk })
    recorder = new Recorder(store, { bots })
    const folder = bot("bot_ada", "memory one, long enough\n")
    session("ses_code", project)
    const file = join(project, "draft.txt")
    const memory = join(folder, "MEMORY.md")
    for (const [n, text] of ["draft one\n", "draft two\n", "draft three\n"].entries()) {
      writeFileSync(file, text)
      await hear(turn("ses_code", `m${n}`, tool("ses_code", `c${n}`, "write", { filePath: file })))
    }
    await hear(turn("ses_bot_ada", "mb", edit("ses_bot_ada", "cb", memory, "memory two, long enough\n")))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    expect(value.versions.map((version: any) => [version.kept, version.reason ?? null])).toEqual([[false, "cleared"], [true, null], [true, null]])
    const gone = await route("GET", `kuvo/artifacts/${value.id}/versions/1`)
    expect(gone).toEqual({ status: 410, value: { message: "That version is no longer kept." } })
    const { value: kept } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(memory)}`)
    expect(kept.versions.every((version: any) => version.kept)).toBe(true)
  })

  test("what you keep keeps every version past the budget; once you stop keeping it, they go as the next version passes it", async () => {
    // Two drafts, three versions each (10 bytes a version), over a budget of 15 for older ones.
    store = new ArtifactStore(join(root, "artifacts"), { bots, budget: 15, disk: () => disk })
    recorder = new Recorder(store, { bots })
    session("ses_code", project)
    const kept = join(project, "kept.txt")
    const other = join(project, "other.txt")
    writeFileSync(kept, "keep one!\n")
    await hear(turn("ses_code", "m0", tool("ses_code", "c0", "write", { filePath: kept })))
    expect((await route("POST", `kuvo/artifacts/${ArtifactStore.idOf(kept)}/pin`, { pinned: true })).value.pinned).toMatchObject({ by: "you" })
    for (const [n, text] of ["keep two!\n", "keep 3!!!\n"].entries()) {
      writeFileSync(kept, text)
      await hear(turn("ses_code", `mk${n}`, tool("ses_code", `ck${n}`, "write", { filePath: kept })))
    }
    for (const [n, text] of ["other one\n", "other two\n", "other 3!!\n"].entries()) {
      writeFileSync(other, text)
      await hear(turn("ses_code", `mo${n}`, tool("ses_code", `co${n}`, "write", { filePath: other })))
    }
    const kepts = async (file: string) => (await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)).value.versions.map((version: any) => version.kept)
    expect(await kepts(kept)).toEqual([true, true, true])
    expect(await kepts(other)).toEqual([false, true, true])
    expect((await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(kept)}/versions/1`)).value).toBe("keep one!\n")

    // Kept no more: past the budget again, its older versions are the oldest to go.
    await route("POST", `kuvo/artifacts/${ArtifactStore.idOf(kept)}/pin`, { pinned: false })
    writeFileSync(other, "other 4!!\n")
    await hear(turn("ses_code", "mo3", tool("ses_code", "co3", "write", { filePath: other })))
    expect(await kepts(kept)).toEqual([false, false, true])
  })

  test("what you keep is still kept after the box starts again", async () => {
    session("ses_code", project)
    const file = join(project, "plan.md")
    writeFileSync(file, "plan\n")
    await hear(turn("ses_code", "m1", tool("ses_code", "c1", "write", { filePath: file })))
    await route("POST", `kuvo/artifacts/${ArtifactStore.idOf(file)}/pin`, { pinned: true, note: "The one we ship" })
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    expect(value.pinned).toMatchObject({ by: "you", note: "The one we ship" })
  })

  test("a deleted file stays listed as gone, with what it was", async () => {
    session("ses_code", project)
    const file = join(project, "old.md")
    writeFileSync(file, "old\n")
    await hear(turn("ses_code", "m1", tool("ses_code", "c1", "write", { filePath: file })))
    unlinkSync(file)
    await hear(turn("ses_code", "m2", tool("ses_code", "c2", "edit", { filePath: file }, { metadata: { files: [{ file, patch: "@@ -1 +0,0 @@\n-old\n", status: "deleted" }] } })))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    expect(typeof value.gone).toBe("number")
    expect(value.versions.map((version: any) => version.status)).toEqual(["added", "deleted"])
    expect((await route("GET", `kuvo/artifacts/${value.id}/versions/1`)).value).toBe("old\n")
  })
})

describe("what the record keeps a copy of", () => {
  test("a likely secret is listed but never copied nor shown, not even what changed", async () => {
    session("ses_code", project)
    const secret = join(project, ".env")
    writeFileSync(secret, "TOKEN=one\n")
    await hear(turn("ses_code", "m1", tool("ses_code", "c1", "write", { filePath: secret })))
    writeFileSync(secret, "TOKEN=two\n")
    await hear(turn("ses_code", "m2", tool("ses_code", "c2", "write", { filePath: secret })))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(secret)}`)
    expect(value.versions.map((version: any) => [version.n, version.kept, version.reason])).toEqual([[1, false, "secret"], [2, false, "secret"]])
    expect(JSON.stringify(value)).not.toContain("TOKEN")
    expect((await route("GET", `kuvo/artifacts/${value.id}/versions/2`)).status).toBe(410)
    const changes = await route("GET", `kuvo/artifacts/${value.id}/versions/2/changes`)
    expect(changes.status).toBe(410)
    expect(JSON.stringify(changes.value)).not.toContain("TOKEN")
    // Nothing of it in the record's folder.
    const copies = spawnSync("grep", ["-rl", "TOKEN", join(root, "artifacts")]).stdout.toString()
    expect(copies).toBe("")
  })

  test("a file its name doesn't tell the kind of is served as text only when it is; a Pages document is served as one", async () => {
    session("ses_code", project)
    const weights = join(project, "model.pt"), notes = join(project, "notes.rst"), pages = join(project, "Plan.pages")
    writeFileSync(weights, Buffer.from([0x80, 0x02, 0x00, 0x7d, 0x00, 0xff]))
    writeFileSync(notes, "Title\n=====\n")
    writeFileSync(pages, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))
    await hear(turn("ses_code", "m1", [...tool("ses_code", "c1", "write", { filePath: weights }), ...tool("ses_code", "c2", "write", { filePath: notes }), ...tool("ses_code", "c3", "write", { filePath: pages })]))
    const read = async (path: string) => (await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(path)}`)).value
    expect([(await read(weights)).type, (await read(notes)).type, (await read(pages)).type]).toEqual(["application/octet-stream", "text/plain", "application/vnd.apple.pages"])
    // Its bytes aren't shown as lines of text.
    expect((await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(weights)}/versions/1/changes`)).value.style).toBe("none")
    expect((await read(weights)).versions[0].lines).toBeUndefined()
  })

  test("in a git project, code keeps only its change (git has the rest); a document there gets copies; what git ignores gets none", async () => {
    spawnSync("git", ["init", "-q", project])
    writeFileSync(join(project, ".gitignore"), "build/\n")
    session("ses_code", project)
    const code = join(project, "app.ts")
    writeFileSync(code, "let a = 1\n")
    await hear(turn("ses_code", "m1", edit("ses_code", "c1", code, "let a = 2\n")))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(code)}`)
    expect(value.versions.map((version: any) => [version.n, version.kept, version.reason])).toEqual([[1, false, "git"]])
    const { value: changes } = await route("GET", `kuvo/artifacts/${value.id}/versions/1/changes`)
    expect(changes).toMatchObject({ style: "lines", added: 1, removed: 1 })
    expect(changes.patch).toContain("+let a = 2")
    // Pinned: a copy of it as it is now.
    await route("POST", `kuvo/artifacts/${value.id}/pin`, { pinned: true })
    expect((await route("GET", `kuvo/artifacts/${value.id}/versions/1`)).value).toBe("let a = 2\n")

    const report = join(project, "report.md")
    writeFileSync(report, "# Report\n")
    mkdirSync(join(project, "build"))
    const built = join(project, "build", "out.txt")
    writeFileSync(built, "built\n")
    await hear(turn("ses_code", "m2", [...tool("ses_code", "c2", "write", { filePath: report }), ...tool("ses_code", "c3", "write", { filePath: built })]))
    expect((await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(report)}/versions/1`)).value).toBe("# Report\n")
    const { value: ignored } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(built)}`)
    expect(ignored.versions[0]).toMatchObject({ kept: false, reason: "ignored" })
    expect((await route("GET", `kuvo/artifacts/${ignored.id}/versions/1`)).status).toBe(410)
  })

  test("what git ignores, or won't say of (a file beyond a symbolic link), keeps no copy; the rest of the same turn's files do", async () => {
    spawnSync("git", ["init", "-q", project])
    writeFileSync(join(project, ".gitignore"), "*.log\n")
    mkdirSync(join(root, "elsewhere"))
    symlinkSync(join(root, "elsewhere"), join(project, "linked"))
    const log = join(project, "run.log")
    const linked = join(project, "linked", "notes.md")
    const plain = join(project, "notes.md")
    for (const file of [log, linked, plain]) writeFileSync(file, "SECRET-ish\n")
    await store.changeAll([log, linked, plain], { by: { kind: "agent" }, via: "shell", where: { project } })
    const version = async (path: string) => (await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(path)}`)).value.versions[0]
    expect(await version(log)).toMatchObject({ kept: false, reason: "ignored" })
    expect((await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(log)}/versions/1`)).status).toBe(410)
    expect(await version(linked)).toMatchObject({ kept: false, reason: "ignored" })
    expect(await version(plain)).toMatchObject({ kept: true })
  })

  test("in a repository git won't read, nothing keeps a copy: what it ignores can't be told", async () => {
    writeFileSync(join(project, ".git"), "not a repository\n")
    const notes = join(project, "notes.md")
    writeFileSync(notes, "maybe ignored\n")
    await store.change(notes, { by: { kind: "agent" }, via: "write", where: { project } })
    expect((await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(notes)}`)).value.versions[0]).toMatchObject({ kept: false, reason: "ignored" })
  })

  test("with the disk down to its floor, what a new version replaces keeps no copy, but the newest, memory and what's pinned keep theirs", async () => {
    const folder = bot("bot_ada", "one\n")
    session("ses_code", project)
    const draft = join(project, "draft.txt")
    writeFileSync(draft, "first\n")
    await hear(turn("ses_code", "m1", tool("ses_code", "c1", "write", { filePath: draft })))
    disk = { free: 5 * 1024 ** 3, total: 245 * 1024 ** 3 }
    writeFileSync(draft, "second\n")
    await hear(turn("ses_code", "m2", tool("ses_code", "c2", "write", { filePath: draft })))
    await hear(turn("ses_bot_ada", "mb", edit("ses_bot_ada", "cb", join(folder, "MEMORY.md"), "two\n")))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(draft)}`)
    expect(value.versions.map((version: any) => [version.kept, version.reason ?? null])).toEqual([[false, "low-disk"], [true, null]])
    const { value: memory } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(join(folder, "MEMORY.md"))}`)
    expect(memory.versions.every((version: any) => version.kept)).toBe(true)
    expect((await route("GET", "kuvo/artifacts/storage")).value).toMatchObject({ low: true })
  })

  test("your budget for older versions is kept, and older ones past it go at once", async () => {
    session("ses_code", project)
    const draft = join(project, "draft.txt")
    for (const [n, text] of ["one\n", "two\n"].entries()) {
      writeFileSync(draft, text)
      await hear(turn("ses_code", `m${n}`, tool("ses_code", `c${n}`, "write", { filePath: draft })))
    }
    expect((await route("POST", "kuvo/artifacts/storage", { budget: 0 })).value).toMatchObject({ budget: 0, older: 0 })
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
    expect((await route("GET", "kuvo/artifacts/storage")).value.budget).toBe(0)
    expect((await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(draft)}`)).value.versions.map((version: any) => version.kept)).toEqual([false, true])
  })
})

describe("what can go wrong on disk", () => {
  test("a file that can't be read for a moment isn't taken as deleted", async () => {
    session("ses_code", project)
    const file = join(project, "locked.md")
    writeFileSync(file, "a\n")
    await hear(turn("ses_code", "m1", tool("ses_code", "c1", "write", { filePath: file })))
    chmodSync(file, 0o000)
    try {
      await hear(turn("ses_code", "m2", tool("ses_code", "c2", "write", { filePath: file })))
    } finally {
      chmodSync(file, 0o644)
    }
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    expect(value.gone).toBeNull()
    expect(value.versions.map((version: any) => version.status)).toEqual(["added"])
  })

  test("a long log is written again whole, and everything's there after the next start", async () => {
    session("ses_code", project)
    const file = join(project, "busy.md")
    for (let n = 0; n < 400; n++) {
      writeFileSync(file, `line ${n}\n`)
      // Shown again and again: a line each, for what's only one artifact.
      await hear(turn("ses_code", `m${n}`, [...tool("ses_code", `c${n}`, "write", { filePath: file }), ...tool("ses_code", `s${n}`, "show_file", { path: file })]))
    }
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
    expect(readdirSync(join(root, "artifacts", "log"))).toEqual(["0000-00.jsonl"])
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk })
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    expect(value.versions.length).toBe(400)
    expect((await route("GET", `kuvo/artifacts/${value.id}/versions/400`)).value).toBe("line 399\n")
  })
})

describe("restoring a version", () => {
  test("only in a bot's folder or the project it was made in", async () => {
    session("ses_chat", join(root, "elsewhere"))
    mkdirSync(join(root, "elsewhere"))
    const file = join(root, "outside.md")
    for (const [n, text] of ["one\n", "two\n"].entries()) {
      writeFileSync(file, text)
      await hear(turn("ses_chat", `m${n}`, tool("ses_chat", `c${n}`, "write", { filePath: file })))
    }
    // It says so, so a client doesn't offer it.
    expect((await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)).value.restorable).toBe(false)
    const { status } = await route("POST", `kuvo/artifacts/${ArtifactStore.idOf(file)}/restore`, { version: 1 })
    expect(status).toBe(409)
    expect(readFileSync(file, "utf8")).toBe("two\n")
  })

  test("puts it back as a version by you, keeping what it replaced so it can be undone", async () => {
    session("ses_code", project)
    const notes = join(project, "notes.md")
    for (const [n, text] of ["first\n", "second\n"].entries()) {
      writeFileSync(notes, text)
      await hear(turn("ses_code", `m${n}`, tool("ses_code", `c${n}`, "write", { filePath: notes })))
    }
    // You changed it since, outside any turn.
    writeFileSync(notes, "mine\n")
    const id = ArtifactStore.idOf(notes)
    expect((await route("GET", `kuvo/artifacts/${id}`)).value.restorable).toBe(true)
    const { status, value } = await route("POST", `kuvo/artifacts/${id}/restore`, { version: 1 })
    expect(status).toBe(200)
    expect(readFileSync(notes, "utf8")).toBe("first\n")
    expect(value.versions.map((version: any) => [version.n, version.by.kind, version.via, version.restored ?? null])).toEqual([
      [1, "agent", ["write"], null],
      [2, "agent", ["write"], null],
      [3, "you", ["replaced"], null],
      [4, "you", ["restore"], 1],
    ])
    // Undone: what it replaced, back.
    await route("POST", `kuvo/artifacts/${id}/restore`, { version: 3 })
    expect(readFileSync(notes, "utf8")).toBe("mine\n")
  })

  test("never through a file someone left by the name it's put back through, which would give it another name", async () => {
    session("ses_code", project)
    const notes = join(project, "notes.md")
    for (const [n, text] of ["first\n", "second\n"].entries()) {
      writeFileSync(notes, text)
      await hear(turn("ses_code", `m${n}`, tool("ses_code", `c${n}`, "write", { filePath: notes })))
    }
    // A command's own file, linked by that name.
    const planted = join(project, "planted.txt")
    writeFileSync(planted, "planted\n")
    linkSync(planted, notes + ".kuvo-restore")
    const { status } = await route("POST", `kuvo/artifacts/${ArtifactStore.idOf(notes)}/restore`, { version: 1 })
    expect(status).toBe(200)
    expect(readFileSync(notes, "utf8")).toBe("first\n")
    expect(readFileSync(planted, "utf8")).toBe("planted\n")
    expect(statSync(notes).nlink).toBe(1)
  })
})

describe("pages kept up to date", () => {
  test("a document two wake-ups rewrote is a living page", async () => {
    const folder = bot("bot_ada", "m\n")
    const daily = join(folder, "workspace", "daily.md")
    for (const n of [1, 2]) {
      writeFileSync(daily, `Day ${n}\n`)
      await hear([
        { type: "session.inbox.enqueued", data: { sessionID: "ses_bot_ada", inboxID: `msg_wake${n}`, item: { type: "user", payload: { text: "[Wake-up] Write the daily summary" } } } },
        ...turn("ses_bot_ada", `msg_wake${n}`, tool("ses_bot_ada", `c${n}`, "write", { filePath: daily })),
      ])
    }
    const { value } = await route("GET", "kuvo/artifacts?bot=bot_ada")
    expect(value.artifacts[0]).toMatchObject({ name: "daily.md", kind: "document", living: true })
    expect(value.artifacts[0].latest.trigger).toBe("wake")
  })
})

describe("as events really come", () => {
  test("a turn's end and the next turn's start in one burst: the next turn keeps its message and its versions", async () => {
    session("ses_code", project)
    const file = join(project, "notes.md")
    writeFileSync(file, "one\n")
    // Heard as the feed hands them on: each without waiting for the one before.
    const burst = [...turn("ses_code", "msg_1", tool("ses_code", "c1", "write", { filePath: file }))]
    const second: Event[] = [
      { type: "session.execution.started", data: { sessionID: "ses_code" } },
      { type: "session.inbox.delivered", data: { sessionID: "ses_code", inboxID: "msg_2" } },
      { type: "session.tool.input.started", data: { sessionID: "ses_code", assistantMessageID: "msg_b", id: "c2", name: "write" } },
      { type: "session.tool.called", data: { sessionID: "ses_code", assistantMessageID: "msg_b", id: "c2", input: { filePath: file } } },
    ]
    let last: Promise<void> = Promise.resolve()
    for (const event of [...burst, ...second]) last = recorder.heard(source, event)
    await last
    writeFileSync(file, "one\ntwo\n")
    await recorder.heard(source, { type: "session.tool.success", data: { sessionID: "ses_code", assistantMessageID: "msg_b", id: "c2", content: [], metadata: {} } })
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    expect(value.versions.map((version: any) => [version.n, version.turn?.message ?? null, version.via])).toEqual([[1, "msg_1", ["write"]], [2, "msg_2", ["write"]]])
  })

  test("a picture an agent only looked at isn't something it made", async () => {
    session("ses_code", project)
    const picture = join(project, "screenshot.png")
    writeFileSync(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]))
    await hear(turn("ses_code", "m1", tool("ses_code", "c1", "read", { path: picture }, { content: [{ type: "file", uri: pathToFileURL(picture).href, mime: "image/png" }] })))
    expect((await route("GET", "kuvo/artifacts?session=ses_code")).value.artifacts).toEqual([])
  })

  test("no 'before' is made up from a file that changed again since the edit", async () => {
    session("ses_code", project)
    const file = join(project, "list.md")
    writeFileSync(file, "one\n")
    // Two edits in one step, both on disk before the first is heard.
    const first = edit("ses_code", "c1", file, "one\ntwo\n")
    const second = edit("ses_code", "c2", file, "one\ntwo\nthree\n")
    await hear(turn("ses_code", "m1", [...first, ...second]))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    for (const version of value.versions.filter((each: any) => each.before)) {
      const text = (await route("GET", `kuvo/artifacts/${value.id}/versions/0`)).value
      expect(["", "one\n"]).toContain(text)
    }
  })

  test("a file made and then edited in one turn is new in that turn's version", async () => {
    session("ses_code", project)
    const file = join(project, "plan.md")
    writeFileSync(file, "a\n")
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_code" } }, ...tool("ses_code", "c1", "write", { filePath: file })])
    await hear(edit("ses_code", "c2", file, "a\nb\n"))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(file)}`)
    expect(value.versions.filter((each: any) => !each.before).map((version: any) => [version.status, version.edits])).toEqual([["added", 2]])
  })

  test("in a git project, a turn's several edits to code all show in its changes", async () => {
    spawnSync("git", ["init", "-q", project])
    session("ses_code", project)
    const code = join(project, "app.ts")
    writeFileSync(code, "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n")
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_code" } }])
    await hear(edit("ses_code", "c1", code, "A\nb\nc\nd\ne\nf\ng\nh\ni\nj\n"))
    await hear(edit("ses_code", "c2", code, "A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n"))
    const { value } = await route("GET", `kuvo/artifacts/${ArtifactStore.idOf(code)}/versions/1/changes`)
    expect(value.patch).toContain("+A")
    expect(value.patch).toContain("+J")
    expect([value.added, value.removed]).toEqual([2, 2])
  })

  test("paging through a list made in one moment misses nothing and repeats nothing", async () => {
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk, now: () => new Date("2026-10-26T09:00:00.000Z") })
    recorder = new Recorder(store, { bots, now: () => new Date("2026-10-26T09:00:00.000Z") })
    session("ses_code", project)
    const names = Array.from({ length: 7 }, (_, i) => `f${i}.md`)
    await hear([{ type: "session.execution.started", data: { sessionID: "ses_code" } }])
    for (const [i, name] of names.entries()) {
      writeFileSync(join(project, name), name)
      await hear(tool("ses_code", `c${i}`, "write", { filePath: join(project, name) }))
    }
    const seen: string[] = []
    let before: string | null = null
    do {
      const query: string = `kuvo/artifacts?session=ses_code&limit=3${before ? `&before=${encodeURIComponent(before)}` : ""}`
      const { value } = await route("GET", query)
      seen.push(...value.artifacts.map((artifact: any) => artifact.name))
      before = value.next
    } while (before)
    expect(seen.sort()).toEqual(names)
  })
})

describe("the routes", () => {
  test("a list says whose, and a followed list sends a line now and one on each change", async () => {
    expect((await route("GET", "kuvo/artifacts")).status).toBe(400)
    expect((await route("GET", "kuvo/artifacts?bot=a&group=b")).status).toBe(400)
    session("ses_code", project)
    const controller = new AbortController()
    const response = await artifactRoutes(store, "GET", ["events"], new URLSearchParams("session=ses_code"), async () => ({}), controller.signal)
    const reader = response.body!.getReader()
    const line = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value))
    expect((await line()).artifacts).toEqual([])
    const file = join(project, "a.md")
    writeFileSync(file, "a\n")
    await hear(turn("ses_code", "m1", tool("ses_code", "c1", "write", { filePath: file })))
    expect((await line()).artifacts.map((artifact: any) => artifact.name)).toEqual(["a.md"])
    controller.abort()
  })

  test("what you keep in a conversation's followed list goes to the top, marked yours, as you keep it, and back in its place as you stop", async () => {
    session("ses_code", project)
    // A minute apart, so which is newer is never a tie.
    let minute = 0
    const now = () => new Date(Date.UTC(2026, 9, 26, 9, minute))
    store = new ArtifactStore(join(root, "artifacts"), { bots, disk: () => disk, now })
    recorder = new Recorder(store, { bots, now })
    for (const [n, name] of ["older.png", "newer.pdf"].entries()) {
      minute = n
      const file = join(project, name)
      writeFileSync(file, name)
      await hear(turn("ses_code", `m${n}`, tool("ses_code", `c${n}`, "write", { filePath: file })))
    }
    const controller = new AbortController()
    const response = await artifactRoutes(store, "GET", ["events"], new URLSearchParams("session=ses_code"), async () => ({}), controller.signal)
    const reader = response.body!.getReader()
    const line = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value)).artifacts.map((artifact: any) => [artifact.name, artifact.pinned?.by ?? null])
    expect(await line()).toEqual([["newer.pdf", null], ["older.png", null]])
    const older = ArtifactStore.idOf(join(project, "older.png"))
    await route("POST", `kuvo/artifacts/${older}/pin`, { pinned: true })
    expect(await line()).toEqual([["older.png", "you"], ["newer.pdf", null]])
    await route("POST", `kuvo/artifacts/${older}/pin`, { pinned: false })
    expect(await line()).toEqual([["newer.pdf", null], ["older.png", null]])
    controller.abort()
  })
})
