import "../safety"
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { subscribe } from "../../src/agents/events"
import { Store } from "../../src/agents/store"
import { Turn } from "../../src/agents/turn"
import { noTokens, type ServerEvent } from "../../src/agents/wire"
import { unwrapShell } from "../../src/agents/agents/codex"
import { fileDiff, fromPatch, unified } from "../../src/agents/diff"
import { messageID, newID } from "../../src/agents/ids"
import { compareVersions, homebrewKeg, install, npmGlobalPrefix, update, versionIn } from "../../src/agents/maintenance"
import { evaluate, matches } from "../../src/agents/rules"
import { handover } from "../../src/agents/handover"
import { EngineAgent, EngineLink } from "../../src/agents/engine"
import { generatedImages } from "../../src/agents/agents/antigravity"
import { kuvoToolName, loadKuvoTools, setToolServer } from "../../src/agents/kuvotools"
import { pictureData, pictureFile, withPictures } from "../../src/agents/pictures"
import { expandCommand } from "../../src/agents/server"
import { Auto } from "../../src/agents/auto"
import type { Roster } from "../../src/agents/roster"
import { commandParts, parseCommands, Sessions, withTextFiles } from "../../src/agents/sessions"
import { refreshLoginPath, run, which } from "../../src/agents/proc"
import { commandSignIn } from "../../src/agents/signin"

describe("diffs", () => {
  test("a changed line, with the lines around it", () => {
    const { patch, additions, deletions } = unified("a\nb\nc\nd\n", "a\nb\nC\nd\n")
    expect(additions).toBe(1)
    expect(deletions).toBe(1)
    expect(patch).toBe("@@ -1,4 +1,4 @@\n a\n b\n-c\n+C\n d\n")
  })

  test("a new file is all added", () => {
    const diff = fileDiff("/tmp/x.txt", undefined, "one\ntwo\n")
    expect(diff.status).toBe("added")
    expect(diff.additions).toBe(2)
    expect(diff.patch.startsWith("--- /tmp/x.txt\n+++ /tmp/x.txt\n@@ -0,0 +1,2 @@\n")).toBe(true)
  })

  test("far-apart changes make two hunks", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n"
    const after = before.replace("line 1\n", "line one\n").replace("line 18\n", "line eighteen\n")
    const { patch } = unified(before, after)
    expect(patch.match(/^@@/gm)?.length).toBe(2)
  })

  test("someone else's patch is counted", () => {
    const diff = fromPatch("src/a.ts", "@@ -1,2 +1,2 @@\n-old\n+new\n same\n")
    expect([diff.additions, diff.deletions]).toEqual([1, 1])
    expect(diff.patch.startsWith("--- a/src/a.ts")).toBe(true)
  })
})

describe("permission rules", () => {
  test("nothing set runs without asking", () => {
    expect(evaluate([], "shell", ["ls"])).toBe("allow")
  })

  test("the last matching rule wins", () => {
    const rules = [
      { action: "shell", resource: "*", effect: "ask" as const },
      { action: "shell", resource: "git *", effect: "allow" as const },
    ]
    expect(evaluate(rules, "shell", ["git status"])).toBe("allow")
    expect(evaluate(rules, "shell", ["rm -rf build"])).toBe("ask")
    expect(evaluate(rules, "edit", ["/a"])).toBe("allow")
  })

  test("patterns", () => {
    expect(matches("*.env", "secrets.env")).toBe(true)
    expect(matches("src/*", "lib/a")).toBe(false)
  })
})

describe("IDs", () => {
  test("they sort in the order they were made, as the engine's do", () => {
    const ids = Array.from({ length: 50 }, () => newID("msg"))
    expect([...ids].sort()).toEqual(ids)
    expect(ids[0]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })

  test("an event's message", () => {
    expect(messageID("evt_0123abc")).toBe("msg_0123abc")
  })
})

describe("Codex's commands", () => {
  test("shown as typed", () => {
    expect(unwrapShell(`/bin/zsh -lc 'cat notes.txt'`)).toBe("cat notes.txt")
    expect(unwrapShell(`/bin/zsh -lc "echo \\"hi\\""`)).toBe(`echo "hi"`)
    expect(unwrapShell("ls -la")).toBe("ls -la")
  })
})

describe("keeping an agent's program current", () => {
  test("its version, as it prints it", () => {
    expect(versionIn("2.1.156 (Claude Code)")).toBe("2.1.156")
    expect(versionIn("codex-cli 0.159.3")).toBe("0.159.3")
    expect(versionIn("grok 1.0.62 (1474f9cbdd91)")).toBe("1.0.62")
    expect(versionIn("no version here")).toBeUndefined()
  })

  test("versions compare by number, a pre-release before its release", () => {
    expect(compareVersions("2.1.156", "2.1.303")).toBe(-1)
    expect(compareVersions("0.163.0", "0.159.3")).toBe(1)
    expect(compareVersions("1.0.62", "1.0.62")).toBe(0)
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1)
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1)
  })

  test("who installed it, from where it really is", () => {
    expect(npmGlobalPrefix("/Users/me/.nvm/versions/node/v22.15.1/lib/node_modules/@xai-official/grok/bin/grok", "@xai-official/grok")).toBe("/Users/me/.nvm/versions/node/v22.15.1")
    // A project's own copy isn't a global install.
    expect(npmGlobalPrefix("/Users/me/app/node_modules/x/lib/node_modules/@openai/codex/bin/codex", "@openai/codex")).toBeUndefined()
    expect(npmGlobalPrefix("/opt/homebrew/Caskroom/codex/0.159.3/bin/codex", "@openai/codex")).toBeUndefined()
    expect(homebrewKeg("/opt/homebrew/Caskroom/codex/0.159.3/bin/codex")).toEqual({ kind: "cask", name: "codex", prefix: "/opt/homebrew" })
    expect(homebrewKeg("/usr/local/Cellar/gh/2.80.0/bin/gh")).toEqual({ kind: "formula", name: "gh", prefix: "/usr/local" })
    expect(homebrewKeg("/Users/me/.local/share/claude/versions/2.1.156")).toBeUndefined()
  })

  test("your login shell's PATH, read again and again, stays as it is (a profile that adds a folder each time, as Ubuntu's does)", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kuvo-shell-"))
    const shell = join(folder, "login-shell")
    // Its profile puts ~/.local/bin first, whatever the PATH already has; then runs what it's given.
    writeFileSync(shell, '#!/bin/sh\nPATH="/home/me/.local/bin:$PATH"\neval "$2"\n')
    chmodSync(shell, 0o755)
    const saved = { SHELL: process.env.SHELL, PATH: process.env.PATH }
    process.env.SHELL = shell
    try {
      await refreshLoginPath(true)
      const first = process.env.PATH
      await refreshLoginPath(true)
      await refreshLoginPath(true)
      expect(process.env.PATH).toBe(first)
      expect(first?.split(":").filter((entry) => entry === "/home/me/.local/bin").length).toBe(1)
    } finally {
      // (Not assigned when there was none: that would make it the word "undefined", the shell every later test in the run starts.)
      if (saved.SHELL === undefined) delete process.env.SHELL
      else process.env.SHELL = saved.SHELL
      process.env.PATH = saved.PATH
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("an agent's program that hangs, deaf to being asked to stop (checking its sign-in), is stopped when its time is up, not waited on for ever", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kuvo-hang-"))
    const pidFile = join(folder, "pid")
    try {
      const ran = await run("/bin/sh", ["-c", `trap '' TERM; echo $$ >"${pidFile}"; exec sleep 30`], { timeout: 500 })
      expect(ran.timedOut).toBe(true)
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow()
    } finally {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL") } catch {}
      rmSync(folder, { recursive: true, force: true })
    }
  }, 20_000)

  test("installing with its maker's command: there after it, with its version, or why not", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kuvo-install-"))
    // (Your login shell's PATH isn't read here.)
    const readPath = async () => {}
    try {
      const bin = join(folder, "bin")
      const command = `mkdir -p bin && printf '#!/bin/sh\\necho "fake 1.4.2"\\n' > bin/fake && chmod +x bin/fake && echo ran >> runs`
      const installed = await install("Fake", command, folder, () => which("fake", [bin]), readPath)
      expect(installed).toEqual({ installed: true, version: "1.4.2" })
      // Asked again: it's there, so its installer doesn't run again.
      expect(await install("Fake", command, folder, () => which("fake", [bin]), readPath)).toEqual({ installed: true, version: "1.4.2" })
      expect(readFileSync(join(folder, "runs"), "utf8")).toBe("ran\n")

      const failed = await install("Other", "echo 'curl: (6) Could not resolve host' >&2; exit 6", folder, () => which("other", [bin]), readPath)
      expect(failed.installed).toBe(false)
      expect(failed.message).toContain("Other isn't installed after")
      expect(failed.message).toContain("Could not resolve host")
      // Shown as plain text in an alert: no Markdown ticks around the command.
      expect(failed.message).not.toContain("`")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("updating an agent", () => {
  test("left as it was, it's up to date only when the newest is known to be that version; otherwise it says why not", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kuvo-update-"))
    const original = globalThis.fetch
    // npm's registry: the newest of one package, and an answer that isn't one for the other.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      return url.includes("kuvo-test-known") ? Response.json({ version: "1.0.0" }) : new Response("unavailable", { status: 503 })
    }) as typeof fetch
    try {
      // A program on 1.0.0 whose own updater runs and leaves it there.
      const program = (name: string) => {
        const executable = join(folder, name)
        writeFileSync(executable, `#!/bin/sh\nif [ "$1" = update ]; then echo "nothing new"; else echo "${name} 1.0.0"; fi\n`)
        chmodSync(executable, 0o755)
        return { name, executable, npmPackage: `kuvo-test-${name}`, nativeUpdate: { args: ["update"], isNative: () => true } }
      }
      expect(await update(program("known"), folder)).toEqual({ updated: false, version: "1.0.0" })
      const unknown = await update(program("unknown"), folder)
      expect(unknown.updated).toBe(false)
      expect(unknown.message).toContain("unknown is still 1.0.0 after “unknown update”")
      expect(unknown.message).not.toContain("`")
    } finally {
      globalThis.fetch = original
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("Settings' Blocks, as the engine gives them", () => {
  test("keep their own kind: an ask asks, a block blocks, and one of a kind a newer engine has blocks too", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({ data: [{ info: { policies: [
          { action: "tool.use", resource: "shell:git push *", effect: "ask" },
          { action: "tool.use", resource: "shell:rm *", effect: "deny-forever" },
          { action: "tool.use", resource: "webfetch", effect: "deny" },
          { action: "tool.use", resource: "shell:ls", effect: "allow" },
        ] } }] }),
    })
    const link = new EngineLink()
    try {
      link.configure(`http://127.0.0.1:${server.port}`, "x")
      expect(await link.policies("/tmp/project")).toEqual([
        { action: "shell", resource: "git push *", effect: "ask" },
        { action: "shell", resource: "rm *", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "shell", resource: "ls", effect: "allow" },
      ])
    } finally {
      link.configure(undefined, undefined)
      server.stop(true)
    }
  })
})

describe("a session's files", () => {
  test("a turn that ends while they can't be written (a full disk) still ends, and what it said is written once they can be", () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-store-"))
    const error = console.error
    try {
      const store = new Store(folder)
      store.add({ id: "ses_full", projectID: "p", cost: 0, tokens: noTokens(), time: { created: 1, updated: 1 }, location: { directory: "/tmp" } })
      const turn = new Turn(store, "ses_full", "/tmp", { providerID: "opencode", id: "m" }, "build")
      turn.startStep()
      turn.blockDelta("text-0", "text", "Done.")
      turn.endStep()
      // Nothing more can be written there, whoever runs it: a file where its folder was.
      rmSync(join(folder, "ses_full"), { recursive: true, force: true })
      writeFileSync(join(folder, "ses_full"), "")
      console.error = () => {}
      turn.finish("succeeded")
      expect(turn.isEnded).toBe(true)
      // Room again: written.
      rmSync(join(folder, "ses_full"))
      store.flush()
      const kept = JSON.parse(readFileSync(join(folder, "ses_full", "messages.json"), "utf8"))
      expect(kept.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" })
      expect(JSON.stringify(kept)).toContain("Done.")
    } finally {
      console.error = error
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("blocks an agent keeps apart", () => {
  test("thinking and words that interleave stay two blocks", () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-turn-"))
    try {
      const store = new Store(folder)
      store.add({ id: "ses_t", projectID: "p", cost: 0, tokens: noTokens(), time: { created: 1, updated: 1 }, location: { directory: "/tmp" } })
      const seen: ServerEvent[] = []
      const stop = subscribe((event) => seen.push(event))
      const turn = new Turn(store, "ses_t", "/tmp", { providerID: "opencode", id: "m" }, "build")
      turn.startStep()
      turn.blockDelta("reasoning-0", "reasoning", "Think")
      turn.blockDelta("text-0", "text", "It ")
      turn.blockDelta("reasoning-0", "reasoning", "ing.")
      turn.blockDelta("text-0", "text", "printed hello.")
      turn.blockEnd("reasoning-0")
      turn.endStep()
      turn.finish("succeeded")
      stop()
      const step = store.get("ses_t")!.messages.find((message) => message.type === "assistant") as any
      expect(step.content.map((content: any) => [content.type, content.text])).toEqual([
        ["reasoning", "Thinking."],
        ["text", "It printed hello."],
      ])
      expect(seen.filter((event) => event.type === "session.text.ended")).toHaveLength(1)
      expect(seen.filter((event) => event.type === "session.reasoning.ended")).toHaveLength(1)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a client that reads a block mid-reply, then gets pieces from before its read, has each word once", () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-turn-"))
    try {
      const store = new Store(folder)
      store.add({ id: "ses_r", projectID: "p", cost: 0, tokens: noTokens(), time: { created: 1, updated: 1 }, location: { directory: "/tmp" } })
      const seen: ServerEvent[] = []
      const stop = subscribe((event) => seen.push(event))
      const turn = new Turn(store, "ses_r", "/tmp", { providerID: "opencode", id: "m" }, "build")
      turn.startStep()
      // Repeated pieces, as replies have them (blank lines, indentation), and a character in two halves.
      const pieces = ["Line.\n", "\n", "\n", "Next 🙂", " ", " ", "end."]
      const reads: string[] = []
      for (const piece of pieces) {
        reads.push((store.get("ses_r")!.messages.find((message) => message.type === "assistant") as any)?.content.find((content: any) => content.type === "text")?.text ?? "")
        turn.text(piece)
      }
      stop()
      const deltas = seen.filter((event) => event.type === "session.text.delta").map((event) => (event as any).data as { delta: string; at: number })
      // A read at any point, with the pieces from any point before it on top, each where it says it goes.
      for (const [read, text] of reads.entries()) {
        for (let since = 0; since <= read; since++) {
          let shown = text
          for (const { delta, at } of deltas.slice(since)) {
            if (shown.length >= at + delta.length) continue
            shown += delta.slice(shown.length - at)
          }
          expect(shown).toBe(pieces.join(""))
        }
      }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("signing in with an agent's command", () => {
  // Like Claude Code's: prints a page for when no browser opens (ending on a code), then hands its
  // browser the page that comes back by itself, and takes a pasted code.
  function fakeLogin(folder: string) {
    const script = join(folder, "login")
    writeFileSync(
      script,
      `#!/bin/sh
echo "If the browser didn't open, visit: https://example.com/printed?redirect=code"
sleep 0.5
"$BROWSER" "https://example.com/browser?redirect=localhost"
printf "Paste code here if prompted > "
read code
while [ "$code" = "part" ]; do echo "Invalid code. Please make sure the full code was copied" >&2; printf "Paste code here if prompted > "; read code; done
[ "$code" = "good" ] && echo signed > "${join(folder, "account")}" && exit 0
echo "Login failed: Request failed with status code 400"
exit 1
`,
    )
    chmodSync(script, 0o755)
    return script
  }

  async function attempt(folder: string, options: { signedInBefore?: boolean; onComplete?: () => void; remote?: boolean } = {}) {
    return commandSignIn({
      command: fakeLogin(folder),
      args: [],
      home: folder,
      temporary: folder,
      instructions: "",
      // Signed in before: an ended sign-in still reads as one.
      signedIn: async () => options.signedInBefore || existsSync(join(folder, "account")),
      codePrompt: /Paste code here if prompted >\s*/g,
      onComplete: options.onComplete,
      printedPage: options.remote,
    })
  }

  test("on another device, the printed page, which ends on a code to paste here", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      const sign = await attempt(folder, { remote: true })
      expect(sign.url).toBe("https://example.com/printed?redirect=code")
      expect(sign.acceptsCode).toBe(true)
      await sign.complete!("good")
      expect((await settled(sign)).status).toBe("complete")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a device code printed with its page is given with it", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      const script = join(folder, "device")
      writeFileSync(script, `#!/bin/sh\necho "Open https://accounts.x.ai/device and enter the code:"\nsleep 0.3\necho "  WDJB-MJHT"\nsleep 0.5\necho signed > "${join(folder, "account")}"\n`)
      chmodSync(script, 0o755)
      const sign = await commandSignIn({
        command: script,
        args: [],
        home: folder,
        temporary: folder,
        instructions: "",
        signedIn: async () => existsSync(join(folder, "account")),
        printedPage: true,
        userCode: /\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/,
      })
      expect(sign.url).toBe("https://accounts.x.ai/device")
      expect(sign.userCode).toBe("WDJB-MJHT")
      expect((await settled(sign)).status).toBe("complete")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  async function settled(sign: Awaited<ReturnType<typeof attempt>>) {
    for (let waited = 0; waited < 10_000 && sign.status().status === "pending"; waited += 100) await Bun.sleep(100)
    return sign.status()
  }

  test("a page that comes late (Claude Code slow to start): given with the sign-in's status, to open then", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      const script = join(folder, "slow")
      const go = join(folder, "go")
      writeFileSync(script, `#!/bin/sh\nwhile [ ! -f "${go}" ]; do sleep 0.05; done\n"$BROWSER" "https://example.com/late?redirect=localhost"\nread code\n`)
      chmodSync(script, 0o755)
      const sign = await commandSignIn({ command: script, args: [], home: folder, temporary: folder, instructions: "Finish on the page.", signedIn: async () => false, pageWait: 0 })
      expect(sign.url).toBe("")
      expect(sign.status().url).toBeUndefined()
      writeFileSync(go, "")
      for (let waited = 0; waited < 10_000 && !sign.status().url; waited += 50) await Bun.sleep(50)
      expect(sign.status()).toMatchObject({ status: "pending", url: "https://example.com/late?redirect=localhost" })
      sign.cancel()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a command that prints its page and takes a code only in a terminal (claude setup-token): run in one, the code typed with Return", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      const script = join(folder, "terminal-only")
      writeFileSync(script, `#!/bin/sh\n[ -t 0 ] || exit 3\nprintf 'Use the url below\\nhttps://example.com/terminal?redirect=platform\\n\\nPaste code here if prompted > '\nread code\n[ "$code" = good ] && echo signed > "${join(folder, "account")}"\n`)
      chmodSync(script, 0o755)
      const sign = await commandSignIn({
        command: script, args: [], home: folder, temporary: folder, instructions: "Finish on the page.", terminal: true, printedPage: true,
        codePrompt: /Paste code here if prompted\s*>\s*/g, signedIn: async () => existsSync(join(folder, "account")),
      })
      expect(sign.url).toBe("https://example.com/terminal?redirect=platform")
      await sign.complete!("good")
      expect((await settled(sign)).status).toBe("complete")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("opens the page handed to the browser, not the one printed first", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      const sign = await attempt(folder)
      expect(sign.url).toBe("https://example.com/browser?redirect=localhost")
      expect(sign.acceptsCode).toBe(true)
      sign.cancel()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a pasted code is typed into the command", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      const sign = await attempt(folder)
      await sign.complete!("good\n")
      expect((await settled(sign)).status).toBe("complete")
      expect(readFileSync(join(folder, "account"), "utf8").trim()).toBe("signed")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a wrong code says so, without the command's prompt", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      const sign = await attempt(folder)
      await sign.complete!("bad")
      const status = await settled(sign)
      expect(status.status).toBe("failed")
      expect(status.message).toContain("That code didn't work")
      await expect(sign.complete!("good")).rejects.toThrow()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("signing in again: a wrong code fails, though the sign-in it replaces still reads as one", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      let completed = 0
      const sign = await attempt(folder, { signedInBefore: true, onComplete: () => completed++ })
      await sign.complete!("bad")
      const status = await settled(sign)
      expect(status.status).toBe("failed")
      expect(status.message).toContain("That code didn't work")
      expect(completed).toBe(0)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("signing in again: the command's success completes it", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      let completed = 0
      const sign = await attempt(folder, { signedInBefore: true, onComplete: () => completed++ })
      await sign.complete!("good")
      expect((await settled(sign)).status).toBe("complete")
      expect(completed).toBe(1)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("part of a code is turned away at once, and the whole one still works", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-signin-"))
    try {
      const sign = await attempt(folder)
      await expect(sign.complete!("part")).rejects.toThrow("couldn't be read")
      expect(sign.status().status).toBe("pending")
      await sign.complete!("good")
      expect((await settled(sign)).status).toBe("complete")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("handovers", () => {
  test("what the agent said comes before the file change it led to", () => {
    const text = handover(
      [
        { type: "user", id: "msg_1", time: { created: 1 }, text: "fix the parser" },
        {
          type: "assistant",
          id: "msg_2",
          time: { created: 2 },
          agent: "build",
          model: { providerID: "alpha", id: "one" },
          content: [
            { type: "text", text: "I'll fix the parser." },
            { type: "tool", id: "call_1", name: "edit", state: { status: "completed", input: { path: "src/parser.ts" }, content: [] } },
          ],
        } as any,
      ],
      [],
      () => "Alpha, one",
    )!
    expect(text.indexOf("I'll fix the parser.")).toBeLessThan(text.indexOf("src/parser.ts"))
  })

  test("what you sent while another agent worked is still asked, not done", () => {
    const text = handover([], [{ type: "user", id: "msg_3", time: { created: 3 }, text: "use tabs too" }], () => "Alpha, one")!
    expect(text).toContain("[You, while it worked]\nuse tabs too")
    expect(text).toContain("part of what they ask")
  })
})

describe("a command line's commands", () => {
  const commands = (line: string) => commandParts(line).slice(1)

  test("each command counts, however the line joins them", () => {
    expect(commands("a && b || c")).toEqual(["a", "b", "c"])
    expect(commands("true & git push")).toContain("git push")
    expect(commands("if true; then git push; fi")).toContain("git push")
    expect(commands("{ git push; }")).toContain("git push")
    expect(commands("! git push")).toContain("git push")
    expect(commands("time git push")).toContain("git push")
    expect(commands("for r in o; do git push $r; done")).toContain("git push $r")
    expect(commands("(cd x && git push)")).toContain("git push")
    expect(commands('echo "$(git push)"')).toContain("git push")
    expect(commands("echo `git push`")).toContain("git push")
    expect(commands("diff <(git show HEAD:a) a")).toContain("git show HEAD:a")
  })

  test("comments, here-documents, line breaks and what comes before a command don't hide it", () => {
    const blocked = (line: string) => commandParts(line).some((part) => /^git push( |$)/.test(part))
    expect(blocked("# now let's push\ngit push origin main")).toBe(true)
    expect(blocked(`git commit -m "$(cat <<'EOF'\nIt's a fix (really)\nEOF\n)" && git push origin main`)).toBe(true)
    expect(blocked("cat <<EOF && git push origin main\nbody\nEOF")).toBe(true)
    expect(blocked("git \\\npush")).toBe(true)
    expect(blocked("VAR=1 git push")).toBe(true)
    expect(blocked("2>/dev/null git push")).toBe(true)
    expect(blocked("sudo -u me git push")).toBe(true)
    expect(blocked("env FOO=1 nohup git push &")).toBe(true)
    expect(blocked("git -C ../other push origin")).toBe(true)
    expect(blocked("bash -c 'cd x && git push'")).toBe(true)
    expect(blocked("sh -lc \"git push\"")).toBe(true)
    // A quote never closed: still split, the plain way.
    expect(blocked("echo 'oops; git push")).toBe(true)
    // What only looks like it stays where it is.
    expect(blocked('git commit -m "wip; git push later"')).toBe(false)
    expect(blocked("cat <<'EOF' > notes.md\ngit push\nEOF")).toBe(false)
    expect(blocked("echo done # git push later")).toBe(false)
  })

  test("what a line hides from a Block is found: comments that aren't, wrappers' options, paths and quotes, and what eval, xargs and find run", () => {
    const found = (line: string) => commandParts(line)
    expect(found("echo a\\ #; rm -rf /")).toContain("rm -rf /")
    expect(found('cat <<< "x"\nrm -rf /\nx')).toContain("rm -rf /")
    expect(found("(( n << 2 ))\nrm -rf /\n2")).toContain("rm -rf /")
    for (const wrapped of ["sudo -n rm -rf /", "command -p rm -rf /", "caffeinate -u rm -rf /", "time -p rm -rf /", "timeout 5 rm -rf /", "/bin/rm -rf /", "\\rm -rf /", '"rm" -rf /', 'eval "rm -rf /"', 'env -S "rm -rf /" ls']) {
      expect(found(wrapped)).toContain("rm -rf /")
    }
    expect(found("sudo -u bob ls")).toContain("ls")
    expect(found('git "push" origin')).toContain("git push origin")
    expect(found("echo / | xargs -n 1 rm -rf")).toContain("rm -rf")
    expect(found("find . -name x -exec rm -rf {} \\;")).toContain("rm -rf '{}'")
    // A shell reading its script from its input runs what isn't known here; a script file is as any program.
    expect(parseCommands("bash <<EOF\nrm -rf /\nEOF").sure).toBe(false)
    expect(found("bash <<EOF\nrm -rf /\nEOF")).toContain("rm -rf /")
    expect(parseCommands("curl -s x | sh").sure).toBe(false)
    expect(parseCommands("bash scripts/build.sh 2>&1").sure).toBe(true)
    expect(parseCommands("cd app && npm run build 2>&1 | tail -5").sure).toBe(true)
    expect(parseCommands("echo $((1 << 2))").sure).toBe(true)
    expect(parseCommands("X=rm; $X -rf /").sure).toBe(false)
  })

  test("what's quoted, redirected or read from a here-document stays in its command", () => {
    expect(commandParts('git commit -m "wip; git push later"')).toEqual(['git commit -m "wip; git push later"'])
    expect(commandParts("git commit -m 'docs (git push) flow'")).toEqual(["git commit -m 'docs (git push) flow'"])
    expect(commands("ls 2>&1 | grep x")).toEqual(["ls 2>&1", "grep x"])
    expect(commands("make &> log; echo done")).toEqual(["make &> log", "echo done"])
    const heredoc = commands("cat > notes <<'EOF'\ngit push\nEOF\necho hi")
    expect(heredoc).not.toContain("git push")
    expect(heredoc).toContain("echo hi")
  })
})

describe("the engine's models", () => {
  test("one is signed out of only when the engine lists its providers without it; an engine not up, or listing none yet, isn't known", async () => {
    let providers: { id: string }[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/api/provider") return Response.json({ data: providers })
        if (path === "/api/model") return Response.json({ data: [] })
        return new Response("", { status: 404 })
      },
    })
    const link = new EngineLink()
    try {
      expect(await new EngineAgent(link, "openai").signedOut()).toBe(false)
      link.configure(`http://127.0.0.1:${server.port}`, "pw")
      expect(await new EngineAgent(link, "openai").signedOut()).toBe(false)
      providers = [{ id: "opencode" }]
      expect(await new EngineAgent(link, "openai").signedOut()).toBe(true)
      expect(await new EngineAgent(link, "opencode").signedOut()).toBe(false)
      // Signed in since the engine was last asked: it's asked again rather than turned away.
      providers = [{ id: "opencode" }, { id: "openai" }]
      expect(await new EngineAgent(link, "openai").signedOut()).toBe(false)
    } finally {
      link.configure(undefined, undefined)
      server.stop(true)
    }
  })
})

describe("your commands", () => {
  test("a command from Settings or written as a file in a settings folder, the last one counting", async () => {
    const home = mkdtempSync(join(tmpdir(), "kuvo-commands-"))
    const project = join(home, "project", ".opencode")
    mkdirSync(join(project, "command", "git"), { recursive: true })
    writeFileSync(join(project, "command", "md.md"), "---\ndescription: From a file\n---\nDo the md thing with $ARGUMENTS\n")
    writeFileSync(join(project, "command", "git", "tidy.md"), "Tidy $1")
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/api/config") return new Response("", { status: 404 })
        return Response.json([
          { type: "document", path: join(home, "opencode.json"), info: { commands: { cfg: { template: "cfg says $1" }, md: { template: "overridden" } } } },
          { type: "directory", path: project },
        ])
      },
    })
    const link = new EngineLink()
    try {
      link.configure(`http://127.0.0.1:${server.port}`, "pw")
      expect(await link.commandTemplate("cfg", home)).toBe("cfg says $1")
      expect(await link.commandTemplate("md", home)).toBe("Do the md thing with $ARGUMENTS")
      expect(await link.commandTemplate("git/tidy", home)).toBe("Tidy $1")
      expect(await link.commandTemplate("../project/.opencode/command/md", home)).toBeUndefined()
      expect(await link.commandTemplate("none", home)).toBeUndefined()
    } finally {
      link.configure(undefined, undefined)
      server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("what you write after a command fills it in, as the engine does", () => {
    expect(expandCommand("Review $ARGUMENTS carefully.", "src/a.ts")).toBe("Review src/a.ts carefully.")
    expect(expandCommand("Compare $1 with $2.", "a.ts b.ts")).toBe("Compare a.ts with b.ts.")
    expect(expandCommand("Write the changelog.", "")).toBe("Write the changelog.")
    expect(expandCommand("Write the changelog.", "for 1.2")).toBe("Write the changelog.\n\nfor 1.2")
    expect(expandCommand("Fix this: $ARGUMENTS", "awk '{print $2}' $$ $&")).toBe("Fix this: awk '{print $2}' $$ $&")
    expect(expandCommand("Review $1", "a.ts and b.ts")).toBe("Review a.ts and b.ts")
    expect(expandCommand("Move $1 to $2", "a.ts b c")).toBe("Move a.ts to b c")
    expect(expandCommand("Fix $1: $ARGUMENTS", "$ARGUMENTS x")).toBe("Fix $ARGUMENTS x: $ARGUMENTS x")
  })
})

describe("what the engine asks in a conversation run through the bridge", () => {
  test("keeps what it is: an MCP server's form stays one, a question stays one with its tool call, and your answer goes back", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-engine-forms-"))
    const requests: { method: string; path: string; body?: any }[] = []
    let heard: { event(event: any): void } | undefined
    const link = {
      ready: true,
      providerName: () => "OpenAI",
      offered: async () => ({ listed: true, ready: true, models: [] }),
      listen: (_: string, listener: { event(event: any): void }) => ((heard = listener), () => {}),
      request: async (method: string, path: string, body?: unknown) => {
        requests.push({ method, path, body })
        return method === "POST" && path === "/api/session" ? { data: { id: "eng_1" } } : {}
      },
    } as unknown as EngineLink
    const agent = new EngineAgent(link, "openai")
    const sessions = new Sessions(new Store(join(folder, "sessions")), { find: () => agent } as unknown as Roster, new Auto(folder))
    const until = async (condition: () => boolean) => {
      while (!condition()) await Bun.sleep(5)
    }
    try {
      const id = sessions.create({ title: "Bridge", model: { providerID: "openai", id: "one" }, location: { directory: folder } }).id
      sessions.prompt(id, { id: "msg_engine_forms_00001", text: "go", files: [], delivery: "steer" })
      await until(() => Boolean(heard) && requests.some((request) => request.path.endsWith("/prompt")))
      const fields = [{ key: "pick", title: "Pick", type: "string", required: true, options: [{ value: "a", label: "A (Recommended)" }, { value: "b", label: "B" }] }]
      heard!.event({ type: "form.created", data: { sessionID: "eng_1", form: { id: "frm_server", sessionID: "global", title: "probe asks", metadata: { kind: "mcp-elicitation", server: "probe", message: "Pick one" }, fields } } })
      await until(() => sessions.forms(id).length === 1)
      expect(sessions.forms(id)[0].metadata).toEqual({ kind: "mcp-elicitation", server: "probe", message: "Pick one" })
      sessions.replyForm(id, sessions.forms(id)[0].id, { pick: "a" })
      await until(() => requests.some((request) => request.path === "/api/session/global/form/frm_server/reply"))

      heard!.event({ type: "form.created", data: { sessionID: "eng_1", form: { id: "frm_asked", sessionID: "eng_1", title: "Question", metadata: { kind: "question", tool: { id: "call_7" } }, fields } } })
      await until(() => sessions.forms(id).length === 1)
      expect(sessions.forms(id)[0].metadata).toEqual({ kind: "question", tool: { id: "call_7" } })
      sessions.replyForm(id, sessions.forms(id)[0].id, null)
      await until(() => requests.some((request) => request.method === "DELETE" && request.path === "/api/session/eng_1/form/frm_asked"))

      // Turned down by its box with words (Autopilot): the engine's model hears them too.
      heard!.event({ type: "form.created", data: { sessionID: "eng_1", form: { id: "frm_left", sessionID: "eng_1", title: "Question", metadata: { kind: "question", tool: { id: "call_8" } }, fields } } })
      await until(() => sessions.forms(id).length === 1)
      sessions.replyForm(id, sessions.forms(id)[0].id, null, "This is on Autopilot: leave it.")
      await until(() => requests.some((request) => request.method === "DELETE" && request.path === `/api/session/eng_1/form/frm_left?message=${encodeURIComponent("This is on Autopilot: leave it.")}`))

      // One the engine names no kind for isn't taken for the agent's question.
      heard!.event({ type: "form.created", data: { sessionID: "eng_1", form: { id: "frm_plain", sessionID: "eng_1", title: "Details", fields } } })
      await until(() => sessions.forms(id).length === 1)
      expect(sessions.forms(id)[0].metadata?.kind).not.toBe("question")
      sessions.replyForm(id, sessions.forms(id)[0].id, null)
    } finally {
      sessions.closeAll()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("summarizing a conversation run through the bridge on the engine (/compact)", () => {
  test("the engine's own summary is asked for: its row and how it ended show, none of its words, and what's there stays", async () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-engine-compact-"))
    const requests: { method: string; path: string; body?: any }[] = []
    let heard: { event(event: any): void } | undefined
    const link = {
      ready: true,
      providerName: () => "OpenAI",
      offered: async () => ({ listed: true, ready: true, models: [] }),
      listen: (_: string, listener: { event(event: any): void }) => ((heard = listener), () => {}),
      request: async (method: string, path: string, body?: unknown) => {
        requests.push({ method, path, body })
        return method === "POST" && path === "/api/session" ? { data: { id: "eng_1" } } : {}
      },
    } as unknown as EngineLink
    const agent = new EngineAgent(link, "openai")
    const sessions = new Sessions(new Store(join(folder, "sessions")), { find: () => agent } as unknown as Roster, new Auto(folder))
    const until = async (condition: () => boolean) => {
      while (!condition()) await Bun.sleep(5)
    }
    const idles = (id: string) => sessions.messages(id).filter((message) => message.type === "idle")
    try {
      const id = sessions.create({ title: "Bridge", model: { providerID: "openai", id: "one" }, location: { directory: folder } }).id
      sessions.prompt(id, { id: "msg_engine_compact_0001", text: "go", files: [], delivery: "steer" })
      await until(() => Boolean(heard) && requests.some((request) => request.path.endsWith("/prompt")))
      const inboxID = requests.find((request) => request.path.endsWith("/prompt"))!.body.id
      heard!.event({ type: "session.inbox.delivered", data: { sessionID: "eng_1", inboxID } })
      heard!.event({ type: "session.execution.succeeded", data: { sessionID: "eng_1" } })
      await until(() => idles(id).length === 1)
      const before = sessions.messages(id).map((message) => message.id)

      expect(sessions.compact(id).state).toBe("compacting")
      await until(() => requests.some((request) => request.path.endsWith("/compact")))
      expect(requests.find((request) => request.path.endsWith("/compact"))).toMatchObject({ method: "POST", path: "/api/session/eng_1/compact", body: { delivery: "steer" } })
      expect(requests.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1)
      // The summary's own step, as the engine streams it, isn't a reply.
      heard!.event({ type: "session.step.started", data: { sessionID: "eng_1", assistantMessageID: "m_summary", model: { providerID: "openai", id: "one" } } })
      heard!.event({ type: "session.text.started", data: { sessionID: "eng_1", assistantMessageID: "m_summary", partID: "p_1" } })
      heard!.event({ type: "session.execution.succeeded", data: { sessionID: "eng_1" } })
      await until(() => idles(id).length === 2)

      const after = sessions.messages(id)
      expect(after.slice(0, before.length).map((message) => message.id)).toEqual(before)
      expect(after.slice(before.length).map((message) => message.type)).toEqual(["compaction", "idle"])
      expect(after.find((message) => message.type === "compaction")).toMatchObject({ status: "completed", reason: "manual" })
    } finally {
      sessions.closeAll()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("attachments", () => {
  test("a text file you attach goes in the message; a picture and a binary file stay files", () => {
    const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-attach-"))
    try {
      writeFileSync(join(folder, "notes.md"), "# Plan\nShip it.")
      writeFileSync(join(folder, "data.bin"), Buffer.from([1, 0, 2, 3]))
      const { text, files } = withTextFiles("Read these", [
        { uri: `file://${join(folder, "notes.md")}`, mime: "text/markdown", path: join(folder, "notes.md") },
        { uri: `file://${join(folder, "data.bin")}`, mime: "application/octet-stream", path: join(folder, "data.bin") },
        { uri: "file:///tmp/shot.png", mime: "image/png", path: "/tmp/shot.png" },
      ])
      expect(text).toContain("# Plan\nShip it.")
      expect(text).toContain(`<file path="${join(folder, "notes.md")}">`)
      expect(files.map((file) => file.mime)).toEqual(["application/octet-stream", "image/png"])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("Kuvo Code's tools, as agents name them", () => {
  test("a call named only by its tool is Kuvo Code's when its arguments are the ones Kuvo Code's tool takes", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const message: any = await request.json()
        return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [
          { name: "show_widget", inputSchema: { properties: { html: {}, title: {} } } },
          { name: "send_message", inputSchema: { properties: { to: {}, text: {}, wait: {} } } },
        ] } })
      },
    })
    try {
      setToolServer({ url: `http://127.0.0.1:${server.port}/mcp`, token: "t", timeout: 1_000 })
      await loadKuvoTools()
      expect(kuvoToolName("show_widget", { html: "<b>hi</b>", title: "Hi" })).toBe("kuvo-browser_show_widget")
      expect(kuvoToolName("send_message", { to: "Sam", text: "hi" })).toBe("kuvo-browser_send_message")
      // Antigravity's own send_message (to its subagents) isn't Kuvo Code's.
      expect(kuvoToolName("send_message", { Message: "hi", Recipient: "c1" })).toBeUndefined()
      expect(kuvoToolName("generate_image", { prompt: "an apple" })).toBeUndefined()
    } finally {
      setToolServer(undefined)
      server.stop(true)
    }
  })
})

describe("pictures", () => {
  test("a picture file, picture data, and words with pictures after them", () => {
    expect(pictureFile("/tmp/a b.png")).toEqual({ type: "file", uri: "file:///tmp/a%20b.png", mime: "image/png", name: "a b.png" })
    expect(pictureFile("/tmp/notes.txt")).toBeUndefined()
    expect(pictureData("AAAA", "image/jpeg")?.uri).toBe("data:image/jpeg;base64,AAAA")
    expect(withPictures("done", [undefined])).toBe("done")
    expect(withPictures("", [pictureFile("/tmp/x.jpg")])).toEqual([{ type: "text", text: "" }, { type: "file", uri: "file:///tmp/x.jpg", mime: "image/jpeg", name: "x.jpg" }])
  })

  test("Antigravity's generated image: the newest one saved under its name", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kuvo-images-"))
    try {
      writeFileSync(join(folder, "apple_1.jpg"), "x")
      await Bun.sleep(20)
      writeFileSync(join(folder, "apple_2.jpg"), "y")
      writeFileSync(join(folder, "pear_3.png"), "z")
      writeFileSync(join(folder, "notes.md"), "n")
      const [image] = generatedImages(folder, { image_name: "apple" })
      expect(image.name).toBe("apple_2.jpg")
      expect(image.mime).toBe("image/jpeg")
      expect(generatedImages(folder, { ImageName: '"pear"' })[0].name).toBe("pear_3.png")
      expect(generatedImages(join(folder, "missing"), {})).toEqual([])
      // Not named: only one made since the turn began, never your attachment or an older picture.
      expect(generatedImages(folder, {})).toEqual([])
      expect(generatedImages(folder, {}, Date.now() + 60_000)).toEqual([])
      const since = Date.now()
      await Bun.sleep(20)
      writeFileSync(join(folder, "made_9.png"), "m")
      expect(generatedImages(folder, {}, since)[0].name).toBe("made_9.png")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe("Cursor's results", () => {
  test("a running command's output, as its SDK sends it, and results it used to drop", async () => {
    const { cursorToolResult, shellChunk } = await import("../../src/agents/agents/cursor")
    expect(shellChunk({ case: "stdout", value: { data: "building…\n" } })).toBe("building…\n")
    expect(shellChunk({ case: "exit", value: { code: 0 } })).toBe("")
    expect(cursorToolResult({ type: "grep", args: {} }, { workspaceResults: { "/p": { type: "content", output: { matches: [{ file: "a.ts", lineNumber: 3, content: "let x" }] } } } }).output).toBe("a.ts: 3: let x")
    expect(cursorToolResult({ type: "ls", args: {} }, { directoryTreeRoot: { absPath: "/p", childrenDirs: [{ absPath: "/p/src", childrenDirs: [], childrenFiles: [{ name: "a.ts" }] }], childrenFiles: [{ name: "README.md" }] } }).output).toBe("/p\n  src/\n    a.ts\n  README.md")
    expect(cursorToolResult({ type: "generateImage", args: {} }, { filePath: "/tmp/cat.png", imageData: "" }).output).toEqual([{ type: "text", text: "" }, { type: "file", uri: "file:///tmp/cat.png", mime: "image/png", name: "cat.png" }])
    expect(cursorToolResult({ type: "task", args: {} }, { resultSuffix: "Found it.", isBackground: false }).output).toBe("Found it.")
  })
})
