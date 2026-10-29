// Agents writing to each other (PROTOCOL.md, "Agents' tools")
// Any conversation on any of your computers can ask who else there is (list_agents), write to one of
// them (send_message), read one's conversation (read_conversation) and start a session
// (start_session), and run the sessions it started as you would (list_sessions, stop_session,
// answer_ask, list_models, make_project, list_projects: `work/tools.ts`, PROTOCOL.md "Work"). Every box answers them alike (`POST kuvo/agent-tools`): this Mac's app and a
// machine's kuvo-browser.js only pass the call on. A message reaches its conversation as input that
// says who sent it, and the agent there takes it up; with `wait`, the sender gets its answer back.
// One on another computer goes there by mail (PROTOCOL.md, "Peers"). You name one with "&".

import { HERE, IS_MAC } from "../home";
import { readKit } from "../bots/kit";
import { listBots } from "../bots/list";
import { asked } from "../engine/client";
import { messageID } from "../engine/sessions";
import { macMoving } from "../host-interface";
import { keepOwn, ownAgents, ownAsLast } from "../peers/agents";
import { composeAgents, isPutAway, peerOf, readPeerAgents } from "../peers/directory";
import { movedOf, peersOf } from "../peers/known";
import { readLink } from "../state";
import { excerpt, folded, READ_BY_MAIL, READ_LIMIT, readConversation } from "./conversation";
import { letterAnswer, leaveLetter, offRelay } from "./leave";
import { composeLetter, placeOfSession } from "./letter";
import { allowed, takeBack } from "./limits";
import { OUTSIDE, seatRefusal, startedWords, startSession } from "./start";
import { answerTo } from "./take";
import { answerAskTool, listModelsTool, listProjectsTool, listSessionsTool, makeProjectTool, stopSessionTool } from "../work/tools";
import type { ListedAgent, Target } from "../../shared/records";
import type { SessionPlace } from "./letter";

/** What a tool says back to its agent: its words, and whether it didn't do what was asked. */
export interface ToolAnswer {
  text: string;
  isError: boolean;
}

/** Where a tool's call is answered: the engine here and the coding agents' bridge while it runs,
 * until its asker goes (`signal`); `step`, between looks for an answer (ms; a test's are short). */
export interface ToolPlace {
  readEngine: () => Target;
  bridge: () => Target | null;
  signal?: AbortSignal;
  step?: number;
}

/** The tools, by name. */
export const AGENT_TOOLS = ["list_agents", "send_message", "read_conversation", "start_session", "list_sessions", "stop_session", "answer_ask", "list_models", "make_project", "list_projects"] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];
export const isAgentTool = (name: unknown): name is AgentToolName => AGENT_TOOLS.includes(name as AgentToolName);

const said = (text: string): ToolAnswer => ({ text, isError: false });
const refused = (text: string): ToolAnswer => ({ text, isError: true });
const why = (error: unknown) => String((error as Error | null)?.message ?? error);

/** Everyone a tool here can name: this box's own agents and its peers', and this box's name among
 * them (null on a Mac, whose agents name no machine). */
export interface Everyone {
  here: string | null;
  agents: ListedAgent[];
}

/** Where conversations here run: the engine, and the coding agents' bridge while it runs. */
export function targetsOf(place: Pick<ToolPlace, "readEngine" | "bridge">): Target[] {
  const targets: Target[] = [];
  try { targets.push(place.readEngine()); } catch {}
  const bridge = place.bridge();
  if (bridge) targets.push(bridge);
  return targets;
}

/** Everyone, as they are now: this box's own worked out again (as last worked out while its engine
 * can't say), then each peer's it alone lists. */
export async function everyone(place: Pick<ToolPlace, "readEngine">): Promise<Everyone> {
  const link = readLink();
  const fresh = await ownAgents(place.readEngine, link?.id).catch(() => null);
  if (fresh) keepOwn(fresh, link?.id ?? null);
  const here = IS_MAC ? null : link?.id ?? null;
  return { here, agents: composeAgents(fresh ?? ownAsLast(link?.id ?? null), here, peersOf(link), readPeerAgents(), movedOf(link)).agents };
}

/** The conversation a call works for, where it runs: itself, a subagent's (the one that started
 * it), and a coding agent's engine run (Auto's) the conversation it runs for (`kuvo.engineFor`). Null
 * where it isn't one here. */
export async function rootOf(session: string | null, targets: Target[]): Promise<{ session: string; place: SessionPlace } | null> {
  let id = session;
  let found: { session: string; place: SessionPlace } | null = null;
  for (let step = 0; id && step < 6; step++) {
    const place = await placeOfSession(id, targets).catch(() => null);
    if (!place) break;
    found = { session: id, place };
    const kuvo = place.data.metadata?.kuvo;
    const above = place.data.parentID ?? (typeof kuvo?.engineFor === "string" ? kuvo.engineFor : null);
    if (!above) break;
    id = above;
  }
  return found;
}

/** What an agent is, for one here to read: "bot, on the Mac", "session, here, in api", "session, on
 * lokum". */
export function whatAgent(agent: ListedAgent, here: string | null): string {
  const place = (agent.machine ?? null) === here ? (IS_MAC ? "on the Mac" : "here") : agent.machine ? `on ${agent.machine}` : "on the Mac";
  return `${agent.kind}, ${place}${agent.project ? `, in ${agent.project}` : ""}`;
}

/** The list, for an agent to read (not the one asking). */
export function describeAgents(agents: ListedAgent[], caller: string | null, here: string | null): string {
  const others = agents.filter(agent => agent.session !== caller);
  if (!others.length) return "No other agents yet.";
  const lines = others.map(agent => `- ${agent.name} (${whatAgent(agent, here)}) address: ${agent.session}${agent.about ? `: ${agent.about}` : ""}`);
  return "Agents you can write to with send_message, or whose conversation you can read with read_conversation (by name or address):\n" + lines.join("\n");
}

// A conversation here named by its address that the list doesn't (older than the latest it names):
// one an agent could be, not a subagent's, a group chat's seat, nor one put away.
async function addressed(wanted: string, targets: Target[], here: string | null): Promise<ListedAgent | null> {
  const place = await placeOfSession(wanted, targets).catch(() => null);
  if (!place || place.data.parentID || place.data.metadata?.kuvo?.seat || isPutAway(place.data)) return null;
  const bot = listBots(here ?? undefined).some(each => each.session === wanted);
  return { session: wanted, name: place.data.title || "New session", kind: bot ? "bot" : "session", ...(here ? { machine: here } : {}) };
}

// The agent `wanted` names (its address, or its name, with or without the "&" you name it with), or
// why there's none to take.
async function findAgent(wanted: string, caller: string | null, { agents, here }: Everyone, targets: Target[]): Promise<{ agent: ListedAgent } | { error: ToolAnswer }> {
  let name = wanted.trim();
  if (name.startsWith("&") && !agents.some(agent => agent.name === name)) name = name.slice(1);
  let matches = agents.filter(agent => agent.session === name);
  if (!matches.length && name.startsWith("ses_")) {
    const one = await addressed(name, targets, here);
    if (one) matches = [one];
  }
  if (!matches.length) matches = agents.filter(agent => folded(agent.name) === folded(name));
  if (!matches.length) {
    // Part of a name ("Release" for "Release notes"): those it could be.
    const close = agents.filter(agent => folded(agent.name).includes(folded(name))).slice(0, 8);
    const hint = close.length ? "Did you mean one of these?\n" + describeAgents(close, caller, here) : "Use list_agents to see who there is.";
    return { error: refused(`There's no agent called ${name}. ` + hint) };
  }
  if (matches.length > 1) return { error: refused(`More than one agent is called ${name}: use one's address.\n` + describeAgents(matches, caller, here)) };
  return { agent: matches[0] };
}

// Who a conversation is to the others: its name in the list, else where it is.
const nameOf = (caller: string | null, { agents, here }: Everyone) =>
  agents.find(agent => agent.session === caller)?.name ?? (IS_MAC ? "another agent" : `an agent on ${here ?? "a machine"}`);

// Why there's no waiting for an answer while this box is off the relay.
const offlineNote = () => `Your other computers can't be reached through the relay now: it goes once ${HERE}'s back on it, and its answer comes to you as a message.`;

// The box a conversation not here is on, among the peers.
function peerFor(session: string) {
  const link = readLink();
  const peers = peersOf(link);
  const told = readPeerAgents();
  const peer = peerOf(session, peers, told, movedOf(link));
  return peer ? { peer, features: told[peer.key]?.features ?? [] } : null;
}

// A message from `caller` to the agent `args.to` names, wherever it runs; with `wait`, its answer.
async function sendMessage(args: Record<string, unknown>, caller: string | null, all: Everyone, targets: Target[], place: ToolPlace): Promise<ToolAnswer> {
  if (typeof args.to !== "string" || !args.to.trim()) return refused("Say who to write to (to).");
  if (typeof args.text !== "string" || !args.text.trim()) return refused("Say what to write (text).");
  const { text } = args;
  const waits = args.wait === true;
  const found = await findAgent(args.to, caller, all, targets);
  if ("error" in found) return found.error;
  const target = found.agent;
  if (target.session === caller) return refused("That's you.");
  // Moving to another computer: once it's over, to it where it lives then.
  if (IS_MAC && (await macMoving(target.session).catch(() => false))) return refused(`${target.name} is moving to another computer. Try again in a minute.`);
  // A few at a time: two agents shouldn't keep writing to each other unattended. Taken back if it
  // doesn't go, so one tried again isn't counted twice.
  const key = caller ?? "outside";
  const counted = allowed("messages", key);
  if (counted === null) return refused("You've sent a lot of messages in the last few minutes. Wait a while, or ask the user how to go on.");
  const failed = (words: string) => {
    takeBack("messages", key, counted);
    return refused(words);
  };
  const sender = nameOf(caller, all);
  const here = await placeOfSession(target.session, targets).catch(() => null);
  if (here) {
    const id = messageID();
    try {
      await asked(here.target, "POST", `api/session/${encodeURIComponent(target.session)}/prompt`, { id, text: composeLetter(sender, caller ?? "unknown", text, waits), delivery: "steer" });
    } catch (error) {
      return failed(`It didn't reach ${target.name}: ${why(error)}`);
    }
    if (!waits) return said(`Sent to ${target.name}. Its answer, if it writes one, comes to you as a message.`);
    const answer = await answerTo(here.target, target.session, id, { wait: place.step, signal: place.signal });
    return said(answer ? `${target.name} answered:\n\n${answer}` : `${target.name} hasn't answered yet. It may still write back with send_message.`);
  }
  // On another of your computers: by mail. Without a conversation to answer, or off the relay,
  // there's no waiting for its answer.
  const away = peerFor(target.session);
  if (!away) return failed(`${target.name} can't be reached now. Try again later.`);
  const offline = offRelay();
  const wait = waits && Boolean(caller) && !offline;
  let id: string;
  try {
    id = leaveLetter({ from: caller, to: target.session, text, peer: away.peer.key, wait });
  } catch {
    return failed(`It didn't reach ${target.name}.`);
  }
  if (!wait) return said(waits && caller && offline ? offlineNote() : `On its way to ${target.name}${target.machine ? ` on ${target.machine}` : ""}. Its answer, if it writes one, comes to you as a message.`);
  const answer = await letterAnswer(id, place.signal, { step: place.step });
  if (answer && "failed" in answer) return failed(`It didn't reach ${target.name}: ${answer.failed}`);
  if (answer && "note" in answer) return said(answer.note);
  return said(answer?.text ? `${target.name} answered:\n\n${answer.text}` : `${target.name} hasn't answered yet. It may still write back with send_message.`);
}

// The conversation of the agent `args.of` names, as you'd read it; a long one as its start and its
// latest part; with `query`, the parts that mention it. One on another computer comes by mail from a
// box that shares them (`letters-read`).
async function readOne(args: Record<string, unknown>, caller: string | null, all: Everyone, targets: Target[], place: ToolPlace): Promise<ToolAnswer> {
  const of = typeof args.of === "string" ? args.of.trim() : "";
  if (!of) return refused("Say whose conversation to read (of).");
  const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : null;
  const found = await findAgent(of, caller, all, targets);
  if ("error" in found) return found.error;
  const target = found.agent;
  if (target.session === caller) return refused("That's this conversation: you have it already.");
  const intro = `${target.name}'s conversation (${whatAgent(target, all.here)}, address ${target.session}), oldest first. What's under **User** is the user's; under **${target.name}**, its agent's.\n\n`;
  const here = await placeOfSession(target.session, targets).catch(() => null);
  if (here) {
    try {
      return said(intro + excerpt(await readConversation(here.target, target.session, here.data, target.name, place.signal), query, READ_LIMIT));
    } catch (error) {
      return refused(`Couldn't read ${target.name}'s conversation: ${why(error)}`);
    }
  }
  const later = `${target.name}'s conversation can't be read now. Try again later, or write to it with send_message.`;
  const away = peerFor(target.session);
  if (!away || !caller || offRelay()) return refused(later);
  if (!away.features.includes("letters-read")) return refused(`${target.name}'s computer doesn't share its conversations yet (it runs an older Kuvo Code). Ask it what you need with send_message.`);
  let id: string;
  try {
    id = leaveLetter({ from: caller, to: target.session, text: query ?? "read", peer: away.peer.key, wait: true, read: query ? { query } : {} });
  } catch {
    return refused(later);
  }
  const answer = await letterAnswer(id, place.signal, { step: place.step, cut: READ_BY_MAIL });
  if (answer && "text" in answer) return said(intro + answer.text);
  if (answer && "failed" in answer) return refused(`Couldn't read ${target.name}'s conversation: ${answer.failed}`);
  return refused(later);
}

/** A tool's call (`name`, its `args`), from the conversation `session` (as the engine names it; null
 * from outside one): what it says back. */
export async function agentTool(name: AgentToolName, args: Record<string, unknown>, session: string | null, place: ToolPlace): Promise<ToolAnswer> {
  const targets = targetsOf(place);
  // A subagent writes, reads and starts sessions as its conversation: its name, its folder, its
  // approval, where answers go.
  const root = await rootOf(session, targets);
  const caller = root?.session ?? session;
  // A bot's seat in a group chat only talks and looks things up, whatever agent it runs on: the work
  // happens in each bot's own conversation, handed out after the wrap-up.
  if (root?.place.data.metadata?.kuvo?.seat && (name === "send_message" || name === "start_session")) return refused(seatRefusal().message);
  const all = await everyone(place);
  switch (name) {
    case "list_agents":
      return said(describeAgents(all.agents, caller, all.here));
    case "send_message":
      return sendMessage(args, caller, all, targets, place);
    case "read_conversation":
      return readOne(args, caller, all, targets, place);
    case "start_session": {
      // From a conversation this box doesn't have: an agent all the same, counted and approved as
      // one (`outside`).
      const by = root ? { ...root, name: nameOf(root.session, all) } : OUTSIDE;
      return startedWords(await startSession(args, by, { readEngine: place.readEngine, bridge: place.bridge, step: place.step, signal: place.signal }), args.wait === true);
    }
    case "list_models": {
      let engine: Target | null = null;
      try { engine = place.readEngine(); } catch {}
      return listModelsTool(engine, place.bridge(), place.signal);
    }
    case "list_projects":
      return listProjectsTool();
    case "make_project": {
      if (!root) return refused("Only a conversation on this computer makes projects here.");
      return makeProjectTool({ ...root, name: nameOf(root.session, all) }, args, { signal: place.signal, ...(place.step ? { every: place.step } : {}) });
    }
    case "list_sessions":
    case "stop_session":
    case "answer_ask": {
      // Only a conversation here has sessions of its own.
      if (!root) return refused("Only a conversation on this computer has sessions of its own.");
      const caller = { ...root, name: nameOf(root.session, all) };
      if (name === "list_sessions") return listSessionsTool(caller, targets, place.signal);
      if (name === "stop_session") return stopSessionTool(caller, args, targets, place.signal);
      return answerAskTool(caller, args, targets, place.signal);
    }
  }
}
