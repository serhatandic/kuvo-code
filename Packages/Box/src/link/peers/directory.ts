// @ts-nocheck
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
import { readLink } from "../state";
import { macsOf } from "./known";

export const PEER_AGENTS_FILE = path.join(RUN, "peer-agents.json");
// What a Mac connected over SSH says its agents are (as it mails them), for when the relay can't
// be reached.
export const MAC_AGENTS_FILE = path.join(RUN, "mac-agents.json");
export const AGENTS_FILE = path.join(RUN, "agents.json");

export const PEER_LOCK = path.join(RUN, ".peers.lock");

const MOST_AGENTS = 120;

export const fitsAgent = agent => isObject(agent) && typeof agent.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(agent.session)
  && typeof agent.name === "string" && (agent.kind === "bot" || agent.kind === "session");
// A bot's `id` too (`bot_…`, as group chats name their members), and how it looks (`look`: color,
// shape, face), so a chat on another computer can have it and show it.
// Only colors, shapes and faces the apps draw (BotLook): another (a newer computer's) is the plain
// one's, so a phone can always read it.
const LOOKS = {
  color: ["mint", "sky", "indigo", "violet", "pink", "coral", "orange", "amber", "lime", "graphite"],
  shape: ["round", "squircle", "pebble", "gem", "bloom"],
  face: ["calm", "happy", "sleepy", "wink", "curious", "bright"],
};
const PLAIN_LOOK = { color: "graphite", shape: "round", face: "calm" };
const keptLook = look => (isObject(look)
  ? Object.fromEntries(Object.keys(LOOKS).map(key => [key, LOOKS[key].includes(look[key]) ? look[key] : PLAIN_LOOK[key]])) : undefined);
export const keptAgent = ({ session, name, kind, project, about, machine, id, look }) => ({ session, name: plainName(name).slice(0, 200), kind,
  ...(kind === "bot" && typeof id === "string" && /^bot_[A-Za-z0-9]{1,60}$/.test(id) ? { id } : {}),
  ...(kind === "bot" && keptLook(look) ? { look: keptLook(look) } : {}),
  ...(typeof project === "string" && project ? { project: project.slice(0, 200) } : {}), ...(typeof about === "string" && about ? { about: about.slice(0, 500) } : {}),
  ...(typeof machine === "string" && machine ? { machine: machine.slice(0, 200) } : {}) });
// What a peer says it answers (`features`, as kuvo/info's), kept with its agents.
export const keptFeatures = features => (Array.isArray(features) ? features.filter(each => typeof each === "string" && each.length <= 60).slice(0, 80) : []);

// What a peer said its agents are, the newest it said: false for an older list.
export function takeAgents(sender, given, file = PEER_AGENTS_FILE, lock = PEER_LOCK) {
  if (!isObject(given) || typeof given.at !== "number" || !Array.isArray(given.list)) return false;
  return locked(lock, () => {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (given.at <= (all[sender.key]?.at ?? 0)) return false;
    all[sender.key] = { at: given.at, kind: sender.kind, ...(sender.id ? { id: sender.id } : {}), list: given.list.filter(fitsAgent).slice(0, MOST_AGENTS).map(keptAgent),
      ...(Array.isArray(given.features) ? { features: keptFeatures(given.features) } : {}) };
    writePrivate(file, JSON.stringify(all));
    return true;
  });
}

// What each peer told, by its key; a Mac's as it last said it, by mail or over SSH, whichever's newer.
export function readPeerAgents(file = PEER_AGENTS_FILE, macFile = MAC_AGENTS_FILE, link = null) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
  try {
    const given = JSON.parse(fs.readFileSync(macFile, "utf8"));
    const macs = macsOf(link ?? readLink() ?? {});
    if (macs.includes(given?.key) && typeof given.at === "number" && Array.isArray(given.list) && given.at > (all[given.key]?.at ?? 0)) {
      all[given.key] = { at: given.at, kind: "mac", list: given.list.filter(fitsAgent).slice(0, MOST_AGENTS).map(keptAgent) };
    }
  } catch {}
  return all;
}

// The box a session is on, among the peers: the one a Mac says it moved to, else the one that
// lists it. One listed by more than one is a Mac's when a Mac lists it, else nobody's (one of them
// could be claiming another's).
export function peerOf(session, peers, told, moved = new Map()) {
  if (moved.has(session)) return peers.find(peer => peer.key === moved.get(session)) ?? null;
  const listing = peers.filter(peer => (told[peer.key]?.list ?? []).some(agent => agent.session === session));
  if (listing.length <= 1) return listing[0] ?? null;
  const macs = listing.filter(peer => peer.kind === "mac");
  return macs.length === 1 ? macs[0] : null;
}

// Put away: archived, as a Mac archives one (`kuvo.archived` in its metadata) or the engine does.
export const isPutAway = session => session?.metadata?.["kuvo.archived"] === true || Boolean(session?.metadata?.kuvo?.archived) || Boolean(session?.time?.archived);

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
