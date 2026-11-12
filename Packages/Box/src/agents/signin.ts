// Signing in by running an agent's own sign-in command (`claude auth login`, `codex login`,
// `grok login`): it opens its maker's page in your browser and finishes by itself. The page it
// would open is caught (its BROWSER is a little script that writes it down), so the app opens it,
// once, and can open it again. Some also print a page to use when no browser opens, which ends on
// a code to paste back (Claude Code's): that's taken too, typed into the command.

import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { privateFolder, writeSecret } from "../shared/files"
import { join } from "node:path"
import type { SignInAttempt } from "./agent"
import { newID } from "./ids"
import { firstURL, plain } from "./proc"
import { Screen } from "./screen"
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
  /** How long the attempt waits for its page before it's handed back without one (its status
   * gives the page once it comes). */
  pageWait?: number
  /** Where a device code is in what it prints, for showing beside the page. */
  userCode?: RegExp
  /** Each line it has printed in full, as it's seen (in a terminal, a line the cursor has left):
   * for a sign-in it hands over rather than keeps (`claude setup-token`'s token), taken as soon as
   * it shows, and never a line still being drawn. */
  onLine?: (line: string) => void
  /** What it prints that's never said back (a token it hands over): left out of a failure's words. */
  secret?: RegExp
  /** Run in a terminal of its own, for a command that prints its page and takes a code only there
   * (`claude setup-token`): wide, so nothing it prints wraps. */
  terminal?: boolean
  /** What it says of a pasted code it turns away (as it waits for another). */
  refusedCode?: RegExp
  /** A refused code ends the sign-in, with these words (its program takes no second one). */
  refusedEnds?: string
}

/**
 * The catcher, in the temporary folder: a path without spaces (Python splits BROWSER on them). In a
 * folder only you can open, written by the bridge itself (never one found there), and what it writes
 * down (a sign-in's page) only you can read.
 */
export function catcher(temporary: string): string {
  const path = join(privateFolder(join(temporary, "bin")), "kuvo-catch-url")
  const script = '#!/bin/sh\numask 077\nprintf \'%s\\n\' "$1" >> "$KUVO_URL_FILE"\n'
  if (!ownScript(path, script)) {
    writeSecret(path, script)
    chmodSync(path, 0o700)
  }
  return path
}

/** Whether `path` is that script, as the bridge wrote it: yours, and no one else's to change or read. */
function ownScript(path: string, script: string): boolean {
  try {
    const there = lstatSync(path)
    return there.isFile() && there.uid === process.getuid?.() && (there.mode & 0o777) === 0o700 && readFileSync(path, "utf8") === script
  } catch {
    return false
  }
}

export async function commandSignIn(options: CommandSignInOptions): Promise<SignInAttempt> {
  // The page it hands its browser, written down in a folder of this attempt's own that only you can
  // open, and gone with it.
  const browser = catcher(options.temporary)
  const own = mkdtempSync(join(options.temporary, "kuvo-signin-"))
  const urlFile = join(own, "url")
  const env: Record<string, string | undefined> = { ...process.env, ...options.env, BROWSER: browser, KUVO_URL_FILE: urlFile }
  // A value left `undefined` is unset, as in `run`.
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name]
  // What it printed, its terminal codes taken out as a whole (one can come split over two reads).
  // In a terminal, what its screen shows: a terminal UI redraws only what changed, jumping over the
  // rest, so its stream has words in pieces (a token too).
  let printed = ""
  let output = ""
  const refused = options.refusedCode ?? /invalid code/i
  // Whether a code was typed and is being taken; in a terminal, whether a line it printed since
  // turned it away.
  let afterPaste = false
  let refusedLine = false
  // (In a pipe: where its output stood then, and where the next line starts.)
  let pastedAt = 0
  let lineFrom = 0
  const screen = options.terminal
    ? new Screen(TERMINAL.cols, TERMINAL.rows, (line) => {
        if (afterPaste && refused.test(line)) refusedLine = true
        said(line)
      })
    : undefined
  /** A line it printed in full: what it hands over (a token) may sign you in then and there. */
  const said = (line: string) => {
    if (!options.onLine) return
    options.onLine(line)
    if (signedInBefore !== false || status.status !== "pending") return
    void options.signedIn().then((signedIn) => {
      if (!signedIn || status.status !== "pending") return
      succeed()
      child.kill()
    }, () => {})
  }
  /** Whether what it printed since the code was typed turns it away. */
  const turnedAway = () => (screen ? refusedLine || refused.test(screen.current()) : refused.test(output.slice(pastedAt)))
  const take = (text: string) => {
    if (screen) {
      screen.write(text)
      output = screen.text()
    } else {
      printed += text
      output = plain(printed)
      for (let end = output.indexOf("\n", lineFrom); end >= 0; end = output.indexOf("\n", lineFrom)) {
        said(output.slice(lineFrom, end + 1))
        lineFrom = end + 1
      }
    }
    // A code turned away after it was checked over the network, however long that took: one that
    // takes no second code ends the sign-in.
    if (options.refusedEnds && afterPaste && status.status === "pending" && turnedAway()) {
      status = { status: "failed", message: options.refusedEnds }
      child.kill()
    }
  }
  let type: (text: string) => Promise<void>
  let child: ReturnType<typeof Bun.spawn>
  // (A command that can't start leaves nothing behind either.)
  try {
    if (options.terminal) {
      const decoder = new TextDecoder()
      const spawned = Bun.spawn([options.command, ...options.args], {
        env,
        terminal: { ...TERMINAL, data: (_terminal: unknown, data: Uint8Array) => take(decoder.decode(data, { stream: true })) },
      } as any) as any
      child = spawned
      // A terminal's Return.
      type = async (text) => void spawned.terminal.write(text.replace(/\n$/, "\r"))
    } else {
      const spawned = Bun.spawn([options.command, ...options.args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      child = spawned
      const read = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder()
        for await (const chunk of stream) take(decoder.decode(chunk, { stream: true }))
      }
      void read(spawned.stdout)
      void read(spawned.stderr)
      type = async (text) => {
        spawned.stdin.write(text)
        await spawned.stdin.flush()
      }
    }
  } catch (error) {
    rmSync(own, { recursive: true, force: true })
    throw error
  }
  let status: OAuthStatus = { status: "pending" }
  let pasted = false
  /** Whether it was signed in as it started (signing in again): undefined until known. */
  let signedInBefore: boolean | undefined
  const succeed = () => {
    status = { status: "complete" }
    options.onComplete?.()
  }
  void child.exited.then(async (code) => {
    rmSync(own, { recursive: true, force: true })
    if (status.status !== "pending") return
    const signedIn = await options.signedIn().catch(() => false)
    if (status.status !== "pending") return
    // Signed in before (an ended sign-in still reads as one): only the command's own success says
    // this one worked.
    if (signedIn && (code === 0 || signedInBefore === false)) succeed()
    else if (pasted) status = { status: "failed", message: "That code didn't work. Start again, and paste the code from the page this sign-in opens." }
    else {
      // (Its secret first, before taking anything out can join a piece of it to other words.)
      let words = options.secret ? output.replace(options.secret, "") : output
      if (options.codePrompt) words = words.replace(options.codePrompt, "")
      // No control characters (a terminal's codes are gone already).
      words = words.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      status = { status: "failed", message: lastLines(words) || `Signing in stopped (exit code ${code}).` }
    }
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
  const look = (waited: number) => {
    const printed = firstURL(output)
    if (options.printedPage) return printed ?? ""
    if (existsSync(urlFile)) return readFileSync(urlFile, "utf8").split("\n")[0].trim()
    if (printed) printedAt ??= waited
    return printed && waited - printedAt! >= 3_000 ? printed : ""
  }
  let waited = 0
  for (; waited < (options.pageWait ?? 15_000) && !url; waited += 200) {
    url = look(waited)
    if (!url) await Bun.sleep(200)
    if (status.status !== "pending") break
  }
  // Not come yet (the command slow to start, or waiting on another Claude Code): looked for still,
  // and given with its status once it comes, for the app to open then.
  let late: string | undefined
  if (!url) {
    void (async () => {
      for (; status.status === "pending" && !late; waited += 200) {
        late = look(waited) || undefined
        if (!late) await Bun.sleep(200)
      }
    })()
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
          pastedAt = output.length
          afterPaste = true
          refusedLine = false
          await type(code.trim() + "\n")
          // A code it can't read (part of one) is turned away at once, and it waits for another.
          for (let waited = 0; waited < 1_500 && status.status === "pending"; waited += 100) {
            await Bun.sleep(100)
            if (!options.refusedEnds && turnedAway()) {
              pasted = false
              afterPaste = false
              throw new Error("That code couldn't be read. Copy all of it from the page, and paste it again.")
            }
          }
          // (Set as its output comes in, meanwhile.)
          const now = status as OAuthStatus
          if (options.refusedEnds && now.status === "failed" && now.message === options.refusedEnds) throw new Error(options.refusedEnds)
        }
      : undefined,
    status: () => (late && status.status === "pending" ? { ...status, url: late, instructions: options.instructions } : status),
    cancel() {
      if (status.status === "pending") status = { status: "failed", message: "Cancelled." }
      child.kill()
    },
  }
}

/** The terminal a command runs in: wide, so nothing it prints wraps. */
const TERMINAL = { cols: 1000, rows: 50 }

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-4).join("\n").trim()
}
