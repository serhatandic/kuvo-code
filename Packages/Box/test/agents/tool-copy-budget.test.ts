// What every call of an agent carries of the box's own words (#213): its vault and sandbox tools, the
// sandbox note the engine is given, what a bot is told and Codex's words on asking. Each agent kind
// has a budget, the size these came to once trimmed and a little more, so they can't creep back
// unnoticed. KuvoCodeTests' ToolCopyBudgetTests holds the app's tools and their instructions to the
// same. Tokens are counted as a UTF-8 byte in four, as the box counts them elsewhere (groups/rules.ts).
//
// Grown past one on purpose? Trim something else first; if it can't be, raise that budget here and
// say why in the commit.

import "../safety"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ASKING_WORDS } from "../../src/agents/agents/codex"
import { botInstructions, type BotKit } from "../../src/link/bots/kit"
import { SANDBOX_TOOLS } from "../../src/link/fence/outside"
import { agentsNote } from "../../src/link/fence/files"
import { VAULT_TOOLS } from "../../src/link/vault/tools"

const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4)

type Tool = { name: string; description: string; inputSchema: unknown }
const tools = [...VAULT_TOOLS, ...SANDBOX_TOOLS] as readonly Tool[]
// Each tool as a model gets it, under the server's name; and only their names, as Claude Code lists
// a deferred one until it looks it up.
const schemas = JSON.stringify(tools.map((tool) => ({ name: `kuvo-browser_${tool.name}`, description: tool.description, input_schema: tool.inputSchema })))
const names = tools.map((tool) => `mcp__kuvo-browser__${tool.name}`).join("\n")

// The longest the sandbox note gets: a Mac's, where tmux doesn't fit.
const sandboxNote = [agentsNote("darwin", false), agentsNote("darwin"), agentsNote("linux", false)].sort((a, b) => b.length - a.length)[0]!

// The longest a bot is told: one on a machine, in a project, with a personality and a job, as each
// box tells its bots from the words its release brings.
const words = JSON.parse(readFileSync(new URL("../../../KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), "utf8"))
function told(place: "mac" | "machine"): string {
  const here = words.here[place]
  const kit = {
    instructions: (words.instructions as string[]).join("\n\n").replace(/⟦(place|clock|browser)⟧/g, (_, key: string) => here[key])
      .replaceAll("⟦system⟧", "Linux machine").replaceAll("⟦machine⟧", "workstation").replaceAll("⟦timeZone⟧", "America/Los_Angeles"),
    job: words.job,
    projectNote: words.projectNote,
    identityNote: words.identityNote,
  } as BotKit
  const personality = words.personalityWords.replaceAll("⟦name⟧", words.personalities[0].name).replaceAll("⟦description⟧", words.personalities[0].description)
  return botInstructions(kit, "Mira", "/home/someone/.kuvo-code/bots/bot_0123456789", personality, "/home/someone/projects/storefront", {
    line: "Keeps the build green",
    section: "Keeps the build green: checks CI every morning, fixes what broke, and tells me what it couldn't.",
  })
}
const bot = [told("mac"), told("machine")].sort((a, b) => b.length - a.length)[0]!

test("what each agent kind carries of the box's own words, on every call, stays within its budget", () => {
  const carried = {
    "an engine session": tokens(schemas) + tokens(sandboxNote),
    "an engine bot": tokens(schemas) + tokens(sandboxNote) + tokens(bot),
    "a Claude Code bot": tokens(names) + tokens(bot),
    "a Codex bot": tokens(schemas) + tokens(bot) + tokens(ASKING_WORDS),
    "a Cursor, Grok or Antigravity bot": tokens(schemas) + tokens(bot),
  }
  const budget = {
    "an engine session": 1_700,
    "an engine bot": 4_100,
    "a Claude Code bot": 2_450,
    "a Codex bot": 3_300,
    "a Cursor, Grok or Antigravity bot": 3_250,
  }
  for (const kind of Object.keys(budget) as (keyof typeof budget)[]) expect({ kind, tokens: carried[kind] }).toEqual({ kind, tokens: Math.min(carried[kind], budget[kind]) })
})
