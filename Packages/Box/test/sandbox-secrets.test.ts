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
      ...(mac ? [["clone its folder and read it", `${process.execPath} ${clone} ${cargo} ${join(elsewhere, "cloned")} && cat ${join(elsewhere, "cloned", "credentials.toml")}`]] : []),
    ]
    const script = tries.map(([what, command]) => `if ( ${command} ) >/dev/null 2>&1; then echo "${what}: allowed"; else echo "${what}: refused"; fi`).join("\n")
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KUVO_FENCE_WORK: project } })
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
