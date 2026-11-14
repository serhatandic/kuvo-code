import "./safety"
import { afterAll, beforeEach, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { ask, follow } from "./route-answer"

// What a conversation waits on you for (PROTOCOL.md, "A conversation's asks"): every client draws
// the cards from the box's words alone, and answers through it, to the session that asked (a
// subagent's too). Only the engine is a stand-in, keeping each session's asks as the engine does.

const { engineHandler } = await import("../src/link/server/router")
const { forgetAsks, noteAskEvent } = await import("../src/link/glance/asked")

const home = process.env.HOME!
const work = join(process.env.KUVO_HOME!, "asks-work")
mkdirSync(work, { recursive: true })

// The engine: its sessions, each one's permissions and forms, a subagent's messages, and what it
// was asked to do, each time.
let sessions: Record<string, any>, permissions: Record<string, any[]>, forms: Record<string, any[]>, messages: Record<string, any[]>
let got: { method: string; path: string; body: any }[], refusing: Set<string>
beforeEach(() => {
  forgetAsks()
  got = []
  refusing = new Set()
  sessions = {
    ses_root: { id: "ses_root", location: { directory: work }, time: { created: 1, updated: 1 } },
    ses_child: { id: "ses_child", parentID: "ses_root", location: { directory: work }, time: { created: 2, updated: 2 } },
  }
  permissions = {
    ses_root: [
      { id: "per_edit", sessionID: "ses_root", action: "edit", resources: [`${work}/src/App.swift`, `${work}/b.swift`, `${work}/c.swift`], save: ["*"],
        metadata: { files: [{ file: `${work}/src/App.swift`, patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" }] } },
      { id: "per_out", sessionID: "ses_root", action: "external_directory", resources: [`${home}/notes/*`] },
    ],
    ses_child: [
      { id: "per_push", sessionID: "ses_child", action: "shell", resources: ["git push origin main"], save: ["git push *"], source: { type: "tool", messageID: "msg_1", id: "call_1" }, message: "It wants to push." },
    ],
  }
  forms = {
    ses_root: [
      { id: "que_1", sessionID: "ses_root", title: "Pick", metadata: { kind: "question" }, fields: [
        { key: "color", type: "string", title: "Color", description: "Which color?", required: true, options: [{ value: "blue", label: "Blue", description: "Calm" }, { value: "red", label: "Red" }] },
        { key: "extras", type: "multiselect", title: "Extras", options: [{ value: "docs", label: "Docs" }], custom: true },
        { key: "kept", type: "string", hidden: true, default: "as before" },
      ] },
      { id: "frm_mcp", sessionID: "ses_root", title: "GitHub", metadata: { kind: "mcp-elicitation", server: "github", message: "Pick a repository." }, fields: [{ key: "repo", type: "number" }] },
    ],
  }
  messages = { ses_child: [{ id: "msg_1", type: "assistant", content: [{ type: "tool", id: "call_1", name: "shell", state: { status: "running", input: { command: "cd app && git push origin main" } } }] }] }
})

const engine = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" ? undefined : await request.json().catch(() => undefined)
    got.push({ method: request.method, path: url.pathname, body })
    const reply = (value: unknown, status = 200) => Response.json(value, { status })
    if (url.pathname === "/api/session") {
      const parent = url.searchParams.get("parentID")
      return reply({ data: Object.values(sessions).filter(each => (each.parentID ?? "null") === parent) })
    }
    const [, id, kind, ask, step] = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?)?$/) ?? []
    if (id === "ses_broken") return reply({ message: "Busy." }, 500)
    if (!id || !sessions[id]) return reply({ message: "No such session." }, 404)
    if (!kind) return reply({ data: sessions[id] })
    if (kind === "message") return reply({ data: messages[id] ?? [] })
    const list = kind === "permission" ? permissions : kind === "form" ? forms : null
    if (!list) return reply({ message: "Not here." }, 404)
    if (!ask) return reply({ data: list[id] ?? [] })
    if (!(list[id] ?? []).some(each => each.id === ask)) return reply({ message: "Not asked." }, 404)
    if (refusing.has(ask)) return reply({ message: "It can't take that now." }, 400)
    if ((step === "reply" && request.method === "POST") || (!step && request.method === "DELETE")) {
      list[id] = list[id]!.filter(each => each.id !== ask)
      return reply({ data: true })
    }
    return reply({ message: "Not here." }, 404)
  },
})
const target = { port: engine.port, password: "pw" } as any
const handler = engineHandler(() => target, { name: "test" }, () => { throw new Error("none") })
afterAll(() => {
  engine.stop(true)
  forgetAsks()
})

const asked = (path: string) => got.filter(each => each.method !== "GET" && each.path === path)

test("a conversation's asks, its subagents' too, come worded as the cards show them, oldest first", async () => {
  // When each came, as the box heard them (one it didn't hear came before: first).
  noteAskEvent({ type: "form.created", data: { form: { id: "que_1", sessionID: "ses_root" } } }, "engine", 1_000)
  noteAskEvent({ type: "permission.asked", data: { id: "per_push", sessionID: "ses_child" } }, "engine", 2_000)
  noteAskEvent({ type: "permission.asked", data: { id: "per_edit", sessionID: "ses_root" } }, "engine", 3_000)
  noteAskEvent({ type: "form.created", data: { form: { id: "frm_mcp", sessionID: "ses_root" } } }, "engine", 4_000)
  const { status, json } = await ask(handler, "GET", "kuvo/sessions/ses_root/asks")
  expect(status).toBe(200)
  expect(json.asks.map((each: any) => each.id)).toEqual(["per_out", "que_1", "per_push", "per_edit", "frm_mcp"])
  const [out, question, push, edit, other] = json.asks
  expect(edit).toEqual({
    id: "per_edit", kind: "permission", session: "ses_root", title: "Allow editing src/App.swift and 2 more?", message: null, command: null,
    files: [{ file: `${work}/src/App.swift`, patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, status: "modified" }],
    resources: ["src/App.swift", "b.swift", "c.swift"],
    choices: [
      { answer: "once", title: "Allow Once", named: null, placeholder: null },
      { answer: "always", title: "Always Allow Edits", named: null, placeholder: null },
      { answer: "reject", title: "Don’t Allow", named: null, placeholder: null },
      { answer: "instead", title: "Tell It What to Do Instead…", named: null, placeholder: "Tell it what to do instead…" },
    ],
  })
  // A subagent's, in its own name, with the whole command line its tool call runs.
  expect(push).toMatchObject({ session: "ses_child", title: "Allow running this command?", message: "It wants to push.", command: "cd app && git push origin main", resources: ["git push origin main"] })
  expect(push.choices[1]).toEqual({ answer: "always", title: "Always Allow", named: "git push", placeholder: null })
  // A folder outside, as people know it.
  expect(out).toMatchObject({ title: "Allow working outside the project?", resources: ["~/notes"] })
  expect(out.choices[1]).toMatchObject({ title: "Always Allow", named: "~/notes" })
  expect(question).toEqual({ id: "que_1", kind: "question", session: "ses_root", title: "Pick", questions: [
    { key: "color", title: "Color", question: "Which color?", options: [{ value: "blue", label: "Blue", description: "Calm" }, { value: "red", label: "Red", description: null }], multiple: false, custom: false, required: true },
    { key: "extras", title: "Extras", question: "Extras", options: [{ value: "docs", label: "Docs", description: null }], multiple: true, custom: true, required: false },
  ] })
  expect(other).toEqual({ id: "frm_mcp", kind: "other", session: "ses_root", title: "GitHub", message: "Pick a repository.", dismiss: true })
})

test("an answer goes to the session that asked, as the engine takes it", async () => {
  // Tell It What to Do Instead: Don't Allow, with your words.
  expect((await ask(handler, "POST", "kuvo/sessions/ses_root/asks/per_push", { answer: "instead", message: " Push a branch instead. " })).status).toBe(200)
  expect(asked("/api/session/ses_child/permission/per_push/reply")).toEqual([{ method: "POST", path: "/api/session/ses_child/permission/per_push/reply", body: { decision: "reject", message: "Push a branch instead." } }])
  expect((await ask(handler, "POST", "kuvo/sessions/ses_root/asks/per_edit", { answer: "always" })).status).toBe(200)
  expect(asked("/api/session/ses_root/permission/per_edit/reply")[0]!.body).toEqual({ decision: "always" })
  // Answered: it isn't waiting any more, and isn't listed.
  expect((await ask(handler, "POST", "kuvo/sessions/ses_root/asks/per_edit", { answer: "once" })).status).toBe(404)
  expect((await ask(handler, "GET", "kuvo/sessions/ses_root/asks")).json.asks.map((each: any) => each.id)).not.toContain("per_edit")
  // Instead without words, or an answer it hasn't: refused, nothing sent.
  expect((await ask(handler, "POST", "kuvo/sessions/ses_root/asks/per_out", { answer: "instead", message: "  " })).status).toBe(400)
  expect((await ask(handler, "POST", "kuvo/sessions/ses_root/asks/per_out", { answer: "maybe" })).status).toBe(400)
  expect(asked("/api/session/ses_root/permission/per_out/reply")).toEqual([])
})

test("a question's answers are checked against what it asks, and go with what wasn't asked", async () => {
  const send = (body: unknown) => ask(handler, "POST", "kuvo/sessions/ses_root/asks/que_1", body)
  // A required one missing, a choice it doesn't offer, a key it doesn't ask: refused.
  expect((await send({ answers: { extras: ["docs"] } })).json.message).toContain("Color")
  expect((await send({ answers: { color: "green" } })).status).toBe(400)
  expect((await send({ answers: { color: "blue", size: "big" } })).status).toBe(400)
  expect(asked("/api/session/ses_root/form/que_1/reply")).toEqual([])
  // Words of its own where it takes them; the hidden field's default with them.
  expect((await send({ answers: { color: "blue", extras: ["docs", "tests"] } })).status).toBe(200)
  expect(asked("/api/session/ses_root/form/que_1/reply")[0]!.body).toEqual({ answer: { kept: "as before", color: "blue", extras: ["docs", "tests"] } })
})

test("a form a client can't answer is dismissed from it, never answered", async () => {
  expect((await ask(handler, "POST", "kuvo/sessions/ses_root/asks/frm_mcp", { answers: { repo: 1 } })).status).toBe(400)
  expect((await ask(handler, "POST", "kuvo/sessions/ses_root/asks/frm_mcp", { dismiss: true })).status).toBe(200)
  expect(asked("/api/session/ses_root/form/frm_mcp")).toEqual([{ method: "DELETE", path: "/api/session/ses_root/form/frm_mcp", body: undefined }])
})

test("what the box asks you for a subagent shows with its asks, answered on the Mac or a phone", async () => {
  const { ask: askVault } = await import("../src/link/vault/asks")
  const stop = new AbortController()
  const answered = askVault({ kind: "use", session: "ses_child", itemName: "GitHub token", why: "To open the pull request." }, stop.signal)
  try {
    const { status, json } = await ask(handler, "GET", "kuvo/sessions/ses_root/asks")
    expect(status).toBe(200)
    const vault = json.asks.find((each: any) => each.session === "ses_child" && each.kind === "other")
    expect(vault).toMatchObject({ kind: "other", title: "Allow it to use the vault?", message: "GitHub token\nTo open the pull request.", dismiss: false })
    // Neither answered nor put away from here.
    const refused = await ask(handler, "POST", `kuvo/sessions/ses_root/asks/${vault.id}`, { dismiss: true })
    expect(refused.status).toBe(400)
    expect(refused.json.message).toContain("Mac or a phone")
  } finally {
    stop.abort()
    await answered
  }
})

test("one the engine refuses says why; no such conversation, or one whose place doesn't answer, says so", async () => {
  refusing.add("per_out")
  const refused = await ask(handler, "POST", "kuvo/sessions/ses_root/asks/per_out", { answer: "once" })
  expect(refused).toEqual({ status: 502, json: { message: "It can't take that now." } })
  expect((await ask(handler, "GET", "kuvo/sessions/ses_none/asks")).status).toBe(404)
  expect((await ask(handler, "GET", "kuvo/sessions/ses_broken/asks")).status).toBe(503)
  const nowhere = engineHandler(() => { throw new Error("none") }, { name: "test" }, () => { throw new Error("none") })
  expect((await ask(nowhere, "GET", "kuvo/sessions/ses_root/asks")).status).toBe(503)
})

test("followed, the asks come again as one comes or is answered", async () => {
  const stream = follow(handler, "kuvo/sessions/ses_root/asks/events")
  try {
    expect((await stream.next()).asks.map((each: any) => each.id)).toEqual(["per_edit", "per_out", "que_1", "frm_mcp", "per_push"])
    // A subagent asks: the box's long-running process hears it, and every follower reads again.
    permissions.ses_child!.push({ id: "per_read", sessionID: "ses_child", action: "read", resources: [`${work}/secrets.txt`] })
    noteAskEvent({ type: "permission.asked", data: { id: "per_read", sessionID: "ses_child" } }, "engine")
    const now = (await stream.next()).asks
    expect(now.at(-1)).toMatchObject({ id: "per_read", title: "Allow reading secrets.txt?", resources: ["secrets.txt"] })
    // Answered on another client: gone.
    permissions.ses_child = permissions.ses_child!.filter(each => each.id !== "per_read")
    noteAskEvent({ type: "permission.replied", data: { requestID: "per_read", sessionID: "ses_child" } }, "engine")
    expect((await stream.next()).asks.map((each: any) => each.id)).not.toContain("per_read")
  } finally {
    stream.stop()
  }
})
