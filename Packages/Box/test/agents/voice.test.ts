import "../safety"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EngineLink } from "../../src/agents/engine"
import type { GoalPlaces } from "../../src/agents/goals"
import { server } from "../../src/agents/groups/api"
import { run } from "../../src/agents/proc"
import { voiceRoutes, VoiceWords } from "../../src/agents/voice"
import { StandIn } from "./support/standin"

// The words voice input listens for in a conversation, as a box picks them from its folder and
// what was said in it lately, for the engine's sessions and the coding agents' alike.

let root: string
let engine: StandIn
let link: EngineLink

process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"

const listen = () => () => {}
function places(bridge = false): GoalPlaces {
  return { engine: { api: link, listen }, bridge: { api: server(engine.url, "x"), listen }, isBridge: () => bridge }
}

const secretHex = "9f86d081884c7d659a2feaa0c55ad015"
const envValue = "sk_live_51HqLyjWDarjtT1zdp7dc"

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kuvo-voice-"))
  const folder = join(root, "pomodoro")
  const git = (...args: string[]) => run("git", ["-C", folder, "-c", "user.email=t@example.com", "-c", "user.name=T", ...args])
  await run("git", ["init", "-q", "-b", "main", folder])
  mkdirSync(join(folder, "src", "views"), { recursive: true })
  mkdirSync(join(folder, "node_modules", "left-pad"), { recursive: true })
  writeFileSync(join(folder, "src", "timer.ts"), "export function startTimer() {}\n")
  writeFileSync(join(folder, "src", "views", "ClockFace.swift"), "struct ClockFace {}\n")
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "@acme/focus-kit", dependencies: { zustand: "4.0.0" } }))
  writeFileSync(join(folder, ".gitignore"), "node_modules/\n")
  writeFileSync(join(folder, "node_modules", "left-pad", "index.js"), "module.exports = 1\n")
  // A secrets file git doesn't ignore: never read, never named.
  writeFileSync(join(folder, ".env"), `STRIPE_KEY=${envValue}\nDATABASE_NAME=orders_db\n`)
  await git("add", "-A")
  await git("commit", "-qm", "first")
  engine = new StandIn(() => {})
  engine.directory = folder
  engine.session("ses_work", [
    { id: "msg_0001", type: "user", text: `Make pauseOnBlur work in the timer. The build id is ${secretHex}, see https://example.com/someLongPathName.`, time: { created: 1 } },
    {
      id: "msg_0002",
      type: "assistant",
      content: [
        { type: "text", text: "I'll read `src/timer.ts` and the `.env` first." },
        { type: "tool", name: "read", state: { status: "completed", input: { filePath: join(folder, ".env") }, content: [{ type: "text", text: `STRIPE_KEY=${envValue}` }] } },
        { type: "tool", name: "edit", state: { status: "completed", input: { filePath: join(folder, "src", "timer.ts"), newString: "window.addEventListener(\"blur\", handleBlurEvent)" } } },
      ],
      time: { created: 2 },
    },
  ])
  link = new EngineLink()
  link.configure(engine.url, "x")
})

afterEach(() => {
  link.configure(undefined, undefined)
  engine.stop()
  rmSync(root, { recursive: true, force: true })
})

const words = async (voice: VoiceWords, session = "ses_work") => {
  const response = await voiceRoutes(voice, "GET", ["words", session])
  return { status: response.status, body: (await response.json()) as any }
}

describe("voice input's words", () => {
  test("name the project: its folder, files with and without extensions, its package, what the conversation said; never a secret", async () => {
    for (const bridge of [false, true]) {
      const { status, body } = await words(new VoiceWords(places(bridge)))
      expect(status).toBe(200)
      const said: string[] = body.data.words
      expect(said[0]).toBe("pomodoro")
      for (const word of ["timer.ts", "timer", "ClockFace.swift", "ClockFace", "views", "src", "pauseOnBlur", "handleBlurEvent", "focus-kit", "package.json", "zustand"]) expect(said).toContain(word)
      // What the conversation says comes before the rest of the project.
      expect(said.indexOf("pauseOnBlur")).toBeLessThan(said.indexOf("ClockFace"))
      expect(said.indexOf("timer.ts")).toBeLessThan(said.indexOf("ClockFace"))
      // Never what's in a secrets file, its name, a hash, what git ignores, a tool input's keys, or a link's path.
      const all = said.join(" ")
      for (const out of [envValue, "STRIPE_KEY", "DATABASE_NAME", "orders_db", ".env", secretHex, "left-pad", "filePath", "newString", "someLongPathName"]) expect(all).not.toContain(out)
      // Nor the folders a path the agent named is in, outside the project (a temporary one's, your home's).
      for (const folder of root.split("/").filter(Boolean)) expect(said).not.toContain(folder)
      expect(said.length).toBeLessThanOrEqual(100)
      expect(new Set(said.map((word) => word.toLowerCase())).size).toBe(said.length)
      for (const word of said) expect(word.length).toBeLessThanOrEqual(40)
    }
  })

  test("a big project gives at most 100, and a folder that isn't a repository still has its files named", async () => {
    const big = join(root, "big")
    mkdirSync(join(big, "lib"), { recursive: true })
    mkdirSync(join(big, ".hidden"))
    writeFileSync(join(big, ".hidden", "inside.ts"), "")
    for (let index = 0; index < 300; index++) writeFileSync(join(big, "lib", `module${index}.ts`), "")
    engine.directory = big
    engine.session("ses_work", [])
    const said: string[] = (await words(new VoiceWords(places()))).body.data.words
    expect(said).toHaveLength(100)
    expect(said.slice(0, 2)).toEqual(["big", "lib"])
    expect(said).toContain("module0.ts")
    expect(said).toContain("module0")
    expect(said).not.toContain("inside")
  })

  test("a conversation that isn't there is 404, one with no folder 409", async () => {
    const voice = new VoiceWords(places())
    expect((await words(voice, "ses_gone")).status).toBe(404)
    engine.directory = ""
    const none = await words(voice)
    expect(none.status).toBe(409)
    expect(none.body.message).toBe("That conversation has no folder.")
    expect((await voiceRoutes(voice, "POST", ["words", "ses_work"])).status).toBe(405)
  })
})
