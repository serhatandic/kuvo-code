import { expect, test } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// The link's main.ts isn't type-checked yet (@ts-nocheck) while its parts move into modules, so
// neither tsc nor the bundler says when it uses a name nothing declares or imports any more (one
// that moved): the box would fail only as that line runs. This checks a copy without the pragma
// for those errors alone. It goes once main.ts is checked as the rest is.

const link = join(import.meta.dir, "../src/link")
// Can't find a name (2304, 2552), a module's export (2305, 2614, 2724), or the value of a shorthand
// property (18004); used before it's declared (2448).
const UNRESOLVED = /error TS(2304|2305|2448|2552|2614|2724|18004)\b/

test("everything main.ts uses is declared there or imported", () => {
  const source = readFileSync(join(link, "main.ts"), "utf8")
  expect(source.startsWith("// @ts-nocheck\n")).toBe(true)
  const copy = join(link, ".unresolved-main.ts")
  writeFileSync(copy, "//" + source.slice("// @ts-nocheck".length))
  try {
    // Its own runtime runs tsc, so it needs no node on PATH; no DOM, whose globals (`name`,
    // `status`, `origin`…) would stand in for names that went.
    const tsc = Bun.spawnSync([process.execPath, join(import.meta.dir, "../node_modules/typescript/bin/tsc"), "--noEmit", "--skipLibCheck",
      "--target", "ESNext", "--lib", "ESNext", "--module", "ESNext", "--moduleResolution", "bundler", "--types", "node", "--esModuleInterop", copy])
    const output = tsc.stdout.toString()
    // It ran, and found what an unchecked file always has: else nothing here would show.
    expect(tsc.exitCode).toBe(2)
    expect(output).toContain("error TS")
    expect(output.split("\n").filter(line => UNRESOLVED.test(line))).toEqual([])
  } finally {
    rmSync(copy, { force: true })
  }
}, 120_000)
