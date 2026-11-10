// This box's agents, as its peers hear of them (PROTOCOL.md, "Peers")
// Who this box's agents are (its bots, its latest titled sessions), told to its peers as that
// changes, and written with what they told into `run/agents.json` (what a Mac that's gone told,
// forgotten).

import fs from "node:fs";
import path from "node:path";
import { FEATURES } from "../../shared/features";
import { processRuns as runs } from "../../shared/platform";
import { boxProjects } from "../areas/projects";
import { readKit } from "../bots/kit";
import { listBots } from "../bots/list";
import { currentDigest } from "../documents/work";
import { readBridgeFile } from "../engine/client";
import { locked, textOf, writePrivate } from "../files";
import { IS_MAC, K } from "../home";
import { awaySessions, movedAway } from "../moves/records";
import { macLink, readLink } from "../state";
import { AGENTS_FILE, composeAgents, fitsAgent, isPutAway, keptAgent, MAC_AGENTS_FILE, PEER_AGENTS_FILE, PEER_LOCK, readPeerAgents } from "./directory";
import { mailFor, movedOf, peersOf } from "./known";
import { tellSeatPeers } from "./seats";
import type { BotKit } from "../bots/kit";
import type { DigestEntry } from "../documents/work";
import type { EngineSession } from "../engine/sessions";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { AgentsFile, BridgeRecord, ListedAgent, Target, ToldAgents } from "../../shared/records";

/** What this box last told a peer of its agents (`announce`): all of them as JSON, when, and the
 * sessions that fit in that mail. */
export interface ToldPeer {
  json: string;
  at: number;
  sessions: Set<string>;
}

// What peers only `mac` named told this box, and what that Mac said over SSH, gone with it.
export function forgetMacsAgents(mac: string, link: LinkState | null): void {
  const keep = new Set(peersOf(link).map(peer => peer.key));
  locked(PEER_LOCK, () => {
    let all: Record<string, ToldAgents> = {};
    try { all = JSON.parse(fs.readFileSync(PEER_AGENTS_FILE, "utf8")); } catch { return; }
    for (const key of Object.keys(all)) if (!keep.has(key)) delete all[key];
    writePrivate(PEER_AGENTS_FILE, JSON.stringify(all));
  });
  try { if (JSON.parse(fs.readFileSync(MAC_AGENTS_FILE, "utf8"))?.key === mac) fs.rmSync(MAC_AGENTS_FILE, { force: true }); } catch {}
  writeAgents(link);
}

// This box's own agents: its bots, then its latest sessions, its engine's and its coding
// agents' (not a bot's, a subagent's, a group chat's seat, nor one put away), as the Mac lists its
// own: one without a title is "New session", and a chat's project is "Chats". Null when its engine
// can't say (then what it last said stands).
export async function ownAgents(readEngine: () => Target, machine?: string, kit: BotKit | null = readKit(), readBridge: () => BridgeRecord = readBridgeFile): Promise<ListedAgent[] | null> {
  // Not what doesn't live here (a copy a move brought, not switched to yet; an original going).
  const away = new Set(awaySessions());
  const bots = listBots(machine).filter(bot => !away.has(bot.session)).map(bot => ({ session: bot.session, name: bot.name, kind: "bot" as const, id: bot.id, ...(bot.job ? { about: bot.job } : {}), ...(bot.look ? { look: bot.look } : {}) }));
  const botSessions = new Set(bots.map(bot => bot.session));
  const sessionsOf = async (target: Target): Promise<EngineSession[]> => {
    const response = await fetch(`http://127.0.0.1:${target.port}/api/session?parentID=null&limit=100&order=desc`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`It answered ${response.status}.`);
    // (As the engine and the agents' bridge answer it: their sessions, each whole.)
    return ((await response.json()) as { data?: EngineSession[] } | null)?.data ?? [];
  };
  let sessions: EngineSession[];
  try { sessions = await sessionsOf(readEngine()); } catch { return null; }
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents")) sessions = sessions.concat(await sessionsOf(bridge));
  } catch {}
  const projects = boxProjects(kit);
  const named = (directory: string | undefined): string | undefined => projects.find(project => project.directory === directory)?.name
    ?? (directory === path.join(K, "chats") ? "Chats" : directory ? path.basename(directory) : undefined);
  const recent = sessions
    .filter(session => !session.parentID && !botSessions.has(session.id) && !away.has(session.id) && !session.metadata?.kuvo?.seat && !isPutAway(session))
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, 40)
    .map(session => ({ session: session.id, name: session.title || "New session", kind: "session" as const, ...(named(session.location?.directory ?? session.directory) ? { project: named(session.location?.directory ?? session.directory) } : {}) }));
  return [...bots, ...recent].map(keptAgent);
}

// This box's own agents, as last worked out (`refreshOwn`), for `run/agents.json`.
let ownList: ListedAgent[] | null = null;
let ownMachine: string | null = null;
// Each working out's turn, and the latest one kept: one begun earlier, answered later, is older.
let refreshes = 0, keptRefresh = 0;
// Them, as just worked out elsewhere (`kuvo/named`), on box `machine`.
export function keepOwn(list: ListedAgent[], machine: string | null): void {
  ownList = list;
  keptRefresh = refreshes;
  ownMachine = machine;
}

// This box's own agents as last worked out: since it started, else as `run/agents.json` last had
// them (`ownID`: this box's name there).
export function ownAsLast(ownID: string | null): ListedAgent[] {
  if (ownList) return ownList;
  try { return ((JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8")) as Partial<AgentsFile> | null)?.agents ?? []).filter(agent => fitsAgent(agent) && (agent.machine ?? null) === ownID); } catch { return []; }
}

// Writes `run/agents.json`: this box's agents and its peers'. Its own as last written while it
// can't say yet (its engine starting), rather than none.
export function writeAgents(link: LinkState | null = readLink()): void {
  // COMPAT(beta.1 mac-agents): a Mac's list over SSH, no longer read. Goes 3 months after 0.8.0.
  fs.rmSync(MAC_AGENTS_FILE, { force: true });
  const ownID = ownMachine ?? link?.id ?? null;
  const own = ownAsLast(ownID);
  const composed = composeAgents(own, ownID, peersOf(link), readPeerAgents(), movedOf(link));
  try {
    const text = JSON.stringify(composed);
    if (textOf(AGENTS_FILE) !== text) writePrivate(AGENTS_FILE, text);
  } catch {}
  // Who can be in its group chats from your other computers, as they told it.
  tellSeatPeers(link).catch(() => {});
}

// This box's own agents, worked out again, and `run/agents.json` with them, relay or not.
export async function refreshOwn(readEngine: () => Target, link: LinkState | null = readLink()): Promise<ListedAgent[] | null> {
  // (This Mac's box lists its agents with its link off too: its group chats name them.)
  if (!link?.key && !IS_MAC) return ownList;
  ownMachine = link?.id ?? null;
  const turn = ++refreshes;
  const list = await ownAgents(readEngine, link?.id);
  if (list && turn > keptRefresh) {
    ownList = list;
    keptRefresh = turn;
  }
  writeAgents(link);
  return ownList;
}

// What this box answers, as its agents' mail says (`kuvo/info`'s features): on a Mac, its app's
// list, as the app gives it (`kuvo/link/config`).
const ownFeatures = (): readonly string[] => (IS_MAC && Array.isArray(macLink.config?.features) ? macLink.config.features : FEATURES);

// The names a box from before the lists were in order checks of its peers (moves, calls, letters
// and group chats' seats). Such a box keeps only the first 80 names a peer's mail gives
// (`keptFeatures`), and in order there are more before some of these: so they go first. Boxes now
// keep many more, so a name added later needn't be here. This goes once no box from bridge 0.9.211
// or before is left: three months after the release that brings it.
const CHECKED_BY_OLDER_PEERS = ["groups.seats", "letters-read", "moves", "moves.agents", "moves.check", "work.elsewhere"];

/** `features` as this box's mail gives them: those older boxes check of a peer first. */
export const mailedFeatures = (features: readonly string[]): string[] =>
  [...CHECKED_BY_OLDER_PEERS.filter(name => features.includes(name)), ...features.filter(name => !CHECKED_BY_OLDER_PEERS.includes(name))];

// Tells each peer this box's agents: when they change, and every ten minutes, with a digest of
// its documents to each that takes them, so one that missed what was given gets it then (PROTOCOL.md,
// "Documents"). `told` remembers what went to whom, and when. `ask`: just connected, so each is
// told, and asked for theirs.
export const toldPeers = new Map<string, ToldPeer>();
export async function announce(host: Pick<LinkHost, "send">, readEngine: () => Target, link: LinkState | null = readLink(), now = Date.now(), ask = false): Promise<void> {
  if (!link?.key) return;
  await refreshOwn(readEngine, link);
  if (!ownList) return;
  // With the conversations it moved away lately, and where each lives now.
  const moved = movedAway(now).map(({ session, key, at }) => ({ session, key, at }));
  const json = JSON.stringify([ownList, moved]);
  let have: DigestEntry[] | false | null = null;
  for (const peer of peersOf(link)) {
    const last = toldPeers.get(peer.key);
    if (!ask && last && last.json === json && now - last.at < 600_000) continue;
    // Not as it connects: `docsChanged` greets each with its digest then.
    if (have === null) have = ask ? false : currentDigest();
    const docs = peer.sign && have ? { docs: { have } } : {};
    // As many as fit in one mail: the first (bots, then the latest sessions) first.
    let bytes: Buffer | null = null, sent: ListedAgent[] = [];
    for (const count of [ownList.length, Math.floor(ownList.length / 2), Math.floor(ownList.length / 4)]) {
      sent = ownList.slice(0, count);
      bytes = mailFor(peer, { agents: { at: now, list: sent, features: mailedFeatures(ownFeatures()), moved }, ...docs, at: now, ...(ask ? { ask: "agents" } : {}) }, link);
      if (bytes) break;
    }
    if (!bytes) continue;
    try {
      host.send(bytes);
      toldPeers.set(peer.key, { json, at: now, sessions: new Set(sent.map(agent => agent.session)) });
    } catch {}
  }
}