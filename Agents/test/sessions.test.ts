// Sessions with scripted agents: what's waiting and when it goes, Stop, moving between agents,
// Auto down its list, and what a session keeps. Each test has a folder of its own, removed after.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpThread } from "../src/acp"
import { AntigravityFollower } from "../src/agents/antigravity"
import type { Agent, RunInput, RunResult, Thread, TurnHooks } from "../src/agent"
import { Auto } from "../src/auto"
import { subscribe } from "../src/events"
import type { Roster } from "../src/roster"
import { Sessions, timing } from "../src/sessions"
import { Snapshots } from "../src/snapshots"
import { Store } from "../src/store"
import type { Turn } from "../src/turn"
import type { Message, ServerEvent } from "../src/wire"

type Script = (input: RunInput, turn: Turn, hooks: TurnHooks, thread: FakeThread) => Promise<RunResult>

const replies: Script = async (input, turn) => {
  turn.startStep()
  turn.text(`${input.model.providerID}/${input.model.id} on: ${input.text.split("User message:\n").pop()}`)
  turn.endStep()
  return { outcome: "succeeded" }
}

/** Runs until it's stopped. */
const works: Script = (_input, turn, _hooks, thread) => {
  turn.startStep()
  turn.text("working")
  return new Promise((resolve) => (thread.onStop = () => resolve({ outcome: "interrupted" })))
}

class FakeAgent implements Agent {
  id = "fake"
  instance = { id: "default" }
  signedIn = true
  /** Its models run where a request it can't send is dropped (the engine's), and it's signed out of. */
  dropsSignedOut?: boolean
  script: Script = replies
  runs: { text: string; model: string; state: Record<string, unknown> }[] = []
  threads: FakeThread[] = []

  constructor(
    readonly providerID: string,
    readonly name: string,
  ) {}

  methods() {
    return []
  }
  async account() {
    return { installed: true, signedIn: this.signedIn }
  }
  async models() {
    return []
  }
  async signedOut() {
    return this.dropsSignedOut === true
  }
  thread(_session: unknown, state: Record<string, unknown>): Thread {
    const thread = new FakeThread(this, state)
    this.threads.push(thread)
    return thread
  }
}

class FakeThread implements Thread {
  interrupted = 0
  closed = false
  turnedAway = 0
  onOwnTurn?: Thread["onOwnTurn"]
  onStop?: () => void
  steer?: (input: { id: string; text: string; files: unknown[] }) => Promise<boolean>
  /** Its next prepare says it started over. */
  fresh = false
  /** Its prepare never ends, or fails. */
  prepareHangs = false
  prepareFails = false

  async prepare() {
    if (this.prepareHangs) await new Promise(() => {})
    if (this.prepareFails) throw new Error("It couldn't start.")
    const fresh = this.fresh
    this.fresh = false
    return { fresh }
  }

  constructor(
    readonly agent: FakeAgent,
    readonly state: Record<string, unknown>,
  ) {}

  run(input: RunInput, turn: Turn, hooks: TurnHooks) {
    this.agent.runs.push({ text: input.text, model: input.model.id, state: this.state })
    return this.agent.script(input, turn, hooks, this)
  }
  async interrupt() {
    this.interrupted++
    this.onStop?.()
  }
  close() {
    this.closed = true
  }
  turnAway() {
    this.turnedAway++
  }
}

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-agents-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let root: string
let store: Store
let auto: Auto
let a: FakeAgent
let b: FakeAgent
let sessions: Sessions
let events: ServerEvent[]
let unsubscribe: () => void

function make() {
  store = new Store(join(root, "sessions"))
  auto = new Auto(root)
  const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
  sessions = new Sessions(store, { find: (id: string | undefined) => (id ? agents.get(id) : undefined) } as unknown as Roster, auto)
}

beforeEach(() => {
  root = mkdtempSync(join(base, "case-"))
  a = new FakeAgent("alpha", "Alpha")
  b = new FakeAgent("beta", "Beta")
  events = []
  unsubscribe = subscribe((event) => events.push(event))
  make()
})

afterEach(() => {
  unsubscribe()
  sessions.closeAll()
  timing.stopGrace = 8_000
})

async function until(condition: () => boolean, ms = 3_000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

function create(model = { providerID: "alpha", id: "one" }) {
  return sessions.create({ model, location: { directory: "/tmp/project" } }).id
}

let counter = 0
function send(id: string, text: string, delivery: "steer" | "queue" = "steer") {
  const inputID = `msg_test${String(++counter).padStart(8, "0")}`
  sessions.prompt(id, { id: inputID, text, files: [], delivery })
  return inputID
}

const idles = (id: string) => sessions.messages(id).filter((message) => message.type === "idle") as Extract<Message, { type: "idle" }>[]
const texts = (id: string) =>
  sessions
    .messages(id)
    .flatMap((message) => (message.type === "assistant" ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : []))
const settled = (id: string, count: number, ms?: number) => until(() => idles(id).length >= count && !sessions.active().includes(id), ms)

describe("what's waiting", () => {
  test("a message starts at once, and one sent meanwhile waits for it", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    send(id, "second")
    expect(sessions.inbox(id).map((item) => item.delivery)).toEqual(["queue"])
    a.script = replies
    a.threads[0].onStop!()
    // Stopped: the one waiting stays.
    await settled(id, 1)
    expect(sessions.inbox(id)).toHaveLength(1)
    expect(a.runs).toHaveLength(1)
  })

  test("after a turn that ends on its own, the next one goes", async () => {
    let release!: () => void
    a.script = (input, turn) => {
      if (input.text !== "first") return replies(input, turn, {} as TurnHooks, {} as FakeThread)
      return new Promise((resolve) => (release = () => resolve({ outcome: "succeeded" })))
    }
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    send(id, "second")
    release()
    await settled(id, 2)
    expect(a.runs.map((run) => run.text)).toEqual(["first", "second"])
    expect(sessions.inbox(id)).toHaveLength(0)
  })

  test("Stop holds what waits; steering it starts it", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    const waiting = send(id, "second")
    await sessions.interrupt(id)
    await settled(id, 1)
    expect(idles(id)[0].outcome).toBe("interrupted")
    expect(a.runs).toHaveLength(1)
    a.script = replies
    sessions.setDelivery(id, waiting, "steer")
    await settled(id, 2)
    expect(a.runs.map((run) => run.text)).toEqual(["first", "second"])
  })

  test("Send Now: the message you picked goes next, not the first in line", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    send(id, "second")
    const picked = send(id, "third")
    a.script = replies
    sessions.setDelivery(id, picked, "steer")
    await sessions.interrupt(id, true)
    // Then, as that one ends on its own, the rest in line.
    await settled(id, 3)
    expect(a.runs.map((run) => run.text)).toEqual(["first", "third", "second"])
    expect(sessions.inbox(id)).toHaveLength(0)
  })

  test("a queued message while nothing runs goes at once, as the engine's do; behind others held, it waits", async () => {
    const id = create()
    send(id, "now", "queue")
    await settled(id, 1)
    expect(a.runs).toHaveLength(1)
    a.script = works
    send(id, "working")
    await until(() => a.runs.length === 2)
    const held = send(id, "held", "queue")
    await sessions.interrupt(id)
    await settled(id, 2)
    // Held after the Stop: one queued behind it waits too, until a nudge.
    send(id, "behind", "queue")
    await Bun.sleep(30)
    expect(a.runs).toHaveLength(2)
    a.script = replies
    sessions.setDelivery(id, held, "steer")
    await settled(id, 4)
    expect(a.runs.map((run) => run.text)).toEqual(["now", "working", "held", "behind"])
  })

  test("after an error, nothing more starts on its own", async () => {
    a.script = async () => ({ outcome: "failed", error: { type: "agent", message: "broke" } })
    let release!: () => void
    const failing = a.script
    a.script = (input, turn, hooks, thread) =>
      input.text === "first" ? new Promise((resolve) => (release = () => resolve({ outcome: "failed", error: { type: "agent", message: "broke" } }))) : failing(input, turn, hooks, thread)
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    send(id, "second")
    release()
    await settled(id, 1)
    await Bun.sleep(30)
    expect(a.runs).toHaveLength(1)
    expect(idles(id)[0].error?.message).toBe("broke")
  })

  test("a model whose account you signed out of, where it'd be dropped without a word, says so and keeps nothing waiting", async () => {
    a.dropsSignedOut = true
    const id = create()
    send(id, "hello")
    await settled(id, 1)
    expect(a.runs).toHaveLength(0)
    expect(idles(id)[0].outcome).toBe("failed")
    expect(idles(id)[0].error).toEqual({ type: "provider.auth", message: "Alpha isn't signed in. Sign in to it in Settings › Accounts, or pick another model." })
  })

  test("a message sent twice goes once", async () => {
    const id = create()
    sessions.prompt(id, { id: "msg_twice0000001", text: "hi", files: [], delivery: "steer" })
    sessions.prompt(id, { id: "msg_twice0000001", text: "hi", files: [], delivery: "steer" })
    await settled(id, 1)
    await Bun.sleep(20)
    expect(a.runs).toHaveLength(1)
  })

  test("what waits outlasts the bridge", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    send(id, "second")
    sessions.closeAll()
    store.flush()
    make()
    expect(sessions.inbox(id).map((item) => item.payload.text)).toEqual(["second"])
    expect(idles(id).at(-1)?.outcome).toBe("interrupted")
  })

  test("a message sent while a session is being deleted starts nothing", async () => {
    timing.stopGrace = 50
    a.script = (_input, turn) => {
      turn.startStep()
      return new Promise(() => {})
    }
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    const removed = sessions.remove(id)
    expect(() => send(id, "late")).toThrow()
    await removed
    await Bun.sleep(100)
    expect(a.runs).toHaveLength(1)
    expect(sessions.list().some((session) => session.id === id)).toBe(false)
    expect(sessions.active()).not.toContain(id)
  })

  test("deleting a session starts nothing that waited", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    send(id, "second")
    await sessions.remove(id)
    await Bun.sleep(30)
    expect(a.runs).toHaveLength(1)
  })
})

describe("Stop", () => {
  test("an agent that doesn't stop is given up on", async () => {
    timing.stopGrace = 50
    a.script = (_input, turn) => {
      turn.startStep()
      turn.text("ignoring you")
      return new Promise(() => {})
    }
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    await sessions.interrupt(id)
    await settled(id, 1)
    expect(idles(id)[0].outcome).toBe("interrupted")
    expect(a.threads[0].closed).toBe(true)
    // What it says now doesn't go in.
    const before = JSON.stringify(sessions.messages(id))
    a.script = replies
    send(id, "again")
    await settled(id, 2)
    expect(a.threads).toHaveLength(2)
    expect(JSON.stringify(sessions.messages(id)).startsWith(before.slice(0, -1))).toBe(true)
  })

  test("asks still open are answered no", async () => {
    let decision: string | undefined
    a.script = async (_input, _turn, hooks) => {
      decision = await hooks.permission({ action: "shell", resources: ["rm -rf build"] })
      return { outcome: "interrupted" }
    }
    const id = create()
    sessions.update(id, { permissions: [{ action: "shell", resource: "*", effect: "ask" }] })
    send(id, "go")
    await until(() => sessions.permissions(id).length === 1)
    await sessions.interrupt(id)
    await settled(id, 1)
    expect(decision).toBe("reject")
    expect(sessions.permissions(id)).toHaveLength(0)
  })
})

describe("permissions", () => {
  test("Approve All with a rule that refuses something asks here, and the rule answers", async () => {
    const seen: (boolean | string)[] = []
    a.script = async (_input, _turn, hooks) => {
      seen.push(hooks.approvesAll())
      seen.push(await hooks.permission({ action: "shell", resources: ["rm -rf /"] }))
      seen.push(await hooks.permission({ action: "shell", resources: ["ls"] }))
      return { outcome: "succeeded" }
    }
    const id = create()
    sessions.update(id, { permissions: [{ action: "shell", resource: "rm *", effect: "deny" }] })
    send(id, "go")
    await settled(id, 1)
    expect(seen).toEqual([false, "reject", "once"])
  })

  test("plan mode refuses changes and doesn't approve all", async () => {
    const seen: (boolean | string)[] = []
    a.script = async (_input, _turn, hooks) => {
      seen.push(hooks.approvesAll())
      seen.push(await hooks.permission({ action: "edit", resources: ["/tmp/project/a.ts"] }))
      return { outcome: "succeeded" }
    }
    const id = create()
    sessions.selectAgent(id, "plan")
    send(id, "go")
    await settled(id, 1)
    expect(seen).toEqual([false, "reject"])
    expect(sessions.messages(id).some((message) => message.type === "agent-switched")).toBe(true)
  })

  test("Always on a command lets that command through, not a line that adds another", async () => {
    const answers: string[] = []
    a.script = async (_input, _turn, hooks) => {
      answers.push(await hooks.permission({ action: "shell", resources: ["npm test"], save: ["npm test *"] }))
      answers.push(await hooks.permission({ action: "shell", resources: ["npm test -- a"] }))
      answers.push(await hooks.permission({ action: "shell", resources: ["npm test && rm -rf build"] }))
      return { outcome: "succeeded" }
    }
    const id = create()
    sessions.update(id, { permissions: [{ action: "shell", resource: "*", effect: "ask" }] })
    send(id, "go")
    await until(() => sessions.permissions(id).length === 1)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
    await until(() => sessions.permissions(id).length === 1)
    expect(sessions.permissions(id)[0].resources).toEqual(["npm test && rm -rf build"])
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "reject")
    await settled(id, 1)
    expect(answers).toEqual(["always", "once", "reject"])
  })

  test("Always on a command doesn't let through one after a comment or in a here-document's line", async () => {
    const answers: string[] = []
    a.script = async (_input, _turn, hooks) => {
      answers.push(await hooks.permission({ action: "shell", resources: ["npm test"], save: ["npm test *"] }))
      answers.push(await hooks.permission({ action: "shell", resources: ["npm test # it's quick\nrm -rf build"] }))
      answers.push(await hooks.permission({ action: "shell", resources: ["npm test <<EOF && rm -rf build\nx\nEOF"] }))
      return { outcome: "succeeded" }
    }
    const id = create()
    sessions.update(id, { permissions: [{ action: "shell", resource: "*", effect: "ask" }] })
    send(id, "go")
    await until(() => sessions.permissions(id).length === 1)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
    await until(() => sessions.permissions(id).length === 1 && sessions.permissions(id)[0].resources[0].includes("rm"))
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "reject")
    await until(() => sessions.permissions(id).length === 1 && sessions.permissions(id)[0].resources[0].includes("EOF"))
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "reject")
    await settled(id, 1)
    expect(answers).toEqual(["always", "reject", "reject"])
  })

  test("Always also lets through what else waits on the same thing", async () => {
    const answers: string[] = []
    a.script = async (_input, _turn, hooks) => {
      const first = hooks.permission({ action: "shell", resources: ["git status"], save: ["git *"] })
      const second = hooks.permission({ action: "shell", resources: ["git diff"], save: ["git *"] })
      answers.push(...(await Promise.all([first, second])))
      answers.push(await hooks.permission({ action: "shell", resources: ["git log"] }))
      return { outcome: "succeeded" }
    }
    const id = create()
    sessions.update(id, { permissions: [{ action: "shell", resource: "*", effect: "ask" }] })
    send(id, "go")
    await until(() => sessions.permissions(id).length === 2)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "always")
    await settled(id, 1)
    expect(answers).toEqual(["always", "once", "once"])
  })
})

describe("asks and conversations", () => {
  test("what the engine asks first (reading .env) is yours to answer, even with Approve All", async () => {
    let decided: string | undefined
    a.script = async (_input, turn, hooks) => {
      decided = await hooks.permission({ action: "read", resources: [".env"], weighed: true })
      turn.startStep()
      turn.text("read it")
      turn.endStep()
      return { outcome: "succeeded" }
    }
    const id = create()
    send(id, "read the env")
    await until(() => sessions.permissions(id).length === 1)
    expect(decided).toBeUndefined()
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "reject")
    await settled(id, 1)
    expect(decided).toBe("reject")
  })

  test("Settings' Blocks refuse what they block, even with Approve All, and keep the agent asking", async () => {
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, async () => [
      { action: "shell", resource: "git push *", effect: "deny" },
    ])
    let approvesAll: boolean | undefined
    let checked: unknown[] = []
    const decided: string[] = []
    a.script = async (_input, turn, hooks) => {
      approvesAll = hooks.approvesAll()
      decided.push(await hooks.permission({ action: "shell", resources: ["git push origin main"] }))
      decided.push(await hooks.permission({ action: "shell", resources: ["git status"] }))
      // A command line's commands each count.
      decided.push(await hooks.permission({ action: "shell", resources: ["git add -A && git commit -m x && git push origin main"] }))
      decided.push(await hooks.permission({ action: "shell", resources: ["cd /tmp/project; git push"] }))
      checked = [hooks.check({ action: "shell", resources: ["ls | git push"] }), hooks.check({ action: "shell", resources: ["ls"] })]
      turn.startStep()
      turn.text("done")
      turn.endStep()
      return { outcome: "succeeded" }
    }
    const id = create()
    send(id, "push it")
    await settled(id, 1)
    expect(approvesAll).toBe(false)
    expect(decided).toEqual(["reject", "once", "reject", "reject"])
    expect(checked).toEqual(["deny", undefined])
    expect(sessions.permissions(id)).toHaveLength(0)
  })

  test("an agent of yours (Settings › Agents) keeps its name, and its agent is told what it's told", async () => {
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, undefined, async (name) =>
      name === "reviewer" ? { system: "Review the code; change nothing.", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "deny" }] } : undefined,
    )
    let told = ""
    let edit: string | undefined
    a.script = async (input, turn, hooks, thread) => {
      told = hooks.instructions()
      edit = await hooks.permission({ action: "edit", resources: ["/tmp/project/a.ts"] })
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, agent: "reviewer", location: { directory: "/tmp/project" } }).id
    expect(sessions.get(id).agent).toBe("reviewer")
    send(id, "look at it")
    await settled(id, 1)
    expect(told).toContain("Review the code; change nothing.")
    // Its own rules hold: it may not edit.
    expect(edit).toBe("reject")
    // Back to Build: it isn't told any more.
    sessions.selectAgent(id, "build")
    send(id, "now fix it")
    await settled(id, 2)
    expect(told).not.toContain("Review the code")
  })

  test("Blocks not known (the engine can't be reached): the agent asks, rather than run on its own", async () => {
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    let reads = 0
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, async () => {
      reads++
      return undefined
    })
    let approvesAll: boolean | undefined
    let cannotAsk: boolean | undefined
    let checked: unknown[] = []
    let decided: string | undefined
    a.script = async (input, turn, hooks, thread) => {
      approvesAll = hooks.approvesAll()
      cannotAsk = hooks.approvesAll(false)
      checked = [hooks.check({ action: "shell", resources: ["git push"] }), hooks.check({ action: "read", resources: ["/tmp/project/a.ts"] })]
      decided = await hooks.permission({ action: "shell", resources: ["git push"] })
      return replies(input, turn, hooks, thread)
    }
    const id = create()
    send(id, "go")
    // Read again before asking, and asked, since they still aren't known.
    await until(() => sessions.permissions(id).length === 1)
    expect(reads).toBe(2)
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "reject")
    await settled(id, 1)
    expect(approvesAll).toBe(false)
    // An agent that can't ask isn't held back by Blocks no one knows.
    expect(cannotAsk).toBe(true)
    expect(checked).toEqual(["ask", undefined])
    expect(decided).toBe("reject")
  })

  test("known Blocks that refuse something hold back even an agent that can't ask", async () => {
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, async () => [
      { action: "shell", resource: "git push *", effect: "deny" },
    ])
    let cannotAsk: boolean | undefined
    a.script = async (input, turn, hooks, thread) => {
      cannotAsk = hooks.approvesAll(false)
      return replies(input, turn, hooks, thread)
    }
    const id = create()
    send(id, "go")
    await settled(id, 1)
    expect(cannotAsk).toBe(false)
  })

  test("an agent of yours that refuses edits doesn't approve all, and its rules don't outlast a switch", async () => {
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    let engineAnswers = true
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, async () => [], async (name) =>
      !engineAnswers
        ? undefined
        : name === "reviewer"
          ? { system: "Change nothing.", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "deny" }] }
          : { permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "read", resource: "*.env", effect: "ask" }, { action: "browser", resource: "*", effect: "deny" }] },
    )
    const seen: unknown[] = []
    a.script = async (input, turn, hooks, thread) => {
      seen.push(hooks.approvesAll(), await hooks.permission({ action: "edit", resources: ["/tmp/project/a.ts"] }))
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, agent: "reviewer", location: { directory: "/tmp/project" } }).id
    send(id, "look")
    await settled(id, 1)
    // Build: its .env ask and its browser rule don't stop it approving all.
    sessions.selectAgent(id, "build")
    send(id, "fix it")
    await settled(id, 2)
    // Back to the reviewer while the engine doesn't answer, then to Build: the reviewer's rules
    // aren't Build's.
    sessions.selectAgent(id, "reviewer")
    send(id, "look again")
    await settled(id, 3)
    engineAnswers = false
    sessions.selectAgent(id, "build")
    send(id, "fix it now")
    await settled(id, 4)
    expect(seen).toEqual([false, "reject", true, "once", false, "reject", true, "once"])
  })

  test("Claude Code's own plan mode isn't refused its plan file by the hook", async () => {
    let checked: unknown[] = []
    a.script = async (input, turn, hooks, thread) => {
      checked = [hooks.check({ action: "edit", resources: ["/home/me/.claude/plans/plan.md"] }, true), hooks.check({ action: "edit", resources: ["/tmp/project/a.ts"] })]
      return replies(input, turn, hooks, thread)
    }
    const id = create()
    sessions.selectAgent(id, "plan")
    send(id, "plan it")
    await settled(id, 1)
    expect(checked).toEqual([undefined, "deny"])
  })

  test("reading a .env file asks first, as on the engine; an example of one doesn't", async () => {
    const decided: string[] = []
    a.script = async (_input, turn, hooks) => {
      decided.push(await hooks.permission({ action: "read", resources: ["/tmp/project/.env.example"] }))
      decided.push(await hooks.permission({ action: "read", resources: ["/tmp/project/.env"] }))
      turn.startStep()
      turn.endStep()
      return { outcome: "succeeded" }
    }
    const id = create()
    send(id, "read the settings")
    await until(() => sessions.permissions(id).length === 1)
    expect(sessions.permissions(id)[0].resources).toEqual(["/tmp/project/.env"])
    sessions.replyPermission(id, sessions.permissions(id)[0].id, "once")
    await settled(id, 1)
    expect(decided).toEqual(["once", "once"])
  })

  test("Stop while an agent gets ready stops the turn", async () => {
    timing.stopGrace = 50
    const id = create()
    a.thread = ((session: unknown, state: Record<string, unknown>) => {
      const thread = new FakeThread(a, state)
      thread.prepareHangs = true
      a.threads.push(thread)
      return thread
    }) as any
    send(id, "go")
    await until(() => sessions.active().includes(id))
    await Bun.sleep(20)
    await sessions.interrupt(id)
    await settled(id, 1, 2_000)
    expect(idles(id)[0].outcome).toBe("interrupted")
    expect(a.threads[0].closed).toBe(true)
  })

  test("an agent that couldn't start fails the message, and the next starts it again", async () => {
    const id = create()
    let first = true
    a.thread = ((session: unknown, state: Record<string, unknown>) => {
      const thread = new FakeThread(a, state)
      thread.prepareFails = first
      first = false
      a.threads.push(thread)
      return thread
    }) as any
    send(id, "go")
    await settled(id, 1)
    expect(idles(id)[0].outcome).toBe("failed")
    expect(idles(id)[0].error?.message).toContain("couldn't start")
    expect(a.threads[0].closed).toBe(true)
    send(id, "again")
    await settled(id, 2)
    expect(idles(id)[1].outcome).toBe("succeeded")
    expect(a.threads).toHaveLength(2)
  })

  test("a conversation the agent couldn't pick up again is handed all that came before", async () => {
    const id = create()
    send(id, "first thing")
    await settled(id, 1)
    a.threads[0].fresh = true
    send(id, "second thing")
    await settled(id, 2)
    expect(a.runs[1].text).toContain("first thing")
    expect(a.runs[1].text).toContain("second thing")
  })
})

describe("undo", () => {
  test("undo puts the files back and hides the turn; redo brings them back; the next message makes it final", async () => {
    const folder = mkdtempSync(join(root, "repo-"))
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", folder, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    git("init", "-q")
    writeFileSync(join(folder, "a.txt"), "one\n")
    git("add", ".")
    git("commit", "-q", "-m", "first")
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, undefined, undefined, new Snapshots(join(root, "snapshots")))
    a.script = async (input, turn, hooks, thread) => {
      if (input.text.includes("change")) {
        writeFileSync(join(folder, "a.txt"), "two\n")
        writeFileSync(join(folder, "b.txt"), "new\n")
      }
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "change it")
    await settled(id, 1)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("two\n")

    const revert = await sessions.stageRevert(id, first)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\n")
    expect(existsSync(join(folder, "b.txt"))).toBe(false)
    expect(revert.files?.map((file) => file.file.split("/").pop()).sort()).toEqual(["a.txt", "b.txt"])
    expect(sessions.get(id).revert?.messageID).toBe(first)

    await sessions.clearRevert(id)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("two\n")
    expect(readFileSync(join(folder, "b.txt"), "utf8")).toBe("new\n")
    expect(sessions.get(id).revert).toBeUndefined()

    await sessions.stageRevert(id, first)
    a.threads.forEach((thread) => (thread.closed = false))
    send(id, "do something else")
    await settled(id, 1)
    // The undone turn is gone; the agent starts its conversation over.
    expect(sessions.messages(id).some((message) => message.type === "user" && message.text === "change it")).toBe(false)
    expect(events.some((event) => event.type === "session.revert.committed")).toBe(true)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\n")
    expect(a.threads.length).toBe(2)
  })
})

describe("titles and one-off answers", () => {
  test("a session is named from your first message: by the model for titles you picked, else the session's", async () => {
    const titler = new FakeAgent("zen", "Zen") as FakeAgent & { generate: (prompt: string, model?: { id: string }) => Promise<string> }
    titler.generate = async (_prompt, model) => `"Fixing the parser (${model?.id})."`
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    let picked: { providerID: string; id: string } | undefined = { providerID: "zen", id: "small" }
    sessions = new Sessions(
      store,
      { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined), all: () => [...agents.values()] } as unknown as Roster,
      auto,
      (provider) => (provider === "zen" ? titler : undefined),
      undefined,
      undefined,
      undefined,
      async () => picked,
    )
    const first = create()
    send(first, "the parser drops the last line, fix it")
    await settled(first, 1)
    await until(() => sessions.get(first).title === "Fixing the parser (small)")
    // None picked: the session's own model, when its agent can answer one so.
    picked = undefined
    ;(a as any).generate = async (prompt: string) => (prompt.includes("<message>") ? "Tidy the README" : "")
    const second = create()
    send(second, "tidy the readme")
    await settled(second, 1)
    await until(() => sessions.get(second).title === "Tidy the README")
    expect(await sessions.generate(second, "a commit message")).toBe("")
    // One that can't: another agent you're signed in to writes it, on a quick model of its own.
    delete (a as any).generate
    let asked: unknown = "none"
    ;(b as any).generate = async (_prompt: string, model?: unknown) => {
      asked = model
      return "Something else entirely"
    }
    const third = create()
    send(third, "something else")
    await settled(third, 1)
    await until(() => sessions.get(third).title === "Something else entirely")
    expect(asked).toBeUndefined()
    await expect(sessions.generate(third, "a commit message")).rejects.toThrow()
    // Not if it's signed out: no title from the bridge (the app names it).
    b.signedIn = false
    const fourth = create()
    send(fourth, "one more")
    await settled(fourth, 1)
    await Bun.sleep(30)
    expect(sessions.get(fourth).title).toBeFalsy()
    delete (b as any).generate
  })
})

describe("steering", () => {
  test("a message for an agent that takes one partway goes into its turn at once", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    const steered: string[] = []
    a.threads[0].steer = async (input) => {
      steered.push(input.text)
      return true
    }
    send(id, "also do this")
    await until(() => steered.length === 1)
    await until(() => sessions.inbox(id).length === 0)
    expect(sessions.messages(id).filter((message) => message.type === "user").map((message: any) => message.text)).toEqual(["first", "also do this"])
    a.threads[0].onStop!()
    await settled(id, 1)
    // It went into that turn: no second one for it.
    expect(a.runs).toHaveLength(1)
  })

  test("a text file sent partway goes in the message, as for one that starts a turn", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    const notes = join(root, "notes.md")
    writeFileSync(notes, "remember the milk\n")
    let steered: { text: string; files: unknown[] } | undefined
    a.threads[0].steer = async (input) => {
      steered = input
      return true
    }
    sessions.prompt(id, { id: "msg_test_steerfile", text: "and this", files: [{ uri: `file://${notes}`, name: "notes.md" }], delivery: "steer" })
    await until(() => steered !== undefined)
    expect(steered!.text).toContain("remember the milk")
    expect(steered!.files).toHaveLength(0)
    a.threads[0].onStop!()
    await settled(id, 1)
  })

  test("one cancelled while the agent takes it is sent all the same; one it turns away is cancelled", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    const answers: ((taken: boolean) => void)[] = []
    a.threads[0].steer = () => new Promise((resolve) => answers.push(resolve))
    const kept = send(id, "too late to cancel")
    await until(() => answers.length === 1)
    sessions.cancelInput(id, kept)
    expect(sessions.inbox(id)).toHaveLength(1)
    answers[0](true)
    await until(() => sessions.inbox(id).length === 0)
    expect(sessions.messages(id).some((message) => message.id === kept)).toBe(true)
    const dropped = send(id, "cancel me")
    await until(() => answers.length === 2)
    sessions.cancelInput(id, dropped)
    answers[1](false)
    await until(() => sessions.inbox(id).length === 0)
    expect(sessions.messages(id).some((message) => message.id === dropped)).toBe(false)
    expect(events.some((event) => event.type === "session.inbox.cancelled" && (event.data as any).inboxID === dropped)).toBe(true)
    a.threads[0].onStop!()
    await settled(id, 1)
    expect(a.runs).toHaveLength(1)
  })

  test("one taken just as its turn ends goes once, not again as a turn of its own", async () => {
    let finish!: () => void
    a.script = (input, turn) => {
      if (input.text !== "first") return replies(input, turn, {} as TurnHooks, {} as FakeThread)
      turn.startStep()
      return new Promise((resolve) => (finish = () => resolve({ outcome: "succeeded" })))
    }
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    let answer!: (taken: boolean) => void
    a.threads[0].steer = () => new Promise((resolve) => (answer = resolve))
    const late = send(id, "one more thing")
    await until(() => answer !== undefined)
    finish()
    await settled(id, 1)
    answer(true)
    await until(() => sessions.inbox(id).length === 0)
    await Bun.sleep(50)
    expect(sessions.messages(id).filter((message) => message.id === late)).toHaveLength(1)
    expect(a.runs).toHaveLength(1)
  })

  test("a message the agent never got to is handed to it with the next one", async () => {
    let steeredID = ""
    a.script = async (input, turn) => {
      if (a.runs.length > 1) return replies(input, turn, {} as TurnHooks, {} as FakeThread)
      turn.startStep()
      await until(() => steeredID !== "" && sessions.inbox(id).length === 0)
      turn.text("did the first")
      turn.endStep()
      return { outcome: "interrupted", missed: [steeredID] }
    }
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    a.threads[0].steer = async () => true
    steeredID = send(id, "and the second")
    await settled(id, 1)
    send(id, "go on")
    await settled(id, 2)
    expect(a.runs[1].text).toContain("and the second")
    expect(a.runs[1].text).toContain("go on")
  })

  test("one it turns away waits for the turn to end", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    a.threads[0].steer = async () => false
    send(id, "later")
    await until(() => sessions.inbox(id)[0]?.delivery === "queue")
    a.script = replies
    a.threads[0].onStop!()
    await settled(id, 1)
    expect(sessions.inbox(id)).toHaveLength(1)
  })
})

describe("undo, carefully", () => {
  // Each turn here snapshots the folder with git, which a busy Mac (CI) can make slow: given room.
  /** A git repository in the test's folder, with its first commit. */
  function repository(files: Record<string, string>, setup?: (folder: string) => void) {
    const folder = mkdtempSync(join(root, "repo-"))
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", folder, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    git("init", "-q")
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(folder, path, ".."), { recursive: true })
      writeFileSync(join(folder, path), text)
    }
    setup?.(folder)
    git("add", ".")
    git("commit", "-q", "-m", "first")
    return folder
  }

  function withSnapshots() {
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, undefined, undefined, new Snapshots(join(root, "snapshots")))
  }

  test("only what the turn changed goes back: your own edits and new files stay", async () => {
    const folder = repository({ "a.txt": "one\n", "b.txt": "mine\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "a.txt"), "agent\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "change a")
    await settled(id, 1, 20_000)
    // You, by hand, after it.
    writeFileSync(join(folder, "b.txt"), "mine, edited\n")
    writeFileSync(join(folder, "notes.txt"), "new of mine\n")
    await sessions.stageRevert(id, first)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\n")
    expect(readFileSync(join(folder, "b.txt"), "utf8")).toBe("mine, edited\n")
    expect(readFileSync(join(folder, "notes.txt"), "utf8")).toBe("new of mine\n")
    await sessions.clearRevert(id)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("agent\n")
  }, 30_000)

  test("undo from a message sent partway puts back what its turn changed after it", async () => {
    const folder = repository({ "a.txt": "one\n", "b.txt": "two\n" })
    withSnapshots()
    let steered = false
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "a.txt"), "before it\n")
      await until(() => steered)
      await Bun.sleep(20)
      writeFileSync(join(folder, "b.txt"), "after it\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    send(id, "change a")
    await until(() => a.runs.length === 1)
    a.threads[0].steer = async () => {
      steered = true
      return true
    }
    const partway = send(id, "now b")
    await settled(id, 1, 20_000)
    await sessions.stageRevert(id, partway)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("before it\n")
    expect(readFileSync(join(folder, "b.txt"), "utf8")).toBe("two\n")
    await sessions.clearRevert(id)
    expect(readFileSync(join(folder, "b.txt"), "utf8")).toBe("after it\n")
  }, 30_000)

  test("a repository inside the project (a submodule, a clone) is never touched", async () => {
    const folder = repository({ "a.txt": "one\n" })
    const inner = join(folder, "vendor", "lib")
    mkdirSync(inner, { recursive: true })
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", inner, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
    git("init", "-q")
    writeFileSync(join(inner, "lib.js"), "v1\n")
    git("add", ".")
    git("commit", "-q", "-m", "v1")
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "a.txt"), "two\n")
      writeFileSync(join(inner, "lib.js"), "v2\n")
      git("commit", "-q", "-am", "v2")
      writeFileSync(join(inner, "work.txt"), "mine, not committed\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "update the library")
    await settled(id, 1, 20_000)
    await sessions.stageRevert(id, first)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\n")
    expect(readFileSync(join(inner, "lib.js"), "utf8")).toBe("v2\n")
    expect(readFileSync(join(inner, "work.txt"), "utf8")).toBe("mine, not committed\n")
    expect(existsSync(join(inner, ".git"))).toBe(true)
  }, 30_000)

  test("files the ignore rules left out stay when the turn changed those rules", async () => {
    const folder = repository({ ".gitignore": ".env\nnode_modules/\n", "a.txt": "one\n" }, (folder) => {
      writeFileSync(join(folder, ".env"), "SECRET=1\n")
      mkdirSync(join(folder, "node_modules", "x"), { recursive: true })
      writeFileSync(join(folder, "node_modules", "x", "index.js"), "module\n")
    })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, ".gitignore"), "dist/\n")
      writeFileSync(join(folder, "new.txt"), "made by it\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "tidy the ignore file")
    await settled(id, 1, 20_000)
    await sessions.stageRevert(id, first)
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toBe(".env\nnode_modules/\n")
    expect(readFileSync(join(folder, ".env"), "utf8")).toBe("SECRET=1\n")
    expect(existsSync(join(folder, "node_modules", "x", "index.js"))).toBe(true)
    expect(existsSync(join(folder, "new.txt"))).toBe(false)
  }, 30_000)

  test("a turn cut short (a quit) can still be undone, and the messages before it", async () => {
    const folder = repository({ "a.txt": "one\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "a.txt"), "two\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "change it")
    await settled(id, 1, 20_000)
    // The next turn is cut short: its note has no files, as after a crash.
    a.script = async (_input, turn) => {
      writeFileSync(join(folder, "a.txt"), "three\n")
      turn.startStep()
      return new Promise(() => {})
    }
    send(id, "change it again")
    await until(() => readFileSync(join(folder, "a.txt"), "utf8") === "three\n")
    await Bun.sleep(50)
    sessions.closeAll()
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, undefined, undefined, new Snapshots(join(root, "snapshots")))
    await until(() => !sessions.active().includes(id))
    // At once: the undo waits while the cut-short turn's files are read.
    await sessions.stageRevert(id, first)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\n")
  }, 30_000)

  test("a file it made whose name looks like git's pathspec magic goes with the undo", async () => {
    const folder = repository({ "a.txt": "one\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, ":(new)"), "made\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "make it")
    await settled(id, 1, 20_000)
    await sessions.stageRevert(id, first)
    expect(existsSync(join(folder, ":(new)"))).toBe(false)
  }, 30_000)

  test("in a subfolder, a file the top folder's rules left out stays, though the agent changed those rules", async () => {
    const folder = repository({ ".gitignore": "sub/secret.txt\n", "sub/a.txt": "one\n", "sub/secret.txt": "mine\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, ".gitignore"), "")
      writeFileSync(join(folder, "sub", "new.txt"), "made\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: join(folder, "sub") } }).id
    const first = send(id, "change it")
    await settled(id, 1, 20_000)
    await sessions.stageRevert(id, first)
    expect(existsSync(join(folder, "sub", "new.txt"))).toBe(false)
    expect(readFileSync(join(folder, "sub", "secret.txt"), "utf8")).toBe("mine\n")
  }, 30_000)

  test("a turn cut short long ago (the app was closed) isn't undone through: your edits since stay", async () => {
    const folder = repository({ "a.txt": "one\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "a.txt"), "two\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "change it")
    await settled(id, 1, 20_000)
    a.script = async (_input, turn) => {
      turn.startStep()
      return new Promise(() => {})
    }
    send(id, "change it again")
    await until(() => a.runs.length === 2)
    await Bun.sleep(600)
    sessions.closeAll()
    // Closed a while; you edited meanwhile.
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(join(root, "sessions", id, "messages.json"), old, old)
    writeFileSync(join(folder, "a.txt"), "mine\n")
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(new Store(join(root, "sessions")), { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, undefined, undefined, new Snapshots(join(root, "snapshots")))
    await Bun.sleep(300)
    await expect(sessions.stageRevert(id, first)).rejects.toThrow("couldn't keep")
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("mine\n")
  }, 30_000)

  test("a turn the agent begins on its own while Undo is being staged is turned away, and the undo stays", async () => {
    const folder = repository({ "a.txt": "one\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "a.txt"), "two\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "change it")
    await settled(id, 1, 20_000)
    const staging = sessions.stageRevert(id, first)
    // Taken for now (the files are being put back), then let go once the undo is staged.
    expect(a.threads[0].onOwnTurn!({ text: "Alpha carried on by itself." })).toBe(true)
    await staging
    await Bun.sleep(50)
    expect(a.threads[0].turnedAway).toBe(1)
    expect(a.runs).toHaveLength(1)
    expect(sessions.get(id).revert?.messageID).toBe(first)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\n")
    // And one while it's staged isn't taken at all.
    expect(a.threads[0].onOwnTurn!({ text: "Alpha carried on by itself." })).toBe(false)
  }, 30_000)

  test("Stop before a turn the agent began on its own is taken stops that too", async () => {
    const folder = repository({ "a.txt": "one\n" })
    withSnapshots()
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    send(id, "hello")
    await settled(id, 1, 20_000)
    expect(a.threads[0].onOwnTurn!({ text: "Alpha carried on by itself." })).toBe(true)
    // Its files are being kept: Stop comes first.
    await sessions.interrupt(id)
    await settled(id, 2, 20_000)
    expect(idles(id)[1].outcome).toBe("interrupted")
    expect(a.runs).toHaveLength(1)
    expect(a.threads[0].turnedAway).toBe(1)
  }, 30_000)

  test("Undo doesn't start what was waiting, so it isn't made final at once", async () => {
    const folder = repository({ "a.txt": "one\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "a.txt"), "two\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "change it")
    await settled(id, 1, 20_000)
    // One waiting, held after a Stop.
    a.script = works
    send(id, "working")
    await until(() => a.runs.length === 2)
    send(id, "waits", "queue")
    await sessions.interrupt(id)
    await settled(id, 2, 20_000)
    await sessions.stageRevert(id, first)
    await Bun.sleep(50)
    expect(a.runs).toHaveLength(2)
    expect(sessions.get(id).revert?.messageID).toBe(first)
    expect(sessions.inbox(id)).toHaveLength(1)
  }, 30_000)

  test("a message sent while the stopped turn's files are being kept goes once that's done", async () => {
    const folder = repository({ "a.txt": "one\n" })
    class Slow extends Snapshots {
      slow = false
      override async take(directory: string) {
        if (this.slow) await Bun.sleep(300)
        return super.take(directory)
      }
    }
    const snapshots = new Slow(join(root, "snapshots"))
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, undefined, undefined, snapshots)
    a.script = works
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    send(id, "work")
    await until(() => a.runs.length === 1)
    snapshots.slow = true
    a.script = replies
    await sessions.interrupt(id)
    await Bun.sleep(100)
    send(id, "now this")
    await until(() => a.runs.length === 2, 5_000)
    await settled(id, 2, 20_000)
    expect(sessions.inbox(id)).toHaveLength(0)
  }, 30_000)

  test("an Undo that fails partway puts the files back as they were, and stages nothing", async () => {
    const folder = repository({ "a.txt": "one\n", "b.txt": "one\n" })
    class Failing extends Snapshots {
      failNext = false
      override async restore(directory: string, tree: string, paths: string[]) {
        if (this.failNext) {
          this.failNext = false
          writeFileSync(join(folder, "a.txt"), "half\n")
          throw new Error("disk full")
        }
        return super.restore(directory, tree, paths)
      }
    }
    const snapshots = new Failing(join(root, "snapshots"))
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, undefined, undefined, snapshots)
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "a.txt"), "two\n")
      writeFileSync(join(folder, "b.txt"), "two\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "change both")
    await settled(id, 1, 20_000)
    snapshots.failNext = true
    await expect(sessions.stageRevert(id, first)).rejects.toThrow()
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("two\n")
    expect(sessions.get(id).revert).toBeUndefined()
    // A later Undo and Redo work from the files as they are.
    await sessions.stageRevert(id, first)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("one\n")
    await sessions.clearRevert(id)
    expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("two\n")
  }, 30_000)

  test("never deletes through a link the agent replaced", async () => {
    const outside = mkdtempSync(join(root, "outside-"))
    writeFileSync(join(outside, "lib.js"), "keep me\n")
    const folder = repository({ "a.txt": "one\n" }, (folder) => symlinkSync(outside, join(folder, "lib")))
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      // The link replaced with a folder of its own, with a file of the same name.
      rmSync(join(folder, "lib"))
      mkdirSync(join(folder, "lib"))
      writeFileSync(join(folder, "lib", "lib.js"), "copy\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "vendor it")
    await settled(id, 1, 20_000)
    await sessions.stageRevert(id, first)
    expect(lstatSync(join(folder, "lib")).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(outside, "lib.js"), "utf8")).toBe("keep me\n")
  }, 30_000)

  test("another session's work in the same project stays", async () => {
    const folder = repository({ "a.txt": "one\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, input.text.includes("first") ? "from-a.txt" : "from-b.txt"), "x\n")
      return replies(input, turn, hooks, thread)
    }
    const one = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const two = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(one, "first")
    await settled(one, 1)
    send(two, "second")
    await settled(two, 1)
    await sessions.stageRevert(one, first)
    expect(existsSync(join(folder, "from-a.txt"))).toBe(false)
    expect(existsSync(join(folder, "from-b.txt"))).toBe(true)
  }, 30_000)

  test("a file that became a folder goes back", async () => {
    const folder = repository({ "config": "plain\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      rmSync(join(folder, "config"))
      mkdirSync(join(folder, "config"))
      writeFileSync(join(folder, "config", "main.json"), "{}\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    const first = send(id, "split it")
    await settled(id, 1, 20_000)
    await sessions.stageRevert(id, first)
    expect(readFileSync(join(folder, "config"), "utf8")).toBe("plain\n")
    await sessions.clearRevert(id)
    expect(readFileSync(join(folder, "config", "main.json"), "utf8")).toBe("{}\n")
  }, 30_000)

  test("in a subfolder, the repository's ignore rules hold: what it ignores is left alone", async () => {
    const folder = repository({ ".gitignore": "node_modules/\n", "app/a.txt": "one\n" })
    withSnapshots()
    a.script = async (input, turn, hooks, thread) => {
      writeFileSync(join(folder, "app", "a.txt"), "two\n")
      mkdirSync(join(folder, "app", "node_modules", "pkg"), { recursive: true })
      writeFileSync(join(folder, "app", "node_modules", "pkg", "index.js"), "installed\n")
      return replies(input, turn, hooks, thread)
    }
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: join(folder, "app") } }).id
    const first = send(id, "install and change")
    await settled(id, 1, 20_000)
    await sessions.stageRevert(id, first)
    expect(readFileSync(join(folder, "app", "a.txt"), "utf8")).toBe("one\n")
    expect(existsSync(join(folder, "app", "node_modules", "pkg", "index.js"))).toBe(true)
  }, 30_000)
})

describe("commands you run yourself", () => {
  test("a command's output a job it left running keeps open still comes, and a lot of it is kept to its end", async () => {
    const folder = mkdtempSync(join(root, "project-"))
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    sessions.runShell(id, "(sleep 30 &) ; echo done-here")
    sessions.runShell(id, "yes line | head -n 200000")
    const shells = () => sessions.messages(id).filter((message) => message.type === "shell") as any[]
    await until(() => shells().every((shell) => shell.status !== "running"), 10_000)
    expect(shells()[0].output.output).toContain("done-here")
    expect(shells()[1].output.truncated).toBe(true)
    expect(shells()[1].output.output.length).toBeLessThanOrEqual(50_000)
  })

  test("one run while the agent works reaches it with your next message", async () => {
    const folder = mkdtempSync(join(root, "project-"))
    a.script = works
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    send(id, "first")
    await until(() => a.runs.length === 1)
    sessions.runShell(id, "echo while-it-worked")
    await until(() => (sessions.messages(id).find((message) => message.type === "shell") as any)?.status === "completed")
    a.script = replies
    a.threads[0].onStop!()
    await settled(id, 1)
    send(id, "second")
    await settled(id, 2)
    expect(a.runs.at(-1)!.text).toContain("echo while-it-worked")
  })

  test("a command run with ! joins the conversation, and the agent gets it with your next message", async () => {
    const folder = mkdtempSync(join(root, "project-"))
    const id = sessions.create({ model: { providerID: "alpha", id: "one" }, location: { directory: folder } }).id
    send(id, "hello")
    await settled(id, 1)
    sessions.runShell(id, "echo printed-here")
    const shell = () => sessions.messages(id).find((message) => message.type === "shell") as any
    await until(() => shell()?.status === "completed")
    expect(shell().output.output).toBe("printed-here")
    expect(shell().exit).toBe(0)
    expect(events.some((event) => event.type === "session.shell.ended")).toBe(true)
    send(id, "what did it print?")
    await settled(id, 2)
    const told = a.runs.at(-1)!.text
    expect(told).toContain("Since your last reply, the user ran these commands themselves")
    expect(told).toContain("echo printed-here")
    expect(told).toContain("printed-here")
    expect(told.endsWith("User message:\nwhat did it print?")).toBe(true)
  })
})

describe("subagents", () => {
  test("a subagent's work is told in a session of its own under the conversation, linked from its step", async () => {
    let child = ""
    a.script = (_input, turn, hooks, thread) => {
      turn.startStep()
      turn.toolStart("call_task", "subagent")
      turn.toolCalled("call_task", { description: "Look around", prompt: "Read the README" })
      const run = hooks.subagent("call_task", { title: "Look around", prompt: "Read the README", agent: "Explore" })
      child = run.sessionID
      run.turn.startStep()
      run.turn.text("It's a parser.")
      run.turn.endStep()
      return new Promise((resolve) => {
        thread.onStop = () => resolve({ outcome: "interrupted" })
        setTimeout(() => {
          run.end("succeeded")
          turn.toolSucceeded("call_task", "It's a parser.")
          turn.endStep()
          resolve({ outcome: "succeeded" })
        }, 50)
      })
    }
    const id = create()
    send(id, "what is this project")
    await until(() => child !== "")
    expect(sessions.active()).toContain(child)
    expect(sessions.get(child).parentID).toBe(id)
    expect(sessions.list(undefined, id).map((session) => session.id)).toEqual([child])
    expect(sessions.list(undefined, null).map((session) => session.id)).toEqual([id])
    expect(() => sessions.prompt(child, { id: "msg_test_child", text: "hi", files: [], delivery: "steer" })).toThrow()
    await settled(id, 1)
    expect(sessions.active()).not.toContain(child)
    const step = sessions.messages(id).find((message) => message.type === "assistant") as any
    expect(step.content.find((content: any) => content.type === "tool").state.metadata.sessionID).toBe(child)
    const childMessages = sessions.messages(child)
    expect(childMessages[0]).toMatchObject({ type: "user", text: "Read the README" })
    expect(childMessages.some((message) => message.type === "assistant")).toBe(true)
    expect(childMessages.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" })
    // It goes with the conversation.
    await sessions.remove(id)
    expect(() => sessions.get(child)).toThrow()
  })

  /**
   * An ACP agent that says only what Antigravity says over its protocol, and the record it keeps
   * (`brain`): its prompts write `records[n]` (the whole conversation so far) as it takes them.
   */
  function antigravityLike(folder: string, brain: string, holdMs: number, records: Record<string, unknown>[][] = []) {
    const script = join(folder, "agent.js")
    const logs = join(brain, "s1", ".system_generated", "logs")
    const lines = records.map((steps) => steps.map((step, index) => JSON.stringify({ step_index: index, status: "DONE", ...step })).join("\n") + "\n")
    writeFileSync(
      script,
      `let buffer = ""
let prompt
let prompts = 0
const fs = require("node:fs")
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
const update = (value) => send({ method: "session/update", params: { sessionId: "s1", update: value } })
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, authMethods: [] } })
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "s1" } })
    else if (message.method === "session/prompt") {
      const record = ${JSON.stringify(lines)}[prompts++]
      if (record) {
        fs.mkdirSync(${JSON.stringify(logs)}, { recursive: true })
        fs.writeFileSync(${JSON.stringify(join(logs, "transcript.jsonl"))}, record)
      }
      update({ sessionUpdate: "tool_call", toolCallId: "s1:1", title: "Running start_subagent", kind: "other", status: "in_progress", rawInput: {} })
      update({ sessionUpdate: "tool_call_update", toolCallId: "s1:1", status: "completed", rawOutput: "Start subagents" })
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Started them." } })
      setTimeout(() => send({ id: message.id, result: { stopReason: "end_turn" } }), ${holdMs})
    } else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
    )
    const agy: Agent = {
      id: "antigravity",
      providerID: "gamma",
      name: "Gamma",
      instance: { id: "default" },
      methods: () => [],
      account: async () => ({ installed: true, signedIn: true }),
      models: async () => [],
      thread: (session, state) => {
        // One for the conversation, from turn to turn, as Antigravity's.
        const followers = new Map<string, AntigravityFollower>()
        return new AcpThread(
          {
            fileSystem: false,
            authMethod: () => undefined,
            command: async () => ({ argv: [process.execPath, script], cwd: folder }),
            selectModel: async () => {},
            follow: (sessionId, turn, hooks) => {
              if (!followers.has(sessionId)) followers.set(sessionId, new AntigravityFollower(brain, sessionId, 25))
              return followers.get(sessionId)!.follow(turn, hooks)
            },
            hides: (call) => /\bstart_subagent\b/.test(String(call?.title ?? "")),
          },
          session,
          state,
          "Gamma",
        )
      },
    }
    return agy
  }

  /** A conversation's record, as Antigravity writes it. */
  function record(brain: string, conversation: string, steps: Record<string, unknown>[]) {
    const folder = join(brain, conversation, ".system_generated", "logs")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "transcript.jsonl"), steps.map((step, index) => JSON.stringify({ step_index: index, status: "DONE", ...step })).join("\n") + "\n")
  }

  test("Antigravity's subagents, from its own record: a row and a session each, with their steps", async () => {
    const folder = mkdtempSync(join(root, "agy-"))
    const brain = join(folder, "brain")
    const turnOne = [
      { source: "USER_EXPLICIT", type: "USER_INPUT", content: "spawn two" },
      { type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: { Subagents: JSON.stringify([{ Role: "Timer Worker 1", TypeName: "self", Prompt: "Wait, then say hi" }, { Role: "Timer Worker 2", TypeName: "self", Prompt: "Wait too" }]) } }] },
      { type: "INVOKE_SUBAGENT", content: 'Created the following subagents:\n{ "conversationId":  "c1" }\n{ "conversationId":  "c2" }' },
      { type: "PLANNER_RESPONSE", content: "Started them." },
    ]
    // A timer of its own (its record stays "running"), then a message back once it fires.
    record(brain, "c1", [
      { type: "SYSTEM_MESSAGE", content: "Wait, then say hi" },
      { type: "PLANNER_RESPONSE", tool_calls: [{ name: "schedule", args: { DurationSeconds: "1", toolSummary: '"Schedule timer"' } }] },
      { type: "GENERIC", status: "RUNNING", content: "Created At: x\nTool is running as a background task with task id: c1/task-2" },
      { type: "PLANNER_RESPONSE", content: "Waiting for the timer." },
      { type: "SYSTEM_MESSAGE", content: "[Message] sender=c1/task-2 content=done" },
      { type: "PLANNER_RESPONSE", tool_calls: [{ name: "send_message", args: { Message: '"hi"', Recipient: '"s1"' } }] },
      { type: "GENERIC", content: "Created At: x\nCompleted At: y\nMessage sent." },
      { type: "PLANNER_RESPONSE", content: "hi" },
    ])
    // The second is still at work as the turn ends.
    record(brain, "c2", [
      { type: "SYSTEM_MESSAGE", content: "Wait too" },
      { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: '"sleep 100"' } }] },
      { type: "GENERIC", status: "RUNNING", content: "Running…" },
    ])
    // Its next turn's record has all of the first's too.
    const turnTwo = [...turnOne, { source: "USER_EXPLICIT", type: "USER_INPUT", content: "and now?" }, { type: "PLANNER_RESPONSE", content: "Still waiting." }]
    const agy = antigravityLike(folder, brain, 300, [turnOne, turnTwo])
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider === "gamma" ? agy : undefined) } as unknown as Roster, auto)
    const id = sessions.create({ model: { providerID: "gamma", id: "one" }, location: { directory: folder } }).id
    send(id, "spawn two")
    await settled(id, 1, 15_000)
    const step = sessions.messages(id).find((message) => message.type === "assistant") as any
    const rows = step.content.filter((content: any) => content.type === "tool")
    // Antigravity's own "start_subagent" isn't a row: the subagents are.
    expect(rows.map((row: any) => [row.name, row.state.input.description])).toEqual([
      ["subagent", "Timer Worker 1"],
      ["subagent", "Timer Worker 2"],
    ])
    const [first, second] = rows.map((row: any) => row.state.metadata.sessionID)
    expect(sessions.messages(first)[0]).toMatchObject({ type: "user", text: "Wait, then say hi" })
    const tools = sessions.messages(first).flatMap((message: any) => (message.type === "assistant" ? message.content.filter((content: any) => content.type === "tool") : []))
    expect(tools.map((tool: any) => [tool.name, tool.state.status])).toEqual([
      ["schedule", "completed"],
      ["send_message", "completed"],
    ])
    expect(texts(first)).toContain("hi")
    expect(sessions.messages(first).at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" })
    const working = sessions.messages(second).find((message) => message.type === "assistant") as any
    expect(working.content.find((content: any) => content.type === "tool")).toMatchObject({ name: "shell", state: { input: { command: "sleep 100" } } })
    expect(sessions.active()).not.toContain(second)
    // The next turn doesn't start them again.
    const before = sessions.messages(first).length
    send(id, "and now?")
    await settled(id, 2, 15_000)
    const later = sessions.messages(id).filter((message) => message.type === "assistant").at(-1) as any
    expect(later.content.filter((content: any) => content.type === "tool")).toHaveLength(0)
    expect(sessions.list(folder, id)).toHaveLength(2)
    expect(sessions.messages(first)).toHaveLength(before)
  })

  test("Antigravity's subagents it didn't start (you said no) get no rows", async () => {
    const folder = mkdtempSync(join(root, "agy-"))
    const brain = join(folder, "brain")
    const agy = antigravityLike(folder, brain, 100, [
      [
        { source: "USER_EXPLICIT", type: "USER_INPUT", content: "spawn one" },
        { type: "PLANNER_RESPONSE", tool_calls: [{ name: "invoke_subagent", args: { Subagents: [{ Role: "Worker", Prompt: "Do it" }] } }] },
        { type: "PLANNER_RESPONSE", content: "Fine." },
      ],
    ])
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider === "gamma" ? agy : undefined) } as unknown as Roster, auto)
    const id = sessions.create({ model: { providerID: "gamma", id: "one" }, location: { directory: folder } }).id
    send(id, "spawn one")
    await settled(id, 1, 15_000)
    const step = sessions.messages(id).find((message) => message.type === "assistant") as any
    expect(step.content.filter((content: any) => content.type === "tool")).toHaveLength(0)
    expect(sessions.list(folder, id)).toHaveLength(0)
  })

  test("a subagent still at work when the turn is stopped is stopped with it", async () => {
    let child = ""
    a.script = (_input, turn, hooks, thread) => {
      turn.startStep()
      turn.toolStart("call_task", "subagent")
      turn.toolCalled("call_task", { description: "Wait" })
      child = hooks.subagent("call_task", { title: "Wait" }).sessionID
      return new Promise((resolve) => (thread.onStop = () => resolve({ outcome: "interrupted" })))
    }
    const id = create()
    send(id, "go")
    await until(() => child !== "")
    await sessions.interrupt(id)
    await settled(id, 1)
    expect(sessions.messages(child).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
    expect(sessions.active()).not.toContain(child)
    // Its step, stopped, still says which session it is.
    const step = sessions.messages(id).find((message) => message.type === "assistant") as any
    const call = step.content.find((content: any) => content.type === "tool")
    expect(call.state.status).toBe("error")
    expect(call.state.metadata.sessionID).toBe(child)
  })

  test("a subagent in the background: what it asked goes when it ends, and Stop in its session stops it", async () => {
    let run: any
    a.script = async (_input, turn, hooks) => {
      turn.startStep()
      turn.toolStart("call_task", "subagent")
      turn.toolCalled("call_task", { description: "Wait" })
      run = hooks.subagent("call_task", { title: "Wait", background: true })
      turn.endStep()
      return { outcome: "succeeded" }
    }
    const id = create()
    sessions.update(id, { permissions: [{ action: "shell", resource: "*", effect: "ask" }] })
    send(id, "go")
    await settled(id, 1)
    const asked = run.permission({ toolCallID: "t1", action: "shell", resources: ["rm -rf build"] })
    await until(() => sessions.permissions(id).length === 1)
    run.end("succeeded")
    expect(await asked).toBe("reject")
    expect(sessions.permissions(id)).toHaveLength(0)
    // Another, with no way for its agent to stop it: Stop in its session ends it there.
    a.script = async (_input, turn, hooks) => {
      turn.startStep()
      turn.toolStart("call_task2", "subagent")
      run = hooks.subagent("call_task2", { title: "Wait", background: true })
      turn.endStep()
      return { outcome: "succeeded" }
    }
    send(id, "again")
    await settled(id, 2)
    expect(await sessions.interrupt(run.sessionID)).toBe(true)
    expect(sessions.messages(run.sessionID).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
  })

  test("a subagent at work when the bridge stops ends with it", async () => {
    let child = ""
    a.script = (_input, turn, hooks) => {
      turn.startStep()
      turn.toolStart("call_task", "subagent")
      turn.toolCalled("call_task", { description: "Wait" })
      child = hooks.subagent("call_task", { title: "Wait" }).sessionID
      return new Promise(() => {})
    }
    const id = create()
    send(id, "go")
    await until(() => child !== "")
    sessions.closeAll()
    expect(sessions.messages(child).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
    expect(sessions.active()).not.toContain(child)
  })
})

describe("from the engine", () => {
  test("a conversation from the engine carries on here, its first agent handed all of it", async () => {
    const id = sessions.importSession({
      title: "Fix the parser",
      model: { providerID: "alpha", id: "one" },
      location: { directory: "/tmp/project" },
      messages: [
        { type: "user", id: "msg_0001", time: { created: 1 }, text: "the parser drops commas" },
        { type: "assistant", id: "msg_0002", time: { created: 2, completed: 3 }, agent: "build", model: { providerID: "opencode", id: "big-pickle" }, content: [{ type: "text", text: "It splits on spaces only." }] },
        { type: "idle", id: "msg_0003", time: { created: 3 }, outcome: "succeeded" },
        { type: "compaction", id: "msg_0004", time: { created: 4 } },
      ],
    }).id
    expect(sessions.get(id).title).toBe("Fix the parser")
    expect(sessions.messages(id).map((message) => message.type)).toEqual(["user", "assistant", "idle"])
    send(id, "now fix it")
    await settled(id, 2)
    const told = a.runs[0].text
    expect(told).toContain("the parser drops commas")
    expect(told).toContain("It splits on spaces only.")
    expect(told.endsWith("User message:\nnow fix it")).toBe(true)
  })
})

describe("moving between agents", () => {
  test("the next agent gets what it hasn't seen, and the first only what came since", async () => {
    const id = create()
    send(id, "plan the thing")
    await settled(id, 1)
    sessions.selectModel(id, { providerID: "beta", id: "two" })
    send(id, "now build it")
    await settled(id, 2)
    const handed = b.runs[0].text
    expect(handed).toContain("This conversation began with another agent")
    expect(handed).toContain("plan the thing")
    expect(handed).toContain("alpha/one on: plan the thing")
    expect(handed.endsWith("User message:\nnow build it")).toBe(true)

    sessions.selectModel(id, { providerID: "alpha", id: "one" })
    send(id, "check it")
    await settled(id, 3)
    const back = a.runs[1].text
    expect(back).not.toContain("plan the thing")
    expect(back).toContain("now build it")
    expect(back).toContain("beta/two on: now build it")
    // Each agent kept its own conversation.
    expect(a.threads).toHaveLength(1)
    expect(b.threads).toHaveLength(1)
  })

  test("an agent you stopped isn't told it was stopped, as if by another", async () => {
    a.script = works
    const id = create()
    send(id, "first")
    await until(() => a.runs.length === 1)
    await sessions.interrupt(id)
    await settled(id, 1)
    a.script = replies
    send(id, "second")
    await settled(id, 2)
    expect(a.runs[1].text).toBe("second")
  })

  test("an agent whose run broke is told what it missed", async () => {
    a.script = async () => {
      throw new Error("its process died")
    }
    const id = create()
    send(id, "first")
    await settled(id, 1)
    a.script = replies
    send(id, "second")
    await settled(id, 2)
    expect(a.runs[1].text).toContain("first")
    expect(a.runs[1].text).toContain("its process died")
    expect(a.runs[1].text.endsWith("User message:\nsecond")).toBe(true)
    // It started a new conversation of its own.
    expect(a.threads).toHaveLength(2)
    expect(a.threads[0].closed).toBe(true)
  })

  test("a new session from a message: what came before, handed over", async () => {
    const id = create()
    const first = send(id, "first")
    await settled(id, 1)
    const second = send(id, "second")
    await settled(id, 2)
    const fork = sessions.fork(id, second)
    expect(fork.id).not.toBe(id)
    expect(sessions.messages(fork.id).map((message) => message.id)).toContain(first)
    expect(sessions.messages(fork.id).map((message) => message.id)).not.toContain(second)
    send(fork.id, "another way")
    await settled(fork.id, 2)
    const handed = a.runs.at(-1)!.text
    expect(handed).toContain("first")
    expect(handed).not.toContain("second")
    expect(handed.endsWith("User message:\nanother way")).toBe(true)
  })

  test("a model of the same agent needs no handover", async () => {
    const id = create()
    send(id, "one")
    await settled(id, 1)
    sessions.selectModel(id, { providerID: "alpha", id: "other" })
    send(id, "two")
    await settled(id, 2)
    expect(a.runs[1].text).toBe("two")
    expect(a.runs[1].model).toBe("other")
  })

  test("a session from before keeps its agent's conversation", async () => {
    const id = create()
    send(id, "one")
    await settled(id, 1)
    const record = store.get(id)!
    delete record.agent.threads
    record.agent.claudeSession = "abc"
    record.agent.claudeStarted = true
    store.save(id, true)
    sessions.closeAll()
    make()
    sessions.selectModel(id, { providerID: "beta", id: "two" })
    sessions.selectModel(id, { providerID: "alpha", id: "one" })
    send(id, "two")
    await settled(id, 2)
    expect(a.runs.at(-1)!.state).toMatchObject({ claudeSession: "abc", claudeStarted: true })
    expect(a.runs.at(-1)!.text).toBe("two")
    expect(store.get(id)!.agent.claudeSession).toBeUndefined()
  })

  test("a turn an agent begins on its own doesn't count as its having seen what it missed", async () => {
    const id = create()
    send(id, "for alpha")
    await settled(id, 1)
    sessions.selectModel(id, { providerID: "beta", id: "two" })
    send(id, "for beta")
    await settled(id, 2)
    // Alpha carries on by itself (a command of its ended): taken, though it hasn't seen beta's turn.
    expect(a.threads[0].onOwnTurn!({ text: "Alpha carried on by itself." })).toBe(true)
    await settled(id, 3)
    sessions.selectModel(id, { providerID: "alpha", id: "one" })
    send(id, "back to alpha")
    await settled(id, 4)
    expect(a.runs.at(-1)!.text).toContain("for beta")
  })

  test("switching models mid-turn goes on with the new one", async () => {
    a.script = works
    const id = create()
    send(id, "start")
    await until(() => a.runs.length === 1)
    sessions.selectModel(id, { providerID: "beta", id: "two" })
    sessions.synthetic(id, "The user switched the model while you were working. Carry on.")
    await sessions.interrupt(id, true)
    await settled(id, 2)
    expect(b.runs).toHaveLength(1)
    expect(b.runs[0].text).toContain("start")
    expect(b.runs[0].text.endsWith("Carry on.")).toBe(true)
    expect(sessions.messages(id).some((message) => message.type === "synthetic")).toBe(true)
  })
})

describe("Auto", () => {
  const limited = (scope: "provider" | "model"): Script => async (_input, turn) => {
    turn.startStep()
    turn.text("started on it")
    turn.toolStart("call_1", "shell", { command: "make" })
    turn.endStep()
    return { outcome: "failed", error: { type: "limit", message: "limit" }, limit: { scope } }
  }

  test("a model's limit skips that model; the next in the list goes on with what it did", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "beta", modelID: "one" },
      { providerID: "alpha", modelID: "two" },
    ])
    a.script = (input, turn, hooks, thread) => (input.model.id === "one" ? limited("model")(input, turn, hooks, thread) : replies(input, turn, hooks, thread))
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    expect(b.runs).toHaveLength(1)
    expect(b.runs[0].text).toContain("started on it")
    expect(b.runs[0].text).toContain("make")
    const notes = sessions.messages(id).filter((message) => message.type === "synthetic")
    expect(notes).toHaveLength(1)
    // The tool the first one left running was stopped.
    const first = sessions.messages(id).find((message) => message.type === "assistant") as any
    expect(first.content.find((content: any) => content.type === "tool").state.status).toBe("error")

    // Next time: alpha/one is held, so beta goes first.
    send(id, "again")
    await settled(id, 2)
    expect(a.runs.filter((run) => run.model === "one")).toHaveLength(1)
    expect(b.runs).toHaveLength(2)
  })

  test("back on the first model once its limit resets, and the session says so", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "beta", modelID: "one" },
    ])
    a.script = async (input, turn, hooks, thread) => {
      const result = await limited("provider")(input, turn, hooks, thread)
      return { ...result, limit: { scope: "provider", resetsAt: Date.now() + 3_600_000 } }
    }
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    expect(b.runs).toHaveLength(1)
    const notes = () => sessions.messages(id).flatMap((message) => (message.type === "synthetic" ? [message.text] : []))
    expect(notes()).toHaveLength(1)

    // Its limit reset (as when it's over): alpha runs again, first, and says it's back.
    auto.clearLimits()
    a.script = replies
    send(id, "again")
    await settled(id, 2)
    expect(a.runs.at(-1)?.text).toContain("again")
    expect(b.runs).toHaveLength(1)
    expect(notes()).toHaveLength(2)
    expect(notes()[1]).toBe("Back on Alpha (one): its limit has reset.")

    // Not said again while it stays.
    send(id, "and again")
    await settled(id, 3)
    expect(notes()).toHaveLength(2)
  })

  test("on the fourth with three at their limits: the second, once it resets, though the first is still held", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "alpha", modelID: "two" },
      { providerID: "beta", modelID: "one" },
      { providerID: "beta", modelID: "two" },
    ])
    const heldUntil = (resetsAt: number): Script => async (input, turn, hooks, thread) => {
      const result = await limited("model")(input, turn, hooks, thread)
      return { ...result, limit: { scope: "model", resetsAt } }
    }
    const soon = Date.now() + 400
    a.script = (input, turn, hooks, thread) => heldUntil(input.model.id === "two" ? soon : Date.now() + 3_600_000)(input, turn, hooks, thread)
    b.script = (input, turn, hooks, thread) => (input.model.id === "one" ? heldUntil(Date.now() + 3_600_000)(input, turn, hooks, thread) : replies(input, turn, hooks, thread))
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    expect(b.runs.map((run) => run.model)).toEqual(["one", "two"])

    await until(() => Date.now() > soon + 50)
    a.script = (input, turn, hooks, thread) => (input.model.id === "two" ? replies(input, turn, hooks, thread) : heldUntil(Date.now() + 3_600_000)(input, turn, hooks, thread))
    send(id, "again")
    await settled(id, 2)
    // The first is still held; the second runs, and says it's back.
    expect(a.runs.map((run) => run.model)).toEqual(["one", "two", "two"])
    expect(b.runs).toHaveLength(2)
    const notes = sessions.messages(id).flatMap((message) => (message.type === "synthetic" ? [message.text] : []))
    expect(notes.at(-1)).toBe("Back on Alpha (two): its limit has reset.")
  })

  test("a model that couldn't take your message: the next of that agent's gets the message itself", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "alpha", modelID: "two" },
    ])
    a.script = (input, turn, hooks, thread) =>
      input.model.id === "one" ? Promise.resolve({ outcome: "failed", error: { type: "model", message: "Cannot use this model" } }) : replies(input, turn, hooks, thread)
    const id = create({ providerID: "auto", id: "auto" })
    sessions.prompt(id, { id: "msg_test_files_1", text: "build the thing", files: [{ uri: "file:///tmp/a.png", name: "a.png" }], delivery: "steer" })
    await settled(id, 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    expect(a.runs.map((run) => run.model)).toEqual(["one", "two"])
    expect(a.runs[1].text).toContain("build the thing")
    expect(a.runs[1].text).not.toContain("Carry on")
  })

  test("not \"back on\" a model after a message on it you picked yourself", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "beta", modelID: "one" },
    ])
    a.script = async (input, turn, hooks, thread) => {
      const result = await limited("provider")(input, turn, hooks, thread)
      return { ...result, limit: { scope: "provider", resetsAt: Date.now() + 3_600_000 } }
    }
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    auto.clearLimits()
    a.script = replies
    sessions.selectModel(id, { providerID: "alpha", id: "one" })
    send(id, "on alpha")
    await settled(id, 2)
    sessions.selectModel(id, { providerID: "auto", id: "auto" })
    send(id, "on auto")
    await settled(id, 3)
    const notes = sessions.messages(id).flatMap((message) => (message.type === "synthetic" ? [message.text] : []))
    expect(notes.some((note) => note.startsWith("Back on"))).toBe(false)
  })

  test("a model you picked that couldn't take your message: the next gets it, not just what came after", async () => {
    a.script = (input, turn, hooks, thread) =>
      input.model.id === "one" ? Promise.resolve({ outcome: "failed", error: { type: "model", message: "Cannot use this model" } }) : replies(input, turn, hooks, thread)
    const id = create({ providerID: "alpha", id: "one" })
    send(id, "build the thing")
    await settled(id, 1)
    sessions.selectModel(id, { providerID: "alpha", id: "two" })
    send(id, "try again")
    await settled(id, 2)
    expect(a.runs[1].text).toContain("build the thing")
    expect(a.runs[1].text).toContain("try again")
  })

  test("an ACP agent that turned a message away gets the app's instructions with the next", async () => {
    // A small ACP agent: it turns away prompts on model "one", and writes down each prompt.
    const folder = mkdtempSync(join(root, "acp-"))
    const log = join(folder, "prompts.log")
    const script = join(folder, "agent.js")
    writeFileSync(
      script,
      `const { appendFileSync } = require("node:fs")
let buffer = "", model = ""
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, authMethods: [] } })
    else if (message.method === "session/new") send({ id: message.id, result: { sessionId: "s1" } })
    else if (message.method === "session/set_model") { model = message.params.modelId; send({ id: message.id, result: {} }) }
    else if (message.method === "session/prompt") {
      const text = message.params.prompt.find((part) => part.type === "text").text
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ model, text }) + "\\n")
      if (model === "one") send({ id: message.id, error: { code: -32602, message: "Cannot use this model" } })
      else {
        send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } })
        send({ id: message.id, result: { stopReason: "end_turn" } })
      }
    } else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
    )
    const gamma: Agent = {
      id: "acp",
      providerID: "gamma",
      name: "Gamma",
      instance: { id: "default" },
      methods: () => [],
      account: async () => ({ installed: true, signedIn: true }),
      models: async () => [],
      thread: (session, state) =>
        new AcpThread(
          {
            fileSystem: false,
            authMethod: () => undefined,
            command: async () => ({ argv: [process.execPath, script], cwd: folder }),
            selectModel: async (rpc, sessionId, modelId) => {
              await rpc.request("session/set_model", { sessionId, modelId })
            },
          },
          session,
          state,
          "Gamma",
        ),
    }
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider === "gamma" ? gamma : undefined) } as unknown as Roster, auto)
    auto.set([
      { providerID: "gamma", modelID: "one" },
      { providerID: "gamma", modelID: "two" },
    ])
    const id = create({ providerID: "auto", id: "auto" })
    sessions.setInstruction(id, "worktree", "WORK IN THE WORKTREE")
    send(id, "build the thing")
    await settled(id, 1, 15_000)
    const prompts = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { model: string; text: string })
    expect(prompts.map((prompt) => prompt.model)).toEqual(["one", "two"])
    expect(prompts[1].text).toContain("WORK IN THE WORKTREE")
    expect(prompts[1].text).toContain("build the thing")
  })

  test("an agent that can't start passes to the next model", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "beta", modelID: "one" },
    ])
    a.script = async () => {
      throw new Error("Its process didn't start.")
    }
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    expect(b.runs).toHaveLength(1)
    expect(b.runs[0].text).toContain("do it")
  })

  test("an account's limit skips all of its models", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "alpha", modelID: "two" },
      { providerID: "beta", modelID: "one" },
    ])
    a.script = limited("provider")
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    expect(a.runs.map((run) => run.model)).toEqual(["one"])
    expect(b.runs).toHaveLength(1)
    expect(auto.limits().map((limit) => limit.key)).toEqual(["alpha"])
  })

  test("all at their limits: it says so, and says when the first resets", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "beta", modelID: "one" },
    ])
    a.script = limited("provider")
    b.script = async (input, turn, hooks, thread) => {
      const result = await limited("provider")(input, turn, hooks, thread)
      return { ...result, limit: { scope: "provider", resetsAt: Date.now() + 3_600_000 } }
    }
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    const idle = idles(id)[0]
    expect(idle.outcome).toBe("failed")
    expect(idle.error?.message).toContain("Every model in your Custom Auto list is at a usage limit")
    expect(idle.error?.message).toContain("the first resets at")
  })

  test("a signed-out agent is skipped", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "beta", modelID: "one" },
    ])
    a.signedIn = false
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    expect(a.runs).toHaveLength(0)
    expect(b.runs).toHaveLength(1)
  })

  test("interleaved providers and models, in your order", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "beta", modelID: "one" },
      { providerID: "alpha", modelID: "two" },
      { providerID: "beta", modelID: "two" },
    ])
    a.script = limited("model")
    b.script = limited("model")
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    const order = [...a.runs.map((run) => ({ ...run, p: "alpha" })), ...b.runs.map((run) => ({ ...run, p: "beta" }))]
    expect(order).toHaveLength(4)
    expect(auto.limits()).toHaveLength(4)
    expect(sessions.messages(id).filter((message) => message.type === "synthetic")).toHaveLength(4)
  })

  test("Stop during Auto stops, and goes no further down the list", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "beta", modelID: "one" },
    ])
    a.script = works
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await until(() => a.runs.length === 1)
    await sessions.interrupt(id)
    await settled(id, 1)
    expect(idles(id)[0].outcome).toBe("interrupted")
    expect(b.runs).toHaveLength(0)
  })

  test("another model of the same agent carries on, without your message again", async () => {
    auto.set([
      { providerID: "alpha", modelID: "one" },
      { providerID: "alpha", modelID: "two" },
    ])
    a.script = (input, turn, hooks, thread) => (input.model.id === "one" ? limited("model")(input, turn, hooks, thread) : replies(input, turn, hooks, thread))
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    expect(a.runs.map((run) => run.model)).toEqual(["one", "two"])
    const second = a.runs[1].text
    expect(second).not.toContain("do it")
    expect(second).not.toContain("began with another agent")
    expect(second).toContain("Carry on with my last message")
  })

  test("a model that fails is passed by, also one that did some of it", async () => {
    auto.set([
      { providerID: "alpha", modelID: "gone" },
      { providerID: "beta", modelID: "one" },
    ])
    a.script = async () => ({ outcome: "failed", error: { type: "agent", message: "Unknown model gone" } })
    const id = create({ providerID: "auto", id: "auto" })
    send(id, "do it")
    await settled(id, 1)
    expect(idles(id)[0].outcome).toBe("succeeded")
    expect(b.runs).toHaveLength(1)
    expect(sessions.messages(id).some((message) => message.type === "synthetic" && message.text.includes("stopped: Unknown model gone"))).toBe(true)
    // Nothing held: it's tried again next time.
    expect(auto.limits()).toHaveLength(0)

    a.script = async (_input, turn) => {
      turn.startStep()
      turn.toolStart("call_x", "shell", { command: "rm build" })
      turn.toolSucceeded("call_x", "")
      turn.endStep()
      return { outcome: "failed", error: { type: "agent", message: "broke halfway" } }
    }
    send(id, "again")
    await settled(id, 2)
    // The next one carries on from what it did.
    expect(idles(id)[1].outcome).toBe("succeeded")
    expect(b.runs).toHaveLength(2)
  })

  test("a short rate limit is held a few minutes", () => {
    auto.hold({ providerID: "alpha", modelID: "one" }, { scope: "model", brief: true })
    const held = auto.limits()[0]
    expect(held.until - Date.now()).toBeLessThan(4 * 60_000)
    expect(held.until - Date.now()).toBeGreaterThan(2 * 60_000)
  })

  test("an empty list can't be picked", () => {
    expect(() => create({ providerID: "auto", id: "auto" })).toThrow("Settings › Custom Auto")
  })

  test("limits are kept, and go when their time has", () => {
    auto.hold({ providerID: "alpha", modelID: "one" }, { scope: "model", resetsAt: Date.now() + 60_000 })
    auto.hold({ providerID: "beta", modelID: "one" }, { scope: "provider", resetsAt: Date.now() - 1 })
    const reloaded = new Auto(root)
    expect(reloaded.isHeld({ providerID: "alpha", modelID: "one" })).toBeTruthy()
    expect(reloaded.isHeld({ providerID: "alpha", modelID: "two" })).toBeFalsy()
    // Its reset was unknown (in the past here): held half an hour.
    expect(reloaded.isHeld({ providerID: "beta", modelID: "two" })).toBeTruthy()
    reloaded.clearLimits()
    expect(reloaded.limits()).toHaveLength(0)
  })
})

describe("a session the bridge stopped in the middle of", () => {
  test("is ended as stopped when it starts again", () => {
    const id = create()
    const record = store.get(id)!
    record.messages.push(
      { type: "user", id: "msg_u", time: { created: 1 }, text: "go" },
      {
        type: "assistant",
        id: "msg_a",
        time: { created: 2 },
        agent: "build",
        model: { providerID: "alpha", id: "one" },
        content: [{ type: "tool", id: "call", name: "shell", state: { status: "running", input: { command: "make" } } }],
      },
    )
    store.save(id, true)
    make()
    const messages = sessions.messages(id)
    expect(messages.at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
    const step = messages.find((message) => message.type === "assistant") as any
    expect(step.time.completed).toBeDefined()
    expect(step.content[0].state.status).toBe("error")
    expect(sessions.get(id).outcome).toBe("interrupted")
  })

  test("a turn an app note started is ended too", () => {
    const id = create()
    const record = store.get(id)!
    record.messages.push(
      { type: "user", id: "msg_u", time: { created: 1 }, text: "go" },
      { type: "idle", id: "msg_i", time: { created: 2 }, outcome: "interrupted" },
      { type: "synthetic", id: "msg_s", time: { created: 3 }, text: "The user switched the model." },
    )
    store.save(id, true)
    make()
    expect(sessions.messages(id).at(-1)).toMatchObject({ type: "idle", outcome: "interrupted" })
  })

  test("a damaged session folder is skipped", () => {
    mkdirSync(join(root, "sessions", "ses_broken"), { recursive: true })
    writeFileSync(join(root, "sessions", "ses_broken", "session.json"), "{not json")
    make()
    expect(sessions.list().some((session) => session.id === "ses_broken")).toBe(false)
  })
})

describe("what comes in while a turn starts, ends or is stopped, step by step", () => {
  // No clock here: the agents' runs end, and the files are kept and put back, when the test says.

  /** Lets go on whatever can without a step the test holds (only what's due already: no timers). */
  async function drain() {
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve))
  }

  /** Snapshots kept in memory (each turn changes a.txt), whose takes and restores the test can hold and let go. */
  class StepSnapshots {
    hold = { take: false, restore: false }
    held: { kind: "take" | "restore"; go: () => void }[] = []
    trees = 0
    restored: string[] = []
    private async wait(kind: "take" | "restore") {
      if (this.hold[kind]) await new Promise<void>((go) => this.held.push({ kind, go }))
    }
    async take() {
      await this.wait("take")
      return `tree${++this.trees}`
    }
    async changed() {
      return ["a.txt"]
    }
    async changes(_directory: string, _from: string, _to: string, paths: string[]) {
      return paths.map((file) => ({ file, patch: "", additions: 1, deletions: 1 }))
    }
    async restore(_directory: string, tree: string) {
      await this.wait("restore")
      this.restored.push(tree)
    }
    release(kind: "take" | "restore") {
      const at = this.held.findIndex((held) => held.kind === kind)
      if (at < 0) throw new Error(`No ${kind} is held.`)
      this.held.splice(at, 1)[0].go()
    }
  }

  function withSteps() {
    const snapshots = new StepSnapshots()
    const agents = new Map([a, b].map((agent) => [agent.providerID, agent]))
    sessions = new Sessions(store, { find: (provider: string | undefined) => (provider ? agents.get(provider) : undefined) } as unknown as Roster, auto, undefined, undefined, undefined, snapshots as unknown as Snapshots)
    return snapshots
  }

  /** Alpha's runs end when the test ends them, in order (Stop alone doesn't end one). */
  function heldRuns() {
    const ends: ((result: RunResult) => void)[] = []
    a.script = (input, turn) => {
      turn.startStep()
      turn.text(`on: ${input.text}`)
      return new Promise((resolve) => ends.push(resolve))
    }
    return ends
  }

  const own = () => a.threads[0].onOwnTurn!({ text: "Alpha carried on by itself." })

  test("a turn the agent begins on its own while Undo puts the files back is turned away once it's staged; a message sent meanwhile goes after", async () => {
    const snapshots = withSteps()
    const id = create()
    const first = send(id, "change it")
    await drain()
    expect(idles(id)).toHaveLength(1)
    snapshots.hold.restore = true
    const staging = sessions.stageRevert(id, first)
    await drain()
    expect(snapshots.held.map((held) => held.kind)).toEqual(["restore"])
    // Taken for now; and your message waits for the files.
    expect(own()).toBe(true)
    send(id, "and now this")
    await drain()
    expect(a.runs).toHaveLength(1)
    snapshots.release("restore")
    await staging
    await drain()
    expect(a.threads[0].turnedAway).toBe(1)
    expect(a.runs.map((run) => run.text)).toEqual(["change it", "and now this"])
    // Your message made the undo final.
    expect(events.some((event) => event.type === "session.revert.committed")).toBe(true)
    expect(sessions.messages(id).some((message) => message.id === first)).toBe(false)
    expect(snapshots.restored).toEqual(["tree1"])
  })

  test("a turn the agent begins on its own right after Stop is turned away, and what waits stays held", async () => {
    const ends = heldRuns()
    const id = create()
    send(id, "work")
    await drain()
    send(id, "waits", "queue")
    const stopping = sessions.interrupt(id)
    expect(own()).toBe(false)
    ends[0]({ outcome: "interrupted" })
    expect(await stopping).toBe(true)
    await drain()
    expect(idles(id).map((idle) => idle.outcome)).toEqual(["interrupted"])
    expect(a.runs).toHaveLength(1)
    expect(sessions.inbox(id).map((item) => item.payload.text)).toEqual(["waits"])
    expect(sessions.active()).not.toContain(id)
  })

  test("a turn the agent begins on its own as its turn ends goes first, and the message waiting goes after it", async () => {
    const ends = heldRuns()
    const id = create()
    send(id, "first")
    await drain()
    send(id, "second", "queue")
    expect(own()).toBe(true)
    ends[0]({ outcome: "succeeded" })
    await drain()
    expect(a.runs).toHaveLength(2)
    expect(a.runs[1].text).toContain("carried on by itself")
    expect(sessions.inbox(id)).toHaveLength(1)
    ends[1]({ outcome: "succeeded" })
    await drain()
    expect(a.runs.map((run) => run.text)[2]).toBe("second")
    ends[2]({ outcome: "succeeded" })
    await drain()
    expect(idles(id).map((idle) => idle.outcome)).toEqual(["succeeded", "succeeded", "succeeded"])
    expect(sessions.inbox(id)).toHaveLength(0)
  })

  test("a message the agent turns away just as its turn ends goes next, once", async () => {
    const ends = heldRuns()
    const id = create()
    send(id, "first")
    await drain()
    const answers: ((taken: boolean) => void)[] = []
    a.threads[0].steer = () => new Promise((resolve) => answers.push(resolve))
    const late = send(id, "one more thing")
    await drain()
    expect(answers).toHaveLength(1)
    ends[0]({ outcome: "succeeded" })
    await drain()
    // Not started while it's being handed to the turn that just ended.
    expect(a.runs).toHaveLength(1)
    answers[0](false)
    await drain()
    expect(a.runs.map((run) => run.text)).toEqual(["first", "one more thing"])
    ends[1]({ outcome: "succeeded" })
    await drain()
    expect(sessions.messages(id).filter((message) => message.id === late)).toHaveLength(1)
    expect(sessions.inbox(id)).toHaveLength(0)
    expect(idles(id)).toHaveLength(2)
  })

  test("Send Now while the stopped turn's files are kept starts the message you picked once they are", async () => {
    const snapshots = withSteps()
    const ends = heldRuns()
    const id = create()
    send(id, "work")
    await drain()
    send(id, "held")
    const picked = send(id, "picked")
    expect(sessions.inbox(id).map((item) => item.delivery)).toEqual(["queue", "queue"])
    snapshots.hold.take = true
    const stopping = sessions.interrupt(id)
    ends[0]({ outcome: "interrupted" })
    await stopping
    await drain()
    expect(snapshots.held.map((held) => held.kind)).toEqual(["take"])
    sessions.setDelivery(id, picked, "steer")
    expect(await sessions.interrupt(id, true)).toBe(false)
    snapshots.hold.take = false
    snapshots.release("take")
    await drain()
    expect(a.runs.map((run) => run.text)).toEqual(["work", "picked"])
    expect(sessions.inbox(id).map((item) => item.payload.text)).toEqual(["held"])
  })

  test("a session deleted mid-turn starts nothing: not what waits, nor a turn its agent begins on its own", async () => {
    const ends = heldRuns()
    const id = create()
    send(id, "work")
    await drain()
    send(id, "waits", "queue")
    // The agent forgets its conversation when the test says.
    let forgotten!: () => void
    ;(a as any).forgetConversation = () => new Promise<void>((resolve) => (forgotten = resolve))
    const removing = sessions.remove(id)
    expect(own()).toBe(false)
    expect(() => send(id, "late")).toThrow()
    ends[0]({ outcome: "interrupted" })
    await drain()
    // Still being deleted: nothing sent now starts either.
    expect(() => send(id, "later still")).toThrow()
    expect(sessions.active()).not.toContain(id)
    forgotten()
    await removing
    await drain()
    expect(a.runs).toHaveLength(1)
    expect(a.threads[0].interrupted).toBe(1)
    expect(sessions.list().some((session) => session.id === id)).toBe(false)
    expect(sessions.active()).not.toContain(id)
    expect(events.filter((event) => event.type === "session.execution.started" && event.data.sessionID === id)).toHaveLength(1)
    expect(events.filter((event) => event.type === "session.deleted" && event.data.sessionID === id)).toHaveLength(1)
  })

  test("Undo while the files are still being kept waits for them, then takes back what the turn changed", async () => {
    const snapshots = withSteps()
    const ends = heldRuns()
    const id = create()
    const first = send(id, "change it")
    await drain()
    snapshots.hold.take = true
    ends[0]({ outcome: "succeeded" })
    await drain()
    expect(snapshots.held.map((held) => held.kind)).toEqual(["take"])
    let staged = false
    const staging = sessions.stageRevert(id, first).then((revert) => {
      staged = true
      return revert
    })
    await drain()
    expect(staged).toBe(false)
    expect(snapshots.restored).toEqual([])
    snapshots.hold.take = false
    snapshots.release("take")
    const revert = await staging
    expect(revert.messageID).toBe(first)
    expect(revert.files?.map((file) => file.file)).toEqual(["a.txt"])
    expect(snapshots.restored).toEqual(["tree1"])
    expect(sessions.get(id).revert?.messageID).toBe(first)
  })
})
