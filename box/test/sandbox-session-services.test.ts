import "./safety"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ownNamespace } from "../src/link/fence/landlock"
import { fencePolicy } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"
import { ownPath } from "../bridge-tests/test-safety.js"

// On Linux, Landlock can't refuse a command a socket, and your session's services listen on them in
// `/run/user/<uid>`: systemd's, which runs whatever it's asked outside the sandbox
// (`systemd-run --user`), its bus, your keyring, your SSH and GPG agents. tmux's server in
// `/tmp/tmux-<uid>` types into your sessions, and an X server takes keystrokes. So each command has
// those folders empty, in a namespace of its own, while it still works in its project.

const uid = process.getuid?.() ?? -1
const runtime = `/run/user/${uid}`
const sessionBus = existsSync(join(runtime, "bus")) && ["/usr/bin/systemd-run", "/bin/systemd-run"].some(existsSync)
// (Where the machine doesn't let it, the sandbox isn't on: the box says so, and nothing runs in it.)
const namespaced = canFence && process.platform === "linux" && (() => {
  const own = mkdtempSync(join(tmpdir(), "kuvo-sandbox-ns-"))
  try { return ownNamespace(own) !== null } finally { rmSync(own, { recursive: true, force: true }) }
})()

test.skipIf(!namespaced || !sessionBus)("a command can't have your session's services run something outside the sandbox", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-services-")))
  try {
    const kuvo = join(root, "kuvo")
    const project = join(root, "project")
    mkdirSync(project, { recursive: true })
    realFence(kuvo)
    // Kuvo Code's own file, which the sandbox hides from commands.
    const hidden = join(kuvo, "secret.txt")
    writeFileSync(hidden, "kept from commands\n")
    const tmux = `/tmp/tmux-${uid}`
    const script = [
      `cat ${hidden} 2>/dev/null && echo "read: allowed" || echo "read: refused"`,
      // systemd runs it, outside the sandbox, as the bus names it or as its folder does.
      `systemd-run --user --quiet --wait --pipe --collect cat ${hidden} 2>/dev/null && echo "systemd: allowed" || echo "systemd: refused"`,
      `DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime}/bus XDG_RUNTIME_DIR=${runtime} systemd-run --user --quiet --wait --pipe --collect cat ${hidden} 2>/dev/null && echo "named: allowed" || echo "named: refused"`,
      // Nor through another process's view of the system's folders (the test's own, outside).
      `ls ${`/proc/${process.pid}/root${runtime}`} >/dev/null 2>&1 && echo "proc: allowed" || echo "proc: refused"`,
      `echo "runtime: $(ls -A ${runtime} 2>/dev/null | wc -l)"`,
      `echo "tmux: $(ls -A ${tmux} 2>/dev/null | wc -l)"`,
      // What it still does: its own folder, its temporary files, and your account as it is.
      `echo ok > written && echo "project: $(cat written)"`,
      `echo ok > "$TMPDIR/t" && echo "temporary: $(cat "$TMPDIR/t")"`,
      `echo "user: $(id -u)"`,
    ].join("\n")
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, KUVO_FENCE_WORK: project } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    const said = Object.fromEntries(out.trim().split("\n").filter(line => /^[a-z]+: /.test(line)).map(line => line.split(": ")))
    expect(out).not.toContain("kept from commands")
    expect(said).toEqual({
      read: "refused", systemd: "refused", named: "refused", proc: "refused", runtime: "0", tmux: "0",
      project: "ok", temporary: "ok", user: String(uid),
    })
    // (And nothing changed outside: the session's folder is as it was.)
    expect(readdirSync(runtime)).toContain("bus")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Other apps' sockets, which sign with the keys commands can't read or run what they're asked: your
// SSH agents (one your shell started in /tmp, OpenSSH's own folder, 1Password's, Bitwarden's, the
// box's own), gpg-agent's, Grok's shared leader's, VS Code's and Cursor's in /tmp. Each refuses a
// command; others it reaches as it would.
test.skipIf(!namespaced)("a command can't use your SSH or GPG agent, or other apps' sockets", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-sockets-")))
  const started = mkdtempSync("/tmp/ssh-")
  const vscode = `/tmp/vscode-ipc-${started.slice("/tmp/ssh-".length)}.sock`
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
    // (Your home folder's, in this one: not this test's own, which can be in yours.)
    const toHome = (each: string) => each.startsWith(policy.home + "/") && !each.startsWith(root + "/") ? join(home, each.slice(policy.home.length + 1)) : each
    const agents = [
      ...[".1password/agent.sock", ".bitwarden-ssh-agent.sock", ".ssh/agent/s.aBcD.agent.eFgH", ".gnupg/S.gpg-agent", ".grok/leader.sock"].map(name => join(home, name)),
      join(started, "agent.123"), vscode, join(root, "own", "agent.sock"),
    ]
    const others = [join(root, "other.sock"), join(home, ".gnupg/S.keyboxd")]
    for (const where of [...agents, ...others]) {
      mkdirSync(dirname(where), { recursive: true })
      const server = net.createServer()
      await new Promise<void>(done => server.listen(where, done))
      servers.push(server)
    }
    realFence(kuvo, (policy.sockets ?? []).map(toHome))
    // (Run on an engine's Bun, `BUN_BE_BUN=1`: the sandbox's runner doesn't pass it on.)
    const connects = (where: string) => `BUN_BE_BUN=1 ${JSON.stringify(process.execPath)} -e 'require("net").connect(process.argv[1]).on("connect", () => process.exit(0)).on("error", () => process.exit(1))' ${JSON.stringify(where)}`
    const script = [...agents, ...others].map(where => `if ( ${connects(where)} ) 2>/dev/null; then echo "${where}: allowed"; else echo "${where}: refused"; fi`).join("\n")
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))).toEqual(
      { ...Object.fromEntries(agents.map(where => [where, "refused"])), ...Object.fromEntries(others.map(where => [where, "allowed"])) })
  } finally {
    if (said === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = said
    for (const server of servers) server.close()
    for (const folder of [root, started]) rmSync(folder, { recursive: true, force: true })
    // (Named in /tmp, outside the test's own folders, so it's named as its own here.)
    rmSync(ownPath(vscode), { force: true })
  }
})
