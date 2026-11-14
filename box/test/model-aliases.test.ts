import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { model } from "../src/agents/agent"

// Claude Code's `default` isn't a model the box offers, but a start_session, a Custom Auto list or
// a session that names it still gets the model it stands for. The bridge is a stand-in (its HTTP
// answer, built as the bridge builds it); the box's own code reading it is real.

let bridge: ReturnType<typeof Bun.serve>
let models: typeof import("../src/link/work/models")

beforeAll(async () => {
  models = await import("../src/link/work/models")
  const listed = [
    model("claude-code", "opus", "Opus 5.5", { variants: ["low", "high"], aliases: ["default"] }),
    model("claude-code", "haiku", "Haiku 4.5"),
    model("claude-code@work", "sonnet", "Sonnet 5.5", { variants: ["low", "high"], aliases: ["default"] }),
  ]
  // (Its accounts as it lists them: signed in, installed, their lists every model they run.)
  const account = (id: string) => ({ id, name: "Claude Code", methods: [{ type: "oauth", id: "agent" }], metadata: { source: "agent", installed: true, modelsComplete: true }, connections: [{ type: "agent" }] })
  bridge = Bun.serve({ port: 0, fetch: request => {
    const url = new URL(request.url)
    if (url.pathname === "/api/model") return Response.json({ data: listed })
    if (url.pathname === "/api/integration") return Response.json({ data: [account("claude-code"), account("claude-code@work")] })
    if (url.pathname === "/api/kuvo/auto") return Response.json({ data: { entries: [], lists: [], limits: [] } })
    return Response.json({ message: "Not here." }, { status: 404 })
  } })
})
afterAll(() => bridge.stop(true))

const there = () => ({ port: bridge.port!, password: "x" })

test("a model named by claude-code/default is the one it stands for on that account, with its efforts", async () => {
  const usable = (await models.modelsHere(null, there())).models
  const first = models.pickModel("claude-code/default", "high", usable)
  expect("model" in first && [first.model.providerID, first.model.id, first.variant]).toEqual(["claude-code", "opus", "high"])
  // (Another account's default is that account's: never assumed to be the same model.)
  const second = models.pickModel({ providerID: "claude-code@work", id: "default" }, undefined, usable)
  expect("model" in second && [second.model.providerID, second.model.id]).toEqual(["claude-code@work", "sonnet"])
})

test("list_models offers the model, not a second row for its default", async () => {
  const text = models.describeModels((await models.modelsHere(null, there())).models, [])
  expect(text).toContain("claude-code/opus (Opus 5.5)")
  expect(text).not.toContain("default")
})

test("a hold kept on claude-code/default marks the model it stands for, and is warned of", async () => {
  const { holdOf } = await import("../src/link/work/unanswering")
  const held = [{ key: "claude-code/default", scope: "model", why: "At its limit", at: 1, until: Date.now() + 60_000 }] as any
  const usable = (await models.modelsHere(null, there())).models
  const opus = usable.find(each => each.id === "opus")!
  expect(holdOf(opus, held)?.why).toBe("At its limit")
  expect(holdOf(usable.find(each => each.id === "haiku")!, held)).toBeNull()
  expect(models.describeModels(usable, held)).not.toContain("claude-code/opus (Opus 5.5)")
})
