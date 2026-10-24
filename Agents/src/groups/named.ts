// Who a message to a group chat names with "&", worked out on the computer the chat lives on, for
// every client alike: the block at the end of what the bots are told, naming each agent the words
// name, with its address and what it is, so a bot can read that conversation or write to it. The
// same block, and the same words, as the Mac's composer adds to a session's message
// (AgentReferences.swift).
//
// The agents there are to name are the box's own and those its other computers told it of, as its
// link writes them (`run/agents.json` on a machine; on the Mac, the file the app gives in
// KUVO_AGENTS_FILE, the same shape).

import { readFileSync } from "node:fs"

export interface NamedAgent {
  session: string
  name: string
  kind: string
  /** Where it lives: a machine's id, or none for the Mac. */
  machine?: string | null
  project?: string | null
  about?: string | null
}

const start = "<named-agents>"
const end = "</named-agents>"
const heading =
  "Agents the user named with & in this message, by their address. Read one's conversation with read_conversation only when what the user asks needs what it knows or did, and write to it with send_message only to ask it something or hand it work; when the user only mentions one, do neither:"

/** The agents file as the link writes it: which computer this is, and the agents there are. */
export function readDirectory(file: string | undefined): { machine: string | null; agents: NamedAgent[] } {
  if (!file) return { machine: null, agents: [] }
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    const agents: NamedAgent[] = Array.isArray(value?.agents)
      ? value.agents.filter((agent: any) => agent && typeof agent.session === "string" && agent.session.startsWith("ses_") && typeof agent.name === "string" && agent.name)
      : []
    return { machine: typeof value?.machine === "string" ? value.machine : null, agents }
  } catch {
    return { machine: null, agents: [] }
  }
}

/** A name or text as names are matched: any case, any accents. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
const isWordCharacter = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}]/u.test(character)

/**
 * The agents `text` names with "&", each once, in the order they're first named; not those in
 * `excluding` (the chat's own bots, already there). Longer names win ("&Miranda" isn't "&Mira");
 * the "&" starts a word, and the name ends where a word does. Of two with the same name, the first
 * the list has (its bots, then the latest sessions).
 */
export function namedIn(text: string, agents: NamedAgent[], excluding: Set<string> = new Set()): NamedAgent[] {
  if (!text.includes("&")) return []
  const byName = new Map<string, NamedAgent>()
  for (const agent of agents) {
    if (excluding.has(agent.session)) continue
    const key = fold(agent.name)
    if (key && !byName.has(key)) byName.set(key, agent)
  }
  const folded = fold(text)
  const found: { at: number; to: number; agent: NamedAgent }[] = []
  for (const [key, agent] of [...byName].sort((a, b) => b[0].length - a[0].length)) {
    const needle = "&" + key
    let from = 0
    for (;;) {
      const at = folded.indexOf(needle, from)
      if (at < 0) break
      from = at + needle.length
      const to = at + needle.length
      if (isWordCharacter(folded[at - 1]) || isWordCharacter(folded[to])) continue
      if (found.some((each) => at < each.to && each.at < to)) continue
      found.push({ at, to, agent })
    }
  }
  const named: NamedAgent[] = []
  for (const { agent } of found.sort((a, b) => a.at - b.at)) if (!named.includes(agent)) named.push(agent)
  return named
}

/** What an agent is, for one on the computer `here` (null: the Mac) to read: "bot, on the Mac", "session, here, in api". */
export function what(agent: NamedAgent, here: string | null): string {
  const machine = agent.machine ?? null
  const place = machine === here ? (here === null ? "on the Mac" : "here") : machine === null ? "on the Mac" : `on ${machine}`
  return `${agent.kind}, ${place}` + (agent.project ? `, in ${agent.project}` : "")
}

/** The block for the agents `text` names, undefined for none. */
export function namedBlock(text: string, directory: { machine: string | null; agents: NamedAgent[] }, excluding: Set<string> = new Set()): string | undefined {
  const named = namedIn(text, directory.agents, excluding)
  if (!named.length) return undefined
  const lines = named.map((agent) => `- &${agent.name} (${agent.session}): ${what(agent, directory.machine)}` + (agent.about ? `: ${agent.about}` : ""))
  return [start, heading, ...lines, end].join("\n")
}
