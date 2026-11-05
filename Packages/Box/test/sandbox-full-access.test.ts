import "./safety"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canFence, realFence } from "./agents/support/fence"

// Full Access: a conversation the box marks runs its commands as yours, outside the sandbox (no
// walls, your SSH agent kept); every other conversation's stay in it; and no command in the sandbox
// can mark its own conversation, nor get out by running the launcher again.

test.skipIf(!canFence)("a conversation in Full Access runs its commands outside the sandbox, and nothing in the sandbox can make one", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-full-")))
  try {
    const kuvo = join(root, "kuvo")
    const project = join(root, "project")
    const elsewhere = join(root, "elsewhere")
    mkdirSync(project, { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
    const fence = realFence(kuvo)
    const launcher = join(kuvo, "bin", "kuvo-fence")
    const run = (session: string, script: string) => {
      const ran = Bun.spawnSync([launcher, "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, KUVO_FENCE_WORK: project, OPENCODE_SESSION_ID: session, SSH_AUTH_SOCK: "/agent.sock", OPENCODE_SERVER_PASSWORD: "pw" } })
      return ran.stdout.toString() + ran.stderr.toString()
    }
    const tries = (label: string, command: string) => `if ( ${command} ) >/dev/null 2>&1; then echo "${label}: allowed"; else echo "${label}: refused"; fi`
    const outside = (file: string) => tries("outside", `echo x > ${join(elsewhere, file)}`)

    // Not marked: in the sandbox, as before.
    expect(run("ses_walled", `${outside("a")}; echo "agent: \${SSH_AUTH_SOCK-none}"`)).toBe("outside: refused\nagent: none\n")

    mkdirSync(join(fence, "full"), { recursive: true })
    writeFileSync(join(fence, "full", "ses_full"), "")
    // Marked: anywhere, with your SSH agent, but never the engine's own password.
    expect(run("ses_full", `${outside("b")}; echo "agent: \${SSH_AUTH_SOCK-none}"; echo "engine: \${OPENCODE_SERVER_PASSWORD-none}"`))
      .toBe("outside: allowed\nagent: /agent.sock\nengine: none\n")
    expect(existsSync(join(elsewhere, "b"))).toBe(true)
    // A name that isn't a conversation's can't reach another file there.
    expect(run("ses_../full/ses_full", outside("c"))).toBe("outside: refused\n")

    // In the sandbox, a command can't mark itself, nor get out through the launcher with a
    // conversation that is marked.
    expect(run("ses_walled", [
      tries("mark", `mkdir -p ${join(fence, "full")} && : > ${join(fence, "full", "ses_walled")}`),
      tries("again", `OPENCODE_SESSION_ID=ses_full KUVO_FENCE_WORK=${project} ${launcher} -c 'echo x > ${join(elsewhere, "d")}'`),
    ].join("; "))).toBe("mark: refused\nagain: refused\n")
    expect(existsSync(join(fence, "full", "ses_walled"))).toBe(false)
    expect(existsSync(join(elsewhere, "d"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
