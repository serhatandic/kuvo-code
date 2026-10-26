import { expect, test } from "bun:test"
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"

// What isn't type-checked yet (`// @ts-nocheck`: the link's main.ts, and parts just moved out of
// it, until each is typed) has neither tsc nor the bundler say when it uses a name nothing
// declares or imports any more (one that moved): the box would fail only as that line runs. This
// checks a copy of each without the pragma for those errors alone. It goes once all are checked.

const src = join(import.meta.dir, "../src")
// Can't find a name (2304, 2552), a module's export (2305, 2614, 2724), or the value of a shorthand
// property (18004); used before it's declared (2448).
const UNRESOLVED = /error TS(2304|2305|2448|2552|2614|2724|18004)\b/
const PRAGMA = "// @ts-nocheck\n"

function* sources(folder: string): Generator<string> {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name)
    if (entry.isDirectory()) yield* sources(file)
    else if (entry.name.endsWith(".ts") && !entry.name.startsWith(".")) yield file
  }
}

test("everything the files not checked yet use is declared there or imported", () => {
  const unchecked = [...sources(src)].filter(file => readFileSync(file, "utf8").startsWith(PRAGMA))
  expect(unchecked).toContain(join(src, "link/main.ts"))
  const copies = unchecked.map(file => {
    const copy = join(dirname(file), `.unresolved-${relative(dirname(file), file)}`)
    writeFileSync(copy, "//" + readFileSync(file, "utf8").slice("// @ts-nocheck".length))
    return copy
  })
  try {
    // Its own runtime runs tsc, so it needs no node on PATH; no DOM, whose globals (`name`,
    // `status`, `origin`…) would stand in for names that went.
    const tsc = Bun.spawnSync([process.execPath, join(import.meta.dir, "../node_modules/typescript/bin/tsc"), "--noEmit", "--skipLibCheck",
      "--target", "ESNext", "--lib", "ESNext", "--module", "ESNext", "--moduleResolution", "bundler", "--types", "node", "--esModuleInterop", ...copies])
    const output = tsc.stdout.toString()
    // It ran, and found what an unchecked file always has: else nothing here would show.
    expect(tsc.exitCode).toBe(2)
    expect(output).toContain("error TS")
    expect(output.split("\n").filter(line => UNRESOLVED.test(line))).toEqual([])
  } finally {
    for (const copy of copies) rmSync(copy, { force: true })
  }
}, 120_000)
