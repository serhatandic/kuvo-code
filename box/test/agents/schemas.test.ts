// The agents' own lists of what they send, against what the bridge knows: a new kind (after an
// agent's update) fails here rather than being lost without a trace. Each check runs when that
// agent's program or package is there, and is skipped otherwise.

import "../safety"
import { REAL_PATH, withRealProgram } from "../../../KuvoLink/Tests/Bridge/test-safety.js"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeMessages, claudeSystem } from "../../src/agents/agents/claude"
import { codexApprovals, codexItems, codexNotifications, codexRequests } from "../../src/agents/agents/codex"

const codex = Bun.which("codex", { PATH: REAL_PATH })

/** The installed Codex's own schema files, read by name, in a folder removed after `check`. */
function codexSchema(check: (read: (file: string) => any) => void) {
  const folder = mkdtempSync(join(tmpdir(), "kuvo-codex-schema-"))
  try {
    // (Only its schema, never signed in: in a home of its own, never yours.)
    const home = join(folder, "codex-home")
    mkdirSync(home)
    const made = withRealProgram(codex!, () => Bun.spawnSync([codex!, "app-server", "generate-json-schema", "--out", join(folder, "schema")], { env: { ...process.env, CODEX_HOME: home } }))
    expect(made.exitCode).toBe(0)
    check((file) => JSON.parse(readFileSync(join(folder, "schema", file), "utf8")))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

describe(codex ? "Codex" : "Codex (skipped: no codex on PATH)", () => {
  test.skipIf(!codex)("every item, notification and request of the installed Codex is known", () => {
    codexSchema((read) => {
      const methods = (file: string): string[] => read(file).oneOf.map((variant: any) => variant.properties.method.enum[0])
      const items: string[] = read("codex_app_server_protocol.v2.schemas.json").definitions.ThreadItem.oneOf.map((variant: any) => variant.properties.type.enum[0])
      const known = new Set([...codexNotifications.shown, ...codexNotifications.ignored])
      expect(items.filter((type) => !codexItems.has(type))).toEqual([])
      expect(methods("ServerNotification.json").filter((method) => !known.has(method))).toEqual([])
      expect(methods("ServerRequest.json").filter((method) => !codexRequests.has(method))).toEqual([])
    })
  })

  // Codex retires a policy in its settings first (`untrusted` in config.toml); one its app-server
  // stops taking would leave a mode (Ask First, Plan, Approve All) not starting Codex at all.
  test.skipIf(!codex)("every approval policy the bridge starts Codex with is one the installed Codex still takes", () => {
    codexSchema((read) => {
      const policies: string[] = read("codex_app_server_protocol.v2.schemas.json").definitions.AskForApproval.oneOf.flatMap((variant: any) => variant.enum ?? [])
      expect(policies.length).toBeGreaterThan(0)
      expect(Object.values(codexApprovals).filter((policy) => !policies.includes(policy))).toEqual([])
    })
  })
})

describe("Claude Code", () => {
  test("every kind of message the Agent SDK's typings list is known", () => {
    const typings = readFileSync(join(import.meta.dir, "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts"), "utf8")
    const union = /export declare type SDKMessage = ([^;]+);/.exec(typings)?.[1] ?? ""
    const names = union.split("|").map((name) => name.trim()).flatMap((name) => {
      const alias = new RegExp(`declare type ${name} = ([A-Za-z| ]+);`).exec(typings)?.[1]
      return alias && !alias.includes("{") ? alias.split("|").map((part) => part.trim()) : [name]
    })
    expect(names.length).toBeGreaterThan(20)
    const missing: string[] = []
    for (const name of names) {
      const body = new RegExp(`declare type ${name} = (\\{[\\s\\S]*?\\n\\});`).exec(typings)?.[1] ?? ""
      const type = /^\s{4}type: '([^']+)'/m.exec(body)?.[1]
      if (!type) continue
      if (!claudeMessages.has(type)) missing.push(type)
      const subtypes = /^\s{4}subtype: ([^;]+);/m.exec(body)?.[1] ?? ""
      if (type === "system") for (const [, subtype] of subtypes.matchAll(/'([^']+)'/g)) if (!claudeSystem.has(subtype)) missing.push(`system:${subtype}`)
    }
    expect(missing).toEqual([])
  })
})

/** Cursor's SDK, where a Kuvo Code on this Mac installed it (its runtime folder), if any. */
function cursorSDK(): string | undefined {
  const support = join(process.env.KUVO_TEST_REAL_HOME ?? "", "Library", "Application Support")
  for (const app of ["run.kuvo.code", "run.kuvo.code.agents", "run.kuvo.code.agents2"]) {
    const path = join(support, app, "agents", "runtime", "cursor", "node_modules", "@cursor", "sdk", "dist", "esm", "index.js")
    if (Bun.file(path).size > 0) return path
  }
  return process.env.KUVO_CURSOR_SDK
}

describe("Cursor", () => {
  const sdk = cursorSDK()
  test.skipIf(!sdk)("every update and tool its SDK tells is known", async () => {
    const { cursorTools, cursorUpdates } = await import("../../src/agents/agents/cursor")
    const module: any = await import(sdk!)
    const updates: string[] = module.InteractionUpdateSchema.options.map((option: any) => option.shape.type.value)
    const tools: string[] = module.ToolCallStartedUpdateSchema.shape.toolCall.options.map((option: any) => option.shape.type.value)
    expect(updates.filter((type) => !cursorUpdates.has(type))).toEqual([])
    expect(tools.filter((type) => !cursorTools.has(type))).toEqual([])
  })
})
