// What this box keeps of its link in `run/link.json` (PROTOCOL.md, "Pairing"; only you can read it):
// its keys and relay, the Macs that set it up, the documents it holds, its phones. One change at a
// time, from this process and from `setup` and `pair` (other processes), under a lock.
//
// Nothing here knows what follows a change: the box says that once, as it starts
// (`onLinkWritten`), and how a link.json an earlier bridge left is read (`readLinkWith`).

import fs from "node:fs";
import path from "node:path";
import type { SignedDoc } from "../shared/documents";
import { locked } from "./files";
import { IS_MAC, LINK_FILE, RUN } from "./home";

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
  /** The Macs that set it up, the last first named in `mac`; their signing keys, and when each was last heard from (ms). */
  mac?: string;
  macs?: string[];
  macSigns?: Record<string, string>;
  macSeen?: Record<string, number>;
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
}

// This Mac's box's link (`runMacLink`): what its app said (`kuvo/link/config`), its keys from the
// app once it has them (with the relay and name, `overlay`, never written), how it stands, and who
// follows that and its phones.
const MAC_OVERLAY = ["key", "secret", "sign", "relay", "name"];
export const macLink: {
  config: any;
  overlay: Partial<LinkState> | null;
  status: { state: string; reason?: string };
  host: any;
  wake: (() => void) | null;
  statusFollowers: Set<() => void>;
  phoneFollowers: Set<() => void>;
} = { config: null, overlay: null, status: { state: "off" }, host: null, wake: null, statusFollowers: new Set(), phoneFollowers: new Set() };

let readAs: (link: any) => any = link => link;
/** How the box reads what an earlier bridge wrote (said once, as it starts). */
export const readLinkWith = (read: (link: any) => any) => {
  readAs = read;
};
let written: (link: LinkState) => void = () => {};
/** What follows each write (said once, as the box starts). */
export const onLinkWritten = (then: (link: LinkState) => void) => {
  written = then;
};

export function readLink(): LinkState | null {
  let link = null;
  try {
    link = readAs(JSON.parse(fs.readFileSync(LINK_FILE, "utf8")));
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
  written(link);
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
