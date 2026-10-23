// Signing in by running an agent's own sign-in command (`claude auth login`, `codex login`,
// `grok login`): it opens its maker's page in your browser and finishes by itself. The page it
// would open is caught (its BROWSER is a little script that writes it down), so the app opens it,
// once, and can open it again. Some also print a page to use when no browser opens, which ends on
// a code to paste back (Claude Code's): that's taken too, typed into the command.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SignInAttempt } from "./agent"
import { newID } from "./ids"
import { firstURL, plain } from "./proc"
import type { OAuthStatus } from "./wire"

export interface CommandSignInOptions {
  command: string
  args: string[]
  env?: Record<string, string | undefined>
  /** Where the bridge keeps its files (the URL catcher goes in `bin`). */
  home: string
  temporary: string
  /** Whether you're signed in now (asked once the command ends). */
  signedIn: () => Promise<boolean>
  instructions: string
  /** The command's prompt for a code from its page, when it takes one: a pasted code is typed there. */
  codePrompt?: RegExp
  /** Signed in: what that changes (an ended sign-in is behind it). */
  onComplete?: () => void
  /** For a page opened on another device: the one it prints, at once (what it hands its browser
   * comes back to this computer, which another device can't reach). */
  printedPage?: boolean
  /** Where a device code is in what it prints, for showing beside the page. */
  userCode?: RegExp
}

/** The catcher, in the temporary folder: a path without spaces (Python splits BROWSER on them). */
export function catcher(temporary: string): string {
  const path = join(temporary, "bin", "kuvo-catch-url")
  if (!existsSync(path)) {
    mkdirSync(join(temporary, "bin"), { recursive: true })
    writeFileSync(path, '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$KUVO_URL_FILE"\n')
    chmodSync(path, 0o755)
  }
  return path
}

export async function commandSignIn(options: CommandSignInOptions): Promise<SignInAttempt> {
  const urlFile = join(options.temporary, `${newID("att")}.url`)
  const child = Bun.spawn([options.command, ...options.args], {
    env: { ...process.env, ...options.env, BROWSER: catcher(options.temporary), KUVO_URL_FILE: urlFile },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  let output = ""
  let status: OAuthStatus = { status: "pending" }
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output += plain(decoder.decode(chunk))
  }
  void read(child.stdout)
  void read(child.stderr)
  let pasted = false
  /** Whether it was signed in as it started (signing in again): undefined until known. */
  let signedInBefore: boolean | undefined
  const succeed = () => {
    status = { status: "complete" }
    options.onComplete?.()
  }
  void child.exited.then(async (code) => {
    rmSync(urlFile, { force: true })
    if (status.status !== "pending") return
    const signedIn = await options.signedIn().catch(() => false)
    if (status.status !== "pending") return
    // Signed in before (an ended sign-in still reads as one): only the command's own success says
    // this one worked.
    if (signedIn && (code === 0 || signedInBefore === false)) succeed()
    else if (pasted) status = { status: "failed", message: "That code didn't work. Start again, and paste the code from the page this sign-in opens." }
    else status = { status: "failed", message: lastLines(options.codePrompt ? output.replace(options.codePrompt, "") : output) || `Signing in stopped (exit code ${code}).` }
  })
  // Signed in while the command lingers (it waits on something after the page): done then.
  // Not when it was signed in already (signing in again, another way): its end says.
  void (async () => {
    signedInBefore = await options.signedIn().catch(() => true)
    if (signedInBefore) return
    while (status.status === "pending") {
      await Bun.sleep(3_000)
      if (status.status !== "pending") return
      if (!(await options.signedIn().catch(() => false))) continue
      if (status.status === "pending") succeed()
      child.kill()
    }
  })()

  // The page to open: what the command handed its browser, which comes back to it by itself. What
  // it printed is for when no browser opens (Claude Code's ends on a code to paste), so it's only
  // taken when nothing reaches the browser a few seconds after it.
  let url = ""
  let printedAt: number | undefined
  for (let waited = 0; waited < 15_000 && !url; waited += 200) {
    const printed = firstURL(output)
    if (options.printedPage) {
      if (printed) url = printed
    } else {
      if (existsSync(urlFile)) url = readFileSync(urlFile, "utf8").split("\n")[0].trim()
      if (printed) printedAt ??= waited
      if (!url && printed && waited - printedAt! >= 3_000) url = printed
    }
    if (!url) await Bun.sleep(200)
    if (status.status !== "pending") break
  }
  // A device code printed with the page: a moment more for it, if it comes after.
  let userCode: string | undefined
  for (let waited = 0; options.userCode && waited < 2_000; waited += 200) {
    userCode = options.userCode.exec(output)?.[1]
    if (userCode || status.status !== "pending") break
    await Bun.sleep(200)
  }
  return {
    url,
    userCode,
    instructions: options.instructions,
    mode: "auto",
    acceptsCode: Boolean(options.codePrompt),
    complete: options.codePrompt
      ? async (code: string) => {
          if (status.status !== "pending") throw new Error("That sign-in is over. Start it again.")
          pasted = true
          const from = output.length
          child.stdin.write(code.trim() + "\n")
          await child.stdin.flush()
          // A code it can't read (part of one) is turned away at once, and it waits for another.
          for (let waited = 0; waited < 1_500 && status.status === "pending"; waited += 100) {
            await Bun.sleep(100)
            if (/invalid code/i.test(output.slice(from))) {
              pasted = false
              throw new Error("That code couldn't be read. Copy all of it from the page, and paste it again.")
            }
          }
        }
      : undefined,
    status: () => status,
    cancel() {
      if (status.status === "pending") status = { status: "failed", message: "Cancelled." }
      child.kill()
    },
  }
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-4).join("\n").trim()
}
