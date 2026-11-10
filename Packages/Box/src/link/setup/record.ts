// Your setup (PROTOCOL.md, "Your setup"): all of your computers that know each other, with one main
// computer, whose box signs who's in it. Here, what a box keeps of it (`setup` in link.json) and
// what a peers document says of it; `settle.ts` says what a box takes, `lead.ts` when a box leads one.

import crypto from "node:crypto";
import type { Doc } from "../../shared/documents";
import { isObject } from "../../shared/json";
import { docKey, held } from "../documents/format";
import { IS_MAC } from "../home";
import type { LinkState } from "../state";

/** A setup's id: `set_` and 16 random bytes, base64url. */
export const SETUP_ID = /^set_[A-Za-z0-9_-]{22}$/;
const STATIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/** What a peers document says of its setup: its id, its epoch (one more with each change of main
 * computer), and the main computer's static key. */
export interface SetupWord {
  id: string;
  epoch: number;
  primary: string;
}

/** What a box keeps of the setup it's in (link.json's `setup`): the setup's word, the main
 * computer's signing key, and its own role. `aside`: kept only so a lower epoch of it is never taken
 * (its main computer stopped naming it, or this box is shared with another Mac's, PROTOCOL.md "Your
 * setup", Shared machines), and followed for nothing else. `conflict`: another main computer named
 * at the same epoch, which this box didn't take. */
export interface SetupRecord extends SetupWord {
  sign: string;
  role: "primary" | "member";
  aside?: true;
  conflict?: { primary: string; epoch: number };
}

export const newSetupID = () => `set_${crypto.randomBytes(16).toString("base64url")}`;

/** The setup a peers document's body names, checked; null for none. */
export function setupOf(body: unknown): SetupWord | null {
  const setup = isObject(body) && isObject(body.setup) ? body.setup : null;
  if (!setup || typeof setup.id !== "string" || !SETUP_ID.test(setup.id) || !Number.isSafeInteger(setup.epoch) || (setup.epoch as number) < 1
    || typeof setup.primary !== "string" || !STATIC_KEY.test(setup.primary)) return null;
  return { id: setup.id, epoch: setup.epoch as number, primary: setup.primary };
}

/** The setup a peers document names, when its signer is that setup's main computer (the box it
 * names as `primary`, a Mac, signs with the key it was signed with): the only setup a document makes
 * a box take. Null for one that names none, or another's. */
export function ledSetup(doc: Doc | null | undefined): SetupWord | null {
  if (doc?.kind !== "peers") return null;
  const setup = setupOf(doc.body);
  if (!setup) return null;
  const boxes = Array.isArray(doc.body.boxes) ? doc.body.boxes : [];
  return boxes.some(box => isObject(box) && box.key === setup.primary && box.sign === doc.origin && box.kind === "mac") ? setup : null;
}

/** The setup this box follows now: its record, unless it's set aside. */
export const followedSetup = (link: LinkState | null | undefined): SetupRecord | null => (link?.setup && !link.setup.aside ? link.setup : null);

/** The setup document a member holds (its main computer's peers document), or null. */
export function setupDoc(link: LinkState | null | undefined): Doc | null {
  const setup = followedSetup(link);
  return setup?.role === "member" ? held(link!.docs?.[docKey(setup.sign, "peers")]) : null;
}

/** Whether a peers document goes back on the setup this box keeps: the same setup at a lower epoch
 * (never taken, whoever signed it). */
export function lowerEpoch(link: LinkState | null | undefined, doc: Doc): boolean {
  const kept = link?.setup;
  const said = doc.kind === "peers" ? setupOf(doc.body) : null;
  return Boolean(kept && said && said.id === kept.id && said.epoch < kept.epoch);
}

/** The #181 switch ("other computers can start work here"), as this box keeps it: the value you set,
 * or none; and what it is when you set none: off on the main computer (and on a Mac in no setup,
 * the one your app runs on), on everywhere else, so it follows the role. */
export function startsFromOthers(link: LinkState | null | undefined): { value: "on" | "off" | null; default: "on" | "off" } {
  const value = link?.startsFromOthers === "on" || link?.startsFromOthers === "off" ? link.startsFromOthers : null;
  const setup = followedSetup(link);
  const main = setup ? setup.role === "primary" : IS_MAC;
  return { value, default: main ? "off" : "on" };
}
