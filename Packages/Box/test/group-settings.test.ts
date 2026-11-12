import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// What every group chat on a computer goes by, worked out by that computer's box with no Mac (and
// no client) there: what each personality tells a bot (Kuvo Code's own and yours), who sets what
// about a bot, Ask First (the computer's default approval), and what its Settings › Permissions
// hold back, given to the coding agents' bridge, which keeps them for its chats' seats. A client
// says only your clock. The bridge is the real one's group chat routes and store; its engine a
// stand-in.

type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
const NEVER_PUSH: Rule = { action: "shell", resource: "git push*", effect: "deny" }
const ASK_EDITS: Rule = { action: "edit", resource: "*", effect: "ask" }

const before: Record<string, string | null> = {}
const keep = (file: string) => { before[file] = existsSync(file) ? readFileSync(file, "utf8") : null }
const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

let root: string
let bridge: ReturnType<typeof Bun.serve>
let store: import("../src/agents/groups/store").GroupStore
let rulesChanged = 0
let configFile: string, approvalFile: string
let round: () => Promise<void> = async () => {}

beforeAll(async () => {
  const home = await import("../src/link/home")
  configFile = (await import("../src/link/areas/config")).CONFIG_FILE
  approvalFile = (await import("../src/link/work/approval")).APPROVAL_FILE
  const words = join(home.K, "bin", "bot-words.json")
  const library = (await import("../src/link/personalities/library")).PERSONALITIES_FILE
  for (const file of [configFile, approvalFile, words, library]) keep(file)
  // Kuvo Code's words for bots, as a release puts them beside the bridge; one personality you made;
  // Settings › Permissions with something held back; Ask First picked last on this computer.
  mkdirSync(dirname(words), { recursive: true })
  copyFileSync(new URL("../../KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url).pathname, words)
  put(library, JSON.stringify({ kuvo: 1, personalities: [{ id: "custom.grumpy", name: "Grumpy", description: "Complains, then helps.", symbol: "cloud", updated: 1 }], removed: [] }))
  put(configFile, JSON.stringify({ permissions: [ASK_EDITS, NEVER_PUSH] }))
  ;(await import("../src/link/work/approval")).rememberApproval("askFirst")

  // The coding agents' bridge, its group chats' own routes and store.
  root = mkdtempSync(join(tmpdir(), "kuvo-group-settings-"))
  const { GroupStore } = await import("../src/agents/groups/store")
  const { groupRoutes } = await import("../src/agents/groups/routes")
  store = new GroupStore(join(root, "groups"), join(root, "bots"), join(root, "run", "agents.json"))
  // (What the runner does with a change to the rules is its own suite's: here, only that it's told.)
  const runner = { rulesChanged: () => { rulesChanged++ } } as unknown as import("../src/agents/groups/runner").GroupRunner
  bridge = Bun.serve({
    port: 0,
    async fetch(request) {
      const parts = new URL(request.url).pathname.split("/").filter(Boolean)
      if (parts.slice(0, 3).join("/") !== "api/kuvo/groups") return Response.json({}, { status: 404 })
      return groupRoutes(runner, store, request.method, parts.slice(3), () => request.json())
    },
  })
  const { keepGroupSettings } = await import("../src/link/areas/group-settings")
  keepGroupSettings(() => ({ port: bridge.port!, password: "pw" }), each => { round = each })
})

afterAll(() => {
  bridge.stop(true)
  rmSync(root, { recursive: true, force: true })
  for (const [file, text] of Object.entries(before)) {
    if (text === null) rmSync(file, { force: true })
    else writeFileSync(file, text)
  }
})

test("a computer's box gives its group chats what they go by, with no Mac: personalities, who sets what, Ask First, what's held back", async () => {
  const words = JSON.parse(readFileSync(new URL("../../KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), "utf8"))
  await round()
  const settings = store.settings()!
  expect(settings).toBeDefined()
  // Kuvo Code's own, in its words, and yours.
  const preset = words.personalities[0]
  expect(settings.personalities[preset.id]).toBe(words.personalityWords.replaceAll("⟦name⟧", preset.name).replaceAll("⟦description⟧", preset.description))
  expect(settings.personalities["custom.grumpy"]).toContain("Complains, then helps.")
  expect(settings.identityNote).toBe(words.identityNote)
  expect(settings.askFirst).toBe(true)
  expect(settings.denies).toEqual([NEVER_PUSH])
  expect(rulesChanged).toBe(1)
})

test("what they go by follows this computer: Auto picked, a rule taken out", async () => {
  ;(await import("../src/link/work/approval")).rememberApproval("auto")
  put(configFile, JSON.stringify({ permissions: [ASK_EDITS] }))
  await round()
  expect(store.settings()!.askFirst).toBe(false)
  expect(store.settings()!.denies).toEqual([])
  expect(rulesChanged).toBe(2)
})

test("a Mac says only your clock; an older Mac's Ask First and personalities don't go over the box's own", async () => {
  const groups = `http://127.0.0.1:${bridge.port}/api/kuvo/groups`
  // A Mac now, on a path of its own.
  expect((await fetch(`${groups}/clock`, { method: "PUT", body: JSON.stringify({ timeZone: "Asia/Tokyo", locale: "ja-JP" }) })).status).toBe(200)
  expect(store.settings()!.timeZone).toBe("Asia/Tokyo")
  expect(store.settings()!.askFirst).toBe(false)
  // As a Mac from before sends them: all of its own.
  await fetch(`${groups}/settings`, { method: "PUT", body: JSON.stringify({ personalities: {}, identityNote: "", askFirst: true, denies: [NEVER_PUSH], timeZone: "Europe/Istanbul", locale: "tr-TR" }) })
  const settings = store.settings()!
  expect(settings.timeZone).toBe("Europe/Istanbul")
  expect(settings.locale).toBe("tr-TR")
  expect(settings.askFirst).toBe(false)
  expect(settings.denies).toEqual([])
  expect(settings.personalities["custom.grumpy"]).toContain("Complains, then helps.")
  // And the box's next round doesn't take your clock away.
  ;(await import("../src/link/work/approval")).rememberApproval("acceptEdits")
  await round()
  expect(store.settings()!.askFirst).toBe(true)
  expect(store.settings()!.timeZone).toBe("Europe/Istanbul")
})

test("while this computer's Settings › Permissions can't be read, its group chats keep what they hold back", async () => {
  put(configFile, JSON.stringify({ permissions: [NEVER_PUSH] }))
  await round()
  expect(store.settings()!.denies).toEqual([NEVER_PUSH])
  // Changed by hand, and not plain JSON any more.
  put(configFile, `{ "permissions": [], // comment\n}`)
  ;(await import("../src/link/work/approval")).rememberApproval("auto")
  await round()
  expect(store.settings()!.denies).toEqual([NEVER_PUSH])
  // Nothing given until it can be read.
  expect(store.settings()!.askFirst).toBe(true)
})
