// What a session's model being ready means for a composer, as the box words it (`readiness`,
// kuvo/sessions/models and the typed send), held to the cases KuvoClient's SessionModelState and
// gpui's ModelState draw from too (protocol/vectors/model-readiness.json).

import "./safety"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { readiness } from "../src/link/work/model-words"

const vectors = JSON.parse(readFileSync(new URL("../../protocol/vectors/model-readiness.json", import.meta.url), "utf8"))

test.each(vectors.cases.map((each: any) => [each.about, each]))("%s", (_, each: any) => {
  const { model, ...state } = each.state
  expect(readiness(model, state, each.known)).toEqual(each.readiness)
})

test("no sentence names a computer or a settings page", () => {
  for (const each of vectors.cases) {
    const words = JSON.stringify(readiness(each.state.model, each.state, each.known))
    expect(words).not.toMatch(/Settings|›| on your | on Studio/)
  }
})
