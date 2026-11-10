// What this Mac's app asks of its box's link (`kuvo/link/…`)
// Whether it's wanted and how it's doing, its phones and documents, your machines, and the letters
// and agents of this Mac's conversations.

import fs from "node:fs";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import type { Body } from "../../shared/json";
import { macDocsChanged, receiveDocs } from "../documents/exchange";
import { ownSign, SIGN } from "../documents/format";
import { digestOf, ownDocs, pruneDocs } from "../documents/work";
import { readEngineFile } from "../engine/client";
import { locked, writePrivate } from "../files";
import { followed } from "../follow";
import { IS_MAC } from "../home";
import { cutText, LETTER_ID, LETTER_MEMORY, LETTERS_SEEN, SENDING } from "../letters/letter";
import { lettersSeen } from "../letters/take";
import { refreshOwn } from "../peers/agents";
import { keptFeatures, PEER_LOCK, readPeerAgents } from "../peers/directory";
import { cleanMoved, cleanPeer, fitsPeer, KEY, MOST_PEERS, ownKey, peersOf } from "../peers/known";
import { readPersonalities } from "../personalities/library";
import { macLink, readLink, updateLink } from "../state";
import { macKeys, macLinkCheck, tellGone } from "./link";
import { noteKeyNow } from "../setup/lead";
import { macSendOutbox } from "./peers";
import type { SignedDoc } from "../../shared/documents";
import type { Peer } from "../peers/known";
import type { AnswerPiece, LinkRequest, RouteContext } from "../server/context";
import type { LinkState, Phone } from "../state";

/** The phones as this Mac's app keeps a copy of them (`kuvo/link/phones` and its events): each
 * phone, each removal, and whether Settings › Phone's pairing link is still waiting. */
export interface MacPhones {
  phones: Phone[];
  removed: { key: string; pairing: string }[];
  pairing: boolean;
}

/** Your machines as this Mac's app last said (`setMacPeers`): link.json to write, or null for what
 * wasn't a list; and the peers it removed now (`gone`), to tell they're let go. */
export interface MacPeersSet {
  link: LinkState | null;
  gone: Peer[];
}

// The phones as the app keeps a copy of them (all of each, with where it is, and every removal),
// and whether Settings › Phone's pairing link is still waiting (a phone came in with it, or it ran
// out: it's done).
const macPhones = (): MacPhones => {
  const link = readLink();
  return {
    phones: link?.phones ?? [],
    removed: link?.removed ?? [],
    pairing: Boolean(link?.appPairing && Date.now() < link.appPairing.expires),
  };
};

// Your machines this Mac set up (over SSH), as its app says: those that sign their documents, each
// `{key, sign, address, name, id}`; the conversations being moved, `{session, key}` each; and the
// machines you removed, by key (`removed`): its peers document names them so they let this Mac go,
// and they hear that once. One just missing from the list (it can't be reached to be set up, say)
// isn't a peer now, and nothing more; one set up again is no longer removed. One that isn't a
// machine's record is left out (a line in the box's log says so), never the rest with it. No link
// for what isn't a list.
export function setMacPeers(link: LinkState, given: unknown): MacPeersSet {
  if (!isObject(given) || !Array.isArray(given.peers)) return { link: null, gone: [] };
  const now = given.peers.slice(0, MOST_PEERS).map(peer => ({ ...peer, kind: "machine" }))
    .filter(peer => fitsPeer(peer) && typeof peer.sign === "string" && SIGN.test(peer.sign)).map(cleanPeer);
  const skipped = Math.min(given.peers.length, MOST_PEERS) - now.length;
  if (skipped) console.error(`${skipped} of this Mac's machines weren't records the box could take, and were left out.`);
  const removed = (Array.isArray(given.removed) ? given.removed : []).filter((key: unknown): key is string => typeof key === "string" && KEY.test(key) && !now.some(peer => peer.key === key));
  const gone = peersOf(link).filter(peer => removed.includes(peer.key));
  const kept = (Array.isArray(link.left) ? link.left : []).filter(key => !now.some(peer => peer.key === key) && !removed.includes(key));
  link.left = [...kept, ...removed].slice(-64);
  link.macPeers = now;
  link.macMoved = cleanMoved(given.moved);
  pruneDocs(link);
  return { link, gone };
}


// `kuvo/link/…`, for this Mac's app.
export async function* macLinkRoute(route: string, request: LinkRequest, signal: AbortSignal | undefined): AsyncGenerator<AnswerPiece> {
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const method = request.method.toUpperCase();
  switch (route) {
    case "kuvo/link/config": {
      if (method !== "PUT") return yield* json(405, {});
      const given = parsed(request.body) as Body<"relay" | "phones" | "machines" | "name" | "app" | "features">;
      let relay = null;
      try { relay = given?.relay ? new URL(String(given.relay)) : null; } catch {}
      if (!isObject(given) || typeof given.phones !== "boolean" || typeof given.machines !== "boolean" || !relay || !["ws:", "wss:"].includes(relay.protocol)) {
        return yield* json(400, { message: "Say whether the phone link is on (phones) and there are machines (machines), and the relay." });
      }
      const config = { phones: given.phones, machines: given.machines, relay: relay.toString().replace(/\/$/, ""), name: String(given.name ?? "Mac").slice(0, 100), app: String(given.app ?? ""),
        ...(Array.isArray(given.features) ? { features: keptFeatures(given.features) } : {}) };
      const before = macLink.config;
      macLink.config = config;
      if (macLink.overlay) macLink.overlay = { ...macLink.overlay, relay: config.relay, name: config.name };
      // Phones not let in any more (the phone link off) lose what they have open; another relay
      // means another connection.
      if (!config.phones) macLink.host?.keepOnly(new Set());
      if (before && (before.relay !== config.relay || before.name !== config.name)) macLink.host?.disconnect?.();
      // Its keys before this answers, so a pairing link can be made right after.
      await macKeys();
      macLinkCheck();
      macLink.wake?.();
      // The phone link on or off: this Mac's phones document comes, or stops changing.
      if (before?.phones !== config.phones) macDocsChanged();
      return yield* json(200, macLink.status);
    }
    case "kuvo/link/status":
      if (method !== "GET") return yield* json(405, {});
      return yield* json(200, macLink.status);
    case "kuvo/link/status/events":
      if (method !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => macLink.status, macLink.statusFollowers, signal);
    case "kuvo/link/phones":
      if (method !== "GET") return yield* json(405, {});
      return yield* json(200, macPhones());
    case "kuvo/link/phones/events":
      if (method !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(macPhones, macLink.phoneFollowers, signal);
    case "kuvo/link/peers": {
      if (method !== "PUT") return yield* json(405, {});
      let gone: Peer[] = [];
      const changed = updateLink(link => {
        const made = setMacPeers(link ?? { phones: [] }, parsed(request.body));
        gone = made.gone;
        return made.link;
      });
      if (!changed) return yield* json(400, { message: "Send {peers: [{key, sign, address, name, id}], moved}." });
      macDocsChanged();
      tellGone(gone);
      return yield* json(200, {});
    }
    case "kuvo/link/setup": {
      // What setting up a machine over SSH gives it: this Mac's key, the key its documents are
      // signed with, its own documents as they are now and those it keeps of your machines.
      if (method !== "GET") return yield* json(405, {});
      await macKeys();
      // `?key=`: a machine set up again, no longer one this Mac removed.
      const again = new URLSearchParams(String(request.path ?? "").split("?")[1] ?? "").get("key");
      const library = readPersonalities();
      let docs: SignedDoc[] = [];
      const link = updateLink(link => {
        if (!link?.sign) return null;
        if (again && Array.isArray(link.left)) link.left = link.left.filter(key => key !== again);
        noteKeyNow(link);
        const own = ownDocs({ link, library });
        docs = [...Object.values(own).map(made => made.envelope), ...Object.values(link.docs ?? {}).sort((a, b) => (a.d < b.d ? -1 : 1))];
        return link;
      });
      if (!link) return yield* json(503, { message: "This Mac's link has no keys yet." });
      // (And the keys this Mac had before, made anew since, for the machine to let go.)
      return yield* json(200, { mac: ownKey(link), macSign: ownSign(link), docs, replaces: link.keysBefore ?? [] });
    }
    case "kuvo/link/docs": {
      // Documents a machine gave as it was set up (over SSH): taken as if they'd come by mail.
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body) as Body<"from" | "docs">;
      const sender = peersOf(readLink()).find(peer => peer.key === given?.from);
      // (One of its machines is `from`, so there's a body.)
      if (!sender || !isObject(given!.docs)) return yield* json(404, { message: "That isn't one of this Mac's machines." });
      await receiveDocs(sender, given!.docs, macLink.host);
      return yield* json(200, {});
    }
    case "kuvo/link/documents": {
      // This Mac's documents, its own brought up to date first, and its digest (what its agents'
      // mail carries, so a machine that missed one gets it).
      if (method !== "GET") return yield* json(405, {});
      const library = readPersonalities();
      updateLink(link => {
        if (!link?.sign) return null;
        const before = JSON.stringify(link.own ?? {});
        ownDocs({ link, library });
        return JSON.stringify(link.own ?? {}) === before ? null : link;
      });
      const link = readLink();
      return yield* json(200, { own: link?.own ?? {}, held: link?.docs ?? {}, views: link?.views ?? {}, left: link?.left ?? [], have: link?.sign ? digestOf(link) : [] });
    }
    // COMPAT(beta.1 mac-letters): the letters an earlier Kuvo Code kept (`agent-letters.json`), into the outbox. Goes 3 months after 0.8.0.
    case "kuvo/link/letters/take": {
      // What an earlier Kuvo Code kept itself (PhoneLink, before this Mac's box took its peers): its
      // letters on their way, and the letters it had delivered (so one sent again isn't twice).
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body) as Body<"letters" | "seen">;
      if (!isObject(given)) return yield* json(400, { message: "Send {letters, seen}." });
      const now = Date.now();
      try {
        fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
        for (const letter of Array.isArray(given.letters) ? given.letters.slice(0, 500) : []) {
          if (!isObject(letter) || !LETTER_ID.test((letter.id ?? "") as string) || typeof letter.to !== "string" || typeof letter.text !== "string" || typeof letter.peer !== "string") continue;
          const kept = { from: typeof letter.from === "string" ? letter.from : null, to: letter.to, text: cutText(letter.text), wait: false,
            at: typeof letter.at === "number" ? letter.at : now, peer: letter.peer, ...(typeof letter.answers === "string" ? { answers: letter.answers } : {}) };
          writePrivate(path.join(SENDING, `${letter.id}.json`), JSON.stringify(kept));
        }
        if (isObject(given.seen)) {
          locked(PEER_LOCK, () => {
            const seen = lettersSeen(now);
            for (const [id, at] of Object.entries(given.seen as Record<string, unknown>)) if (LETTER_ID.test(id) && typeof at === "number" && now - at < LETTER_MEMORY) seen[id] = Math.max(seen[id] ?? 0, at);
            writePrivate(LETTERS_SEEN, JSON.stringify(seen));
          });
        }
      } catch {
        return yield* json(500, { message: "This Mac's box couldn't keep them." });
      }
      macSendOutbox();
      return yield* json(200, {});
    }
    case "kuvo/link/agents/refresh": {
      // The list of everyone made again from this Mac's conversations as they are now (one made a
      // moment ago), before a group chat here names someone with &.
      if (method !== "POST") return yield* json(405, {});
      await refreshOwn(readEngineFile).catch(() => {});
      return yield* json(200, {});
    }
    case "kuvo/link/agents": {
      // The agents your other computers told this Mac of, by computer (its key, and its id here).
      if (method !== "GET") return yield* json(405, {});
      const link = readLink();
      const told = readPeerAgents();
      return yield* json(200, { peers: peersOf(link).map(peer => ({ key: peer.key, id: peer.id ?? null, at: told[peer.key]?.at ?? 0,
        list: told[peer.key]?.list ?? [], features: told[peer.key]?.features ?? [] })) });
    }
    default:
      return yield* json(404, {});
  }
}

// This Mac's box's link, for its app alone (PROTOCOL.md, "This Mac's box: the relay").
export async function* linkRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, route, json } = context;
  if (!IS_MAC || !request.fromApp) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
  return yield* macLinkRoute(route, request, signal);
}
