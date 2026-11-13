// A conversation's SSH agent (vault/ssh.ts) opens soon after the sandbox's launcher notes it, even
// when the folder's watch says nothing: on a busy Mac, FSEvents tells late or not at all, and the
// launcher waits only a moment for the agent before the command runs without it (git over SSH then
// finds no key). Here the injected watch never tells or registers looks: the periodic look finds it.
import "./safety"
import { ownPath } from "../../KuvoLink/Tests/Bridge/test-safety.js"
import { afterAll, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const vaultAgents = process.env.KUVO_VAULT_AGENTS
process.env.KUVO_VAULT_AGENTS = "1"
const { keepSshAgents } = await import("../src/link/vault/ssh")
const { SSH_AGENTS, SSH_FOR } = await import("../src/link/home")
// (Its agents' folder, in Kuvo Code's short folder in /tmp on a Mac, named for this test's home: its
// own. Elsewhere it's in the box's folder, in the run's home, its own already.)
if (!SSH_AGENTS.startsWith(`${process.env.HOME}/`)) ownPath(SSH_AGENTS)
let quick!: () => void
const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
  if (delay === 1000) quick = callback
  return { unref() {} }
}) as any)
let watched = 0
const stop = keepSshAgents((() => {
  watched++
  return { close() {}, unref() {} }
}) as any)
interval.mockRestore()
afterAll(() => {
  stop()
  fs.rmSync(path.join(SSH_FOR, "ses_kept"), { force: true })
  // (As it was, for the files that run after this one in the same process.)
  if (vaultAgents === undefined) delete process.env.KUVO_VAULT_AGENTS
  else process.env.KUVO_VAULT_AGENTS = vaultAgents
})

test("a conversation the launcher notes gets its agent at once, though the folder's watch says nothing", async () => {
  const folder = fs.mkdtempSync(path.join(path.dirname(SSH_FOR), "project-"))
  expect(watched).toBe(1)
  // As the launcher notes it: written aside, then moved in.
  fs.writeFileSync(path.join(SSH_FOR, ".ses_kept.1"), folder)
  fs.renameSync(path.join(SSH_FOR, ".ses_kept.1"), path.join(SSH_FOR, "ses_kept"))
  const prefix = crypto.createHash("sha256").update("ses_kept").digest("hex").slice(0, 16)
  const agent = () => (fs.existsSync(SSH_AGENTS) ? fs.readdirSync(SSH_AGENTS) : []).find(name => name.startsWith(prefix) && name.endsWith(".sock"))
  expect(quick).toBeFunction()
  quick()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(fs.statSync(path.join(SSH_AGENTS, agent()!)).isSocket()).toBe(true)
})
