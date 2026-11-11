// What this box keeps of its link in `run/link.json` (PROTOCOL.md, "Pairing"; only you can read it):
// its keys and relay, the Macs that set it up, the documents it holds, its phones. One change at a
// time, from this process and from `setup` and `pair` (other processes), under a lock.
//
// Nothing here knows what follows a change: the box says that as it starts (`onLinkWritten`).

import fs from "node:fs";
import path from "node:path";
import type { SignedDoc } from "../shared/documents";
import { isObject } from "../shared/json";
import { SIGN } from "./documents/format";
import { locked } from "./files";
import { IS_MAC, LINK_FILE, RUN } from "./home";
import type { NoticeHold } from "./notices/hold";
import type { Peer } from "./peers/known";
import type { LinkHost } from "./relay/host";
import type { SetupRecord } from "./setup/record";

/** A phone this box lets in (PROTOCOL.md, "Paired phones"). */
export interface Phone {
  key: string;
  name?: string;
  added?: number;
  /** Paired here, or listed by one of its Macs (`mac`, that Mac's key). */
  from?: "pair" | "mac";
  mac?: string;
  /** Where it is on the relay, for its notifications. */
  address?: string;
  pairing?: string;
}

/** A pairing link waiting: its token, good until `expires` (ms). */
export interface Pairing {
  token: string;
  expires: number;
}

export interface LinkState {
  relay?: string;
  secret?: string;
  /** Its static key, and its signing key's seed (base64url). */
  key?: string;
  sign?: string;
  name?: string;
  /** Its id on its Macs (their name for this machine). */
  id?: string;
  /** The Macs that set it up, the last first named in `mac`; their signing keys, and when each was
   * last heard from (ms), moved on by the time this machine was off since (`noteOnline`). */
  mac?: string;
  macs?: string[];
  macSigns?: Record<string, string>;
  macSeen?: Record<string, number>;
  /** Each Mac's name, as its setup said it: who else uses this box, to say so. */
  macNames?: Record<string, string>;
  /** The documents it holds, by origin and kind; how far its own are, and the views it's met. */
  docs?: Record<string, SignedDoc>;
  own?: Record<string, { n: number; h: string; b: string }>;
  views?: Record<string, { n: number; h: string }>;
  phones?: Phone[];
  removed?: { key: string; pairing: string }[];
  /** A phone's pairing link, and (this Mac's) the one Settings › Phone shows. */
  pairing?: Pairing;
  appPairing?: Pairing;
  /** Machines a Mac removed, for this Mac's peers document. */
  left?: string[];
  /** Whether each Mac that started its engine leaves a newer box as it is, by the Mac's id. */
  tolerantIDs?: Record<string, boolean>;
  // COMPAT(beta.1 peers-list): a Mac that signs no documents yet, its peers as it listed them. Goes when 0.8.0 ships.
  legacy?: Record<string, { at: number; peers: unknown[]; moved: unknown[] }>;
  macPeers?: unknown;
  macMoved?: unknown;
  /** Machines this Mac removed that haven't heard it yet (they hear it once it's back on the relay). */
  untold?: Peer[];
  /** The setup it's in, and its role there (PROTOCOL.md, "Your setup"). */
  setup?: SetupRecord;
  /** This Mac's static key as its box last had it, and the ones before (made anew since): a machine
   * this Mac sets up again lets those go (`replaces` in setup). */
  keyNow?: string;
  keysBefore?: string[];
  /** The #181 switch, as you set it (none: it follows the role, `startsFromOthers`). */
  startsFromOthers?: "on" | "off";
}

// This Mac's box's link (`runMacLink`): what its app said (`kuvo/link/config`, or as the box kept
// it, mac/link.ts), its keys from the app once it has them (with the relay and name, `overlay`,
// never written in link.json), how it stands, and who follows that and its phones.
const MAC_OVERLAY = ["key", "secret", "sign", "relay", "name"];
/** What this Mac's app says of its box's link (`kuvo/link/config`): whether the phone link is on
 * and there are machines to meet, the relay, this Mac's name and its app's version. */
export interface MacLinkConfig {
  phones: boolean;
  machines: boolean;
  relay: string;
  name: string;
  app: string;
}

export const macLink: {
  config: MacLinkConfig | null;
  overlay: Partial<LinkState> | null;
  status: { state: "off" | "connecting" | "connected" | "failed"; reason?: string };
  host: LinkHost | null;
  /** The notices this Mac's box holds while you're at a computer (its link's). */
  hold?: NoticeHold;
  /** Stopped for good (a test's, as it ends): the link's loop goes. */
  stopped?: boolean;
  /** Stops this Mac's box's part among your other computers (`runMacPeers`). */
  stopPeers?: (() => void) | null;
  wake: (() => void) | null;
  statusFollowers: Set<() => void>;
  phoneFollowers: Set<() => void>;
} = { config: null, overlay: null, status: { state: "off" }, host: null, wake: null, statusFollowers: new Set(), phoneFollowers: new Set() };

const written: ((link: LinkState) => void)[] = [];
/** What follows each write, from now on (the box says it as it starts). */
export const onLinkWritten = (then: (link: LinkState) => void) => {
  written.push(then);
};

// COMPAT(beta.1 peers-list): a Mac that gave no signing key signs no documents. Goes when 0.8.0 ships.
// The signing key a Mac of this box's gave in setup, over SSH; null for one that gave none yet (a
// Mac with Kuvo Code 0.8.0-beta.1, PROTOCOL.md "For released Macs").
export const macSign = (link: LinkState | null | undefined, mac: string): string | null => (typeof link?.macSigns?.[mac] === "string" && SIGN.test(link.macSigns[mac]) ? link.macSigns[mac] : null);

// COMPAT(beta.1 peers-list): link.json as the bridge beta.1 put on machines (0.9.23) left it. Goes when 0.8.0 ships.
// link.json as an earlier bridge left it: each Mac's list it had (`peersFrom`) kept as that Mac's
// word until it signs a document; what lists passed on and their dates needed, gone.
function migratedLink(link: any) {
  // (Read as it was left, whatever its shape.)
  if (!isObject(link as unknown) || !(link.peersFrom || link.vouched || link.macAts)) return link;
  for (const [mac, given] of Object.entries(link.peersFrom ?? {})) {
    if (!macSign(link, mac) && isObject(given)) {
      link.legacy ??= {};
      link.legacy[mac] ??= { at: given.at ?? 0, peers: Array.isArray(given.peers) ? given.peers : [], moved: given.moved ?? [] };
    }
  }
  delete link.peersFrom;
  delete link.vouched;
  delete link.macAts;
  return link;
}

export function readLink(): LinkState | null {
  let link = null;
  try {
    link = migratedLink(JSON.parse(fs.readFileSync(LINK_FILE, "utf8")));
  } catch {}
  // This Mac's: its keys from its app (kept in your Keychain, never in a file here), and its relay
  // and name as its app says, beside what the file keeps.
  if (IS_MAC && macLink.overlay) return { phones: [], ...(link ?? {}), ...macLink.overlay };
  return link;
}

export function writeLink(link: LinkState) {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const temporary = `${LINK_FILE}.${process.pid}.tmp`;
  // This Mac's keys and what its app says stay out of the file.
  const kept = IS_MAC ? Object.fromEntries(Object.entries(link).filter(([key]) => !MAC_OVERLAY.includes(key))) : link;
  fs.writeFileSync(temporary, JSON.stringify(kept, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, LINK_FILE);
  for (const then of written) then(link);
}

// One change to link.json at a time, here and from `setup` and `pair` (other processes): read,
// changed and written under a lock (run/.link.lock), so none writes over another's (a removal,
// say). `change` returns the link to write, or nothing to leave it. A lock left by one that was
// cut off goes after ten seconds; one not had in three goes ahead all the same.
const LOCK = path.join(RUN, ".link.lock");
export function updateLink(change: (link: LinkState | null) => LinkState | null | undefined | void): LinkState | null {
  return locked(LOCK, () => {
    const changed = change(readLink());
    if (changed) writeLink(changed);
    return changed ?? null;
  });
}
