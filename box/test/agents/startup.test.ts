// The agents bridge as Kuvo Code starts it, before the box has set up its sandbox (this Mac's app
// starts the bridge first, a machine's launch may too): no coding agent starts until the box has
// said whether the sandbox is on, so none is left running outside it.

import "../safety"
import { afterAll, afterEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canFence, realFence } from "./support/fence"

const base = realpathSync(mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-startup-test-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const main = join(import.meta.dir, "..", "..", "src", "agents", "main.ts")
const password = "startup-test"
const auth = { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }
let bridge: ReturnType<typeof Bun.spawn> | undefined
let box: ReturnType<typeof Bun.spawn> | undefined
afterEach(() => {
  bridge?.kill()
  box?.kill()
  bridge = box = undefined
})

/** A Codex that says in its account whether it runs in the sandbox: there, Kuvo Code's folder (`kuvo`) can't be read. */
function fakeCodex(bin: string, kuvo: string) {
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "codex.js")
  writeFileSync(
    script,
    `const fs = require("node:fs")
let inside = false
try { fs.readFileSync(${JSON.stringify(join(kuvo, "secret"))}) } catch { inside = true }
if (process.argv[2] !== "app-server") { console.log("codex-cli 0.0.0"); process.exit(0) }
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
let buffer = ""
process.stdin.on("end", () => process.exit(0))
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt", email: inside ? "in-sandbox@test" : "outside-sandbox@test" } } })
    else send({ id: message.id, result: {} })
  }
})
`,
  )
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(join(bin, "codex"), 0o755)
}

/** The bridge, started with the box's sandbox folder empty: the box hasn't set it up yet. This Mac's
 * (the app names the folder), or a `machine`'s (in its Kuvo Code folder). */
function start(root: string, machine = false) {
  const kuvo = join(root, "kuvo")
  const fence = join(kuvo, "run", "fence")
  mkdirSync(fence, { recursive: true })
  writeFileSync(join(kuvo, "secret"), "Kuvo Code's own\n")
  const bin = join(root, "bin")
  fakeCodex(bin, kuvo)
  for (const folder of ["home", "tmp", "agents"]) mkdirSync(join(root, folder), { recursive: true })
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: join(root, "tmp") + "/", BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    KUVO_AGENTS_HOME: join(root, "agents"), OPENCODE_PASSWORD: password,
    ...(machine ? { KUVO_HOME: kuvo } : { KUVO_FENCE: fence }),
  }
  const child = (bridge = Bun.spawn([process.execPath, "run", main], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }))
  const lines = (stream: ReadableStream<Uint8Array>, found: (text: string) => boolean) =>
    (async () => {
      let text = ""
      for await (const chunk of stream) {
        text += new TextDecoder().decode(chunk)
        if (found(text)) return text
      }
      return null
    })()
  const url = lines(child.stdout as ReadableStream<Uint8Array>, (text) => text.includes("\n")).then((text) => (text ? new URL(JSON.parse(text.split("\n")[0]).url) : null))
  // What it says while it waits for the box.
  const waiting = lines(child.stderr as ReadableStream<Uint8Array>, (text) => text.includes("Waiting for the box to set up its sandbox before starting any coding agent."))
  return { kuvo, fence, url, waiting }
}

/** The box (a stand-in, by its script's name), having set its sandbox up (or found it can't run
 * here): it says so as it runs. */
function boxDecides(fence: string) {
  const script = join(fence, "..", "..", "kuvo-link.js")
  writeFileSync(script, "process.stdin.resume()\n")
  box = Bun.spawn([process.execPath, script], { env: { BUN_BE_BUN: "1" }, stdin: "pipe" })
  writeFileSync(join(fence, "decided"), JSON.stringify({ pid: box.pid }))
}

/** Codex's account as the bridge lists it: whose words say where Codex runs. */
async function codexAccount(url: URL) {
  const answer = await fetch(new URL("/api/integration/codex-cli", url), { headers: auth })
  return JSON.stringify(await answer.json())
}

test.skipIf(!canFence)("the bridge starts no coding agent until the box has set up its sandbox: Codex, asked for at once, runs in it", async () => {
  const root = join(base, "on")
  const { kuvo, fence, url, waiting } = start(root)
  // Whichever comes first: the bridge listening (and an app's first ask starting Codex), or the
  // bridge waiting for the box.
  const listening = await Promise.race([url, waiting.then(() => null)])
  if (!listening) {
    realFence(kuvo)
    boxDecides(fence)
  }
  const address = listening ?? (await url)
  expect(address).not.toBeNull()
  expect(await codexAccount(address!)).toContain("in-sandbox@test")
}, 60_000)

test("where the box can't run the sandbox, it says so, and the bridge starts the agents as before", async () => {
  const root = join(base, "off")
  const { fence, url, waiting } = start(root)
  await waiting
  boxDecides(fence)
  const address = await url
  expect(address).not.toBeNull()
  expect(await codexAccount(address!)).toContain("outside-sandbox@test")
}, 60_000)

test("a box that said so before it stopped (a restart, a crash) doesn't count: the bridge waits for the one that runs now", async () => {
  const root = join(base, "gone")
  const kuvo = join(root, "kuvo")
  const fence = join(kuvo, "run", "fence")
  mkdirSync(fence, { recursive: true })
  const gone = Bun.spawn([process.execPath, "-e", "0"], { env: { BUN_BE_BUN: "1" } })
  await gone.exited
  writeFileSync(join(fence, "decided"), JSON.stringify({ pid: gone.pid }))
  const { url, waiting } = start(root)
  expect(await Promise.race([url, waiting.then(() => "waits")])).toBe("waits")
  boxDecides(fence)
  expect(await codexAccount((await url)!)).toContain("outside-sandbox@test")
}, 60_000)

test.skipIf(!existsSync("/proc"))("on Linux, another program that took a gone box's number doesn't count either", async () => {
  const root = join(base, "taken")
  const fence = join(root, "kuvo", "run", "fence")
  mkdirSync(fence, { recursive: true })
  writeFileSync(join(fence, "decided"), JSON.stringify({ pid: process.pid }))
  const { url, waiting } = start(root)
  expect(await Promise.race([url, waiting.then(() => "waits")])).toBe("waits")
  boxDecides(fence)
  expect(await url).not.toBeNull()
}, 60_000)

test("on a machine whose box doesn't run (nothing for it to answer), the bridge doesn't wait for it; while its keeper starts it, it does", async () => {
  const alone = start(join(base, "machine-alone"), true)
  const address = await Promise.race([alone.url, alone.waiting.then(() => "waits")])
  expect(address).toBeInstanceOf(URL)
  expect(await codexAccount(address as URL)).toContain("outside-sandbox@test")
  bridge?.kill()

  const root = join(base, "machine-needed")
  mkdirSync(join(root, "kuvo", "run", "fence"), { recursive: true })
  writeFileSync(join(root, "kuvo", "run", "link.needed"), "")
  const needed = start(root, true)
  expect(await Promise.race([needed.url, needed.waiting.then(() => "waits")])).toBe("waits")
  boxDecides(needed.fence)
  expect(await needed.url).not.toBeNull()
}, 60_000)
