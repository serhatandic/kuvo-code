import "./safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"

// A Mac can be a machine, with or without the app on it: what's kept from commands is decided by
// which box this is, not which system it's on. Run as a box runs it, in a process of its own.
const mac = process.platform === "darwin"
const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-mac-machine-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const LINK = join(import.meta.dir, "..", "src", "link")

function asBox(home: string, env: Record<string, string>): { kuvo: string[]; agents: string; account: string } {
  mkdirSync(home, { recursive: true })
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("KUVO_"))) as Record<string, string>
  const script = `import { fencePolicy } from ${JSON.stringify(join(LINK, "fence", "policy"))}; import { SSH_AGENTS } from ${JSON.stringify(join(LINK, "home"))}; const policy = fencePolicy(); console.log(JSON.stringify({ kuvo: policy.kuvo, account: policy.home, agents: SSH_AGENTS }))`
  const ran = Bun.spawnSync([process.execPath, "-e", script], { env: { ...clean, HOME: home, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", ...env } })
  expect(ran.exitCode, ran.stderr.toString()).toBe(0)
  return JSON.parse(ran.stdout.toString())
}

test.if(mac)("a machine's box on a Mac keeps its commands from the app's connections and logs there, and its SSH agents in its own folder", () => {
  const short = realpathSync(mkdtempSync("/tmp/kuvo-mm-"))
  try {
    const box = asBox(short, { KUVO_HOME: join(short, ".kuvo-code") })
    expect(box.kuvo).toContain(`/private/tmp/kuvo-ssh-${userInfo().uid}`)
    expect(box.kuvo).toContain(join(short, ".kuvo-code"))
    // (Your account's home, whatever HOME says.)
    expect(box.kuvo).toContain(join(box.account, "Library", "Logs", "Kuvo Code"))
    expect(box.agents).toBe(join(short, ".kuvo-code", "run", "ssh-agents"))
  } finally {
    rmSync(short, { recursive: true, force: true })
  }
})

test.if(mac)("a box on a Mac whose folder is too deep for a socket keeps its agents where one fits", () => {
  const home = join(root, "deep")
  const deep = join(home, "a-folder-long-enough-that-no-socket-in-it-could-ever-fit-in-104-bytes", ".kuvo-code")
  expect(asBox(home, { KUVO_HOME: deep }).agents).toStartWith(`/private/tmp/kuvo-ssh-${userInfo().uid}/agents-`)
})

test.if(mac)("the app's box on a Mac that's a machine too keeps its commands from the machine's folder", () => {
  const home = join(root, "both")
  const app = join(home, "Library", "Application Support", "run.kuvo.code", "box")
  const box = asBox(home, { KUVO_HOME: app, KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: join(home, "config") })
  expect(box.kuvo).toContain(join(box.account, ".kuvo-code"))
  expect(box.agents).toStartWith(`/private/tmp/kuvo-ssh-${userInfo().uid}/agents-`)
})

test.if(!mac)("a machine's box on Linux keeps its SSH agents in its own folder", () => {
  const home = join(root, "linux")
  expect(asBox(home, { KUVO_HOME: join(home, ".kuvo-code") }).agents).toBe(join(home, ".kuvo-code", "run", "ssh-agents"))
})
