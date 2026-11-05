import "./safety"
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

// Every file of the box is type-checked (`bun run check`, which CI runs): none says
// `@ts-nocheck`, so none can use a name nothing declares or imports and fail only as that line runs.

const src = join(import.meta.dir, "../src")

function* sources(folder: string): Generator<string> {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    if (entry.isDirectory()) yield* sources(file)
    else if (entry.name.endsWith(".ts")) yield file
  }
}

test("every file of the box is type-checked", () => {
  const files = [...sources(src)]
  expect(files.length).toBeGreaterThan(70)
  expect(files.filter(file => readFileSync(file, "utf8").includes("@ts-nocheck")).map(file => relative(src, file))).toEqual([])
})
