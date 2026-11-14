import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

// Settings › Permissions, as the box's own round brings them to every conversation kept with an
// approval (PROTOCOL.md, "Approval"): one changed while the box was down (by hand in the file, or a
// client that wrote it) reaches them as the box starts, not only at the next change. The engine is a
// stand-in (its HTTP API); the box's code is real.

type Rule = { action: string; resource: string; effect: string }
const NEVER_RM: Rule = { action: "shell", resource: "rm -rf /*", effect: "deny" }
const NEVER_PUSH: Rule = { action: "shell", resource: "git push*", effect: "deny" }

let engine: ReturnType<typeof Bun.serve>
let conversation: { id: string; title: string; location: { directory: string }; permissions: Rule[]; metadata: Record<string, unknown>; time: { created: number; updated: number } }
let engineFile: string
let configFile: string
const before: Record<string, string | null> = {}
const sandboxOnBefore = process.env.KUVO_TEST_SANDBOX_ON

const keep = (file: string) => { before[file] = existsSync(file) ? readFileSync(file, "utf8") : null }
const settings = (...permissions: Rule[]) => {
  mkdirSync(dirname(configFile), { recursive: true })
  writeFileSync(configFile, JSON.stringify({ permissions }))
}

beforeAll(async () => {
  process.env.KUVO_TEST_SANDBOX_ON = "1"
  engineFile = (await import("../src/link/home")).ENGINE_FILE
  configFile = (await import("../src/link/areas/config")).CONFIG_FILE
  keep(engineFile)
  keep(configFile)
  engine = Bun.serve({
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname
      if (route === "/api/session") return Response.json({ data: [conversation] })
      if (route === `/api/session/${conversation.id}`) {
        if (request.method === "PATCH") conversation = { ...conversation, ...(await request.json() as Partial<typeof conversation>) }
        return Response.json({ data: conversation })
      }
      return Response.json({ message: "Not here." }, { status: 404 })
    },
  })
  mkdirSync(dirname(engineFile), { recursive: true })
  writeFileSync(engineFile, JSON.stringify({ pid: process.pid, port: engine.port, password: "pw", version: "test" }))
})

afterAll(() => {
  engine.stop(true)
  for (const [file, text] of Object.entries(before)) {
    if (text === null) rmSync(file, { force: true })
    else writeFileSync(file, text)
  }
  if (sandboxOnBefore === undefined) delete process.env.KUVO_TEST_SANDBOX_ON
  else process.env.KUVO_TEST_SANDBOX_ON = sandboxOnBefore
})

test("a change to Settings › Permissions made while the box was down reaches a conversation in Auto as it starts", async () => {
  const { approvalRules } = await import("../src/link/work/approval")
  const { keepApprovals } = await import("../src/link/areas/approval")
  // Made in Auto by the box with Settings as they were.
  settings(NEVER_RM)
  conversation = {
    id: "ses_kept", title: "Fix the build", location: { directory: "/srv/app" },
    permissions: approvalRules("auto", []) as Rule[],
    metadata: { kuvo: { approval: "auto", applied: "auto" } },
    time: { created: Date.now(), updated: Date.now() },
  }
  // Changed while the box was down; then it starts, and its round runs once.
  settings(NEVER_RM, NEVER_PUSH)
  let round: () => Promise<void> = async () => {}
  keepApprovals(() => ({ port: engine.port!, password: "pw" }), () => null, each => { round = each })
  await round()
  expect(conversation.permissions).toContainEqual(NEVER_PUSH)
  expect(conversation.metadata).toEqual({ kuvo: { approval: "auto", applied: "auto" } })
})
