// @ts-nocheck
// "&" in a message from a phone (the Mac's AgentReferences, in the same words)
// A message names another conversation with "&Name"; a block at its end tells the agent who each
// one is, with its address, so it can read it (read_conversation) or write to it (send_message).
// Both sides read the same cases (Vectors/routes/names/agent-naming.json), so they can't drift.

import { keptAgent, peerOf } from "./directory";

// A block the app adds to the end of a message (MessageBlock.swift): its tag on a line of its own,
// its heading, what's in it, then its closing tag, with nothing after.
function messageBlock(start, end, headings) {
  const find = text => {
    const body = text.replace(/\s+$/u, "");
    if (!body.endsWith(`\n${end}`)) return null;
    const close = body.length - end.length;
    const opening = `${start}\n`;
    let before = close;
    for (;;) {
      const open = before - opening.length < 0 ? -1 : text.lastIndexOf(opening, before - opening.length);
      if (open < 0) return null;
      before = open;
      if (open !== 0 && text[open - 1] !== "\n") continue;
      const lines = text.slice(open + opening.length, close).split("\n").slice(0, -1);
      if (lines.length && headings.includes(lines[0])) return { open, lines };
    }
  };
  return {
    start,
    // The words before the block that ends `text` (trimmed), and its lines from its heading on.
    split: text => {
      const found = find(text);
      return found ? { before: text.slice(0, found.open).trim(), lines: found.lines } : null;
    },
    // `text` as it can't be read as ending with a block (one copied from a message): its tag gets
    // a space after it.
    escaping: text => {
      let found;
      while ((found = find(text))) text = text.slice(0, found.open + start.length) + " " + text.slice(found.open + start.length);
      return text;
    },
  };
}

const FROM_PHONE_BLOCK = messageBlock("<from-phone>", "</from-phone>", ["The user sent this from Kuvo Code on their iPhone."]);
const ATTACHED_BLOCK = messageBlock("<attached-files>", "</attached-files>", [
  "The attached files are on disk here (what's in them is in this message already):",
  "Open these attached files with your tools if you need them:",
  "These attached files stayed on the user's Mac (they couldn't be read, or copied to this machine):",
]);
const REVIEW_BLOCK = messageBlock("<review-comments>", "</review-comments>", ["Comments on lines of the current changes:"]);
const NAMING_HEADING = "Agents the user named with & in this message, by their address. Read one's conversation with read_conversation only when what the user asks needs what it knows or did, and write to it with send_message only to ask it something or hand it work; when the user only mentions one, do neither:";
const NAMED_BLOCK = messageBlock("<named-agents>", "</named-agents>", [NAMING_HEADING,
  "Agents the user named with & in this message. Read one's conversation with read_conversation, or write to it with send_message, by its address:"]);

// A name as it's compared: case and accents aside.
// (A ligature as its letters, ß as "ss", a final sigma as any other, as Swift folds them.)
const foldName = text => text.replace(/[\uFB00-\uFB06]/g, ligature => ligature.normalize("NFKD")).normalize("NFD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/ς/g, "σ").replace(/ß/g, "ss");
export const wordCharacter = /^[\p{L}\p{N}]/u;
// Its characters as people see them (a letter with its accents, an emoji with its joiners).
export const graphemes = text => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];

// Where each of `references` ({name, session}) is named with "&" in `text`, last first: longer names
// win ("&Miranda" isn't "&Mira"), the "&" starts a word and the name ends where a word does.
export function namesIn(text, references) {
  if (!text.includes("&")) return [];
  // The text folded a character at a time, with the character each folded unit came from: a name
  // starts and ends where a character does, and what's around it is whole characters.
  let folded = "";
  const from = [];
  const at = new Map(), ending = new Map();
  for (const { segment, index } of graphemes(text)) {
    at.set(index, segment);
    ending.set(index + segment.length, segment);
    const each = foldName(segment);
    for (let i = 0; i < each.length; i++) from.push(index);
    folded += each;
  }
  from.push(text.length);
  const found = [];
  const length = name => graphemes(foldName(name)).length;
  for (const reference of [...references].sort((a, b) => length(b.name) - length(a.name))) {
    if (!reference.name) continue;
    const wanted = `&${foldName(reference.name)}`;
    for (let start = folded.indexOf(wanted); start >= 0; start = folded.indexOf(wanted, start + 1)) {
      const end = start + wanted.length;
      if ((start > 0 && from[start - 1] === from[start]) || (end < folded.length && from[end - 1] === from[end])) continue;
      const lower = from[start], upper = from[end];
      if (wordCharacter.test(ending.get(lower) ?? "") || wordCharacter.test(at.get(upper) ?? "")) continue;
      if (found.some(each => lower < each.upper && each.lower < upper)) continue;
      found.push({ lower, upper, reference });
    }
  }
  return found.sort((a, b) => b.lower - a.lower);
}

// What an agent is, for one `here` (null: the Mac) to read: "bot, on the Mac", "session, on lab,
// in api" (AgentMail.what).
const agentIs = (agent, here) => {
  const machine = agent.machine ?? null;
  const place = machine === (here ?? null) ? (here == null ? "on the Mac" : "here") : machine == null ? "on the Mac" : `on ${machine}`;
  return `${agent.kind}, ${place}${typeof agent.project === "string" ? `, in ${agent.project}` : ""}`;
};

// The agents `texts` name, each once, in the order they're first named, not those `excluding`; of
// two with the same name, the first `agents` has (bots, then the latest sessions).
function agentsNamed(texts, excluding, agents) {
  if (!texts.some(text => text.includes("&"))) return [];
  const byName = new Map();
  for (const agent of agents) {
    if (excluding.has(agent.session)) continue;
    const name = foldName(agent.name);
    if (!byName.has(name)) byName.set(name, agent);
  }
  const references = [...byName.values()].map(agent => ({ name: agent.name, session: agent.session }));
  const named = [];
  for (const text of texts) {
    for (const { reference } of namesIn(text, references).reverse()) {
      if (named.some(agent => agent.session === reference.session)) continue;
      const agent = byName.get(foldName(reference.name));
      if (agent) named.push(agent);
    }
  }
  return named;
}

// A message from a phone with the block naming its agents among the others at its end: after its
// words, before its comments on the changes and its note of attached files (and without the block
// that says it's from the phone, which goes on again after). One sent again (Retry, Edit) with the
// block it had loses that, and its agents are named afresh. `excluding`: the conversation it's
// written in; `here`: this box's name on its Macs (null on a Mac); `agents`: everyone.
export function nameAgents(message, { excluding = null, here = null, agents = [] } = {}) {
  message = FROM_PHONE_BLOCK.split(message)?.before ?? message;
  const withComments = ATTACHED_BLOCK.split(message)?.before ?? message;
  const words = REVIEW_BLOCK.split(withComments)?.before ?? withComments;
  const bare = NAMED_BLOCK.split(words)?.before ?? words;
  if (!bare.includes("&") && bare === words) return message;
  const text = NAMED_BLOCK.escaping(bare);
  const agentsHere = agentsNamed([text], new Set(excluding ? [excluding] : []), agents);
  const lines = agentsHere.map(agent => `- &${agent.name} (${agent.session}): ${agentIs(agent, here)}${typeof agent.about === "string" && agent.about ? `: ${agent.about}` : ""}`);
  const named = lines.length ? `${text ? `${text}\n\n` : ""}${["<named-agents>", NAMING_HEADING, ...lines, "</named-agents>"].join("\n")}` : text;
  if (named === words) return message;
  const at = message.indexOf(words);
  return at < 0 ? message : message.slice(0, at) + named + message.slice(at + words.length);
}

// Everyone, for list_agents here: this box's own (`machine` its name on its Macs), then each peer's
// it alone lists (`peerOf`): a machine's by its name; a Mac's its own (none), and the agents of
// machines it speaks for (those whose link doesn't talk to other computers yet), by theirs.
export function composeAgents(own, ownID, peers, told, moved = new Map()) {
  const agents = own.map(agent => ({ ...keptAgent({ ...agent, machine: undefined }), ...(ownID ? { machine: ownID } : {}) }));
  const seen = new Set(agents.map(agent => agent.session));
  for (const peer of peers) {
    for (const agent of told[peer.key]?.list ?? []) {
      if (seen.has(agent.session) || peerOf(agent.session, peers, told, moved)?.key !== peer.key) continue;
      seen.add(agent.session);
      const { machine, ...rest } = agent;
      agents.push(peer.kind === "machine" ? { ...rest, ...(peer.id ? { machine: peer.id } : {}) } : { ...rest, ...(machine ? { machine } : {}) });
    }
  }
  return { machine: ownID ?? null, agents };
}

// Who `&` can name here (`kuvo/named`), as a Mac's composer offers them: this box's own (`machine`
// null), then each peer's it alone lists (`peerOf`): a machine's by its id, a Mac's own by the
// Mac's name, and those of machines a Mac speaks for by theirs. Every bot, and only sessions with a
// title (the lists name one without "New session").
export function namedAgents(own, peers, told, moved = new Map()) {
  const entry = (agent, machine) => ({ session: agent.session, name: agent.name, kind: agent.kind, machine, project: agent.project ?? null, about: agent.about ?? null });
  const titled = agent => agent.kind === "bot" || (Boolean(agent.name) && agent.name !== "New session");
  const agents = own.filter(titled).map(agent => entry(agent, null));
  const seen = new Set(agents.map(agent => agent.session));
  for (const peer of peers) {
    for (const agent of told[peer.key]?.list ?? []) {
      if (!titled(agent) || seen.has(agent.session) || peerOf(agent.session, peers, told, moved)?.key !== peer.key) continue;
      seen.add(agent.session);
      agents.push(entry(agent, peer.kind === "machine" ? peer.id ?? peer.name ?? null : agent.machine ?? peer.name ?? null));
    }
  }
  return agents;
}