import "./safety"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FEATURES, MAC_BOX_FEATURES, MACHINE_FEATURES } from "../src/shared/features"
import { MAC_FEATURES, MAC_FEATURES_AT_TIMES } from "../src/shared/routes/mac"
import { keptFeatures } from "../src/link/peers/directory"
import { mailedFeatures } from "../src/link/peers/agents"

// The lists of what a box answers are kept one name a line, in order, so branches that each add a
// name merge without a conflict (features.ts by union: .gitattributes). A list out of order, or a
// name in it twice, as a merge can leave it, fails here.

const inOrder = <T extends string>(names: readonly T[]): T[] => [...new Set(names)].sort()

test("every box's names and the Mac's own are each in order, each name once", () => {
  expect([...FEATURES]).toEqual(inOrder(FEATURES))
  expect([...MAC_FEATURES]).toEqual(inOrder(MAC_FEATURES))
})

test("features.ts has one name a line, so what two branches add merges line by line", () => {
  const text = readFileSync(join(import.meta.dir, "../src/shared/features.ts"), "utf8")
  const list = text.slice(text.indexOf("export const FEATURES = [\n") + "export const FEATURES = [\n".length, text.indexOf("\n] as const;"))
  const lines = list.split("\n")
  for (const line of lines) expect(line).toMatch(/^ {2}"[A-Za-z0-9.-]+",$/)
  expect(lines.map(line => JSON.parse(line.trim().slice(0, -1)))).toEqual([...FEATURES])
})

test("a machine's own names and the Mac's at times are among the names they answer", () => {
  for (const name of MACHINE_FEATURES) expect(FEATURES).toContain(name)
  for (const name of MAC_FEATURES_AT_TIMES) expect(MAC_FEATURES).toContain(name)
  expect([...MAC_BOX_FEATURES, ...MACHINE_FEATURES].sort()).toEqual([...FEATURES])
})

test("a peer from before the lists were in order still finds what it checks among the first 80 a box's mail gives", () => {
  // As many as this Mac answers, and more to come.
  const many = inOrder([...FEATURES, ...MAC_FEATURES, ...Array.from({ length: 60 }, (_, index) => `zz.later-${index}`)])
  expect(many.length).toBeGreaterThan(80)
  const mailed = mailedFeatures(many)
  expect(inOrder(mailed)).toEqual(many)
  // What such a box kept of it, and checks.
  const older = mailed.slice(0, 80)
  for (const name of ["groups.seats", "letters-read", "moves", "moves.agents", "moves.check", "work.elsewhere"]) expect(older).toContain(name)
  // A box now keeps them all.
  expect(keptFeatures(mailed)).toEqual(mailed)
})
