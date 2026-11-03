import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

// The reviewer's eval set (`eval/reviewer/actions.jsonl`): every case it says code settles (a hard
// line, or what always comes to you) comes out so here, with no model at all; and none of the
// others is settled by code, so the model gets to judge them. The model's own share is measured
// with `eval/reviewer/run.ts` on real models.

let box: string
let reviewer: typeof import("../src/link/work/reviewer")
beforeAll(async () => {
  box = mkdtempSync(join(tmpdir(), "kuvo-reviewer-eval-"))
  reviewer = await import("../src/link/work/reviewer")
})
afterAll(() => rmSync(box, { recursive: true, force: true }))

interface Case { id: string; kind: "command" | "file" | "tool"; command?: string; path?: string; access?: "read" | "write"; tool?: string; args?: Record<string, unknown>; said?: string[]; bot?: string; expect: string; by?: string; on?: NodeJS.Platform }
// (A case about one system's places, `on` it only: the walls are each system's own.)
const cases = readFileSync(join(import.meta.dir, "..", "eval", "reviewer", "actions.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Case)
  .filter(each => !each.on || each.on === process.platform)

test("the eval set's code cases are settled by code as it says, and the rest reach the model", async () => {
  const project = join(box, "project")
  const wrong: string[] = []
  for (const each of cases) {
    const action = each.kind === "command" ? { kind: "command" as const, command: each.command!, folder: project }
      : each.kind === "file" ? { kind: "file" as const, path: each.path!.replace(/^~(?=\/)/, homedir()), access: each.access ?? "read", folder: project }
      : { kind: "tool" as const, tool: each.tool!, args: each.args ?? {}, folder: project }
    const context = each.bot ? { session: `eval_${each.id}`, said: [], bot: { id: "bot_eval", name: "Eval", goal: each.bot } } : { session: `eval_${each.id}`, said: each.said ?? [] }
    const verdict = await reviewer.review(action, context, { model: null, tell: "", folder: join(box, "reviews") })
    const byCode = verdict.by === "code" && !(verdict.decision === "ask" && verdict.why === "noModel")
    if (each.by === "code" ? !byCode || verdict.decision !== each.expect : byCode) wrong.push(`${each.id}: ${verdict.decision} by ${verdict.by} (${verdict.reason})`)
  }
  expect(wrong).toEqual([])
  expect(cases.length).toBeGreaterThanOrEqual(100)
})
