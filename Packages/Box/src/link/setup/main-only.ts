// What only your setup's main computer does (PROTOCOL.md, "Your setup", Only the main computer):
// it adds computers and pairs phones. A member says so, naming it (a 409 with its words, for any
// client to show as it is), and the main computer and a box in no setup (one beside an older Mac)
// do them as before: a box you run alone is its own setup's main computer. A member says which computers a phone reaches from the setup's document.

import { isObject } from "../../shared/json";
import type { Hosts } from "../../shared/routes/mac";
import { IS_MAC } from "../home";
import { macDoc } from "../peers/known";
import type { LinkState } from "../state";
import { setupDoc } from "./record";

/** The main computer of the setup this box is a member of: its key and name; null on the main
 * computer itself and in no setup. One set aside counts too (a shared machine, or its main computer
 * not naming it now): it's still that computer's, and stepping aside never opens pairing again. */
export function mainElsewhere(link: LinkState | null | undefined): { key: string; name: string } | null {
  const setup = link?.setup;
  if (!setup || setup.role !== "member" || typeof setup.primary !== "string") return null;
  const doc = macDoc(link, setup.primary, "peers") ?? setupDoc(link);
  const named = (Array.isArray(doc?.body.boxes) ? doc.body.boxes : []).find(box => isObject(box) && box.key === setup.primary);
  const name = String((isObject(named) && typeof named.name === "string" && named.name) || link?.macNames?.[setup.primary] || "").slice(0, 100);
  return { key: setup.primary, name };
}

const named = (main: { name: string }) => main.name || "your main computer";

/** What a member answers a pairing link asked of it (`kuvo/phones/pair`, `kuvo-link.js pair`). */
export const pairElsewhere = (main: { key: string; name: string }) => ({ message: `Pair new phones from ${named(main)}.`, primary: main.key });

/** What a member answers adding, changing or removing computers (`kuvo/machines…`, `kuvo/hosts/…`,
 * and `kuvo/link/peers` from an app beside it that isn't the main computer's). */
export const addElsewhere = (main: { key: string; name: string }) => ({ message: `Add and remove computers from ${named(main)}.`, primary: main.key });

/** `kuvo/hosts` as a member says it, from its setup's document: every machine in the setup a phone
 * reaches directly (itself too), as a Mac lists its machines; the main computer's Mac isn't one (a
 * phone pairs with it). Null where this box is no member, has no relay to name, or holds no document
 * of its setup yet. */
export function memberHosts(link: LinkState | null | undefined): Hosts | null {
  if (IS_MAC || !mainElsewhere(link) || !link?.relay) return null;
  const doc = setupDoc(link) ?? macDoc(link, link.setup!.primary, "peers");
  if (!doc) return null;
  const hosts: Hosts["hosts"][number][] = [];
  for (const box of Array.isArray(doc.body.boxes) ? doc.body.boxes.slice(0, 64) : []) {
    if (!isObject(box) || box.kind !== "machine" || typeof box.key !== "string" || typeof box.address !== "string" || hosts.some(each => each.key === box.key)) continue;
    const name = String(box.name ?? "").slice(0, 100);
    hosts.push({ kind: "machine", name, address: box.address, key: box.key, relay: link.relay, machine: typeof box.id === "string" && box.id ? box.id : name, anotherMac: false, removed: false });
  }
  return { hosts: hosts.sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0)) };
}
