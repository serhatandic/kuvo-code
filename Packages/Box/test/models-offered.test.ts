// The models offered (`kuvo/models/offered`, PROTOCOL.md "The models offered"): each with the side a
// conversation on it runs on and its efforts, so a client offers in place only its own side's and
// draws their efforts without reading the engine's or the bridge's lists itself.

import "./safety"
import { expect, test } from "bun:test"
import { offeredAnswer } from "../src/link/areas/models-offered"
import type { Listed, Lists } from "../src/link/work/model-rule"

const listed = (providerID: string, id: string, name: string, efforts: string[]): Listed => ({
  providerID, id, name, aliases: [], efforts, free: false, provisional: false, hidden: false, retiring: false, released: 1,
})

const lists: Lists = {
  engine: { ready: new Set(["anthropic"]), models: [listed("anthropic", "claude-opus-5-5", "Claude Opus 5.5", ["low", "high", "max"])], accounts: new Map(), fallback: null },
  bridge: {
    models: [listed("claude-code", "opus", "Opus", ["low", "medium", "high"])],
    accounts: new Map([["claude-code", { id: "claude-code", name: "Claude Code", methods: [], signedIn: true, installed: true, complete: true }]]),
    auto: [{ id: "auto_1", name: "Everyday", entries: 2 }],
  },
}

test("each model says its side and its efforts: the engine's, the coding agents', and Custom Auto's lists on the agents' side", () => {
  const answer = offeredAnswer(lists, null)
  expect(answer.models.map(model => [model.providerID, model.id, model.side, model.efforts])).toEqual([
    ["anthropic", "claude-opus-5-5", "engine", ["low", "high", "max"]],
    ["claude-code", "opus", "agents", ["low", "medium", "high"]],
    ["auto", "auto_1", "agents", []],
  ])
  expect(answer.known).toEqual({ engine: true, agents: true })
})

test("a side that can't say has none of its models, and says so", () => {
  const answer = offeredAnswer({ ...lists, bridge: null }, null)
  expect(answer.models.map(model => model.side)).toEqual(["engine"])
  expect(answer.known).toEqual({ engine: true, agents: false })
})
