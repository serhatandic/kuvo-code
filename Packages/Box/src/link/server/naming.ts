// @ts-nocheck
// "&" in a prompt that goes to the engine
// The agents a prompt names with "&" are told at its end (peers/naming), as this box lists
// everyone now (`run/agents.json`).

import fs from "node:fs";
import { refreshOwn } from "../peers/agents";
import { AGENTS_FILE } from "../peers/directory";
import { graphemes, nameAgents, namesIn, wordCharacter } from "../peers/naming";

// A prompt's body with the agents its text names with "&" told at its end (`naming(text, session)`),
// as this box lists everyone now; any other body as it is.
export async function namedIn(body, session, naming) {
  if (!naming) return body;
  let prompt;
  try { prompt = JSON.parse(Buffer.from(body ?? "").toString()); } catch { return body; }
  if (typeof prompt?.text !== "string" || !prompt.text.includes("&")) return body;
  const text = await naming(prompt.text, session).catch(() => prompt.text);
  return text === prompt.text ? body : Buffer.from(JSON.stringify({ ...prompt, text }));
}

// Who a message from a phone names with "&", for `forward`: everyone as this box lists them now,
// at once, and where it is; its own worked out again meanwhile, and waited for (two seconds at most)
// only when a name after "&" isn't there yet (one made a moment ago). One working out at a time.
let refreshingOwn = null;
export const refreshOwnShared = readEngine => (refreshingOwn ??= refreshOwn(readEngine).catch(() => {}).finally(() => { refreshingOwn = null; }));
// That working out, done (what a test waits for before it removes its folders).
export const ownRefreshed = () => refreshingOwn ?? Promise.resolve();
// Everyone, as this box lists them now (`run/agents.json`), and its name there.
export function listedAgents() {
  try {
    const read = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    return { machine: read?.machine ?? null, agents: Array.isArray(read?.agents) ? read.agents : [] };
  } catch {
    return { machine: null, agents: [] };
  }
}
export function namingHere(readEngine) {
  return async (text, session) => {
    let everyone = listedAgents();
    const working = refreshOwnShared(readEngine);
    if (nameMissing(text, everyone.agents)) {
      await Promise.race([working, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
      everyone = listedAgents();
    }
    return nameAgents(text, { excluding: session, here: everyone.machine, agents: everyone.agents });
  };
}

// Whether `text` names with "&" someone `agents` don't have: an "&" starting a word, with none of
// their names after it, whole ("&Miranda" isn't "&Mira").
// (Its characters as `namesIn` reads them: what's before an "&" is a whole character.)
export function nameMissing(text, agents) {
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