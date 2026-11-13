// "&" in a prompt that goes to the engine
// The agents a prompt names with "&" are told at its end (peers/naming), as this box lists
// everyone now (`run/agents.json`).

import fs from "node:fs";
import { refreshOwn } from "../peers/agents";
import { AGENTS_FILE } from "../peers/directory";
import { graphemes, nameAgents, namesIn, wordCharacter } from "../peers/naming";
import type { AgentsFile, ListedAgent, Target } from "../../shared/records";
import type { NameableAgent } from "../peers/naming";

/** A prompt's text with the agents it names with "&" told at its end (`namingHere`), for the
 * conversation it goes to (left out of who's named). */
export type Naming = (text: string, session: string) => Promise<string>;

// A prompt's body with the agents its text names with "&" told at its end (`naming(text, session)`),
// as this box lists everyone now; any other body as it is.
export async function namedIn(body: Buffer | undefined, session: string, naming: Naming | null): Promise<Buffer | undefined> {
  if (!naming) return body;
  let prompt: { text?: unknown } | null;
  try { prompt = JSON.parse(Buffer.from(body ?? "").toString()); } catch { return body; }
  if (typeof prompt?.text !== "string" || !prompt.text.includes("&")) return body;
  const text = await naming(prompt.text, session).catch(() => prompt.text);
  return text === prompt.text ? body : Buffer.from(JSON.stringify({ ...prompt, text }));
}

// Who a message from a phone names with "&", for `forward`: everyone as this box lists them now,
// at once, and where it is; its own worked out again meanwhile, and waited for (two seconds at most)
// only when a name after "&" isn't there yet (one made a moment ago). One working out at a time.
let refreshingOwn: Promise<ListedAgent[] | null | void> | null = null;
export const refreshOwnShared = (readEngine: () => Target): Promise<ListedAgent[] | null | void> => (refreshingOwn ??= refreshOwn(readEngine).catch(() => {}).finally(() => { refreshingOwn = null; }));
// That working out, done (what a test waits for before it removes its folders).
export const ownRefreshed = (): Promise<ListedAgent[] | null | void> => refreshingOwn ?? Promise.resolve();
// Everyone, as this box lists them now (`run/agents.json`), and its name there.
export function listedAgents(): AgentsFile {
  try {
    const read: Partial<AgentsFile> | null = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    return { machine: read?.machine ?? null, agents: Array.isArray(read?.agents) ? read.agents : [] };
  } catch {
    return { machine: null, agents: [] };
  }
}
export function namingHere(readEngine: () => Target): Naming {
  return async (text, session) => {
    const everyone = await everyoneFor(text, readEngine);
    return nameAgents(text, { excluding: session, here: everyone.machine, agents: everyone.agents });
  };
}

// Everyone "&" can name in `text`, as this box lists them now, and its name there: its own worked
// out again meanwhile, and waited for (two seconds at most) only when a name in it, or one `picked`
// from the list (by its session), isn't there yet (one made a moment ago).
export async function everyoneFor(text: string, readEngine: () => Target, picked: string[] = []): Promise<AgentsFile> {
  const everyone = listedAgents();
  const working = refreshOwnShared(readEngine);
  const listed = new Set(everyone.agents.map(agent => agent.session));
  if (!nameMissing(text, everyone.agents) && picked.every(session => listed.has(session))) return everyone;
  await Promise.race([working, new Promise<void>(resolve => setTimeout(resolve, 2000).unref?.())]);
  return listedAgents();
}

// Whether `text` names with "&" someone `agents` don't have: an "&" starting a word, with none of
// their names after it, whole ("&Miranda" isn't "&Mira").
// (Its characters as `namesIn` reads them: what's before an "&" is a whole character.)
export function nameMissing(text: string, agents: NameableAgent[]): boolean {
  if (!text.includes("&")) return false;
  const references = agents.map(agent => ({ name: String(agent.name ?? ""), session: agent.session }));
  const named = new Set(namesIn(text, references).map(each => each.lower));
  const characters = graphemes(text);
  for (let i = 0; i < characters.length; i++) {
    const { segment, index } = characters[i];
    if (segment !== "&" || named.has(index)) continue;
    if (wordCharacter.test(characters[i - 1]?.segment ?? "")) continue;
    const next = characters[i + 1]?.segment;
    if (next && !/^\s/u.test(next)) return true;
  }
  return false;
}