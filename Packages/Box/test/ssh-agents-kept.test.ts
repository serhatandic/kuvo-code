// A conversation's SSH agent (vault/ssh.ts) opens soon after the sandbox's launcher notes it, even
// when the folder's watch says nothing: on a busy Mac, FSEvents tells late or not at all, and the
// launcher waits only a moment for the agent before the command runs without it (git over SSH then
// finds no key). Here the watch never tells.
import "./safety"
import { ownPath } from "../../KuvoLink/Tests/Bridge/test-safety.js"
import { afterAll, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const vaultAgents = process.env.KUVO_VAULT_AGENTS
process.env.KUVO_VAULT_AGENTS = "1"
const watch = fs.watch
// (A watch that's made, and never tells of anything.)
;(fs as { watch: unknown }).watch = () => ({ close() {}, unref() {}, ref() {}, on() { return this } })
const { keepSshAgents } = await import("../src/link/vault/ssh")
const { SSH_AGENTS, SSH_FOR } = await import("../src/link/home")
// (Its agents' folder, in Kuvo Code's short folder in /tmp, named for this test's home: its own.)
ownPath(SSH_AGENTS)
const stop = keepSshAgents()
;(fs as { watch: unknown }).watch = watch
afterAll(() => {
  stop()
  fs.rmSync(path.join(SSH_FOR, "ses_kept"), { force: true })
  // (As it was, for the files that run after this one in the same process.)
  if (vaultAgents === undefined) delete process.env.KUVO_VAULT_AGENTS
  else process.env.KUVO_VAULT_AGENTS = vaultAgents
})

test("a conversation the launcher notes gets its agent at once, though the folder's watch says nothing", async () => {
  const folder = fs.mkdtempSync(path.join(path.dirname(SSH_FOR), "project-"))
  // As the launcher notes it: written aside, then moved in.
  fs.writeFileSync(path.join(SSH_FOR, ".ses_kept.1"), folder)
  fs.renameSync(path.join(SSH_FOR, ".ses_kept.1"), path.join(SSH_FOR, "ses_kept"))
  const prefix = crypto.createHash("sha256").update("ses_kept").digest("hex").slice(0, 16)
  const agent = () => (fs.existsSync(SSH_AGENTS) ? fs.readdirSync(SSH_AGENTS) : []).find(name => name.startsWith(prefix) && name.endsWith(".sock"))
  while (!agent()) await Bun.sleep(20)
  expect(fs.statSync(path.join(SSH_AGENTS, agent()!)).isSocket()).toBe(true)
})
