// Agents on other boxes (PROTOCOL.md, "Peers")
// Each box tells its peers who its agents are (its bots, its latest titled sessions), and keeps
// what each told it, for list_agents here (`run/agents.json`, which kuvo-browser.js reads): those
// files, and what's kept of each agent.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { locked, writePrivate } from "../files";
import { RUN } from "../home";
import { KEY } from "./known";
import type { AgentsFile, ListedAgent, ToldAgents } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";
import { type BotLook, LOOKS as LOOK_WORDS } from "../../shared/routes/bots";
import type { Peer } from "./known";

export const PEER_AGENTS_FILE = path.join(RUN, "peer-agents.json");
// COMPAT(beta.1 mac-agents): what a Mac connected over SSH said its agents were, for when the relay couldn't be reached; no Mac writes it now, and it's removed. Goes 3 months after 0.8.0.
export const MAC_AGENTS_FILE = path.join(RUN, "mac-agents.json");
export const AGENTS_FILE = path.join(RUN, "agents.json");

export const PEER_LOCK = path.join(RUN, ".peers.lock");

const MOST_AGENTS = 120;

/** An agent as another box gave it, once `fitsAgent` has checked its session, name and kind: the
 * rest is cleaned as it's kept (`keptAgent`). */
export interface GivenAgent {
  session: string;
  name: string;
  kind: "bot" | "session";
  id?: unknown;
  look?: unknown;
  project?: unknown;
  about?: unknown;
  machine?: unknown;
}

/** A conversation as the engine (or the agents bridge) lists it, as far as whether it's put away. */
export type PutAwayable = Pick<Partial<EngineSession>, "metadata" | "time">;

export const fitsAgent = (agent: unknown): agent is GivenAgent => isObject(agent) && typeof agent.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(agent.session)
  && typeof agent.name === "string" && (agent.kind === "bot" || agent.kind === "session");
// A bot's `id` too (`bot_…`, as group chats name their members), and how it looks (`look`: color,
// shape, face), so a chat on another computer can have it and show it.
// Only colors, shapes and faces the apps draw (BotLook, its words in shared/routes/bots): another (a
// newer computer's) is the plain one's, so a phone can always read it.
const LOOKS: { [Part in keyof BotLook]: readonly string[] } = { color: LOOK_WORDS.colors, shape: LOOK_WORDS.shapes, face: LOOK_WORDS.faces };
const PLAIN_LOOK: BotLook = { color: "graphite", shape: "round", face: "calm" };
const keptLook = (look: unknown): BotLook | undefined => (isObject(look)
  ? Object.fromEntries((Object.keys(LOOKS) as (keyof BotLook)[]).map(key => [key, LOOKS[key].includes(look[key] as string) ? look[key] as string : PLAIN_LOOK[key]])) as unknown as BotLook : undefined);
export const keptAgent = ({ session, name, kind, project, about, machine, id, look }: GivenAgent): ListedAgent => ({ session, name: plainName(name).slice(0, 200), kind,
  ...(kind === "bot" && typeof id === "string" && /^bot_[A-Za-z0-9]{1,60}$/.test(id) ? { id } : {}),
  ...(kind === "bot" && keptLook(look) ? { look: keptLook(look) } : {}),
  ...(typeof project === "string" && project ? { project: project.slice(0, 200) } : {}), ...(typeof about === "string" && about ? { about: about.slice(0, 500) } : {}),
  ...(typeof machine === "string" && machine ? { machine: machine.slice(0, 200) } : {}) });
// What a peer says it answers (`features`, as kuvo/info's), kept with its agents: 300 names at most
// (80 before bridge 0.9.210, fewer than a Mac's box answers now).
export const keptFeatures = (features: unknown): string[] => (Array.isArray(features) ? features.filter((each): each is string => typeof each === "string" && each.length <= 60).slice(0, 300) : []);

// The conversations a peer says it moved away, and where each lives now (PROTOCOL.md, "Peers").
const keptMoved = (moved: unknown[]): NonNullable<ToldAgents["moved"]> => moved.filter((each): each is { session: string; key: string; at: number } => isObject(each)
  && typeof each.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each.session) && typeof each.key === "string" && KEY.test(each.key) && typeof each.at === "number").slice(0, 400)
  .map(({ session, key, at }) => ({ session, key, at }));

// What a peer said its agents are, the newest it said: false for an older list.
export function takeAgents(sender: { key: string; kind: "mac" | "machine"; id?: string }, given: unknown, file = PEER_AGENTS_FILE, lock = PEER_LOCK): boolean {
  if (!isObject(given) || typeof given.at !== "number" || !Array.isArray(given.list)) return false;
  return locked(lock, () => {
    let all: Record<string, ToldAgents> = {};
    try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if ((given.at as number) <= (all[sender.key]?.at ?? 0)) {
      // (Older by its clock, which may have been set right: heard all the same.)
      if (all[sender.key]) {
        all[sender.key].heard = Date.now();
        writePrivate(file, JSON.stringify(all));
      }
      return false;
    }
    all[sender.key] = { at: given.at as number, heard: Date.now(), kind: sender.kind, ...(sender.id ? { id: sender.id } : {}), list: (given.list as unknown[]).filter(fitsAgent).slice(0, MOST_AGENTS).map(keptAgent),
      ...(Array.isArray(given.features) ? { features: keptFeatures(given.features) } : {}), ...(Array.isArray(given.moved) ? { moved: keptMoved(given.moved) } : {}) };
    writePrivate(file, JSON.stringify(all));
    return true;
  });
}

// What each peer told, by its key, as it last said it by mail.
export function readPeerAgents(file = PEER_AGENTS_FILE): Record<string, ToldAgents> {
  let all: Record<string, ToldAgents> = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
  return all;
}

// The box a session is on, among the peers: where the box that moved it says it went (or a Mac
// says, `movedOf`), else the one that lists it. One listed by more than one is a Mac's when a Mac lists it, else nobody's (one of them
// could be claiming another's).
export function peerOf(session: string, peers: Peer[], told: Record<string, ToldAgents>, moved = new Map<string, string>()): Peer | null {
  if (moved.has(session)) return peers.find(peer => peer.key === moved.get(session)) ?? null;
  const listing = peers.filter(peer => (told[peer.key]?.list ?? []).some(agent => agent.session === session));
  if (listing.length <= 1) return listing[0] ?? null;
  const macs = listing.filter(peer => peer.kind === "mac");
  return macs.length === 1 ? macs[0] : null;
}

// Put away: archived, as a Mac archives one (`kuvo.archived` in its metadata) or the engine does.
export const isPutAway = (session: PutAwayable | null | undefined) => session?.metadata?.["kuvo.archived"] === true || Boolean(session?.metadata?.kuvo?.archived) || Boolean(session?.time?.archived);

// Everyone, for list_agents here: this box's own (`machine` its name on its Macs), then each peer's
// it alone lists (`peerOf`): a machine's by its name; a Mac's its own (none), and the agents of
// machines it speaks for (those whose link doesn't talk to other computers yet), by theirs.
export function composeAgents(own: ListedAgent[], ownID: string | null, peers: Peer[], told: Record<string, ToldAgents>, moved = new Map<string, string>()): AgentsFile {
  const agents: ListedAgent[] = own.map(agent => ({ ...keptAgent({ ...agent, machine: undefined }), ...(ownID ? { machine: ownID } : {}) }));
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
