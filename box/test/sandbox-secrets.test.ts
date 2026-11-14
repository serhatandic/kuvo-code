import "./safety"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canFence, realFence } from "./agents/support/fence"

// Your secrets are never read from the sandbox, wherever they are: cargo's sign-in
// (`~/.cargo/credentials.toml`) is in a folder commands write (cargo's cache), so a command can
// make, change and remove files beside it, but never move it somewhere it isn't hidden, or give it
// another name, to read it there, nor move the folder it's in (where what's in it would be read,
// or what runs later changed, by the folder's new name), clone it whole (macOS's clonefile, which
// the system checks only for the folder), or put a link where one that isn't there yet would be.

test.skipIf(!canFence)("a secret in a folder commands write can't be moved, copied or named again to be read", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-secrets-")))
  try {
    const kuvo = join(root, "kuvo")
    const cargo = join(root, "home", ".cargo")
    const project = join(root, "project")
    // Another folder commands write, where a folder moved would be.
    const elsewhere = join(root, "elsewhere")
    for (const folder of [kuvo, join(cargo, "registry"), join(cargo, "bin"), project, elsewhere]) mkdirSync(folder, { recursive: true })
    const secret = join(cargo, "credentials.toml")
    writeFileSync(secret, 'token = "TOPSECRET"\n')
    // (What runs later in a folder that isn't there yet: `tools`.)
    realFence(kuvo, [], { writable: ["/dev", cargo, elsewhere], secrets: [secret], readOnly: [join(cargo, "bin"), join(cargo, "tools", "bin")] })
    const away = join(elsewhere, "cargo")
    // A folder cloned whole, as clonefile(2) does it (cp clones file by file).
    const clone = join(root, "clone.js")
    writeFileSync(clone, `const { dlopen } = require("bun:ffi")
const lib = dlopen("/usr/lib/libSystem.B.dylib", { clonefile: { args: ["cstring", "cstring", "u32"], returns: "i32" } })
process.exit(lib.symbols.clonefile(Buffer.from(process.argv[2] + "\\0"), Buffer.from(process.argv[3] + "\\0"), 0) === 0 ? 0 : 1)
`)
    const mac = process.platform === "darwin"
    const tries = [
      ["read it", `cat ${secret}`],
      ["write beside it", `echo built > ${join(cargo, "registry", "index")}`],
      // (Each put back where it was, if it moved, for the next.)
      ["move it and read it", `mv ${secret} ${join(cargo, "moved")} && { cat ${join(cargo, "moved")}; read=$?; mv ${join(cargo, "moved")} ${secret}; exit $read; }`],
      ["move it into a folder and read it", `mv ${secret} ${join(cargo, "registry", "moved")} && { cat ${join(cargo, "registry", "moved")}; read=$?; mv ${join(cargo, "registry", "moved")} ${secret}; exit $read; }`],
      ["name it again and read it", `ln ${secret} ${join(cargo, "named")} && cat ${join(cargo, "named")}`],
      ["copy it and read it", `cp ${secret} ${join(cargo, "copied")} && cat ${join(cargo, "copied")}`],
      ["replace it", `echo 'token = "planted"' > ${join(cargo, "planted")} && mv ${join(cargo, "planted")} ${secret}`],
      ["move its folder and read it", `mv ${cargo} ${away} && { cat ${join(away, "credentials.toml")}; read=$?; mv ${away} ${cargo}; exit $read; }`],
      ["move the folder of what runs later and change it", `mv ${cargo} ${away} && { echo planted > ${join(away, "bin", "tool")}; made=$?; mv ${away} ${cargo}; exit $made; }`],
      ["link the folder of what runs later into place and change it", `ln -s ${join(elsewhere, "tools")} ${join(cargo, "tools")} && mkdir -p ${join(elsewhere, "tools", "bin")} && echo planted > ${join(cargo, "tools", "bin", "tool")}`],
      ...(mac ? [["clone its folder and read it", `${JSON.stringify(process.execPath)} ${clone} ${cargo} ${join(elsewhere, "cloned")} && cat ${join(elsewhere, "cloned", "credentials.toml")}`]] : []),
    ]
    const script = tries.map(([what, command]) => `if ( ${command} ) >/dev/null 2>&1; then echo "${what}: allowed"; else echo "${what}: refused"; fi`).join("\n")
    // (The clone runs on this Bun, quoted, as it is: an engine's, `BUN_BE_BUN=1`, is in a folder
    // with a space in its name.)
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KUVO_FENCE_WORK: project, ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: process.env.BUN_BE_BUN } : {}) } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    const seen = Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))
    expect(seen).toEqual({
      "read it": "refused",
      "write beside it": "allowed",
      "move it and read it": "refused",
      "move it into a folder and read it": "refused",
      "name it again and read it": "refused",
      "copy it and read it": "refused",
      "replace it": "refused",
      "move its folder and read it": "refused",
      "move the folder of what runs later and change it": "refused",
      "link the folder of what runs later into place and change it": "refused",
      ...(mac ? { "clone its folder and read it": "refused" } : {}),
    })
    expect(readFileSync(secret, "utf8")).toBe('token = "TOPSECRET"\n')
    expect(existsSync(join(cargo, "bin", "tool"))).toBe(false)
    expect(existsSync(join(cargo, "tools"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The coding agents' sign-ins and opencode's are your secrets, as your API keys are: wherever your
// own XDG_DATA_HOME puts opencode's too (the box's own is in Kuvo Code's folder).
test("the coding agents' sign-ins and opencode's own are among your secrets", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-signins-")))
  try {
    const home = join(root, "home")
    mkdirSync(home)
    const { KUVO_OWN_XDG_DATA_HOME: _, ...env } = process.env as Record<string, string>
    const asStarted = Bun.spawnSync([process.execPath, "-e", `import { fencePolicy } from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "fence", "policy"))}; console.log(JSON.stringify(fencePolicy().secrets))`],
      { env: { ...env, HOME: home, XDG_DATA_HOME: join(root, "data"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } })
    expect(asStarted.exitCode, asStarted.stderr.toString()).toBe(0)
    const secrets: string[] = JSON.parse(asStarted.stdout.toString())
    for (const file of [".codex/auth.json", ".grok/auth.json", ".claude/.credentials.json", ".gemini/oauth_creds.json", ".local/share/opencode/auth.json"])
      expect(secrets).toContain(join(home, file))
    expect(secrets).toContain(join(root, "data", "opencode", "auth.json"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// The coding agents' sign-ins are your secrets too (`~/.codex/auth.json`, `~/.grok/auth.json`): a
// command never reads one, an agent's own included. But the agent run whole in the sandbox with its
// home (Codex with your `~/.codex`) still reads its own sign-in and writes it anew as it renews it,
// while nothing it runs reads another's.
test.skipIf(!canFence)("an agent's sign-in is hidden from commands, but not from the agent run whole with it as its own", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-signins-")))
  try {
    const kuvo = join(root, "kuvo")
    const home = join(root, "home")
    const codex = join(home, ".codex")
    const grok = join(home, ".grok")
    const project = join(root, "project")
    for (const folder of [kuvo, codex, grok, project]) mkdirSync(folder, { recursive: true })
    const mine = join(codex, "auth.json")
    const theirs = join(grok, "auth.json")
    writeFileSync(mine, '{"OPENAI_API_KEY":"TOPSECRET"}\n')
    writeFileSync(theirs, '{"token":"TOPSECRET"}\n')
    // (On a Mac, your Codex's home is what runs later, as the box has it; on Linux, an agent's home is
    // Kuvo Code's own copy of it, which Landlock grants whole.)
    realFence(kuvo, [], { secrets: [mine, theirs], readOnly: process.platform === "darwin" ? [codex, grok] : [] })
    const script = [
      ["find Codex's", `test -e ${mine}`],
      ["read Codex's", `cat ${mine}`],
      ["renew Codex's", `echo '{"OPENAI_API_KEY":"RENEWED"}' > ${mine}.tmp && mv ${mine}.tmp ${mine}`],
      ["read Grok's", `cat ${theirs}`],
    ].map(([what, command]) => `if ( ${command} ) >/dev/null 2>&1; then echo "${what}: allowed"; else echo "${what}: refused"; fi`).join("\n")
    const run = (own: Record<string, string>) => {
      const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project, ...own } })
      const out = ran.stdout.toString() + ran.stderr.toString()
      return Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))
    }
    // A command (the engine's, or one an agent runs).
    // (Landlock keeps what's in a file, not that it's there.)
    expect(run({})).toEqual({ "find Codex's": process.platform === "darwin" ? "refused" : "allowed", "read Codex's": "refused", "renew Codex's": "refused", "read Grok's": "refused" })
    expect(readFileSync(mine, "utf8")).toBe('{"OPENAI_API_KEY":"TOPSECRET"}\n')
    // Codex, run whole with its home (fence.ts `fenceAgent`).
    expect(run({ KUVO_FENCE_OWN: codex, KUVO_FENCE_STATE: "auth.json*", KUVO_FENCE_KEPT: "*.toml" })).toEqual({ "find Codex's": "allowed", "read Codex's": "allowed", "renew Codex's": "allowed", "read Grok's": "refused" })
    expect(readFileSync(mine, "utf8")).toBe('{"OPENAI_API_KEY":"RENEWED"}\n')
    // Codex on an account you added: its home is Kuvo Code's copy, with your own Codex's as a second
    // home it links to (codex.ts `fenced`), whose sign-in is yours, never the added account's.
    const added = join(root, "added")
    mkdirSync(added)
    expect(run({ KUVO_FENCE_OWN: `${added}\n${codex}`, KUVO_FENCE_STATE: "auth.json*", KUVO_FENCE_KEPT: "*.toml" })).toEqual({ "find Codex's": process.platform === "darwin" ? "refused" : "allowed", "read Codex's": "refused", "renew Codex's": "refused", "read Grok's": "refused" })
    expect(readFileSync(mine, "utf8")).toBe('{"OPENAI_API_KEY":"RENEWED"}\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
