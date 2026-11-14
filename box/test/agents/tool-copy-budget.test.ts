// What every call of an agent carries of the box's own words (#213): its vault, sandbox and Work Queue
// tools (and what the Work Queue's tell agents), the
// sandbox note the engine is given, what a bot is told, Codex's words on asking, and what an agent
// on Autopilot and a bot's seat in a group chat are told. Each agent kind has a budget, the size these
// came to once trimmed and a little more, so they can't creep back unnoticed. KuvoCodeTests'
// ToolCopyBudgetTests holds the app's tools and their instructions to the same. Notes that are mostly
// a path or a name (a worktree's, a project's other folders, a conversation moved) aren't counted.
// Tokens are counted as a UTF-8 byte in four, as the box counts them elsewhere (groups/rules.ts).
//
// Grown past one on purpose? Trim something else first; if it can't be, raise that budget here and
// say why in the commit.

import "../safety"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ASKING_WORDS } from "../../src/agents/agents/codex"
import { seatInstructions, type Group, type SeatBot } from "../../src/agents/groups/rules"
import { botInstructions, wordsHere, type BotKit } from "../../src/link/bots/kit"
import { SANDBOX_TOOLS } from "../../src/link/fence/outside"
import { agentsNote } from "../../src/link/fence/files"
import { VAULT_TOOLS } from "../../src/link/vault/tools"
import { AUTOPILOT_WORDS } from "../../src/link/work/autopilot"
import { QUEUE_INSTRUCTIONS, QUEUE_TOOLS } from "../../src/link/work-queue/tools"

const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4)

type Tool = { name: string; description: string; inputSchema: unknown }
const tools = [...VAULT_TOOLS, ...SANDBOX_TOOLS, ...QUEUE_TOOLS] as readonly Tool[]
// Each tool as a model gets it, under the server's name; and only their names, as Claude Code lists
// a deferred one until it looks it up.
const schemas = JSON.stringify(tools.map((tool) => ({ name: `kuvo-browser_${tool.name}`, description: tool.description, input_schema: tool.inputSchema })))
const names = tools.map((tool) => `mcp__kuvo-browser__${tool.name}`).join("\n")
// What the tool servers tell agents of the Work Queue, with its tools.
const queueWords = QUEUE_INSTRUCTIONS

// The longest the sandbox note gets: a Mac's, where tmux doesn't fit.
const sandboxNote = [agentsNote("darwin", false), agentsNote("darwin"), agentsNote("linux", false, true)].sort((a, b) => b.length - a.length)[0]!

// The longest a bot is told: one in a project, with a personality and a job, on this Mac or a
// machine, as each box tells its bots from the words its release brings.
const words = JSON.parse(readFileSync(new URL("../../../KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), "utf8"))
const personality = words.personalityWords.replaceAll("⟦name⟧", words.personalities[0].name).replaceAll("⟦description⟧", words.personalities[0].description)
function told(place: "mac" | "machine"): string {
  const kit = { instructions: wordsHere(words, words.here[place], "linux", "workstation", "America/Los_Angeles"), job: words.job, projectNote: words.projectNote, identityNote: words.identityNote } as BotKit
  return botInstructions(kit, "Mira", "/home/someone/.kuvo-code/bots/bot_0123456789", personality, "/home/someone/projects/storefront", {
    line: "Keeps the build green",
    section: "Keeps the build green: checks CI every morning, fixes what broke, and tells me what it couldn't.",
  })
}
const bot = [told("mac"), told("machine")].sort((a, b) => b.length - a.length)[0]!

// A bot's seat in a group chat it leads, with two others.
const seatBot = (id: string, name: string): SeatBot => ({ id, name, job: "Keeps the build green", instructions: "Checks CI every morning.", memoryFile: `/home/someone/.kuvo-code/bots/${id}/MEMORY.md`, folder: `/home/someone/.kuvo-code/bots/${id}` })
const [mira, ada, ben] = [seatBot("bot_mira", "Mira"), seatBot("bot_ada", "Ada"), seatBot("bot_ben", "Ben")]
const seat = seatInstructions(mira, { name: "Launch", purpose: "Planning the launch." } as Group, [ada, ben], mira, personality, words.identityNote)

// What each agent kind carries, on every call.
const carried = {
  "an engine session": tokens(schemas) + tokens(queueWords) + tokens(sandboxNote),
  "an engine session on Autopilot": tokens(schemas) + tokens(queueWords) + tokens(sandboxNote) + tokens(AUTOPILOT_WORDS),
  "an engine bot": tokens(schemas) + tokens(queueWords) + tokens(sandboxNote) + tokens(bot),
  "a Claude Code bot": tokens(names) + tokens(queueWords) + tokens(bot),
  "a Codex bot": tokens(schemas) + tokens(queueWords) + tokens(bot) + tokens(ASKING_WORDS),
  "a Cursor, Grok or Antigravity bot": tokens(schemas) + tokens(queueWords) + tokens(bot),
  "a bot's seat in a group chat": tokens(seat),
}
// (The Work Queue's eight tools and their line, #243, came to about 1,250 tokens once trimmed from
// 2,130: what every agent kind carries now to keep work items in the queue, not a file. #393's
// GitHub items added ~220 to them, and #553 ~50 to what a bot is told, past six budgets; #579
// trimmed both back.)
const budget: Record<keyof typeof carried, number> = {
  "an engine session": 2_950,
  "an engine session on Autopilot": 3_200,
  "an engine bot": 5_400,
  "a Claude Code bot": 2_650,
  "a Codex bot": 4_600,
  "a Cursor, Grok or Antigravity bot": 4_550,
  "a bot's seat in a group chat": 650,
}

// Each kind on its own, so one past its budget doesn't hide another (#579: one hid five).
for (const kind of Object.keys(budget) as (keyof typeof budget)[]) {
  test(`what ${kind} carries of the box's own words, on every call, stays within its budget of ${budget[kind]} tokens`, () => {
    expect({ kind, tokens: carried[kind] }).toEqual({ kind, tokens: Math.min(carried[kind], budget[kind]) })
  })
}

test("a bot in a project is told how to leave it, its identity note and all", () => {
  // The project note goes ahead of the identity note, which is found as the words' last paragraph:
  // a trim of one and not the other would leave project bots without it.
  expect(words.instructions.at(-1)).toBe(words.identityNote)
  expect(bot).toContain(`${words.projectNote}\n\n${words.identityNote}`)
})
