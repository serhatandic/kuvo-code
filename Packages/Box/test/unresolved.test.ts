import { expect, test } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// The link's main.ts isn't type-checked yet (@ts-nocheck) while its parts move into modules, so
// neither tsc nor the bundler says when it uses a name nothing declares or imports any more (one
// that moved): the box would fail only as that line runs. This checks a copy without the pragma
// for those errors alone. It goes once main.ts is checked as the rest is.

const link = join(import.meta.dir, "../src/link")

test("everything main.ts uses is declared there or imported", () => {
  const copy = join(link, ".unresolved-main.ts")
  writeFileSync(copy, readFileSync(join(link, "main.ts"), "utf8").replace(/^\/\/ @ts-nocheck\n/, "//\n"))
  try {
    const tsc = Bun.spawnSync([join(import.meta.dir, "../node_modules/.bin/tsc"), "--noEmit", "--skipLibCheck", "--target", "ESNext", "--module", "ESNext",
      "--moduleResolution", "bundler", "--types", "node", "--esModuleInterop", copy])
    const unresolved = tsc.stdout.toString().split("\n").filter(line => /error TS(2304|2305|2552|2614|2724)/.test(line))
    expect(unresolved).toEqual([])
  } finally {
    rmSync(copy, { force: true })
  }
}, 120_000)
