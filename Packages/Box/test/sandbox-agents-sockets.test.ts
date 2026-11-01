import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import { dirname, join } from "node:path"
import { escapeRegex, fencePolicy } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// Your SSH and GPG agents sign with the keys the sandbox hides from commands: so a command can't
// reach them, by their sockets' paths, wherever they are (the system's SSH agent, one your shell
// started, gpg-agent's, 1Password's, Secretive's, Bitwarden's, the box's own). (Linux can't refuse
// a socket: there the command only isn't told.)

test.skipIf(!canFence || process.platform !== "darwin")("a command can't use your SSH or GPG agent", async () => {
  // (Short folders: a socket's path has to be.)
  const root = realpathSync(mkdtempSync("/tmp/ksa-"))
  // Where the system and ssh-agent put theirs: in /tmp, and in your own temporary folder.
  const system = mkdtempSync("/private/tmp/com.apple.launchd.")
  const started = mkdtempSync("/private/tmp/ssh-")
  const yours = mkdtempSync(join(realpathSync(os.tmpdir()), "ssh-"))
  const servers: net.Server[] = []
  const said = process.env.SSH_AUTH_SOCK
  try {
    const kuvo = join(root, "kuvo")
    const home = join(root, "home")
    const project = join(root, "project")
    for (const folder of [kuvo, project]) mkdirSync(folder, { recursive: true })
    // The box's own rules, as they'd be in this home folder, started with an agent of its own.
    process.env.SSH_AUTH_SOCK = join(root, "own", "agent.sock")
    const policy = fencePolicy()
    const toHome = (each: string) => each.startsWith(policy.home + "/") ? join(home, each.slice(policy.home.length + 1)) : each
    const agents = [
      ...[".gnupg/S.gpg-agent", ".gnupg/S.gpg-agent.ssh", "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
        "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh", ".bitwarden-ssh-agent.sock"].map(name => join(home, name)),
      join(system, "Listeners"), join(started, "agent.123"), join(yours, "agent.123"), join(root, "own", "agent.sock"),
    ]
    // Ones that are no agent's, which a command reaches as it would any other: gpg's key store's
    // (public keys, for checking signatures), and another program's.
    const others = [join(home, ".gnupg/S.keyboxd"), join(root, "other.sock")]
    for (const where of [...agents, ...others]) {
      mkdirSync(dirname(where), { recursive: true })
      const server = net.createServer()
      await new Promise<void>(done => server.listen(where, done))
      servers.push(server)
    }
    realFence(kuvo, (policy.sockets ?? []).map(toHome), {
      socketPatterns: (policy.socketPatterns ?? []).map(pattern => pattern.replace(escapeRegex(policy.home), escapeRegex(home))),
    })
    const connects = (where: string) => `${process.execPath} -e 'require("net").connect(process.argv[1]).on("connect", () => process.exit(0)).on("error", () => process.exit(1))' ${JSON.stringify(where)}`
    const script = [...agents, ...others].map(where => `if ( ${connects(where)} ) 2>/dev/null; then echo "${where}: allowed"; else echo "${where}: refused"; fi`).join("\n")
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))).toEqual(
      { ...Object.fromEntries(agents.map(where => [where, "refused"])), ...Object.fromEntries(others.map(where => [where, "allowed"])) })
  } finally {
    if (said === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = said
    for (const server of servers) server.close()
    for (const folder of [root, system, started, yours]) rmSync(folder, { recursive: true, force: true })
  }
})
