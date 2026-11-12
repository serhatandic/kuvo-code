import "../safety"
import { expect, test } from "bun:test"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { commandSignIn } from "../../src/agents/signin"

// Signing in with an agent's own command: the page it hands its browser (with what the sign-in
// needs in it) is written down only you can read, in a folder only you can open, and is gone once
// the command ends. The script that catches it is the bridge's own, whatever was there before.

const mode = (where: string) => statSync(where).mode & 0o777

/** Every file and folder under `root`. */
function everything(root: string): string[] {
  return readdirSync(root, { recursive: true }).map((name) => join(root, String(name)))
}

test("a sign-in's page: only you can read it, in a folder only you can open, and gone when the command ends", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "kuvo-signin-secret-"))
  // (The bridge's temporary folder may be open to others: TMPDIR as given.)
  chmodSync(temporary, 0o755)
  // A catcher someone else left there, that would hand them the page.
  mkdirSync(join(temporary, "bin"), { mode: 0o755 })
  chmodSync(join(temporary, "bin"), 0o755)
  const stolen = join(temporary, "stolen")
  writeFileSync(join(temporary, "bin", "kuvo-catch-url"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${stolen}"\n`)
  chmodSync(join(temporary, "bin", "kuvo-catch-url"), 0o777)
  const script = join(temporary, "login")
  writeFileSync(script, `#!/bin/sh\n"$BROWSER" "https://example.test/sign-in?state=SECRET-STATE"\nread code\n`)
  chmodSync(script, 0o755)
  const umask = process.umask(0o022)
  try {
    let ended!: () => void
    const end = new Promise<void>((resolve) => (ended = resolve))
    const sign = await commandSignIn({ command: script, args: [], home: temporary, temporary, instructions: "", signedIn: async () => false, onEnd: () => ended() })
    expect(sign.url).toBe("https://example.test/sign-in?state=SECRET-STATE")
    expect(lstatSync(stolen, { throwIfNoEntry: false })).toBeUndefined()

    // While it waits: where the page is written down, and the catcher.
    const holding = everything(temporary).filter((where) => statSync(where).isFile() && readFileSync(where, "utf8").includes("SECRET-STATE") && where !== script)
    expect(holding.length).toBe(1)
    expect(mode(holding[0]!)).toBe(0o600)
    // Each folder it's in, below the bridge's temporary one.
    const parts = relative(temporary, holding[0]!).split("/").slice(0, -1)
    expect(parts.length).toBeGreaterThan(0)
    for (let at = 1; at <= parts.length; at++) expect(mode(join(temporary, ...parts.slice(0, at)))).toBe(0o700)
    expect(mode(join(temporary, "bin"))).toBe(0o700)
    expect(mode(join(temporary, "bin", "kuvo-catch-url")) & 0o077).toBe(0)

    // Ended: nothing of it left.
    sign.cancel()
    await end
    expect(everything(temporary).filter((where) => statSync(where).isFile() && readFileSync(where, "utf8").includes("SECRET-STATE") && where !== script)).toEqual([])
    expect(readdirSync(temporary).sort()).toEqual(["bin", "login"])
  } finally {
    process.umask(umask)
    rmSync(temporary, { recursive: true, force: true })
  }
})
