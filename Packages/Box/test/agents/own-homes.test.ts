// Where the coding agents keep your default accounts (#333): on a machine, in Kuvo Code's folder
// there; on a Mac, in your own home (`~/.claude`, `~/.codex`, `~/.grok`), whichever way its box runs:
// in its app's folder, or in a home of its own (`~/.kuvo-code`, `box/kind` saying `mac`), where its
// bridge is started as a machine's. Moving the box mustn't sign you out of them or lose their history.

import "../safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const base = realpathSync(mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-own-homes-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))

/** Each agent's default account's folder and an added one's, as the bridge started in `env` has them
 * ("yours" where it's the agent's own, in your home). */
function homes(env: Record<string, string>): Record<string, string> {
  const script = join(base, "homes.ts")
  writeFileSync(script, [
    `import { Accounts } from ${JSON.stringify(join(import.meta.dir, "../../src/agents/accounts"))}`,
    "const accounts = new Accounts(process.env.AGENTS!)",
    "const added = accounts.add(\"claude\", \"Work\")",
    "const said: Record<string, string> = {}",
    "for (const kind of [\"claude\", \"codex\", \"grok\"] as const) said[kind] = accounts.home({ kind, id: \"default\" }) ?? \"yours\"",
    "said.added = accounts.home(added)!.replace(process.env.AGENTS!, \"<bridge>\").replace(added.id, \"<id>\")",
    "process.stdout.write(JSON.stringify(said))",
  ].join("\n"))
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("KUVO_"))) as Record<string, string>
  const ran = Bun.spawnSync([process.execPath, script], { cwd: base, env: { ...clean, ...env }, stderr: "pipe" })
  expect(ran.stderr.toString()).toBe("")
  return JSON.parse(ran.stdout.toString())
}

test("a Mac's box in a home of its own keeps your default accounts where they are; a machine's are in its folder", () => {
  const machine = join(base, "machine", ".kuvo-code"), mac = join(base, "mac", ".kuvo-code")
  mkdirSync(join(mac, "box"), { recursive: true })
  writeFileSync(join(mac, "box", "kind"), "mac\n")
  mkdirSync(machine, { recursive: true })
  // A machine's.
  expect(homes({ KUVO_AGENTS_REMOTE: "1", KUVO_HOME: machine, AGENTS: join(machine, "agents") })).toEqual({
    claude: join(machine, "agents", "claude", "home"), codex: join(machine, "agents", "codex", "home"), grok: join(machine, "agents", "grok", "home"),
    added: "<bridge>/claude/accounts/<id>",
  })
  // A Mac's, started the same way in its home of its own.
  expect(homes({ KUVO_AGENTS_REMOTE: "1", KUVO_HOME: mac, AGENTS: join(mac, "agents") })).toEqual({ claude: "yours", codex: "yours", grok: "yours", added: "<bridge>/claude/accounts/<id>" })
  // And as its app starts it in its folder.
  expect(homes({ AGENTS: join(base, "app", "agents") })).toEqual({ claude: "yours", codex: "yours", grok: "yours", added: "<bridge>/claude/accounts/<id>" })
})
