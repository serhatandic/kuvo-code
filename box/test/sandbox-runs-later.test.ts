import "./safety"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { escapeRegex, fencePolicy } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// What your shell runs as it starts, in folders commands write (the files rustup's, deno's and bun's
// installers have your shell profile source), runs outside the sandbox the next time you open a
// terminal: so commands can't change it.

test.skipIf(!canFence)("a command can't change what your shell runs as it starts, in the caches it writes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-runs-later-")))
  try {
    const kuvo = join(root, "kuvo")
    const home = join(root, "home")
    const project = join(root, "project")
    for (const folder of [kuvo, project]) mkdirSync(folder, { recursive: true })
    // The box's own rules, as they'd be in this home folder.
    const policy = fencePolicy()
    const inHome = (paths: string[]) => paths.filter(each => each.startsWith(policy.home + "/")).map(each => join(home, each.slice(policy.home.length + 1)))
    const names = [".cargo/env", ".cargo/env.fish", ".deno/env", ".bun/_bun"]
    const startUp = names.map(name => join(home, name))
    for (const file of startUp) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, "export PATH\n")
    }
    realFence(kuvo, [], { writable: ["/dev", ...inHome(policy.writable)], readOnly: inHome(policy.readOnly) })
    const script = names.map(name => `if ( echo planted >> ${join(home, name)} ) 2>/dev/null; then echo "${name}: allowed"; else echo "${name}: refused"; fi`).join("\n")
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))).toEqual(Object.fromEntries(names.map(name => [name, "refused"])))
    for (const file of startUp) expect(readFileSync(file, "utf8")).toBe("export PATH\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// zsh's prompt and plugin managers keep what every new terminal sources in your cache folder, which
// commands write: p10k's instant prompt (the first thing a p10k `.zshrc` sources) and its state, named
// for your account as the system has it (a machine's keeper starts the engine without USER), and the
// temporary files p10k moves into place; gitstatusd's program, oh-my-zsh's and prezto's completions,
// antidote's and zsh4humans' plugins, oh-my-posh's init; on a Mac, mise's trusted configs. A command that wrote one would run in your next terminal, outside the sandbox. One that
// isn't there yet can't be made either. What it costs: on Linux, Landlock can't let a command make a
// new folder at the top of your cache folder (so only on a Mac are mise's kept, which would cost
// `~/.local/state` the same).
test.skipIf(!canFence)("a command can't change what zsh and its plugins load as a terminal starts, in the caches it writes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-shell-caches-")))
  try {
    const kuvo = join(root, "kuvo")
    const home = join(root, "home")
    const project = join(root, "project")
    for (const folder of [kuvo, project, join(home, ".local", "state")]) mkdirSync(folder, { recursive: true })
    // The box's rules as a machine's keeper starts it: without USER or LOGNAME (Bun reads them as it
    // starts, so in a process of its own).
    const env: Record<string, string> = { ...process.env as Record<string, string>, BUN_BE_BUN: "1" }
    delete env.USER
    delete env.LOGNAME
    const asStarted = Bun.spawnSync([process.execPath, "-e", `import { fencePolicy } from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "fence", "policy"))}; console.log(JSON.stringify(fencePolicy()))`], { env })
    expect(asStarted.exitCode, asStarted.stderr.toString()).toBe(0)
    const policy: ReturnType<typeof fencePolicy> = JSON.parse(asStarted.stdout.toString())
    const inHome = (paths: string[]) => paths.filter(each => each.startsWith(policy.home + "/")).map(each => join(home, each.slice(policy.home.length + 1)))
    const ownHome = `^${escapeRegex(policy.home)}/`
    const patterns = (policy.readOnlyPatterns ?? []).filter(each => each.startsWith(ownHome)).map(each => `^${escapeRegex(home)}/` + each.slice(ownHome.length))
    const me = Bun.spawnSync(["id", "-un"]).stdout.toString().trim()
    const mac = process.platform === "darwin"
    const there = [`.cache/p10k-instant-prompt-${me}.zsh`, `.cache/p10k-instant-prompt-${me}.zsh.zwc`, `.cache/p10k-dump-${me}.zsh`,
      `.cache/p10k-${me}/prompt-1`, ".cache/gitstatus/gitstatusd-any", ".cache/oh-my-zsh/completions/_tool", ".cache/prezto/zcompdump",
      ".cache/zsh/zcompdump", ".cache/antidote/plugins.zsh", ".cache/oh-my-posh/init.zsh",
      ...(mac ? ["Library/Caches/antidote/plugins.zsh", ".local/state/mise/trusted-configs/project"] : [])]
    const missing = [".cache/zsh4humans/v5/z4h.zsh"]
    for (const name of there) {
      mkdirSync(dirname(join(home, name)), { recursive: true })
      writeFileSync(join(home, name), "true\n")
    }
    realFence(kuvo, [], { writable: ["/dev", ...inHome(policy.writable)], readOnly: inHome(policy.readOnly), readOnlyPatterns: patterns })
    const names = [...there, ...missing]
    const tries = (name: string) => `mkdir -p ${dirname(join(home, name))} 2>/dev/null; if ( echo planted >> ${join(home, name)} ) 2>/dev/null; then echo "${name}: allowed"; else echo "${name}: refused"; fi`
    const planted = `.cache/p10k-dump-${me}.zsh.tmp.4242`
    const script = [...names, ".cache/newtool/x", ".local/state/newtool/x"].map(tries)
      .concat(`if ln -s ${join(project, "evil.zsh")} ${join(home, planted)} 2>/dev/null; then echo "${planted}: allowed"; else echo "${planted}: refused"; fi`).join("\n")
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))).toEqual({
      ...Object.fromEntries([...names, planted].map(name => [name, "refused"])),
      // (Ordinary caches still work: a new one in `~/.local/state` everywhere, at the top of your cache folder on a Mac.)
      ".cache/newtool/x": mac ? "allowed" : "refused", ".local/state/newtool/x": "allowed",
    })
    for (const name of there) expect(readFileSync(join(home, name), "utf8")).toBe("true\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
