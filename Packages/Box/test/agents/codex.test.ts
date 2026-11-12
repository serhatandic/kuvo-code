// Codex's thread against a fake `codex app-server`: what Codex 0.16x sends, shown, not lost.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, watch } from "node:fs"
import { createHash } from "node:crypto"
import { createServer } from "node:net"
import { CodexAgent, codexTiming } from "../../src/agents/agents/codex"
import { Auto } from "../../src/agents/auto"
import { canFence, realFence } from "./support/fence"
import { callServer, computerServers, KEYS } from "./support/servers"
import { subagentEngine } from "./support/subagents"
import { fencePolicy } from "../../src/link/fence/policy"
import type { Roster } from "../../src/agents/roster"
import { Sessions, timing } from "../../src/agents/sessions"
import { Store } from "../../src/agents/store"
import type { Message, PermissionRule } from "../../src/agents/wire"

// By its real place (`/var` is `/private/var` on a Mac): the fake Codex knows the session's own by its folder.
const base = realpathSync(mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-codex-test-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** In a turn's events: Codex works on until you press Stop. */
const untilStopped: [string, any] = ["(works until stopped)", {}]
/** In a turn's events: a summary Codex is asked for after it goes on until it's stopped. */
const summaryUntilStopped: [string, any] = ["(its summary works until stopped)", {}]
/** In a turn's events: Codex (and so what it runs) writes or reads each place (`name: ["write" | "read", path]`; `["replace", path, temp]`
 * saves it whole through `temp`, `["hardlink", path, other]` names it `other` too), and says which it could. */
const tries = "(tries)"
/** In a turn's events: Codex sleeps, for hours, until new input comes for the turn (one that came before the sleep doesn't count, as with the real one). */
const sleepsUntilTold: [string, any] = ["(sleeps until told)", {}]
/** In a turn's events: Codex sleeps (or goes on with the sleep it started as it turned one down) until it turns down something steered, then, a moment later, its sleep ends and another starts in the same breath, until told. */
const sleepsAgainOnceRefused: [string, any] = ["(sleeps, and again once it turns one down)", {}]
/** In a turn's events: Codex works until something's steered into its turn. */
const untilTold: [string, any] = ["(works until told)", {}]
/** In a turn's events: Codex turns down what's steered from here on, as a turn on its way out does. */
const refusesSteers: [string, any] = ["(refuses steers)", {}]
/** In a turn's events: Codex turns down the next thing steered, and takes what comes after it. */
const refusesNextSteer: [string, any] = ["(refuses the next steer)", {}]
/** In a turn's events: Codex turns down the next thing steered, and says a sleep's started in the same breath. */
const refusesAsItSleeps: [string, any] = ["(refuses as it starts to sleep)", {}]
/** In a turn's events: Codex takes what's steered, and says its turn is over in the same breath. */
const endsAsTold: [string, any] = ["(ends as told)", {}]
/** In a turn's events: Codex leaves `command` running in a background terminal, until a file `terminal-done` is in its folder. */
const leavesTerminal = (command: string): [string, any] => ["(leaves a terminal)", { processId: "p1", command }]

/**
 * A Codex whose turn sends `events` (each `[method, params]`, with the thread's id filled in): an
 * ask of Codex's (an approval) waits for its answer before the turn goes on. Turns after the first
 * send `later`, when given. What Kuvo Code sends it is kept in order (`sent`).
 */
function fakeCodex(folder: string, events: [string, any][], later?: [string, any][]): string {
  const script = join(folder, "app-server.js")
  writeFileSync(
    script,
    `const first = ${JSON.stringify(events)}
const later = ${JSON.stringify(later ?? null)}
const { appendFileSync } = require("node:fs")
let buffer = ""
let asked = 0
let turns = 0
const answered = new Map()
let stopped
let input = []
let steers = 0
let wake
let asleep
let sleeps = 0
let refusing = false
let refusingNext = false
let refusingAsItSleeps = false
let sleptInBreath
let refusedOne
let turning = false
let endsAsTold = false
let summaryWorks = false
let summarizing = false
let terminals = []
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
// Its thread: "t1", but for a Codex of a session elsewhere (one of its own).
const thread = process.cwd() === ${JSON.stringify(folder)} ? "t1" : "t-" + process.pid
const inTurn = (params) => ({ threadId: thread, turnId: "u1", ...params })
async function turn() {
  const events = turns++ && later ? later : first
  send({ method: "turn/started", params: { threadId: thread, turn: { id: "u1" } } })
  for (const [method, params] of events) {
    if (method === ${JSON.stringify(untilStopped[0])}) return new Promise((resolve) => (stopped = resolve))
    if (method === ${JSON.stringify(summaryUntilStopped[0])}) {
      summaryWorks = true
      continue
    }
    if (method === "(leaves a terminal)") {
      terminals.push({ ...params, itemId: "c-" + params.processId, cwd: process.cwd() })
      continue
    }
    if (method === ${JSON.stringify(endsAsTold[0])}) {
      endsAsTold = true
      return
    }
    if (method === ${JSON.stringify(refusesSteers[0])}) {
      refusing = true
      continue
    }
    if (method === ${JSON.stringify(refusesNextSteer[0])}) {
      refusingNext = true
      continue
    }
    if (method === ${JSON.stringify(refusesAsItSleeps[0])}) {
      refusingAsItSleeps = true
      continue
    }
    if (method === ${JSON.stringify(untilTold[0])}) {
      if (!steers) await new Promise((resolve) => (wake = resolve))
      steers = 0
      continue
    }
    if (method === ${JSON.stringify(sleepsUntilTold[0])}) {
      const sleep = sleptInBreath ?? { type: "sleep", id: "sleep" + ++sleeps, durationMs: 43200000 }
      if (!sleptInBreath) send({ method: "item/started", params: inTurn({ item: sleep }) })
      sleptInBreath = undefined
      await new Promise((resolve) => (asleep = resolve))
      send({ method: "item/completed", params: inTurn({ item: sleep }) })
      continue
    }
    if (method === ${JSON.stringify(sleepsAgainOnceRefused[0])}) {
      // (Or the one it said had started in the same breath it turned something down.)
      const first = sleptInBreath ?? { type: "sleep", id: "sleep" + ++sleeps, durationMs: 43200000 }
      if (!sleptInBreath) send({ method: "item/started", params: inTurn({ item: first }) })
      sleptInBreath = undefined
      await new Promise((resolve) => (refusedOne = resolve))
      // (A moment later: what it turned down has been heard by then.)
      await new Promise((resolve) => setTimeout(resolve, 100))
      const next = { type: "sleep", id: "sleep" + ++sleeps, durationMs: 43200000 }
      process.stdout.write(JSON.stringify({ method: "item/completed", params: inTurn({ item: first }) }) + "\\n" + JSON.stringify({ method: "item/started", params: inTurn({ item: next }) }) + "\\n")
      await new Promise((resolve) => (asleep = resolve))
      send({ method: "item/completed", params: inTurn({ item: next }) })
      continue
    }
    if (method === ${JSON.stringify(tries)}) {
      const done = []
      for (const [name, [how, named, through]] of Object.entries(params)) {
        // "(attached)": the picture the turn was given.
        const place = named === "(attached)" ? input.find((item) => item.type === "localImage")?.path : named
        if (how === "connect") {
          // (By a short name, from its folder: a socket's whole path can be too long.)
          const here = process.cwd()
          process.chdir(require("node:path").dirname(place))
          const socket = require("node:net").createConnection(require("node:path").basename(place))
          process.chdir(here)
          done.push(name + "=" + (await new Promise((resolve) => {
            socket.on("connect", () => (socket.destroy(), resolve("yes")))
            socket.on("error", () => resolve("no"))
          })))
          continue
        }
        done.push((() => { try {
          if (how === "write") require("node:fs").writeFileSync(place, "x")
          // Saved whole, as Codex saves its sign-in: a new file (\`through\`), renamed onto it.
          else if (how === "replace") require("node:fs").writeFileSync(through, "x"), require("node:fs").renameSync(through, place)
          // Another name for it (\`through\`), a hard link.
          else if (how === "hardlink") require("node:fs").linkSync(place, through)
          else require("node:fs").readFileSync(place)
          return name + "=yes"
        } catch {
          return name + "=no"
        } })())
      }
      send({ method: "item/completed", params: inTurn({ item: { type: "agentMessage", id: "m1", text: done.join(" ") } }) })
      continue
    }
    if (!/requestApproval$|elicitation\\/request$|requestUserInput$/.test(method)) {
      send({ method, params: inTurn(params) })
      continue
    }
    const id = "ask-" + ++asked
    send({ id, method, params: inTurn(params) })
    await new Promise((resolve) => answered.set(id, resolve))
  }
  turning = false
  send({ method: "turn/completed", params: { threadId: thread, turn: { id: "u1", status: "completed" } } })
}
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    // (Where it runs: its session's folder, in the box's sandbox.)
    appendFileSync(require("node:path").join(process.cwd(), "sent.jsonl"), line + "\\n")
    const message = JSON.parse(line)
    if (message.method === undefined) answered.get(message.id)?.()
    // (A Codex that doesn't know your subagents' settings, as the test says: it turns them away.)
    else if (message.method === "thread/start" && process.env.KUVO_TEST_CODEX_REFUSES_AGENTS && Object.keys(message.params.config ?? {}).some((key) => key.startsWith("agents."))) send({ id: message.id, error: { code: -32600, message: "unknown field agents" } })
    else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: thread } } })
    else if (message.method === "thread/compact/start") {
      // As Codex 0.166 does: its answer says nothing, and a turn of its own does it.
      send({ id: message.id, result: {} })
      send({ method: "turn/started", params: { threadId: thread, turn: { id: "c1" } } })
      send({ method: "item/started", params: { threadId: thread, turnId: "c1", item: { type: "contextCompaction", id: "cc1" } } })
      if (summaryWorks) {
        summarizing = true
        continue
      }
      send({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId: "c1", tokenUsage: { last: { totalTokens: 16476, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }, total: { totalTokens: 16476 }, modelContextWindow: 272000 } } })
      send({ method: "item/completed", params: { threadId: thread, turnId: "c1", item: { type: "contextCompaction", id: "cc1" } } })
      send({ method: "turn/completed", params: { threadId: thread, turn: { id: "c1", status: "completed" } } })
    } else if (message.method === "turn/start") {
      input = message.params.input ?? []
      turning = true
      steers = 0
      send({ id: message.id, result: { turn: { id: "u1", status: "inProgress" } } })
      void turn()
    } else if (message.method === "turn/steer") {
      if (endsAsTold) {
        endsAsTold = turning = false
        process.stdout.write(JSON.stringify({ id: message.id, result: { turnId: "u1" } }) + "\\n" + JSON.stringify({ method: "turn/completed", params: { threadId: thread, turn: { id: "u1", status: "completed" } } }) + "\\n")
        continue
      }
      if (refusingAsItSleeps) {
        refusingAsItSleeps = false
        sleptInBreath = { type: "sleep", id: "sleep" + ++sleeps, durationMs: 43200000 }
        process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32600, message: "not now" } }) + "\\n" + JSON.stringify({ method: "item/started", params: inTurn({ item: sleptInBreath }) }) + "\\n")
        steers++
        wake?.()
        wake = undefined
        continue
      }
      const refused = !turning || refusing || refusingNext
      refusingNext = false
      if (refused) {
        send({ id: message.id, error: { code: -32600, message: "no active turn to steer" } })
        refusedOne?.()
        refusedOne = undefined
      } else {
        send({ id: message.id, result: { turnId: "u1" } })
        // (As the real one does, as it takes it.)
        send({ method: "item/started", params: inTurn({ item: { type: "userMessage", id: "steer" + steers, content: message.params.input } }) })
        asleep?.()
        asleep = undefined
      }
      steers++
      wake?.()
      wake = undefined
    } else if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} })
      turning = false
      send({ method: "turn/completed", params: { threadId: "t1", turn: { id: summarizing ? "c1" : "u1", status: "interrupted" } } })
      stopped?.()
    } else if (message.method === "thread/backgroundTerminals/list") {
      // (It can't say, while a file "lists-fail" is there.)
      if (require("node:fs").existsSync(require("node:path").join(process.cwd(), "lists-fail"))) {
        send({ id: message.id, error: { code: -32603, message: "busy" } })
        continue
      }
      if (require("node:fs").existsSync(require("node:path").join(process.cwd(), "terminal-done"))) terminals = []
      send({ id: message.id, result: { data: terminals } })
    } else if (message.method === "thread/backgroundTerminals/clean") {
      terminals = []
      send({ id: message.id, result: {} })
    } else if (message.method === "model/list") {
      // (Those it hides from its picker only when asked for, as the real one lists them.)
      const hidden = message.params?.includeHidden === true ? [{ id: "gpt-mini", model: "gpt-mini", displayName: "GPT Mini", hidden: true }] : []
      send({ id: message.id, result: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", isDefault: true }, ...hidden] } })
    }
    else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
  )
  const launcher = join(folder, "codex")
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(folder, "argv.txt")}"\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

/** What the fake Codex was started with. */
const argv = () => readFileSync(join(root, "argv.txt"), "utf8").trim().split("\n")

/** The messages a fake Codex has written whole to its `sent.jsonl` in `folder`: one it's still writing waits. */
const sentIn = (folder: string): any[] => {
  const text = readFileSync(join(folder, "sent.jsonl"), "utf8")
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line))
}
/** What Kuvo Code sent the fake Codex, in order. */
const sent = (): any[] => sentIn(root)
/** Its answers to Codex's asks, in order. */
const answers = () => sent().filter((message) => String(message.id).startsWith("ask-")).map((message) => message.result)
/** What the turn was started with. */
const turnStart = () => sent().find((message) => message.method === "turn/start").params

class TestCodex extends CodexAgent {
  constructor(
    readonly launcher: string,
    home: string,
    account?: { id: string; home: string },
    /** Your own Codex's folder, which an added account's links to. */
    readonly yours?: string,
  ) {
    super({ home, temporary: home, deps: {} as any }, account)
  }
  override get yourCodex() {
    return this.yours ?? super.yourCodex
  }
  override executable() {
    return this.launcher
  }
  override async account() {
    return { installed: true, signedIn: true }
  }
}

let root: string
let codex: TestCodex | undefined
let sessions: Sessions

beforeEach(() => {
  root = mkdtempSync(join(base, "case-"))
})

afterEach(() => {
  sessions?.closeAll()
  codex?.shutdown()
})

async function until(condition: () => boolean, ms = 10_000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

/** Once `file` is there, as its folder says it changed: no clock, so as slow as the Mac is. */
function made(file: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dirname(file), () => there())
    const there = () => {
      if (!existsSync(file)) return
      watcher.close()
      resolve()
    }
    there()
  })
}

/** A session on a Codex whose turn sends `events`, with your message sent: Codex at work on it. */
function start(events: [string, any][], session: { agent?: string; permissions?: PermissionRule[] } = {}, later?: [string, any][]) {
  codex = new TestCodex(fakeCodex(root, events, later), root)
  const agent = codex
  sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
  // (Titled: no title is asked of this Codex.)
  const id = sessions.create({ title: "Codex", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root }, ...session }).id
  sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
  return id
}

const ended = (id: string) => sessions.messages(id).some((message) => message.type === "idle")

async function run(events: [string, any][], session: { agent?: string; permissions?: PermissionRule[] } = {}) {
  const id = start(events, session)
  await until(() => ended(id))
  return id
}

const steps = (id: string) => sessions.messages(id).filter((message: any) => message.type === "assistant") as any[]
const tools = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "assistant" ? message.content.filter((content: any) => content.type === "tool") : []))
const notices = (id: string) => sessions.messages(id).flatMap((message: Message) => (message.type === "synthetic" ? [(message as { text: string }).text] : []))

/** The session's Ask First (the composer's): edits, commands and fetches wait for your OK. */
const askFirst: PermissionRule[] = ["edit", "write", "patch", "shell", "webfetch", "external_directory"].map((action) => ({ action, resource: "*", effect: "ask" }))

/** A command Codex runs, as it tells one (in your login shell). */
const command = (id: string, line: string, more: Record<string, unknown> = {}) => ({ type: "commandExecution", id, command: `/bin/zsh -lc '${line}'`, cwd: root, status: "inProgress", ...more })

describe("Commands Codex leaves running in a background terminal (#262)", () => {
  /** With its idle close and the lists' while short, for a test. */
  async function quickly(body: () => Promise<void>) {
    const idleClose = timing.idleClose
    const every = codexTiming.terminals
    timing.idleClose = 50
    codexTiming.terminals = 20
    try {
      await body()
    } finally {
      timing.idleClose = idleClose
      codexTiming.terminals = every
    }
  }
  const lists = () => sent().filter((message) => message.method === "thread/backgroundTerminals/list").length

  test("they keep its Codex running past its idle close, shown as still at work, until they end; it isn't woken for that, as in Codex's own CLI", () =>
    quickly(async () => {
      const id = await run([leavesTerminal("npm run dev"), ["item/completed", { item: { type: "agentMessage", id: "m1", text: "Started the server." } }]])
      await until(() => (sessions.background()[id]?.tasks.length ?? 0) === 1)
      // (Listed again every 20 ms: its idle close, 50 ms after the turn, has come round meanwhile.)
      const now = lists()
      await until(() => lists() >= now + 6)
      expect(sent().some((message) => message.method === "thread/unsubscribe")).toBe(false)
      writeFileSync(join(root, "terminal-done"), "")
      await until(() => sent().some((message) => message.method === "thread/unsubscribe"))
      expect(sessions.background()[id]).toBeUndefined()
      expect(sent().filter((message) => message.method === "turn/start")).toHaveLength(1)
    }))

  test("a list that fails isn't taken for none: they're still kept, and listed again", () =>
    quickly(async () => {
      const id = await run([leavesTerminal("npm run dev")])
      await until(() => (sessions.background()[id]?.tasks.length ?? 0) === 1)
      writeFileSync(join(root, "lists-fail"), "")
      // (Three that fail, past its idle close: it gives up on them only after five in a row.)
      const now = lists()
      await until(() => lists() >= now + 3)
      expect(sessions.background()[id]?.tasks.length).toBe(1)
      expect(sent().some((message) => message.method === "thread/unsubscribe")).toBe(false)
      rmSync(join(root, "lists-fail"))
      writeFileSync(join(root, "terminal-done"), "")
      await until(() => sent().some((message) => message.method === "thread/unsubscribe"))
    }))

  test("Stop on what it left running ends them", () =>
    quickly(async () => {
      const id = await run([leavesTerminal("npm run dev")])
      await until(() => (sessions.background()[id]?.tasks.length ?? 0) === 1)
      await sessions.stopBackground(id)
      expect(sent().some((message) => message.method === "thread/backgroundTerminals/clean")).toBe(true)
      expect(sessions.background()[id]).toBeUndefined()
    }))
})

describe("Codex that won't start", () => {
  test("a Codex that turns down being started (an older or newer one) isn't left running, however often it's tried", async () => {
    const script = join(root, "refuses.js")
    writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(join(root, "pids.txt"))}, process.pid + "\\n")
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split("\\n").filter(Boolean)) {
    const message = JSON.parse(line)
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unknown method" } }) + "\\n")
  }
})
`)
    const launcher = join(root, "codex")
    writeFileSync(launcher, `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(launcher, 0o755)
    codex = new TestCodex(launcher, root)
    for (let attempt = 0; attempt < 2; attempt++) await expect(codex.rpc()).rejects.toThrow()
    const pids = readFileSync(join(root, "pids.txt"), "utf8").trim().split("\n").map(Number)
    expect(pids).toHaveLength(2)
    const running = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await until(() => !pids.some(running))
  })

  test("a Codex stopped while it's still starting isn't left running", async () => {
    const script = join(root, "never.js")
    const pidFile = join(root, "pid")
    // It starts, says so (its pid, whole: written aside, then named), and never answers being started.
    writeFileSync(script, `const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(pidFile + ".new")}, String(process.pid))
fs.renameSync(${JSON.stringify(pidFile + ".new")}, ${JSON.stringify(pidFile)})
process.stdin.on("end", () => process.exit(0))
process.stdin.resume()
`)
    const launcher = join(root, "codex")
    writeFileSync(launcher, `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(launcher, 0o755)
    const agent = (codex = new TestCodex(launcher, root))
    const starting = agent.rpc()
    starting.catch(() => {})
    await made(pidFile)
    const pid = Number(readFileSync(pidFile, "utf8"))
    // (As when the session it's for closes, or the bridge stops.)
    agent.shutdown()
    // Its start fails as it ends (long before the 30 s it's given to answer), and nothing of it runs.
    await expect(starting).rejects.toThrow()
    expect(() => process.kill(pid, 0)).toThrow()
  })

  test("one still starting outside the sandbox counts as outside it (agents keep off the vault) from its start until it stops", async () => {
    const go = join(root, "go")
    const script = join(root, "slow.js")
    writeFileSync(script, `const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(join(root, "started"))}, "")
// (Gone when its input ends, as Codex's app-server is: never outliving the tests.)
process.stdin.on("end", () => process.exit(0))
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split("\\n").filter(Boolean)) {
    const message = JSON.parse(line)
    // It answers being started only once it's told to.
    if (message.method === "initialize") {
      const answer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(go)})) return
        clearInterval(answer)
        process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n")
      }, 10)
    }
  }
})
`)
    const launcher = join(root, "codex")
    writeFileSync(launcher, `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
    chmodSync(launcher, 0o755)
    delete process.env.KUVO_FENCE
    const agent = (codex = new TestCodex(launcher, root))
    const starting = agent.rpc()
    await until(() => existsSync(join(root, "started")))
    expect(agent.outside()).toBe(true)
    writeFileSync(go, "")
    await starting
    expect(agent.outside()).toBe(true)
    agent.shutdown()
    await until(() => !agent.outside())
  })
})

describe("Codex, nothing dropped", () => {
  test("an image it made, one it looked at, a function's pictures, and an item kind the bridge doesn't know", async () => {
    const id = await run([
      ["item/completed", { item: { type: "imageGeneration", id: "g1", status: "completed", revisedPrompt: "an apple", savedPath: "/tmp/apple.png" } }],
      ["item/completed", { item: { type: "imageView", id: "v1", path: "/tmp/look.jpg" } }],
      ["item/completed", { item: { type: "functionCallOutput", id: "f1", name: "shot", namespace: "browser", output: [{ type: "input_text", text: "here" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] } }],
      ["item/completed", { item: { type: "hologram", id: "h1", output: "beamed" } }],
    ])
    const [made, viewed, called, unknown] = tools(id)
    expect(made).toMatchObject({ name: "generate_image", state: { status: "completed", content: [{ type: "text" }, { type: "file", mime: "image/png", uri: "file:///tmp/apple.png" }] } })
    expect(viewed).toMatchObject({ name: "read", state: { content: [{ type: "text" }, { type: "file", mime: "image/jpeg" }] } })
    expect(called).toMatchObject({ name: "browser.shot", state: { content: [{ type: "text", text: "here" }, { type: "file", uri: "data:image/png;base64,AAAA" }] } })
    expect(unknown).toMatchObject({ name: "hologram", state: { status: "completed", content: [{ type: "text", text: "beamed" }] } })
  })

  test("what Codex says for you to read, hooks, and an image it couldn't make", async () => {
    const id = await run([
      ["warning", { message: "Your config has an unknown key." }],
      ["model/rerouted", { fromModel: "gpt-a", toModel: "gpt-b", reason: "highRiskCyberActivity" }],
      ["hook/completed", { run: { id: "k1", eventName: "preToolUse", status: "blocked", entries: [{ kind: "stop", text: "Not on main." }] } }],
      ["item/completed", { item: { type: "imageGeneration", id: "g2", status: "failed", failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: 1900000000 } } }],
    ])
    expect(notices(id)).toEqual(["Your config has an unknown key.", "gpt-b answered instead of gpt-a (Codex moves security-sensitive work to it)."])
    const [hook, image] = tools(id)
    expect(hook).toMatchObject({ name: "hook", state: { status: "error" } })
    expect(JSON.stringify(hook.state)).toContain("Not on main.")
    expect(image.state.status).toBe("error")
    expect(JSON.stringify(image.state)).toContain("limit for making images")
  })

  test("a step whose start wasn't told still shows, with an MCP result's pictures and links", async () => {
    const id = await run([
      ["item/completed", { item: { type: "mcpToolCall", id: "m1", server: "kuvo-browser", tool: "browser_screenshot", arguments: {}, status: "completed", result: { content: [{ type: "image", data: "BBBB", mimeType: "image/png" }, { type: "resource_link", name: "Page", uri: "https://example.com" }] } } }],
      ["item/completed", { item: { type: "webSearch", id: "w1", query: "kuvo", action: { type: "openPage", url: "https://kuvo.run" } } }],
    ])
    const [shot, search] = tools(id)
    expect(shot).toMatchObject({ name: "kuvo-browser_browser_screenshot", state: { content: [{ type: "text", text: "Page: https://example.com" }, { type: "file", uri: "data:image/png;base64,BBBB" }] } })
    expect(search.state.content[0].text).toContain("Opened https://kuvo.run")
  })
})

describe("Codex's reply and its steps", () => {
  test("its thinking and words show once as they stream, a command with what it printed and how it ended, a change with each file's lines, and what it says after them as a step of its own", async () => {
    const sum = join(root, "src/sum.ts")
    const added = join(root, "test/sum.test.ts")
    // (Codex gives a new file's whole text, and an edit's unified diff.)
    const changes = [
      { path: sum, kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n export function sum(a: number, b: number) {\n-  return a - b\n+  return a + b\n }\n" },
      { path: added, kind: { type: "add" }, diff: 'import { sum } from "../../src/agents/sum"\n\nexpect(sum(1, 2)).toBe(3)\n' },
    ]
    const id = await run([
      ["item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Checking the tests first." }],
      ["item/completed", { item: { type: "reasoning", id: "r1", summary: ["Checking the tests first."], content: [] } }],
      ["item/agentMessage/delta", { itemId: "m1", delta: "Running " }],
      ["item/agentMessage/delta", { itemId: "m1", delta: "the tests." }],
      ["item/completed", { item: { type: "agentMessage", id: "m1", text: "Running the tests." } }],
      ["item/started", { item: command("c1", "npm test") }],
      ["item/commandExecution/outputDelta", { itemId: "c1", delta: "1 failing\n" }],
      ["item/completed", { item: command("c1", "npm test", { status: "failed", exitCode: 1, aggregatedOutput: "1 failing\n" }) }],
      ["item/started", { item: { type: "fileChange", id: "p1", status: "inProgress", changes } }],
      ["item/completed", { item: { type: "fileChange", id: "p1", status: "completed", changes } }],
      ["item/completed", { item: { type: "agentMessage", id: "m2", text: "Fixed: the tests pass." } }],
    ])
    const [working, after] = steps(id)
    expect(steps(id)).toHaveLength(2)
    expect(working.content.map((content: any) => [content.type, content.text ?? content.name])).toEqual([
      ["reasoning", "Checking the tests first."],
      ["text", "Running the tests."],
      ["tool", "shell"],
      ["tool", "patch"],
    ])
    const [ran, changed] = tools(id)
    expect(ran.state).toMatchObject({ status: "completed", input: { command: "npm test", cwd: root }, content: [{ type: "text", text: "1 failing\n" }], metadata: { output: "1 failing\n", exit: 1 } })
    expect(changed.state).toMatchObject({
      status: "completed",
      metadata: {
        files: [
          { file: sum, additions: 1, deletions: 1, status: "modified" },
          { file: added, additions: 3, deletions: 0, status: "added" },
        ],
      },
    })
    expect(changed.state.metadata.files[1].patch).toContain("+expect(sum(1, 2)).toBe(3)")
    expect(after.content).toEqual([{ type: "text", text: "Fixed: the tests pass." }])
  })
})

describe("Codex's file citations", () => {
  test("a file it cites as what it made shows as a file in the conversation, one it cites in its words as its path, and no directive shows raw, however its words come", async () => {
    const pdf = join(root, "output/pdf/moon.pdf")
    const id = await run([
      ["item/agentMessage/delta", { itemId: "m1", delta: "Created the field note: one page.\n\n:co" }],
      ["item/agentMessage/delta", { itemId: "m1", delta: `dex-file-citation{path="${pdf}" purp` }],
      ["item/agentMessage/delta", { itemId: "m1", delta: 'ose="output"}' }],
      ["item/completed", { item: { type: "agentMessage", id: "m1", text: `Created the field note: one page.\n\n:codex-file-citation{path="${pdf}" purpose="output"}` } }],
      ["item/started", { item: command("c1", "ls") }],
      ["item/completed", { item: command("c1", "ls", { status: "completed", exitCode: 0, aggregatedOutput: "" }) }],
      ["item/completed", { item: { type: "agentMessage", id: "m2", text: 'The review of :codex-file-citation{path="/w/review.pdf" purpose="source"} is due Friday. Time: 10:30.:codex-followup{text="More?"}\nA :codex-file-citation{path="unclosed is kept as words.\nThe rest stays.' } }],
    ])
    const content = steps(id).flatMap((step) => step.content)
    const words = content.filter((part: any) => part.type === "text").map((part: any) => part.text)
    expect(words.join("").replace(':codex-file-citation{path="unclosed', "")).not.toContain(":codex-")
    expect(words).toEqual(["Created the field note: one page.\n\n", "The review of `/w/review.pdf` is due Friday. Time: 10:30.\nA :codex-file-citation{path=\"unclosed is kept as words.\nThe rest stays."])
    const shown = tools(id).find((tool: any) => tool.name === "kuvo-browser_show_file")
    expect(shown?.state).toMatchObject({ status: "completed", input: { path: pdf } })
  })

  test("a reply kept from before its citations were read shows as one does now once the bridge starts again: the file it made shown, and no directive", () => {
    const pdf = join(root, "output/pdf/moon.pdf")
    const store = new Store(join(root, "sessions"))
    // Only to make it: Codex itself isn't asked anything.
    const first = new Sessions(store, { find: (id: string | undefined) => (id === "codex-cli" ? { providerID: "codex-cli" } : undefined) } as unknown as Roster, new Auto(root))
    const id = first.create({ title: "Codex", model: { providerID: "codex-cli", id: "gpt-test" }, location: { directory: root } }).id
    const words = `Created the field note: one page.\n\n:codex-file-citation{path="${pdf}" purpose="output"}\n\nIt follows :codex-file-citation{path="/w/notes.md" purpose="source"}.`
    const kept: Message = { type: "assistant", id: "msg_kept", time: { created: 1, completed: 2 }, agent: "build", model: { providerID: "codex-cli", id: "gpt-test" }, content: [{ type: "text", text: words }] }
    // Another agent's words quoting one (Auto went on with Claude): words, as they were.
    const quoted: Message = { type: "assistant", id: "msg_quoted", time: { created: 3, completed: 4 }, agent: "build", model: { providerID: "claude-code", id: "sonnet" }, content: [{ type: "text", text: words }] }
    store.get(id)!.messages.push(kept, quoted)
    store.save(id, true)
    first.closeAll()

    sessions = new Sessions(new Store(join(root, "sessions")), { find: () => undefined } as unknown as Roster, new Auto(root))
    const reply = sessions.messages(id).find((message) => message.id === "msg_kept") as any
    expect(reply.content.map((part: any) => (part.type === "text" ? part.text : `[${part.name} ${part.state.status} ${part.state.input.path}]`))).toEqual([
      "Created the field note: one page.\n\n",
      `[kuvo-browser_show_file completed ${pdf}]`,
      "\n\nIt follows `/w/notes.md`.",
    ])
    expect((sessions.messages(id).find((message) => message.id === "msg_quoted") as any).content).toEqual([{ type: "text", text: words }])
    expect(sessions.cited).toEqual([{ path: pdf, at: 2 }])
    // Kept as it reads now: read once, not again at the next start.
    expect(readFileSync(join(root, "sessions", id, "messages.json"), "utf8").split(":codex-").length).toBe(3)
    sessions.closeAll()
    sessions = new Sessions(new Store(join(root, "sessions")), { find: () => undefined } as unknown as Roster, new Auto(root))
    expect(sessions.cited).toEqual([])
  })
})

describe("What Codex asks you", () => {
  test("a command it asks to run waits for you on its step: Allow Once lets that one through and the next one asks again; No declines it", async () => {
    const id = start(
      [
        ["item/started", { item: command("c1", "npm test") }],
        ["item/commandExecution/requestApproval", { itemId: "c1", command: "/bin/zsh -lc 'npm test'", cwd: root, reason: "Runs the project's tests." }],
        ["item/completed", { item: command("c1", "npm test", { status: "completed", exitCode: 0, aggregatedOutput: "ok\n" }) }],
        ["item/started", { item: command("c2", "npm test") }],
        ["item/commandExecution/requestApproval", { itemId: "c2", command: "/bin/zsh -lc 'npm test'", cwd: root }],
        ["item/completed", { item: command("c2", "npm test", { status: "declined" }) }],
      ],
      { permissions: askFirst },
    )
    await until(() => sessions.permissions(id).length > 0)
    const [first] = sessions.permissions(id)
    expect(first).toMatchObject({ action: "shell", resources: ["npm test"], message: "Runs the project's tests.", source: { type: "tool", id: "c1" } })
    sessions.replyPermission(id, first.id, "once")
    await until(() => sessions.permissions(id).some((ask) => ask.id !== first.id))
    const [second] = sessions.permissions(id)
    expect(second).toMatchObject({ action: "shell", resources: ["npm test"], source: { id: "c2" } })
    sessions.replyPermission(id, second.id, "reject")
    await until(() => ended(id))
    expect(answers()).toEqual([{ decision: "accept" }, { decision: "decline" }])
    const [ran, declined] = tools(id)
    expect(ran.state).toMatchObject({ status: "completed", metadata: { output: "ok\n", exit: 0 } })
    expect(declined.state).toMatchObject({ status: "error", content: [{ type: "text", text: "Declined." }] })
  })

  test("Allow Always lets the same command through for the rest of the session without asking; another command still asks", async () => {
    const ask = (item: string, line: string): [string, any] => ["item/commandExecution/requestApproval", { itemId: item, command: `/bin/zsh -lc '${line}'`, cwd: root }]
    const id = start(
      [
        ["item/started", { item: command("c1", "npm test") }],
        ask("c1", "npm test"),
        ["item/completed", { item: command("c1", "npm test", { status: "completed", exitCode: 0 }) }],
        ["item/started", { item: command("c2", "npm test") }],
        ask("c2", "npm test"),
        ["item/completed", { item: command("c2", "npm test", { status: "completed", exitCode: 0 }) }],
        ["item/started", { item: command("c3", "rm -rf build") }],
        ask("c3", "rm -rf build"),
        ["item/completed", { item: command("c3", "rm -rf build", { status: "completed", exitCode: 0 }) }],
      ],
      { permissions: askFirst },
    )
    await until(() => sessions.permissions(id).length > 0)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
    await until(() => sessions.permissions(id).length > 0)
    const [other] = sessions.permissions(id)
    expect(other).toMatchObject({ action: "shell", resources: ["rm -rf build"], source: { id: "c3" } })
    sessions.replyPermission(id, other.id, "once")
    await until(() => ended(id))
    expect(answers()).toEqual([{ decision: "accept" }, { decision: "accept" }, { decision: "accept" }])
    expect(tools(id).map((tool: any) => tool.state.status)).toEqual(["completed", "completed", "completed"])
  })

  test("Allow Always on a change lets every later change in the session through, to other files too, without asking", async () => {
    const change = (file: string) => [{ path: join(root, file), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }]
    const id = start(
      [
        ["item/started", { item: { type: "fileChange", id: "p1", status: "inProgress", changes: change("src/a.ts") } }],
        ["item/fileChange/requestApproval", { itemId: "p1" }],
        ["item/completed", { item: { type: "fileChange", id: "p1", status: "completed", changes: change("src/a.ts") } }],
        ["item/started", { item: { type: "fileChange", id: "p2", status: "inProgress", changes: change("src/b.ts") } }],
        ["item/fileChange/requestApproval", { itemId: "p2" }],
        ["item/completed", { item: { type: "fileChange", id: "p2", status: "completed", changes: change("src/b.ts") } }],
      ],
      { permissions: askFirst },
    )
    await until(() => sessions.permissions(id).length > 0)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
    await until(() => ended(id))
    expect(answers()).toEqual([{ decision: "accept" }, { decision: "accept" }])
  })

  test("a change it asks to make shows its files and their lines on the card: Allow Once makes it, No declines the next", async () => {
    const sum = join(root, "src/sum.ts")
    const added = join(root, "test/sum.test.ts")
    const old = join(root, "src/old.ts")
    const edit = [
      { path: sum, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-  return a - b\n+  return a + b\n" },
      { path: added, kind: { type: "add" }, diff: "expect(sum(1, 2)).toBe(3)\n" },
    ]
    const removal = [{ path: old, kind: { type: "delete" }, diff: "export {}\n" }, { path: join(root, "src/moved.ts"), kind: { type: "update", move_path: "/elsewhere/LaunchAgents/x.plist" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }]
    const id = start(
      [
        ["item/started", { item: { type: "fileChange", id: "p1", status: "inProgress", changes: edit } }],
        ["item/fileChange/requestApproval", { itemId: "p1", reason: "Fixes sum." }],
        ["item/completed", { item: { type: "fileChange", id: "p1", status: "completed", changes: edit } }],
        ["item/started", { item: { type: "fileChange", id: "p2", status: "inProgress", changes: removal } }],
        ["item/fileChange/requestApproval", { itemId: "p2" }],
        ["item/completed", { item: { type: "fileChange", id: "p2", status: "declined", changes: removal } }],
      ],
      { permissions: askFirst },
    )
    await until(() => sessions.permissions(id).length > 0)
    const [first] = sessions.permissions(id)
    expect(first).toMatchObject({
      action: "edit",
      resources: [sum, added],
      message: "Fixes sum.",
      source: { type: "tool", id: "p1" },
      metadata: {
        files: [
          { file: sum, additions: 1, deletions: 1, status: "modified" },
          { file: added, additions: 1, deletions: 0, status: "added" },
        ],
      },
    })
    sessions.replyPermission(id, first.id, "once")
    await until(() => sessions.permissions(id).some((ask) => ask.id !== first.id))
    const [second] = sessions.permissions(id)
    // (A rename's new name is asked about too: it's written there.)
    expect(second).toMatchObject({ action: "edit", resources: [old, join(root, "src/moved.ts"), "/elsewhere/LaunchAgents/x.plist"], metadata: { files: [{ file: old, additions: 0, deletions: 1, status: "deleted" }, {}] } })
    sessions.replyPermission(id, second.id, "reject")
    await until(() => ended(id))
    expect(answers()).toEqual([{ decision: "accept" }, { decision: "decline" }])
    const [made, declined] = tools(id)
    expect(made.state.status).toBe("completed")
    expect(declined.state).toMatchObject({ status: "error", content: [{ type: "text", text: "Declined." }] })
  })
})

describe("A question Codex asks (request_user_input_async)", () => {
  // Codex 0.16x's question outside Plan: the tool says "accepted" at once and the turn goes on, or
  // ends; "any reply arrives asynchronously as a new user message".
  const asking: [string, any][] = [
    ["item/completed", { item: { type: "functionCall", id: "f1", name: "request_user_input_async", namespace: null, arguments: "{}" } }],
    ["item/completed", { item: { type: "agentMessage", id: "m1", text: "Which language should the README use?", delivery: "async", questions: [{ title: "Which language should the README use?", options: ["English", "Turkish"] }] } }],
  ]
  const answered: [string, any][] = [["item/completed", { item: { type: "agentMessage", id: "m2", text: "Writing it in Turkish." } }]]
  const starts = () => sent().filter((message) => message.method === "turn/start").map((message) => message.params.input[0].text)
  /** What went into the turn under way. */
  const steered = () => sent().filter((message) => message.method === "turn/steer").map((message) => message.params.input[0].text)
  const said = (id: string) => steps(id).flatMap((step) => step.content.filter((part: any) => part.type === "text").map((part: any) => part.text)).join("\n")
  /** Its card is up and its sleep has started: an answer from here is the one that ends the sleep (one before that is told again as the sleep starts, as "settled before it starts to sleep" shows). */
  const cardUpAsleep = async (id: string, cards = 1) => {
    await until(() => tools(id).some((tool) => tool.name === "sleep"))
    await until(() => sessions.forms(id).length === cards)
  }
  const thinking: [string, any] = ["item/started", { item: { type: "reasoning", id: "r1", summary: [], content: [] } }]

  test("its card shows above the composer with the choices, the session waits, and the choice goes back to Codex, which goes on", async () => {
    const id = start(asking, {}, answered)
    await until(() => sessions.forms(id).length === 1)
    const [form] = sessions.forms(id)
    expect(form.fields).toMatchObject([{ description: "Which language should the README use?", options: [{ value: "English" }, { value: "Turkish" }], custom: true }])
    expect(ended(id)).toBe(false)
    sessions.replyForm(id, form.id, { [form.fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(starts()).toEqual(["go", "Turkish"])
    expect(steps(id).flatMap((step) => step.content.filter((part: any) => part.type === "text").map((part: any) => part.text)).join("\n")).toContain("Writing it in Turkish.")
  })

  test("turned down by its box with words (Autopilot): Codex hears them and goes on", async () => {
    const id = start(asking, {}, answered)
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, null, "This is on Autopilot: leave it.")
    await until(() => ended(id))
    expect(starts()).toEqual(["go", "This is on Autopilot: leave it."])
  })

  /** Turning down what it asks, each once, until its turn's over. */
  const turnDownUntilEnded = async (id: string) => {
    const replied = new Set<string>()
    const unanswered = () => sessions.forms(id).filter((form: any) => !replied.has(form.id))
    while (!ended(id)) {
      for (const form of unanswered()) {
        replied.add(form.id)
        sessions.replyForm(id, form.id, null, "This is on Autopilot: leave it.")
      }
      await until(() => ended(id) || unanswered().length > 0)
    }
  }

  test("asking again and again, each turned down by its box with words, its turn ends", async () => {
    const id = start(asking, {}, asking)
    await turnDownUntilEnded(id)
    expect(starts()).toEqual(["go", "This is on Autopilot: leave it.", "This is on Autopilot: leave it."])
  })

  test("it's told which tool asks you, as the other is refused outside Plan and a model that reached for it said it couldn't ask", async () => {
    await run([])
    const told = sent().find((message) => message.method === "thread/start").params.developerInstructions
    expect(told).toContain("request_user_input_async")
    expect(told).toMatch(/new user message/)
  })

  test("what it asks in Plan, turned down by its box with words, gets those words as its answer", async () => {
    const id = start([["item/tool/requestUserInput", { itemId: "q1", questions: [{ id: "which", header: "Which", question: "Which one?", options: [{ label: "A" }] }, { id: "key", header: "Key", question: "Your key?", isSecret: true }] }]])
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, null, "This is on Autopilot: leave it.")
    await until(() => ended(id))
    expect(answers()).toEqual([{ answers: { which: { answers: ["This is on Autopilot: leave it."] }, key: { answers: [] } } }])
  })

  test("a message you type instead answers it: the card goes and Codex gets your words", async () => {
    const id = start(asking, {}, answered)
    await until(() => sessions.forms(id).length === 1)
    sessions.prompt(id, { id: "msg_codex_test_002", text: "english please", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(sessions.forms(id)).toEqual([])
    expect(starts()).toEqual(["go", "english please"])
  })

  const goesOn: [string, () => [string, any]][] = [
    ["thinking", () => thinking],
    ["a step", () => ["item/started", { item: command("c1", "ls") }]],
    ["more words", () => ["item/completed", { item: { type: "agentMessage", id: "m2", text: "Meanwhile, looking around." } }]],
  ]
  test.each(goesOn)("%s after asking doesn't lose the question: its card is up while it works, and the answer goes into its turn", async (_, after) => {
    const id = start([...asking, after(), untilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    expect(sessions.forms(id)[0].fields[0].description).toBe("Which language should the README use?")
    expect(ended(id)).toBe(false)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish"])
    expect(starts()).toEqual(["go"])
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("asleep for hours after asking: your answer goes into its turn, which ends the sleep, and it goes on", async () => {
    const id = start([...asking, thinking, sleepsUntilTold, ...answered])
    await until(() => tools(id).some((tool) => tool.name === "sleep"))
    await until(() => sessions.forms(id).length === 1)
    expect(ended(id)).toBe(false)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish"])
    expect(starts()).toEqual(["go"])
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("turned down by its box with words (Autopilot) while it sleeps on it: it hears them, the sleep ends and its turn goes on", async () => {
    const id = start([...asking, sleepsUntilTold, ...answered])
    await cardUpAsleep(id)
    sessions.replyForm(id, sessions.forms(id)[0].id, null, "This is on Autopilot: leave it.")
    await until(() => ended(id))
    expect(steered()).toEqual(["This is on Autopilot: leave it."])
    expect(starts()).toEqual(["go"])
  })

  test("settled before it starts to sleep (Autopilot goes ahead at once): the sleep that follows isn't slept, it's told again", async () => {
    const id = start([...asking, untilTold, sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()[0]).toBe("Turkish")
    expect(steered()).toHaveLength(2)
    expect(steered()[1]).toContain("Turkish")
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("a sleep with no answered question behind it isn't woken", async () => {
    const id = start([sleepsUntilTold, ...answered])
    await until(() => tools(id).some((tool) => tool.name === "sleep"))
    // (What you send is the first thing to go in.)
    sessions.prompt(id, { id: "msg_codex_test_005", text: "carry on", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(steered()).toEqual(["carry on"])
  })

  test("answered while it sleeps, a later sleep of its own (waiting on a build, say) isn't woken", async () => {
    const id = start([...asking, sleepsUntilTold, thinking, sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    await until(() => tools(id).some((tool) => tool.name === "sleep"))
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => steered().length === 1 && tools(id).filter((tool) => tool.name === "sleep").length === 2)
    sessions.prompt(id, { id: "msg_codex_test_006", text: "carry on", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish", "carry on"])
  })

  test("answered before a sleep, one it starts after hearing it and working on isn't woken", async () => {
    const id = start([...asking, untilTold, ["item/started", { item: command("c1", "ls") }], sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => tools(id).some((tool) => tool.name === "sleep"))
    sessions.prompt(id, { id: "msg_codex_test_007", text: "carry on", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish", "carry on"])
  })

  test("telling it again as it starts to sleep doesn't go through: it's tried again, and the sleep ends with nobody typing", async () => {
    const id = start([...asking, untilTold, refusesNextSteer, sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()).toHaveLength(3)
    expect(steered()[0]).toBe("Turkish")
    expect(steered()[1]).toContain("Turkish")
    expect(steered()[2]).toBe(steered()[1])
    expect(starts()).toEqual(["go"])
  })

  test("an answer turned down while it sleeps: it's tried again, and the sleep ends with nobody typing", async () => {
    const id = start([refusesNextSteer, ...asking, sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    await until(() => tools(id).some((tool) => tool.name === "sleep"))
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish", "Turkish"])
    expect(starts()).toEqual(["go"])
  })

  test("Stop while it's trying again to reach a sleep: the turn ends at once, with nothing more sent", async () => {
    const id = start([refusesSteers, ...asking, sleepsUntilTold])
    await until(() => sessions.forms(id).length === 1)
    await until(() => tools(id).some((tool) => tool.name === "sleep"))
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => steered().length === 1 && sessions.forms(id).length === 0)
    sessions.interrupt(id)
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish"])
    expect(starts()).toEqual(["go"])
  })

  test("an answer its turn turned down a moment ago goes in as it goes on, and ends the sleep it starts", async () => {
    const id = start([refusesNextSteer, ...asking, untilTold, ["item/started", { item: command("c1", "ls") }], sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered().every((text) => text.includes("Turkish"))).toBe(true)
    expect(steered().length).toBeGreaterThanOrEqual(2)
    expect(starts()).toEqual(["go"])
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("an answer turned down as its sleep gives way to another goes into the new one, and ends it", async () => {
    const id = start([refusesNextSteer, ...asking, sleepsAgainOnceRefused, ...answered])
    await cardUpAsleep(id)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish", "Turkish"])
    expect(starts()).toEqual(["go"])
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("turned down as a sleep starts, and told again as that sleep gives way to another: the new one is told, and ends", async () => {
    const id = start([refusesAsItSleeps, ...asking, untilTold, refusesNextSteer, sleepsAgainOnceRefused, ...answered])
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()).toHaveLength(3)
    expect(steered()[0]).toBe("Turkish")
    expect(steered()[1]).toContain("Turkish")
    expect(steered()[2]).toBe(steered()[1])
    expect(starts()).toEqual(["go"])
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("turned down in the same breath a sleep starts: it's told once more, and no further turn starts for it", async () => {
    const id = start([refusesAsItSleeps, ...asking, untilTold, sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()).toHaveLength(2)
    expect(steered()[1]).toContain("Turkish")
    expect(starts()).toEqual(["go"])
  })

  test("what it heard before asking another isn't told again as it sleeps on the new one: that's yours to answer", async () => {
    const second: [string, any] = ["item/completed", { item: { type: "agentMessage", id: "m3", text: "Which tone?", delivery: "async", questions: [{ title: "Which tone?", options: ["Plain", "Warm"] }] } }]
    const id = start([...asking, untilTold, second, sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => sessions.forms(id).some((form: any) => form.fields[0].description === "Which tone?") && tools(id).some((tool) => tool.name === "sleep"))
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Plain" })
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish", "Plain"])
  })

  test("still open as its turn ends: the session waits, and your answer starts its next turn", async () => {
    const id = start([...asking, thinking, ["item/completed", { item: { type: "agentMessage", id: "m2", text: "I'll wait to hear." } }]], {}, answered)
    await until(() => said(id).includes("I'll wait to hear."))
    await until(() => sessions.forms(id).length === 1)
    expect(ended(id)).toBe(false)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(starts()).toEqual(["go", "Turkish"])
    expect(steered()).toEqual([])
  })

  test("an answer its turn turns down, as it's ending, isn't lost: its next turn starts with it", async () => {
    const id = start([refusesSteers, ...asking, untilTold], {}, answered)
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(starts()).toEqual(["go", "Turkish"])
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("an answer Codex took as its turn ended isn't sent again: it has it", async () => {
    const id = start([...asking, endsAsTold], {}, answered)
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, { [sessions.forms(id)[0].fields[0].key]: "Turkish" })
    await until(() => ended(id))
    expect(steered()).toEqual(["Turkish"])
    expect(starts()).toEqual(["go"])
  })

  test("a message you type that Codex takes as its turn ends isn't sent again: it hears it, and acts on it", async () => {
    const id = start([["item/completed", { item: { type: "agentMessage", id: "m1", text: "Nearly there." } }], endsAsTold], {}, answered)
    await until(() => said(id).includes("Nearly there."))
    sessions.prompt(id, { id: "msg_codex_test_009", text: "one more thing", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(steered()).toEqual(["one more thing"])
    expect(starts()).toEqual(["go"])
  })

  test("two asked in one turn: both cards are up, and each answer goes in", async () => {
    const second: [string, any] = ["item/completed", { item: { type: "agentMessage", id: "m3", text: "Which tone?", delivery: "async", questions: [{ title: "Which tone?", options: ["Plain", "Warm"] }] } }]
    const id = start([...asking, second, sleepsUntilTold, sleepsUntilTold, ...answered])
    await until(() => sessions.forms(id).length === 2)
    for (const form of sessions.forms(id)) sessions.replyForm(id, form.id, { [form.fields[0].key]: form.fields[0].description === "Which tone?" ? "Plain" : "Turkish" })
    await until(() => steered().length >= 2)
    expect(steered().slice(0, 2).sort()).toEqual(["Plain", "Turkish"])
  })

  test("a message you type while it works answers what's open: the cards go, and your words go into its turn", async () => {
    const id = start([...asking, sleepsUntilTold, ...answered])
    await cardUpAsleep(id)
    sessions.prompt(id, { id: "msg_codex_test_004", text: "english please", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(sessions.forms(id)).toEqual([])
    expect(steered()).toEqual(["english please"])
    expect(starts()).toEqual(["go"])
  })

  test("a message you type with two cards up answers both: it hears your words, and not that one was dismissed", async () => {
    const second: [string, any] = ["item/completed", { item: { type: "agentMessage", id: "m3", text: "Which tone?", delivery: "async", questions: [{ title: "Which tone?", options: ["Plain", "Warm"] }] } }]
    const id = start([...asking, second, sleepsUntilTold, ...answered])
    await cardUpAsleep(id, 2)
    sessions.prompt(id, { id: "msg_codex_test_010", text: "english and warm please", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(sessions.forms(id)).toEqual([])
    expect(steered()).toEqual(["english and warm please"])
  })

  test("dismissed while it sleeps on it: it hears so, rather than sleep for hours", async () => {
    const id = start([...asking, sleepsUntilTold, ...answered])
    await cardUpAsleep(id)
    sessions.replyForm(id, sessions.forms(id)[0].id, null)
    await until(() => ended(id))
    expect(steered()).toHaveLength(1)
    expect(steered()[0]).toMatch(/dismissed/)
    expect(starts()).toEqual(["go"])
  })

  const askedAway = (n: number): [string, any] => ["item/completed", { item: { type: "agentMessage", id: `a${n}`, text: "Which?", delivery: "async", questions: [{ title: `Which ${n}?`, options: ["A", "B"] }] } }]
  const stoppedIt = () => sent().some((message) => message.method === "turn/interrupt")

  test("asking again and again in one turn with no work in between, each turned down by its box: its turn is stopped, and ends as finished, not as stopped by you", async () => {
    const rounds = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [askedAway(n), untilTold])
    const id = start([...rounds, untilStopped])
    await turnDownUntilEnded(id)
    expect(steered().every((text) => text.includes("This is on Autopilot: leave it."))).toBe(true)
    expect(stoppedIt()).toBe(true)
    expect((sessions.messages(id).find((message: any) => message.type === "idle") as any).outcome).toBe("succeeded")
  })

  test("a few unmarked questions before it starts, each turned down by its box: its turn goes on to its work", async () => {
    const id = start([askedAway(1), untilTold, askedAway(2), untilTold, askedAway(3), untilTold, ["item/started", { item: command("c1", "ls") }], ...answered])
    await turnDownUntilEnded(id)
    expect(stoppedIt()).toBe(false)
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("however many questions it asks in a long turn, turned down by its box, with work in between: its turn isn't stopped", async () => {
    const rounds = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n): [string, any][] => [askedAway(n), untilTold, ["item/started", { item: command(`c${n}`, "ls") }]])
    const id = start([...rounds, ...answered])
    await turnDownUntilEnded(id)
    expect(stoppedIt()).toBe(false)
    expect(said(id)).toContain("Writing it in Turkish.")
  })

  test("Stop with its card up and it at work: the card goes, and nothing more is sent", async () => {
    const id = start([...asking, untilStopped])
    await until(() => sessions.forms(id).length === 1)
    await until(() => sent().some((message) => message.method === "turn/start"))
    sessions.interrupt(id)
    await until(() => ended(id))
    expect(sessions.forms(id)).toEqual([])
    expect(steered()).toEqual([])
    expect(starts()).toEqual(["go"])
  })

  test("Stop with its turn over and its card still up: the card goes, and no turn starts", async () => {
    const id = start([...asking, ["item/completed", { item: { type: "agentMessage", id: "m2", text: "I'll wait to hear." } }]], {}, answered)
    await until(() => said(id).includes("I'll wait to hear."))
    await until(() => sessions.forms(id).length === 1)
    sessions.interrupt(id)
    await until(() => ended(id))
    expect(sessions.forms(id)).toEqual([])
    expect(starts()).toEqual(["go"])
  })

  test("its turn fails with its card up: the card goes, and the failure is what you see", async () => {
    const id = start([...asking, ["turn/completed", { turn: { id: "u1", status: "failed", error: { message: "It broke." } } }], untilStopped])
    await until(() => ended(id))
    expect(sessions.forms(id)).toEqual([])
    expect((sessions.messages(id).find((message: any) => message.type === "idle") as any).outcome).toBe("failed")
    expect(starts()).toEqual(["go"])
  })

  test("a note of the app's that comes meanwhile (a message relayed from another conversation) doesn't answer it", async () => {
    const id = start(asking, {}, answered)
    await until(() => sessions.forms(id).length === 1)
    sessions.prompt(id, { id: "msg_codex_test_003", text: "A note from the app.", files: [], delivery: "steer", synthetic: { description: "A relayed message" } })
    // Not taken into the turn: it waits for it to end.
    await until(() => sessions.inbox(id).some((item) => item.delivery === "queue"))
    const [form] = sessions.forms(id)
    expect(form).toBeDefined()
    sessions.replyForm(id, form.id, { [form.fields[0].key]: "English" })
    await until(() => starts().length >= 2)
    expect(starts()[1]).toBe("English")
  })

  test("dismissing the card ends the turn there, with nothing sent to Codex", async () => {
    const id = start(asking, {}, answered)
    await until(() => sessions.forms(id).length === 1)
    sessions.replyForm(id, sessions.forms(id)[0].id, null)
    await until(() => ended(id))
    expect(starts()).toEqual(["go"])
  })
})

describe("Codex in the session's modes", () => {
  const reply: [string, any][] = [["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }]]

  test("Approve All: it runs what it needs without asking, outside its sandbox", async () => {
    await run(reply)
    expect(turnStart()).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" }, collaborationMode: { mode: "default" } })
  })

  test("Approve All: a command Codex's own rules ask about (rm -f) runs, answered for you with no card", async () => {
    // With "never", Codex refuses what its rules would ask about ("rm -f style commands are not
    // permitted"); asked instead, your Approve All lets it through.
    const id = await run([
      ["item/started", { item: command("c1", "rm -f nothing-here.txt") }],
      ["item/commandExecution/requestApproval", { itemId: "c1", command: "/bin/zsh -lc 'rm -f nothing-here.txt'", cwd: root }],
      ["item/completed", { item: command("c1", "rm -f nothing-here.txt", { status: "completed", exitCode: 0 }) }],
    ])
    expect(turnStart().approvalPolicy).toBe("on-request")
    expect(answers()).toEqual([{ decision: "accept" }])
    expect(sessions.permissions(id)).toEqual([])
    expect(tools(id)[0].state).toMatchObject({ status: "completed" })
  })

  // Codex asks before any MCP tool runs (outside "never"), as an elicitation of its own.
  const mcpAsk = (server: string, tool: string): [string, any] => ["mcpServer/elicitation/request", { serverName: server, mode: "form", _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} }, message: `Allow the ${server} MCP server to run tool "${tool}"?`, requestedSchema: { type: "object", properties: {} } }]

  test("Approve All: an MCP tool Codex asks about runs, answered for you with no card", async () => {
    const id = await run([mcpAsk("probe", "plain_note"), ...reply])
    expect(answers()).toEqual([{ action: "accept", content: null }])
    expect(sessions.forms(id)).toEqual([])
    expect(sessions.permissions(id)).toEqual([])
  })

  test("Ask First: another server's MCP tool asks as a permission card (No declines it); Kuvo Code's own tools don't ask", async () => {
    const id = start([mcpAsk("kuvo-browser", "show_in_panel"), mcpAsk("probe", "erase_everything"), ...reply], { permissions: askFirst })
    await until(() => sessions.permissions(id).length === 1)
    const [ask] = sessions.permissions(id)
    expect(ask).toMatchObject({ action: "probe_erase_everything" })
    expect(sessions.forms(id)).toEqual([])
    sessions.replyPermission(id, ask.id, "reject")
    await until(() => ended(id))
    expect(answers()).toEqual([{ action: "accept", content: null }, { action: "decline", content: null }])
  })

  test("Plan: another server's MCP tool, which may change things, still waits for your yes", async () => {
    const id = start([mcpAsk("kuvo-browser", "show_in_panel"), mcpAsk("probe", "erase_everything"), ...reply], { agent: "plan" })
    await until(() => sessions.forms(id).length === 1)
    expect(sessions.forms(id)[0].fields[0]).toMatchObject({ title: 'Allow the probe MCP server to run tool "erase_everything"?' })
    sessions.replyForm(id, sessions.forms(id)[0].id, null)
    await until(() => ended(id))
    expect(answers()).toEqual([{ action: "accept", content: null }, { action: "decline" }])
  })

  test("what an MCP server asks in Plan is its form, not the agent's question, so it never counts as one", async () => {
    const id = start([mcpAsk("probe", "erase_everything"), ...reply], { agent: "plan" })
    await until(() => sessions.forms(id).length === 1)
    expect(sessions.forms(id)[0].metadata).toEqual({ kind: "mcp-elicitation", server: "probe" })
    sessions.replyForm(id, sessions.forms(id)[0].id, null)
    await until(() => ended(id))
  })

  test("Ask First: it asks before commands and changes, and what it runs can write in the project and reach the network", async () => {
    await run(reply, { permissions: askFirst })
    expect(turnStart()).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", networkAccess: true }, collaborationMode: { mode: "default" } })
  })

  test("Plan: it can only read, and a change it asks to make anyway is declined without asking you", async () => {
    const changes = [{ path: join(root, "src/sum.ts"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }]
    const id = await run(
      [
        ["item/started", { item: { type: "fileChange", id: "p1", status: "inProgress", changes } }],
        ["item/fileChange/requestApproval", { itemId: "p1" }],
        ["item/completed", { item: { type: "fileChange", id: "p1", status: "declined", changes } }],
      ],
      { agent: "plan" },
    )
    expect(turnStart()).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" }, collaborationMode: { mode: "plan" } })
    expect(answers()).toEqual([{ decision: "decline" }])
    expect(tools(id)[0].state.status).toBe("error")
  })
})

describe.skipIf(!canFence)("Codex in the box's sandbox", () => {
  const reply: [string, any][] = [["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }]]
  /** Kuvo Code's folder, Codex's own home, and a folder elsewhere. */
  let kuvo: string, home: string, elsewhere: string
  beforeEach(() => {
    kuvo = realpathSync(mkdtempSync(join(base, "kuvo-")))
    home = realpathSync(mkdtempSync(join(base, "codex-home-")))
    elsewhere = realpathSync(mkdtempSync(join(base, "elsewhere-")))
    writeFileSync(join(kuvo, "secret"), "s")
    writeFileSync(join(home, "config.toml"), "")
    process.env.CODEX_HOME = home
    // (Its home's `ipc`, as your own Codex's: the ChatGPT app's.)
    process.env.KUVO_FENCE = realFence(kuvo, [join(home, "ipc")])
  })
  afterEach(() => {
    delete process.env.KUVO_FENCE
    delete process.env.CODEX_HOME
  })

  /** What Codex said it could do (`tries`). */
  const said = (id: string) => steps(id).flatMap((step) => step.content.filter((content: any) => content.type === "text").map((content: any) => content.text)).join("")

  test("Codex runs whole in it: what it runs, even a command you allowed, writes only the session's folder and Codex's own state (on a Mac, never its settings, plugins or skills, which run outside the sandbox when you use Codex), never elsewhere, and can't read Kuvo Code's folder", async () => {
    mkdirSync(join(home, "sessions"))
    mkdirSync(join(home, "plugins"))
    mkdirSync(join(home, "shell_snapshots"))
    const id = await run([[tries, {
      project: ["write", join(root, "made.txt")],
      own: ["write", join(home, "state_5.sqlite-wal")],
      signin: ["write", join(home, "auth.json")],
      state: ["write", join(home, "sessions", "rollout.jsonl")],
      settings: ["write", join(home, "config.toml")],
      // A file it never writes.
      other: ["write", join(home, "notes.txt")],
      // Settings put in its state.
      kept: ["write", join(home, "sessions", "config.toml")],
      plugin: ["write", join(home, "plugins", "plugin.js")],
      // What Codex runs or tells its model later, outside a turn: a shell it sources, what each model is told.
      snapshot: ["write", join(home, "shell_snapshots", "s.sh")],
      models: ["write", join(home, "models_cache.json")],
      elsewhere: ["write", join(elsewhere, "e.txt")],
      kuvo: ["read", join(kuvo, "secret")],
    }]], { permissions: askFirst })
    // (Linux grants its home whole: there, a machine's, it's Kuvo Code's own copy of Codex's.)
    const mac = process.platform === "darwin" ? "no" : "yes"
    expect(said(id)).toBe(`project=yes own=yes signin=yes state=yes settings=${mac} other=${mac} kept=${mac} plugin=${mac} snapshot=${mac} models=${mac} elsewhere=no kuvo=no`)
  })

  test("Codex saves its sign-in in it as it does from 0.167, through a new file renamed onto auth.json; a file by that name never becomes its settings", async () => {
    writeFileSync(join(home, "hooks.json"), "{}")
    const id = await run([[tries, {
      signin: ["replace", join(home, "auth.json"), join(home, ".auth-AbC123")],
      settings: ["replace", join(home, "config.toml"), join(home, ".auth-Def456")],
      hooks: ["replace", join(home, "hooks.json"), join(home, ".auth-Ghi789")],
      rules: ["replace", join(home, "rules"), join(home, ".auth-Jkl012")],
      // What every model's told (its instructions): not its state, if not settings.
      instructions: ["replace", join(home, "AGENTS.md"), join(home, ".auth-Pqr678")],
      // Its settings by a name it writes, to write them through that.
      named: ["hardlink", join(home, "config.toml"), join(home, ".auth-Mno345")],
    }]], { permissions: askFirst })
    // (Linux grants its home whole: there, a machine's, it's Kuvo Code's own copy of Codex's.)
    const mac = process.platform === "darwin" ? "no" : "yes"
    expect(said(id)).toBe(`signin=yes settings=${mac} hooks=${mac} rules=${mac} instructions=${mac} named=${mac}`)
    expect(readFileSync(join(home, "auth.json"), "utf8")).toBe("x")
    if (mac === "no") {
      expect(readFileSync(join(home, "config.toml"), "utf8")).toBe("")
      expect(readFileSync(join(home, "hooks.json"), "utf8")).toBe("{}")
      expect(existsSync(join(home, "rules"))).toBe(false)
      expect(existsSync(join(home, "AGENTS.md"))).toBe(false)
    }
  })

  test("a bot on Codex keeps its memory from the sandbox, and nothing else of its folder or another bot's", async () => {
    // Bots' folders, in Kuvo Code's: each with its memory, its settings and its conversation's folder.
    const bot = (id: string) => {
      const folder = join(kuvo, "bots", id)
      mkdirSync(join(folder, "workspace"), { recursive: true })
      writeFileSync(join(folder, "MEMORY.md"), `# ${id}'s memory\n`)
      writeFileSync(join(folder, "bot.json"), "{}")
      return folder
    }
    const ship = bot("bot_ship")
    const scout = bot("bot_scout")
    codex = new TestCodex(fakeCodex(root, [[tries, {
      memory: ["write", join(ship, "MEMORY.md")],
      settings: ["write", join(ship, "bot.json")],
      other: ["write", join(scout, "MEMORY.md")],
      read: ["read", join(scout, "MEMORY.md")],
    }]]), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    // Its own conversation, in its folder, as the box keeps it (`session`).
    const id = sessions.create({ title: "Ship", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: join(ship, "workspace") }, permissions: askFirst }).id
    writeFileSync(join(ship, "session"), id)
    sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(said(id)).toBe("memory=yes settings=no other=no read=no")
    expect(readFileSync(join(ship, "MEMORY.md"), "utf8")).toBe("x")
    expect(readFileSync(join(scout, "MEMORY.md"), "utf8")).toBe("# bot_scout's memory\n")
  })

  test("a bot's agent keeps its own memory folder from the sandbox, not another bot's", async () => {
    const bot = (id: string) => {
      const folder = join(kuvo, "bots", id)
      mkdirSync(join(folder, "workspace"), { recursive: true })
      mkdirSync(join(folder, "memory"), { recursive: true })
      writeFileSync(join(folder, "memory", "MEMORY.md"), `# ${id}'s memory\n`)
      return folder
    }
    const ship = bot("bot_shipmem")
    const scout = bot("bot_scoutmem")
    codex = new TestCodex(fakeCodex(root, [[tries, {
      kept: ["write", join(ship, "memory", "MEMORY.md")],
      made: ["write", join(ship, "memory", "deploys.md")],
      other: ["write", join(scout, "memory", "MEMORY.md")],
      read: ["read", join(scout, "memory", "MEMORY.md")],
    }]]), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Ship", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: join(ship, "workspace") }, permissions: askFirst }).id
    writeFileSync(join(ship, "session"), id)
    sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(said(id)).toBe("kept=yes made=yes other=no read=no")
    expect(readFileSync(join(scout, "memory", "MEMORY.md"), "utf8")).toBe("# bot_scoutmem's memory\n")
  })

  test("a bot's seat in a group chat, working in its project's folder, keeps the bot's memory too; a memory that's another file's other name isn't given", async () => {
    const bot = (id: string) => {
      const folder = join(kuvo, "bots", id)
      mkdirSync(join(folder, "workspace"), { recursive: true })
      writeFileSync(join(folder, "MEMORY.md"), `# ${id}'s memory\n`)
      writeFileSync(join(folder, "bot.json"), "{}")
      return folder
    }
    const ship = bot("bot_ship")
    const scout = bot("bot_scout")
    const project = join(root, "ship-project")
    mkdirSync(project, { recursive: true })
    codex = new TestCodex(fakeCodex(root, [[tries, {
      memory: ["write", join(ship, "MEMORY.md")],
      other: ["write", join(scout, "MEMORY.md")],
    }]]), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    // Its seat: a conversation of its own in the folder it works in, which its box marks as the bot's.
    const seat = sessions.create({ title: "Ship in Launch", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: project }, permissions: askFirst }).id
    sessions.update(seat, { metadata: { kuvo: { seat: { group: "grp_launch", bot: "bot_ship" } } } })
    sessions.prompt(seat, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
    await until(() => ended(seat))
    expect(said(seat)).toBe("memory=yes other=no")
    expect(readFileSync(join(ship, "MEMORY.md"), "utf8")).toBe("x")

    // Scout's memory under Ship's name too (a hard link, made outside the sandbox): not Ship's alone.
    rmSync(join(ship, "MEMORY.md"))
    linkSync(join(scout, "MEMORY.md"), join(ship, "MEMORY.md"))
    const own = sessions.create({ title: "Ship", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: join(ship, "workspace") }, permissions: askFirst }).id
    writeFileSync(join(ship, "session"), own)
    sessions.prompt(own, { id: "msg_codex_test_002", text: "go", files: [], delivery: "steer" })
    await until(() => ended(own))
    expect(said(own)).toBe("memory=no other=no")
    expect(readFileSync(join(scout, "MEMORY.md"), "utf8")).toBe("# bot_scout's memory\n")
  })

  test("what it runs can't ask the ChatGPT app to run something outside it (its socket in Codex's folder), and still reaches other sockets", async () => {
    const listen = async (folder: string) => {
      mkdirSync(folder, { recursive: true })
      const here = process.cwd()
      process.chdir(folder)
      const server = createServer((socket) => socket.end())
      await new Promise<void>((resolve) => server.listen("s.sock", resolve))
      process.chdir(here)
      return server
    }
    const app = await listen(join(home, "ipc"))
    const other = await listen(elsewhere)
    try {
      const id = await run([[tries, { app: ["connect", join(home, "ipc", "s.sock")], other: ["connect", join(elsewhere, "s.sock")] }]], { permissions: askFirst })
      // (On Linux each command's namespace hides the sockets it's given, where the machine lets it.)
      const refused = process.platform === "darwin" || readFileSync(join(kuvo, "run", "fence", "namespace"), "utf8") !== "-"
      expect(said(id)).toBe(`app=${refused ? "no" : "yes"} other=yes`)
      // The box's own rules name your Codex's socket so (and Grok's shared leader's).
      if (process.platform === "darwin") expect(fencePolicy().sockets?.filter((folder) => folder.endsWith("/.codex/ipc") || folder.endsWith("/.grok/leader.sock"))).toHaveLength(2)
    } finally {
      app.close()
      other.close()
    }
  })

  test("a one-off answer from your account's Codex (a title) runs in it too: what it runs can't change Codex's plugins or skills", async () => {
    mkdirSync(join(home, "plugins"))
    mkdirSync(join(home, "skills"))
    codex = new TestCodex(fakeCodex(root, [[tries, {
      plugin: ["write", join(home, "plugins", "plugin.js")],
      skill: ["write", join(home, "skills", "SKILL.md")],
      elsewhere: ["write", join(elsewhere, "e.txt")],
    }]]), root)
    const mac = process.platform === "darwin" ? "no" : "yes"
    expect(await codex.generate("A title for this.")).toBe(`plugin=${mac} skill=${mac} elsewhere=no`)
  })

  test("an added account's Codex works in it: it keeps its conversations in your Codex's folder, which its own links to, and still can't change what runs outside", async () => {
    const yours = realpathSync(mkdtempSync(join(base, "your-codex-")))
    mkdirSync(join(yours, "sessions"))
    mkdirSync(join(yours, "skills"))
    writeFileSync(join(yours, "config.toml"), "")
    const added = join(kuvo, "agents", "codex-work")
    codex = new TestCodex(fakeCodex(root, [[tries, {
      signin: ["write", join(added, "auth.json")],
      state: ["write", join(added, "sessions", "rollout.jsonl")],
      settings: ["write", join(added, "config.toml")],
      skill: ["write", join(yours, "skills", "SKILL.md")],
    }]]), root, { id: "work", home: added }, yours)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Codex", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(existsSync(join(yours, "sessions", "rollout.jsonl"))).toBe(true)
    const mac = process.platform === "darwin" ? "no" : "yes"
    expect(said(id)).toBe(`signin=yes state=yes settings=${mac} skill=${mac}`)
  })

  test("turned off while your account's Codex is busy signing in: a session's turn runs in its own folder, outside the sandbox, not in that Codex", async () => {
    codex = new TestCodex(fakeCodex(root, reply), root)
    const agent = codex
    await agent.signIn()
    delete process.env.KUVO_FENCE
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Codex", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root }, permissions: askFirst }).id
    sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(said(id)).toBe("Done.")
    expect(turnStart().sandboxPolicy.type).toBe("workspaceWrite")
  })

  test("a session's own Codex stops when the session closes", async () => {
    const other = realpathSync(mkdtempSync(join(base, "other-project-")))
    codex = new TestCodex(fakeCodex(root, reply), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Codex", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: other } }).id
    sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
    await until(() => ended(id))
    // (The fake names its thread by its process.)
    const there = sentIn(other)
    const pid = Number(there.find((message) => message.method === "turn/start").params.threadId.slice(2))
    const running = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(running()).toBe(true)
    sessions.closeAll()
    await until(() => !running())
  })

  test("you let the project's commands write another folder while an agent Codex spawned still works: it goes on, in the same Codex, and the session's next turn too", async () => {
    codex = new TestCodex(messagedCodex(root, true, false), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Spawn", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [], delivery: "steer" })
    await until(() => ended(id))
    const child = tools(id)[0].state.metadata.sessionID as string
    // Also Allowed, as the box writes it for this project.
    const allowed = join(kuvo, "run", "fence", "allowed", createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 32))
    mkdirSync(dirname(allowed), { recursive: true })
    writeFileSync(allowed, elsewhere + "\n")
    sessions.prompt(id, { id: "msg_codex_test_002", text: "more", files: [], delivery: "steer" })
    await until(() => sent().filter((message) => message.method === "turn/start").length === 2 && sessions.messages(id).filter((message) => message.type === "idle").length === 2)
    expect(sent().filter((message) => message.method === "initialize")).toHaveLength(1)
    expect(sessions.messages(child).some((message: any) => message.type === "idle" && message.outcome === "interrupted")).toBe(false)
  })

  test("Ask First asks before its commands as Codex does, and Approve All only what Codex's own rules ask about, with Codex's own sandbox off (one can't run inside another)", async () => {
    await run(reply, { permissions: askFirst })
    expect(turnStart()).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } })
    sessions.closeAll()
    codex!.shutdown()
    rmSync(join(root, "sent.jsonl"))
    await run(reply)
    expect(turnStart()).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "dangerFullAccess" } })
  })

  test("each session has a Codex of its own, in its own folder", async () => {
    const first = await run(reply)
    const other = realpathSync(mkdtempSync(join(base, "other-project-")))
    const second = sessions.create({ title: "Codex", model: { providerID: codex!.providerID, id: "gpt-test" }, location: { directory: other } }).id
    sessions.prompt(second, { id: "msg_codex_test_101", text: "go", files: [], delivery: "steer" })
    await until(() => ended(second))
    expect(said(first)).toBe("Done.")
    // The second's Codex started in its folder, and it's the only one there.
    const there = sentIn(other)
    expect(there.filter((message) => message.method === "initialize")).toHaveLength(1)
    expect(sent().filter((message) => message.method === "initialize")).toHaveLength(1)
  })

  test("turned on while Codex is still at work, that turn goes on; the session's next turn runs in the sandbox", async () => {
    delete process.env.KUVO_FENCE
    const id = start([untilStopped], {}, reply)
    await until(() => existsSync(join(root, "sent.jsonl")) && sent().some((message) => message.method === "turn/start"))
    expect(turnStart().sandboxPolicy).toEqual({ type: "dangerFullAccess" })
    process.env.KUVO_FENCE = join(kuvo, "run", "fence")
    await sessions.interrupt(id)
    await until(() => ended(id))
    sessions.prompt(id, { id: "msg_codex_test_102", text: "again", files: [], delivery: "steer" })
    await until(() => sent().filter((message) => message.method === "turn/start").length === 2)
    // A Codex of its own, in the sandbox, where its thread is loaded again.
    expect(sent().filter((message) => message.method === "initialize")).toHaveLength(2)
    expect(sent().filter((message) => message.method === "thread/resume")).toHaveLength(1)
    expect(sent().filter((message) => message.method === "turn/start").at(-1).params.approvalPolicy).toBe("on-request")
  })

  test("a picture you attached is one Codex can see: Kuvo Code's folder, where it's kept, is hidden", async () => {
    const attached = join(kuvo, "Attachments", "shot.png")
    mkdirSync(dirname(attached))
    writeFileSync(attached, "png")
    codex = new TestCodex(fakeCodex(root, reply), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Codex", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [{ uri: pathToFileURL(attached).href, name: "shot.png" }], delivery: "steer" })
    await until(() => ended(id))
    const picture = turnStart().input.find((item: any) => item.type === "localImage")
    expect(picture.path).not.toBe(attached)
    expect(readFileSync(picture.path, "utf8")).toBe("png")
  })

  test("a picture you attach goes only where Codex reads it, wherever a command before put a link", async () => {
    const attached = join(kuvo, "Attachments", "shot.png")
    mkdirSync(dirname(attached))
    writeFileSync(attached, "png")
    // A command earlier made the conversation's temporary folder a link to elsewhere.
    const temporary = join(kuvo, "run", "fence", "tmp", createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 32))
    mkdirSync(dirname(temporary), { recursive: true })
    symlinkSync(elsewhere, temporary)
    codex = new TestCodex(fakeCodex(root, [[tries, { picture: ["read", "(attached)"], change: ["write", "(attached)"] }]]), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Codex", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_codex_test_001", text: "go", files: [{ uri: pathToFileURL(attached).href, name: "shot.png" }], delivery: "steer" })
    await until(() => ended(id))
    expect(said(id)).toBe("picture=yes change=no")
    expect(readdirSync(elsewhere)).toEqual([])
  })
})

describe("Codex's tools", () => {
  test("ChatGPT's Computer Use is off even when your Codex settings turn it on: it can't click around your Mac without a card", async () => {
    await run([["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }]])
    // As Codex 0.163 takes it: a plugin turned off for the whole app-server (its MCP server
    // never starts), the plugin's id unquoted.
    const overrides = argv().flatMap((arg, at, all) => (all[at - 1] === "-c" ? [arg] : []))
    expect(overrides).toContain("plugins.unified-computer-use@openai-bundled.enabled=false")
    expect(overrides).toContain("plugins.computer-use@openai-bundled.enabled=false")
  })
})

describe("Codex and the computer's MCP servers", () => {
  test("its thread gets them through the bridge, without their keys, and a call reaches each with what it needs", async () => {
    const servers = computerServers(root)
    await servers.serve()
    try {
      await run([["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }]])
      const config = sent().find((message) => message.method === "thread/start").params.config as Record<string, any>
      const given = Object.fromEntries(Object.entries(config).filter(([name]) => name.startsWith("mcp_servers.")).map(([name, server]) => [name.slice("mcp_servers.".length), server]))
      expect(Object.keys(given).sort()).toEqual(["files", "notes", "tracker"])
      const text = JSON.stringify(given)
      for (const key of Object.values(KEYS)) expect(text).not.toContain(key)
      expect(await callServer({ url: given.files.url, headers: given.files.http_headers })).toBe(`key:${KEYS.shared}`)
      expect(await callServer({ url: given.tracker.url, headers: given.tracker.http_headers })).toBe(`auth:Bearer ${KEYS.tracker},key:none,at:/tracker`)
    } finally {
      servers.stop()
    }
  })
})

describe("Your subagents (Settings › Agents), in Codex", () => {
  test("they're its roles in the thread, each with its instructions and a model it runs, and the model its other subagents use", async () => {
    const engine = subagentEngine(root)
    engine.model = "codex-cli/gpt-6-luna"
    await engine.serve()
    try {
      await run([["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }]])
      const config = sent().find((message) => message.method === "thread/start").params.config as Record<string, any>
      expect(config["agents.default_subagent_model"]).toBe("gpt-6-luna")
      expect(config["agents.reviewer.description"]).toBe("Reviews a finished change.")
      expect(config["agents.keyword_research.description"]).toBe("Finds keywords.")
      // A mode isn't a subagent, and the engine's own aren't yours.
      expect(Object.keys(config).filter((key) => key.startsWith("agents.") && key.endsWith(".description")).sort()).toEqual(["agents.keyword_research.description", "agents.reviewer.description"])
      // Each role's file, in the bridge's home: what it's told, and its model (its own, or the one
      // subagents use) when Codex runs it.
      const reviewer = readFileSync(config["agents.reviewer.config_file"], "utf8")
      expect(reviewer).toBe('developer_instructions = "You review. You never edit."\nmodel = "gpt-6-luna"\n')
      // Its own model is the engine's OpenAI one, not one of Codex's: it takes the subagents' one then.
      expect(readFileSync(config["agents.keyword_research.config_file"], "utf8")).toBe('developer_instructions = "You research keywords."\n')
      expect(config["agents.reviewer.config_file"].startsWith(root)).toBe(true)
    } finally {
      engine.stop()
    }
  })

  test("a Codex that turns them away still starts the conversation, without them", async () => {
    const engine = subagentEngine(root)
    engine.model = "codex-cli/gpt-6-luna"
    await engine.serve()
    process.env.KUVO_TEST_CODEX_REFUSES_AGENTS = "1"
    try {
      const id = await run([["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }]])
      const starts = sent().filter((message) => message.method === "thread/start")
      expect(starts).toHaveLength(2)
      expect(Object.keys(starts[1].params.config).some((key) => key.startsWith("agents."))).toBe(false)
      expect(sessions.messages(id).at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" })
    } finally {
      delete process.env.KUVO_TEST_CODEX_REFUSES_AGENTS
      engine.stop()
    }
  })

  test("one of another maker's models stays out: its subagents use the conversation's", async () => {
    const engine = subagentEngine(root)
    engine.model = "anthropic/claude-haiku-4-5"
    await engine.serve()
    try {
      await run([["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }]])
      const config = sent().find((message) => message.method === "thread/start").params.config as Record<string, any>
      expect(config["agents.default_subagent_model"]).toBeUndefined()
      expect(config["agents.reviewer.description"]).toBe("Reviews a finished change.")
    } finally {
      engine.stop()
    }
  })
})

/** A Codex whose turn spawns an agent (thread t2) that goes on after it: asks first if `asks`, and works until it's stopped otherwise. */
function spawningCodex(folder: string, asks: boolean): string {
  const script = join(folder, "app-server.js")
  writeFileSync(
    script,
    `let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "t1" } } })
    else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "u1", status: "inProgress" } } })
      send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } })
      send({ method: "item/completed", params: { threadId: "t1", turnId: "u1", item: { type: "subAgentActivity", id: "sa1", kind: "started", agentThreadId: "t2", agentPath: "/root/worker" } } })
      send({ method: "turn/started", params: { threadId: "t2", turn: { id: "u2" } } })
      if (${asks}) send({ id: 500, method: "item/commandExecution/requestApproval", params: { threadId: "t2", turnId: "u2", itemId: "c1", command: "rm -rf build" } })
      setTimeout(() => send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed" } } }), 50)
    } else if (message.id === 500) {
      send({ method: "item/completed", params: { threadId: "t2", turnId: "u2", item: { type: "agentMessage", id: "a2", text: "Answered: " + message.result.decision } } })
      send({ method: "turn/completed", params: { threadId: "t2", turn: { id: "u2", status: "completed" } } })
    } else if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} })
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } } })
    } else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
  )
  const launcher = join(folder, "codex")
  writeFileSync(launcher, `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

describe("Codex's agents in the background", () => {
  async function spawn(asks: boolean) {
    codex = new TestCodex(spawningCodex(root, asks), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    // (Titled: no title is asked of this Codex.)
    const id = sessions.create({ title: "Spawn", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root }, permissions: [{ action: "shell", resource: "*", effect: "ask" }] }).id
    sessions.prompt(id, { id: "msg_codex_test_002", text: "go", files: [], delivery: "steer" })
    await until(() => sessions.messages(id).some((message) => message.type === "idle"))
    const child = tools(id)[0].state.metadata.sessionID as string
    return { id, child }
  }

  test("what one asks during the turn that spawned it is still yours to answer after that turn", async () => {
    const { id, child } = await spawn(true)
    await Bun.sleep(50)
    expect(sessions.permissions(id)).toHaveLength(1)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "once")
    await until(() => sessions.messages(child).some((message) => message.type === "idle"))
    expect(JSON.stringify(sessions.messages(child))).toContain("Answered: accept")
  })

  test("Stop in its session stops it, and so does Codex stopping", async () => {
    const { child } = await spawn(false)
    expect(sessions.active()).toContain(child)
    expect(await sessions.interrupt(child)).toBe(true)
    await until(() => sessions.messages(child).some((message) => message.type === "idle"))
    expect(sessions.messages(child).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
  })

  test("restarted as you said to, a Codex started before the sandbox was on lets an agent it spawned finish first, then stops", async () => {
    const { id, child } = await spawn(true)
    expect(codex!.outside()).toBe(true)
    // Its turn is over, but the agent it spawned still works: it waits.
    expect(codex!.restartOutside()).toBe(true)
    expect(sessions.active()).toContain(child)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "once")
    await until(() => sessions.messages(child).some((message) => message.type === "idle"))
    expect(sessions.messages(child).at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" })
    expect(codex!.restartOutside()).toBe(false)
    await until(() => !codex!.outside())
  })

  test("one still at work when Codex stops ends with it", async () => {
    const { child } = await spawn(false)
    codex!.shutdown()
    await until(() => sessions.messages(child).some((message) => message.type === "idle"))
    expect(sessions.messages(child).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
  })
})

/**
 * A Codex whose turn spawns an agent (thread t2) that goes on after it (or is done by the turn's
 * end, `done`), saying whether it takes your messages (`direct`; unsaid, an older Codex): it
 * answers one into its turn ("Heard: …"), or a turn of its own once it's done ("Again: …"). With
 * `racing`, its turn ends just as a message comes, which turn/steer then turns away. A new
 * app-server (a restart) has to load t2 again before it takes a turn. What it's sent is kept.
 */
function messagedCodex(folder: string, direct: boolean | undefined, done: boolean, racing = false): string {
  const script = join(folder, "app-server.js")
  writeFileSync(
    script,
    `let buffer = ""
const { appendFileSync } = require("node:fs")
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const said = (text, turnId) => send({ method: "item/completed", params: { threadId: "t2", turnId, item: { type: "agentMessage", id: "a" + Math.random(), text } } })
const loaded = new Set()
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    appendFileSync(${JSON.stringify(join(folder, "sent.jsonl"))}, line + "\\n")
    const message = JSON.parse(line)
    if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "t1" } } })
    else if (message.method === "thread/resume" && message.params.threadId === "t2") {
      loaded.add("t2")
      send({ id: message.id, result: { thread: { id: "t2" } } })
    } else if (message.method === "turn/start" && message.params.threadId === "t2") {
      if (!loaded.has("t2")) {
        send({ id: message.id, error: { code: -32600, message: "thread not found: t2" } })
        continue
      }
      send({ id: message.id, result: { turn: { id: "u3", status: "inProgress" } } })
      send({ method: "turn/started", params: { threadId: "t2", turn: { id: "u3" } } })
      said("Again: " + message.params.input[0].text, "u3")
      send({ method: "turn/completed", params: { threadId: "t2", turn: { id: "u3", status: "completed" } } })
    } else if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: "u1", status: "inProgress" } } })
      send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } })
      loaded.add("t2")
      send({ method: "thread/started", params: { thread: { id: "t2", source: { subAgent: { thread_spawn: { parent_thread_id: "t1" } } }${direct === undefined ? "" : `, canAcceptDirectInput: ${direct}`} } } })
      send({ method: "item/completed", params: { threadId: "t1", turnId: "u1", item: { type: "subAgentActivity", id: "sa1", kind: "started", agentThreadId: "t2", agentPath: "/root/worker" } } })
      send({ method: "turn/started", params: { threadId: "t2", turn: { id: "u2" } } })
      if (${done}) {
        said("First pass.", "u2")
        send({ method: "turn/completed", params: { threadId: "t2", turn: { id: "u2", status: "completed" } } })
      }
      setTimeout(() => send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed" } } }), 50)
    } else if (message.method === "turn/steer" && message.params.threadId === "t2" && ${racing}) {
      send({ id: message.id, error: { code: -32600, message: "no active turn to steer" } })
      send({ method: "turn/completed", params: { threadId: "t2", turn: { id: "u2", status: "completed" } } })
    } else if (message.method === "turn/steer" && message.params.threadId === "t2") {
      send({ id: message.id, result: { turnId: "u2" } })
      said("Heard: " + message.params.input[0].text, "u2")
      send({ method: "turn/completed", params: { threadId: "t2", turn: { id: "u2", status: "completed" } } })
    } else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
  )
  const launcher = join(folder, "codex")
  writeFileSync(launcher, `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

describe("Writing to an agent Codex spawned", () => {
  async function spawn(direct: boolean | undefined, done: boolean, racing = false) {
    codex = new TestCodex(messagedCodex(root, direct, done, racing), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Spawn", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root } }).id
    sessions.prompt(id, { id: "msg_codex_test_003", text: "go", files: [], delivery: "steer" })
    await until(() => ended(id))
    const child = tools(id)[0].state.metadata.sessionID as string
    return { id, child }
  }
  const said = (id: string) => sessions.messages(id).flatMap((message: any) => (message.type === "user" ? [message.text] : message.type === "assistant" ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text) : []))
  const idles = (id: string) => sessions.messages(id).filter((message) => message.type === "idle")

  test("while it works: your message shows in its conversation, and it takes it at its next step", async () => {
    const { id, child } = await spawn(true, false)
    expect(sessions.get(child).metadata?.kuvo).toMatchObject({ messages: { via: "direct" } })
    expect(sessions.active()).toContain(child)
    sessions.prompt(child, { id: "msg_codex_child_01", text: "Check the tests too", files: [], delivery: "steer" })
    // At once, before Codex answers.
    expect(said(child)).toContain("Check the tests too")
    await until(() => idles(child).length === 1)
    expect(said(child).slice(-2)).toEqual(["Check the tests too", "Heard: Check the tests too"])
    expect(sent().find((message) => message.method === "turn/steer")?.params).toMatchObject({ threadId: "t2", expectedTurnId: "u2" })
    // The conversation that started it didn't run again.
    expect(idles(id)).toHaveLength(1)
  })

  test("once it's done: your message starts it again, in its own conversation", async () => {
    const { id, child } = await spawn(true, true)
    await until(() => idles(child).length === 1)
    sessions.prompt(child, { id: "msg_codex_child_02", text: "One more thing", files: [], delivery: "steer" })
    await until(() => idles(child).length === 2)
    expect(said(child).slice(-3)).toEqual(["First pass.", "One more thing", "Again: One more thing"])
    expect(idles(child).at(-1)).toMatchObject({ outcome: "succeeded" })
    expect(sent().find((message) => message.method === "turn/start" && message.params.threadId === "t2")).toBeTruthy()
    expect(idles(id)).toHaveLength(1)
  })

  test("its turn ending just as your message comes: a turn of its own takes it", async () => {
    const { child } = await spawn(true, false, true)
    sessions.prompt(child, { id: "msg_codex_child_04", text: "And the docs", files: [], delivery: "steer" })
    await until(() => said(child).includes("Again: And the docs"))
    expect(sessions.messages(child).some((message) => message.type === "synthetic")).toBe(false)
  })

  test("after the bridge starts again (Codex too), you still write to one that's done, in the same conversation", async () => {
    const { child } = await spawn(true, true)
    await until(() => idles(child).length === 1)
    sessions.closeAll()
    codex!.shutdown()
    codex = new TestCodex(messagedCodex(root, true, true), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    expect(sessions.get(child).metadata?.kuvo).toMatchObject({ messages: { via: "direct" } })
    sessions.prompt(child, { id: "msg_codex_child_05", text: "Still there?", files: [], delivery: "steer" })
    await until(() => idles(child).length === 2)
    expect(said(child).slice(-2)).toEqual(["Still there?", "Again: Still there?"])
    // The new Codex loaded its thread first.
    expect(sent().some((message) => message.method === "thread/resume" && message.params.threadId === "t2")).toBe(true)
  })

  test("a Codex that doesn't say whether its agents take messages: you're told to write to the conversation that started it", async () => {
    const { child } = await spawn(undefined, false)
    expect(sessions.get(child).metadata?.kuvo).toMatchObject({ messages: { via: "none" } })
    expect(() => sessions.prompt(child, { id: "msg_codex_child_06", text: "hello", files: [], delivery: "steer" })).toThrow("write to the conversation that started it")
  })

  test("one that takes messages only from the agent that started it says so, and nothing is sent", async () => {
    const { child } = await spawn(false, false)
    const line = "Codex agents of this kind take messages only from the agent that started them."
    expect(sessions.get(child).metadata?.kuvo).toMatchObject({ messages: { via: "none", note: line } })
    expect(() => sessions.prompt(child, { id: "msg_codex_child_03", text: "hello", files: [], delivery: "steer" })).toThrow(line)
    expect(said(child)).not.toContain("hello")
    expect(sent().some((message) => message.params?.threadId === "t2")).toBe(false)
  })
})

describe("Codex's context", () => {
  test("how full it is, as its last request was, against the window Codex says its model has", async () => {
    const id = await run([
      ["item/started", { item: { type: "agentMessage", id: "m1", text: "" } }],
      ["item/agentMessage/delta", { itemId: "m1", delta: "Done." }],
      ["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }],
      ["thread/tokenUsage/updated", { tokenUsage: { modelContextWindow: 258_400, last: { inputTokens: 52_000, cachedInputTokens: 48_000, outputTokens: 900, reasoningOutputTokens: 300 } } }],
    ])
    const last = sessions.messages(id).filter((message: any) => message.type === "assistant").at(-1) as any
    expect(last.tokens).toMatchObject({ input: 4_000, output: 600, reasoning: 300, cache: { read: 48_000 } })
    const models = await codex!.models()
    expect(models.find((model) => model.id === "gpt-test")?.limit.context).toBe(258_400)
  })

  test("a model Codex keeps out of its picker isn't offered, and is still listed, marked, for what asks whether one runs", async () => {
    codex = new TestCodex(fakeCodex(root, []), root)
    expect((await codex!.models()).map((model) => model.id)).toEqual(["gpt-test"])
    const all = await codex!.models({ hidden: true })
    expect(all.map((model) => [model.id, model.hidden ?? false])).toEqual([["gpt-test", false], ["gpt-mini", true]])
  })

  test("what a turn used: each of its model calls counted once, those that only ran commands too", async () => {
    // (Codex tells a call's usage as the call ends, after the commands it ran.)
    const used = (input: number, cached: number, output: number, reasoning: number): [string, any] => [
      "thread/tokenUsage/updated",
      { tokenUsage: { modelContextWindow: 258_400, last: { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: reasoning, totalTokens: input + output } } },
    ]
    const id = await run([
      ["item/started", { item: command("c1", "ls") }],
      ["item/completed", { item: command("c1", "ls", { status: "completed", exitCode: 0, aggregatedOutput: "src\n" }) }],
      used(10_000, 8_000, 150, 50),
      ["item/started", { item: command("c2", "cat src/sum.ts") }],
      ["item/completed", { item: command("c2", "cat src/sum.ts", { status: "completed", exitCode: 0 }) }],
      used(11_000, 10_000, 250, 50),
      ["item/agentMessage/delta", { itemId: "m1", delta: "Done." }],
      ["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }],
      used(12_000, 11_000, 350, 50),
    ])
    // The turn's "N tokens": what its steps wrote, added up.
    expect(steps(id).reduce((sum, step) => sum + (step.tokens?.output ?? 0) + (step.tokens?.reasoning ?? 0), 0)).toBe(750)
    expect(sessions.get(id).tokens).toEqual({ input: 4_000, output: 600, reasoning: 150, cache: { read: 29_000, write: 0 } })
    // How full it is: as the last call left it.
    expect(steps(id).at(-1).tokens).toMatchObject({ input: 1_000, output: 300, cache: { read: 11_000 } })
  })
})

describe("Stopping Codex", () => {
  test("Stop: Codex is told to stop the turn it's on, the command it was running shows stopped, and the session ends stopped", async () => {
    const id = start([["item/started", { item: command("c1", "npm run dev") }], ["item/commandExecution/outputDelta", { itemId: "c1", delta: "listening on 3000\n" }], untilStopped])
    await until(() => tools(id)[0]?.state.metadata?.output === "listening on 3000\n")
    expect(await sessions.interrupt(id)).toBe(true)
    await until(() => ended(id))
    expect(sent().filter((message) => message.method === "turn/interrupt").map((message) => message.params)).toEqual([{ threadId: "t1", turnId: "u1" }])
    expect(sessions.messages(id).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
    expect(tools(id)[0].state).toMatchObject({ status: "error", error: { type: "aborted" }, content: [{ type: "text", text: "Stopped." }] })
  })

  test("its account removed while it works (Settings › Accounts): the turn ends as stopped, without Stop", async () => {
    const id = start([["item/started", { item: command("c1", "npm run dev") }], untilStopped])
    await until(() => tools(id).length > 0)
    // As removing an account does: its conversations close, and its Codex stops.
    sessions.forgetProvider(codex!.providerID)
    codex!.shutdown()
    await until(() => ended(id))
    expect(sessions.messages(id).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
  })
})

describe("summarizing when you ask (/compact)", () => {
  test("Codex is asked with its own request, no turn of words: the row shows it, with no reply or note", async () => {
    const said: [string, any][] = [["item/completed", { item: { type: "agentMessage", id: "m1", text: "The word is HARBOUR." } }]]
    const id = await run(said)
    const before = steps(id).length
    expect(sessions.compact(id).state).toBe("compacting")
    await until(() => sessions.messages(id).filter((message) => message.type === "idle").length === 2)
    expect(sent().filter((message) => message.method === "thread/compact/start").map((message) => message.params)).toEqual([{ threadId: "t1" }])
    expect(sent().filter((message) => message.method === "turn/start")).toHaveLength(1)
    expect(steps(id)).toHaveLength(before)
    expect(sessions.messages(id).filter((message) => message.type === "synthetic")).toEqual([])
    expect(sessions.messages(id).find((message) => message.type === "compaction")).toMatchObject({ status: "completed", reason: "manual" })
  })

  // As Codex 0.166 does one by itself (seen with a real one): the item starts, and completes a
  // couple of seconds later, at a turn's start or partway through.
  const summary = { type: "contextCompaction", id: "cc0" }

  test("one it does by itself shows as it runs, last in the conversation, and ends as one finished row, not a note", async () => {
    const id = start([["item/started", { item: summary }], untilTold, ["item/completed", { item: summary }], ["item/completed", { item: { type: "agentMessage", id: "m1", text: "Done." } }]])
    await until(() => sessions.messages(id).some((message) => message.type === "compaction"))
    expect(sessions.messages(id).at(-1)).toMatchObject({ type: "compaction", status: "running", reason: "auto" })
    sessions.prompt(id, { id: "msg_codex_test_002", text: "carry on", files: [], delivery: "steer" })
    await until(() => ended(id))
    expect(sessions.messages(id).filter((message) => message.type === "compaction")).toMatchObject([{ status: "completed", reason: "auto" }])
    expect(notices(id)).toEqual([])
  })

  test("one it does by itself that Stop cuts short isn't left under way", async () => {
    const id = start([["item/started", { item: summary }], untilStopped])
    await until(() => sessions.messages(id).some((message) => message.type === "compaction"))
    await sessions.interrupt(id)
    await until(() => ended(id))
    expect(sessions.messages(id).filter((message) => message.type === "compaction")).toMatchObject([{ status: "failed", reason: "auto" }])
  })

  test("one you asked for is one row, not a second for the item Codex does it with", async () => {
    await run([["item/completed", { item: { type: "agentMessage", id: "m1", text: "Hi." } }]])
    const id = sessions.list()[0].id
    sessions.compact(id)
    await until(() => sessions.messages(id).filter((message) => message.type === "idle").length === 2)
    expect(sessions.messages(id).filter((message) => message.type === "compaction")).toMatchObject([{ status: "completed", reason: "manual" }])
  })

  test("asked during a turn it isn't sent until that turn ends: Codex would stop the turn", async () => {
    const id = start([untilStopped])
    await until(() => existsSync(join(root, "sent.jsonl")) && sent().some((message) => message.method === "turn/start"))
    expect(sessions.compact(id).state).toBe("waiting")
    // What was sent before the Stop is in the file before it, and Stop lets a waiting summary go.
    await sessions.interrupt(id)
    await until(() => sessions.messages(id).some((message) => message.type === "idle"))
    const methods = sent().map((message) => message.method)
    expect(methods).toContain("turn/interrupt")
    expect(methods).not.toContain("thread/compact/start")
  })

  test("Stop during it: its own turn is told to stop, and the row says it didn't", async () => {
    const id = await run([summaryUntilStopped])
    expect(sessions.compact(id).state).toBe("compacting")
    await until(() => sent().some((message) => message.method === "thread/compact/start"))
    await sessions.interrupt(id)
    await until(() => sessions.messages(id).filter((message) => message.type === "idle").length === 2)
    expect(sent().filter((message) => message.method === "turn/interrupt").map((message) => message.params)).toEqual([{ threadId: "t1", turnId: "c1" }])
    expect(sessions.messages(id).find((message) => message.type === "compaction")).toMatchObject({ status: "failed" })
    expect(sessions.messages(id).filter((message) => message.type === "idle").at(-1)).toMatchObject({ outcome: "interrupted" })
  })
})

describe("Codex, instructions that changed as its thread goes on", () => {
  test("its folder changed: the thread it goes on with is told what changed, once; unchanged, nothing extra", async () => {
    codex = new TestCodex(fakeCodex(root, []), root)
    const agent = codex
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (id: string | undefined) => (id === agent.providerID ? agent : undefined) } as unknown as Roster, new Auto(root))
    const id = sessions.create({ title: "Codex", model: { providerID: agent.providerID, id: "gpt-test" }, location: { directory: root } }).id
    const idles = () => sessions.messages(id).filter((message) => message.type === "idle").length
    const said = () => sent().filter((message) => message.method === "turn/start").map((message) => message.params.input[0].text as string)
    const send = async (text: string, turns: number) => {
      sessions.prompt(id, { id: `msg_codex_told_${turns}`, text, files: [], delivery: "steer" })
      await until(() => idles() === turns)
    }
    sessions.setInstruction(id, "kuvo.worktree", "You work in the worktree at /old/place/tree.")
    await send("first", 1)
    // A new thread has them as its developer instructions: no note.
    expect(sent().find((message) => message.method === "thread/start").params.developerInstructions).toContain("/old/place/tree")
    expect(said()).toEqual(["first"])
    sessions.setInstruction(id, "kuvo.worktree", "You work in the worktree at /new/place/tree.")
    await send("second", 2)
    // The same thread, loaded again, keeps the ones it started with: what changed goes with the message.
    expect(sent().filter((message) => message.method === "thread/resume")).toHaveLength(1)
    const told = said()[1]
    expect(told).toContain("You work in the worktree at /new/place/tree.")
    expect(told).toMatch(/Replaced or taken out:\s+You work in the worktree at \/old\/place\/tree\./)
    expect(told.endsWith("\n\nsecond")).toBe(true)
    // Not its asking words, which didn't change.
    expect(told).not.toContain("request_user_input_async")
    await send("third", 3)
    expect(said()[2]).toBe("third")
  })
})
