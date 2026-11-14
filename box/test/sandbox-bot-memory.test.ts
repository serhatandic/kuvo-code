import "./safety"
import { REAL_PATH } from "../bridge-tests/test-safety.js"
import { expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fenceAgent } from "../src/agents/fence"
import { canFence, realFence } from "./agents/support/fence"

// Each test sets a whole sandbox up and runs programs in it (Bun, the sandbox, a shell) in processes
// of its own, waiting on them: about 1 s on a quiet machine, and over Bun's 5 s when it is busy,
// where Bun then stops the process being waited on and the test sees nothing (72 copies at once on
// this 12-core Mac: 29 of 72 timed out at 5.0 s, `spawnSync` giving `exitCode: null` and no output).
// So a busy machine gets as long as the work takes, not 5 s.
setDefaultTimeout(30_000)

// A bot keeps its memory (`MEMORY.md` in its folder) whatever its agent, run whole in the sandbox.
// Claude Code saves a file whole in a new one beside it first (`MEMORY.md.tmp.<pid>.<random>`) and
// renames that onto it, and writes it in place only where the rename is refused, or where making the
// new one is refused with EACCES (Linux's): macOS refuses with EPERM, so a bot on Claude Code there
// couldn't save its memory at all (every Edit and Write: "EPERM … open 'MEMORY.md.tmp.…'"), while
// its other files stay its own as before.

/** A bot's folder in Kuvo Code's, as the box keeps it, with the sandbox set up for real. */
function botBox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-bot-memory-")))
  const kuvo = join(root, "kuvo")
  const bot = join(kuvo, "bots", "bot_ship")
  const work = join(bot, "workspace")
  mkdirSync(work, { recursive: true })
  mkdirSync(join(bot, "memory"))
  writeFileSync(join(bot, "MEMORY.md"), "# Ship\n\n- likes tea\n")
  writeFileSync(join(bot, "bot.json"), "{}")
  writeFileSync(join(bot, "session"), "ses_ship")
  const fence = realFence(kuvo)
  return { root, kuvo, bot, work, fence, memory: join(bot, "MEMORY.md") }
}

/** Runs `program` whole in the sandbox, as the agents bridge does, in `directory` for `session`. */
function asAgent(box: ReturnType<typeof botBox>, program: string, args: string[], directory: string, session: string, more: { bot?: string; homes?: string[]; env?: Record<string, string> } = {}) {
  process.env.KUVO_FENCE = box.fence
  const fence = fenceAgent(program, directory, { homes: more.homes ?? [], state: more.homes?.length ? ["*"] : [], kept: [], read: [], session, bot: more.bot })!
  delete process.env.KUVO_FENCE
  return { command: [fence.command, ...args], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(box.root, "home"), ...fence.env, ...more.env } }
}

/** Saves a file as Claude Code (2.1.319) does: whole in a new one beside it, renamed onto it; in
 * place where that rename is refused (EXDEV, EPERM, EEXIST, EBUSY), or making the new one is
 * refused with EACCES; the new one removed. */
const savesLikeClaudeCode = String.raw`
const fs = require("fs"), { constants: c } = fs
const [file, text] = process.argv.slice(-2)
const mode = fs.lstatSync(file).mode & 0o777
const made = file + ".tmp." + process.pid + "." + require("crypto").randomBytes(6).toString("hex")
let written = false
try {
  const fd = fs.openSync(made, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, mode | 0o200)
  fs.writeSync(fd, text); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); fs.closeSync(fd); written = true
  fs.renameSync(made, file)
  console.log("saved whole")
} catch (error) {
  if (!(written && ["EXDEV", "EPERM", "EEXIST", "EBUSY"].includes(error.code)) && !(!written && error.code === "EACCES")) { console.log("refused: " + error.code); process.exit(1) }
  const fd = fs.openSync(file, c.O_RDWR | c.O_NOFOLLOW)
  fs.ftruncateSync(fd, 0); fs.writeSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd)
  try { fs.unlinkSync(made) } catch {}
  console.log("saved in place")
}
`

test.skipIf(!canFence)("a bot's agent saves its memory as Claude Code saves a file, in its own conversation and its seat in a group chat, and nothing else of its folder", () => {
  const box = botBox()
  try {
    const project = join(box.root, "ship-project")
    mkdirSync(project)
    // (On a machine's engine, Bun only with BUN_BE_BUN, which the sandbox keeps from what it runs:
    // so the command names it, as a program run as Bun would be started.)
    const runtime = process.env.BUN_BE_BUN ? `BUN_BE_BUN=1 ${JSON.stringify(process.execPath)}` : JSON.stringify(process.execPath)
    // Its own conversation, in its folder; its seat in a group chat, in its project's, named by the bridge.
    for (const [session, directory, bot] of [["ses_ship", box.work, undefined], ["ses_seat", project, "bot_ship"]] as const) {
      const text = `# Ship\n\n- saved from ${session}\n`
      const agent = asAgent(box, "/bin/sh", ["-c", `${runtime} -e '${savesLikeClaudeCode.replaceAll("'", "'\\''")}' ${JSON.stringify(box.memory)} '${text}'`], directory, session, { bot })
      const ran = Bun.spawnSync(agent.command, { cwd: directory, env: agent.env })
      expect({ session, out: ran.stdout.toString() + ran.stderr.toString(), status: ran.exitCode }).toEqual({ session, out: "saved in place\n", status: 0 })
      expect(readFileSync(box.memory, "utf8")).toBe(text)
      // (No new file left beside it.)
      expect(readdirSync(box.bot).sort()).toEqual(["MEMORY.md", "bot.json", "inbox", "memory", "session", "wakes", "watches", "workspace"])
    }
    // What it can't do with it, or the rest of its folder.
    const tries = [
      ["move one onto it", `echo x > ../MEMORY.md.tmp.1.ab ; mv ../MEMORY.md.tmp.1.ab ../MEMORY.md`],
      ["move it away", `mv ../MEMORY.md ../MEMORY.md.old`],
      ["remove it", `rm ../MEMORY.md`],
      ["a link beside it", `ln -s ../bot.json ../MEMORY.md.tmp.2.ab`],
      ["its settings beside it", `ln ../bot.json ../MEMORY.md.tmp.3.ab`],
      // By a name the box writes through and puts in place (its Shelf's restore): never made.
      ["a file by another name beside it", `echo x > ../MEMORY.md.kuvo-restore`],
      ["a file of its own linked by that name", `echo x > ./w && ln ./w ../MEMORY.md.kuvo-restore`],
      ["a file of another name", `echo x > ../job.json`],
      ["change its settings", `echo x > ../bot.json`],
    ]
    const script = tries.map(([what, command]) => `if ( ${command} ) >/dev/null 2>&1; then echo "${what}: allowed"; else echo "${what}: refused"; fi`).join("\n")
    const agent = asAgent(box, "/bin/sh", ["-c", script], box.work, "ses_ship")
    const out = Bun.spawnSync(agent.command, { cwd: box.work, env: agent.env }).stdout.toString()
    expect(Object.fromEntries(out.trim().split("\n").map((line) => line.split(": ")))).toEqual(Object.fromEntries(tries.map(([what]) => [what, "refused"])))
    expect(readFileSync(box.memory, "utf8")).toBe("# Ship\n\n- saved from ses_seat\n")
    expect(readFileSync(join(box.bot, "bot.json"), "utf8")).toBe("{}")
    // (The new file it couldn't move onto it stays, where it could make it: on macOS.)
    expect(readdirSync(box.bot).filter((name) => name !== "MEMORY.md" && name.startsWith("MEMORY.md"))).toEqual(process.platform === "darwin" ? ["MEMORY.md.tmp.1.ab"] : [])
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// The same with Claude Code itself, where it's installed: its Read, Edit and Write tools on the
// bot's memory, as a model would call them (a stand-in for Anthropic's API on 127.0.0.1 asks).
// (The agents' programs aren't on a test's PATH: REAL_PATH has them.)
const claude = Bun.which("claude", { PATH: REAL_PATH })
test.skipIf(!canFence || !claude)("a bot on Claude Code edits and rewrites its memory in the sandbox", async () => {
  const box = botBox()
  const calls = [
    { name: "Read", input: { file_path: box.memory } },
    { name: "Edit", input: { file_path: box.memory, old_string: "- likes tea", new_string: "- likes coffee" } },
    { name: "Write", input: { file_path: box.memory, content: "# Ship\n\n- likes coffee\n- sails at nine\n" } },
  ]
  const results: { tool: string; error: boolean }[] = []
  let next = 0
  const sse = (events: object[]) => events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
  const api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/messages")) return Response.json({})
      const body: any = await request.json()
      for (const block of body.messages?.at(-1)?.content ?? []) if (block.type === "tool_result") results.push({ tool: calls[results.length]?.name, error: block.is_error === true })
      // (Its side requests, a title, have no tools.)
      const call = (body.tools ?? []).some((tool: any) => tool.name === "Edit") ? calls[next++] : undefined
      const block = call ? { type: "tool_use", id: `toolu_${next}`, name: call.name, input: {} } : { type: "text", text: "" }
      const delta = call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "Done." }
      return new Response(sse([
        { type: "message_start", message: { id: `msg_${next}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: block },
        { type: "content_block_delta", index: 0, delta },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]), { headers: { "content-type": "text/event-stream" } })
    },
  })
  try {
    const settings = join(box.root, "claude")
    mkdirSync(settings)
    const agent = asAgent(box, realpathSync(claude!), ["-p", "Keep your memory.", "--model", "claude-haiku-4-5", "--permission-mode", "bypassPermissions", "--allowedTools", "Read,Edit,Write"], box.work, "ses_ship", {
      homes: [settings],
      env: { CLAUDE_CONFIG_DIR: settings, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: "sk-ant-test", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
    })
    const ran = Bun.spawn(agent.command, { cwd: box.work, env: agent.env, stdout: "pipe", stderr: "pipe" })
    const said = (await new Response(ran.stdout).text()) + (await new Response(ran.stderr).text())
    expect({ status: await ran.exited, said }).toEqual({ status: 0, said: "Done.\n" })
    expect(results).toEqual([{ tool: "Read", error: false }, { tool: "Edit", error: false }, { tool: "Write", error: false }])
    expect(readFileSync(box.memory, "utf8")).toBe("# Ship\n\n- likes coffee\n- sails at nine\n")
    expect(readdirSync(box.bot).filter((name) => name.startsWith("MEMORY.md"))).toEqual(["MEMORY.md"])
  } finally {
    api.stop(true)
    rmSync(box.root, { recursive: true, force: true })
  }
}, 60_000)
