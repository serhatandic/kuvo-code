// The names of the models sessions ran on, kept in the box's own folder so a model gone since is
// named as it was (PROTOCOL.md, "A session's model"): two of the box's processes (its relay link and
// its own server) each keep and save them, and neither loses what the other saved.

import "./safety"
import { afterEach, expect, test } from "bun:test"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { BOX } from "../src/link/home"
import { forgetModelNames, lastName, rememberName } from "../src/link/work/model-rule"

const FILE = join(BOX, "model-names.json")
const saved = () => JSON.parse(readFileSync(FILE, "utf8")).names as string[][]
/** What another of the box's processes saves, as it writes the file. */
const anotherSaves = (names: string[][]) => {
  mkdirSync(BOX, { recursive: true })
  writeFileSync(FILE, JSON.stringify({ names }))
}

afterEach(() => forgetModelNames())

test("two writers: what one saved after the other read the file is kept as the other saves", () => {
  forgetModelNames()
  // This process reads the file (empty) and notes Opus 5.5…
  expect(lastName({ providerID: "anthropic", id: "claude-opus-5-5" })).toBeUndefined()
  rememberName({ providerID: "claude-code", id: "default" }, "Opus 5.5")
  // …while the other saves GPT-5.5, then this one saves (a restart's save, at once).
  anotherSaves([["openai", "gpt-5.5", "GPT-5.5"]])
  forgetModelNames(true)
  expect(saved()).toEqual([["openai", "gpt-5.5", "GPT-5.5"], ["claude-code", "default", "Opus 5.5"]])
  // Read again as a box starting does: both.
  expect(lastName({ providerID: "openai", id: "gpt-5.5" })).toBe("GPT-5.5")
  expect(lastName({ providerID: "claude-code", id: "default" })).toBe("Opus 5.5")
})

test("the newest saying wins for a model both named, and the file stays at 2000", () => {
  forgetModelNames()
  rememberName({ providerID: "claude-code", id: "default" }, "Opus 5.5")
  anotherSaves([...Array.from({ length: 2000 }, (_, at) => ["p", `m${at}`, `M${at}`]), ["claude-code", "default", "Opus 5"]])
  forgetModelNames(true)
  const names = saved()
  expect(names.length).toBe(2000)
  expect(names.at(-1)).toEqual(["claude-code", "default", "Opus 5.5"])
  expect(names.filter(([provider, id]) => provider === "claude-code" && id === "default").length).toBe(1)
})

test("forgetting the names lets go of the save waiting for the box's exit", () => {
  forgetModelNames()
  const before = process.listenerCount("exit")
  rememberName({ providerID: "openai", id: "gpt-5.5" }, "GPT-5.5")
  expect(process.listenerCount("exit")).toBe(before + 1)
  forgetModelNames()
  expect(process.listenerCount("exit")).toBe(before)
})
