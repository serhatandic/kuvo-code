import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import net from "node:net"
import { dirname, join } from "node:path"
import { fencePolicy } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// Your SSH and GPG agents sign with the keys the sandbox hides from commands: so a command can't
// reach them, by their sockets' paths, wherever they are (the system's SSH agent, gpg-agent's,
// 1Password's and Secretive's). (Linux can't refuse a socket: there the command only isn't told.)

test.skipIf(!canFence || process.platform !== "darwin")("a command can't use your SSH or GPG agent", async () => {
  // (A short folder: a socket's path has to be.)
  const root = realpathSync(mkdtempSync("/tmp/ksa-"))
  const servers: net.Server[] = []
  try {
    const kuvo = join(root, "kuvo")
    const home = join(root, "home")
    const project = join(root, "project")
    for (const folder of [kuvo, project]) mkdirSync(folder, { recursive: true })
    // The box's own rules, as they'd be in this home folder.
    const policy = fencePolicy()
    const inHome = (paths: string[]) => paths.filter(each => each.startsWith(policy.home + "/")).map(each => join(home, each.slice(policy.home.length + 1)))
    const agents = [".gnupg/S.gpg-agent", ".gnupg/S.gpg-agent.ssh", "Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock",
      "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh"]
    for (const name of agents) {
      mkdirSync(dirname(join(home, name)), { recursive: true })
      const server = net.createServer()
      await new Promise<void>(done => server.listen(join(home, name), done))
      servers.push(server)
    }
    realFence(kuvo, inHome(policy.sockets ?? []), { socketPatterns: policy.socketPatterns })
    const connects = (where: string) => `${process.execPath} -e 'require("net").connect(process.argv[1]).on("connect", () => process.exit(0)).on("error", () => process.exit(1))' ${JSON.stringify(where)}`
    const script = agents.map(name => `if ( ${connects(join(home, name))} ) 2>/dev/null; then echo "${name}: allowed"; else echo "${name}: refused"; fi`).join("\n")
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))).toEqual(Object.fromEntries(agents.map(name => [name, "refused"])))
    // The system's SSH agent's socket, where launchd keeps it (SSH_AUTH_SOCK, as your own shell has it).
    const system = ["/private/var/run/com.apple.launchd.aBcD1234/Listeners", "/private/tmp/com.apple.launchd.aBcD1234/Listeners"]
    for (const where of system) expect((policy.socketPatterns ?? []).some(pattern => new RegExp(pattern).test(where))).toBe(true)
  } finally {
    for (const server of servers) server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
