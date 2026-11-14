import "./safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { availableParallelism, tmpdir } from "node:os"
import { join, relative } from "node:path"

// The box loads whichever of its modules comes first (#661). Its modules import each other in rings
// (letters/calls.ts → start-call.ts → work/stop.ts → calls.ts…), and a module that read a name it
// imports as it loaded (`boxName = computerName`) found it not there yet when the ring was entered
// from elsewhere: a test file that imported it first failed alone and passed after others, and the
// built link (whose order is main.ts's) would have had nothing there, failing only when it was used.
// So each module is loaded first, alone, in a process of its own, as an entry point or a test would.
// (That's every way into a ring: the order inside one depends only on which of its modules is
// reached first, and a ring reached through one already loaded was loaded with it.)
const SRC = join(import.meta.dir, "..", "src")
const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-load-order-")))
// (A module that never finished loading is stopped with the test: only those it started.)
const running = new Set<ReturnType<typeof Bun.spawn>>()
afterAll(() => {
  for (const child of running) child.kill()
  rmSync(root, { recursive: true, force: true })
})

const modules = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = join(folder, entry.name)
    if (entry.isDirectory()) return modules(file)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [file] : []
  })

// The coding agents' bridge runs as it loads: it's started as its build is (`selftest`), which loads
// all it imports and stops. The link's main.ts runs only when it's the program, so it's loaded too.
const AGENTS_MAIN = join(SRC, "agents", "main.ts")

async function loadAlone(module: string, env: Record<string, string>): Promise<string | null> {
  const loaded = "loaded first"
  const run = module === AGENTS_MAIN
    ? [process.execPath, module, "selftest"]
    : [process.execPath, "-e", `await import(${JSON.stringify(module)}); console.log(${JSON.stringify(loaded)}); process.exit(0)`]
  const child = Bun.spawn(run, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  running.add(child)
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  running.delete(child)
  // (Its last line: a module may say something as it loads.)
  const last = out.trim().split("\n").at(-1) ?? ""
  const said = module === AGENTS_MAIN ? last.startsWith("ok ") : last === loaded
  if (code === 0 && said) return null
  const why = err.split("\n").find(line => /Error\b/.test(line)) || err.trim().split("\n").at(-1) || `exit ${code}, saying ${JSON.stringify(last)}`
  return `${relative(SRC, module)}: ${why.trim()}`
}

test("every module of the box loads when it's the first one loaded, entry points included", async () => {
  const all = modules(SRC).sort()
  expect(all).toContain(join(SRC, "link", "main.ts"))
  expect(all).toContain(AGENTS_MAIN)
  const home = join(root, "home")
  mkdirSync(home)
  const env = { ...(process.env as Record<string, string>), HOME: home, KUVO_HOME: join(home, ".kuvo-code"), TMPDIR: root }
  const failed: string[] = []
  const waiting = [...all]
  await Promise.all(Array.from({ length: Math.min(8, availableParallelism()) }, async () => {
    for (let module = waiting.shift(); module; module = waiting.shift()) {
      const failure = await loadAlone(module, env)
      if (failure) failed.push(failure)
    }
  }))
  expect(failed.sort()).toEqual([])
}, 300_000)
