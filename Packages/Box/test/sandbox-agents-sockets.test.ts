import "./safety"
import { ownPath } from "../../KuvoLink/Tests/Bridge/test-safety.js"
import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { escapeRegex, fencePolicy, sshSockets } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// Your SSH and GPG agents sign with the keys the sandbox hides from commands: so a command can't
// reach them, by their sockets' paths, wherever they are (the system's SSH agent, one your shell
// started, gpg-agent's, 1Password's, Secretive's, Bitwarden's, the box's own), nor by another name
// after moving one. (Linux can't refuse a socket: there the command only isn't told.)

test.skipIf(!canFence || process.platform !== "darwin")("a command can't use your SSH or GPG agent", async () => {
  // (Short folders: a socket's path has to be.)
  const root = realpathSync(mkdtempSync("/tmp/ksa-"))
  // Where the system and ssh-agent put theirs: in /tmp, and in your own temporary folder (the
  // system's, whatever TMPDIR says).
  const temporary = realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim())
  const system = mkdtempSync("/private/tmp/com.apple.launchd.")
  const started = mkdtempSync("/private/tmp/ssh-")
  const yours = mkdtempSync(join(temporary, "ssh-"))
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
        "Library/Containers/com.maxgoedjen.Secretive.SecretAgent/Data/socket.ssh", ".bitwarden-ssh-agent.sock",
        ".ssh/agent/s.aBcD.agent.eFgH"].map(name => join(home, name)),
      join(system, "Listeners"), join(started, "agent.123"), join(yours, "agent.123"), join(root, "own", "agent.sock"),
    ]
    // Ones that are no agent's, which a command reaches as it would any other: gpg's key store's
    // (public keys, for checking signatures), another program's, and ssh's own shared connection in
    // /tmp (a ControlPath of `/tmp/ssh-%r@%h:%p`), which it removes too.
    const shared = `/private/tmp/ssh-${basename(root)}@example.com:22`
    const others = [join(home, ".gnupg/S.keyboxd"), join(root, "other.sock"), shared]
    for (const where of [...agents, ...others]) {
      mkdirSync(dirname(where), { recursive: true })
      const server = net.createServer()
      await new Promise<void>(done => server.listen(where, done))
      servers.push(server)
    }
    realFence(kuvo, (policy.sockets ?? []).map(toHome), {
      socketPatterns: (policy.socketPatterns ?? []).map(pattern => pattern.replace(escapeRegex(policy.home), escapeRegex(home))),
      socketFolders: policy.socketFolders,
      // Written as they are on a box: /tmp and your temporary folder.
      writable: ["/dev", "/private/tmp", dirname(temporary)],
    })
    // (The Bun this runs on, quoted: an engine's is in a folder with a space in its name.)
    const connects = (where: string) => `${JSON.stringify(process.execPath)} -e 'require("net").connect(process.argv[1]).on("connect", () => process.exit(0)).on("error", () => process.exit(1))' ${JSON.stringify(where)}`
    // And each in a folder commands write, moved (its folder, or itself) to be reached by another name.
    // (To names no rule knows.)
    const renamed = [[started, join(root, "started")], [system, join(root, "system")], [join(yours, "agent.123"), join(temporary, "moved.sock")]]
    const tries = [...agents, ...others].map(where => `if ( ${connects(where)} ) 2>/dev/null; then echo "${where}: allowed"; else echo "${where}: refused"; fi`)
    for (const [from, to] of renamed) tries.push(`mv ${JSON.stringify(from)} ${JSON.stringify(to)} 2>/dev/null; if ( ${connects(to.endsWith(".sock") ? to : join(to, from === system ? "Listeners" : "agent.123"))} ) 2>/dev/null; then echo "${to}: allowed"; else echo "${to}: refused"; fi`)
    tries.push(`if rm ${JSON.stringify(shared)} 2>/dev/null; then echo "${shared} removed: allowed"; else echo "${shared} removed: refused"; fi`)
    const script = tries.join("\n")
    // (Run on an engine's Bun, `BUN_BE_BUN=1`, the connects need it too, or they run the engine.)
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project, ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: process.env.BUN_BE_BUN } : {}) } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))).toEqual(
      { ...Object.fromEntries([...agents, ...renamed.map(([, to]) => to)].map(where => [where, "refused"])), ...Object.fromEntries([...others, `${shared} removed`].map(where => [where, "allowed"])) })
  } finally {
    if (said === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = said
    for (const server of servers) server.close()
    for (const folder of [root, system, started, yours]) rmSync(folder, { recursive: true, force: true })
    rmSync(ownPath(join(temporary, "moved.sock")), { force: true })
    rmSync(ownPath(`/private/tmp/ssh-${basename(root)}@example.com:22`), { force: true })
  }
})

// SSH's shared connections and agents, wherever your settings put them: in the files they include
// and the system's too, by `~`, `${HOME}` and other variables. A folder of their own is kept whole;
// where they share one (your cache folder, /tmp), only the sockets by the start of their names.
test("your SSH settings' sockets are kept, never the folders they share", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-ssh-settings-")))
  const said = process.env.KUVO_TEST_SOCKETS
  try {
    const home = join(root, "home")
    process.env.KUVO_TEST_SOCKETS = join(root, "elsewhere")
    const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
    write(join(home, ".ssh", "config"), [
      "Host work", "  ControlPath ~/.cache/ssh-%C", "Host *", "  ControlPath=/tmp/%r@%h:%p", "  IdentityAgent \"${HOME}/agents/one.sock\"",
      "  IdentityAgent ${KUVO_TEST_SOCKETS}/two.sock", "  IdentityAgent ${KUVO_NOT_SET}/three.sock", "Include extra/*.conf", "Include more/*/cfg"].join("\n"))
    write(join(home, ".ssh", "extra", "a.conf"), "ControlPath ~/.ssh/cm/%C\n")
    write(join(home, ".ssh", "more", "work", "cfg"), "ControlPath ~/.ssh/deep/%C\n")
    write(join(root, "ssh_config"), "Host *\n  ControlPath /run/ssh-mux/%h\n")
    const { paths, globs } = sshSockets(home, join(root, "ssh_config"))
    expect(paths.sort()).toEqual([join(home, ".ssh", "cm"), join(home, ".ssh", "deep"), join(home, "agents", "one.sock"), join(root, "elsewhere", "two.sock"), "/run/ssh-mux"].sort())
    expect(globs.sort()).toEqual([join(home, ".cache", "ssh-*"), "/tmp/*@*:*"].sort())
  } finally {
    if (said === undefined) delete process.env.KUVO_TEST_SOCKETS
    else process.env.KUVO_TEST_SOCKETS = said
    rmSync(root, { recursive: true, force: true })
  }
})
