// What only your setup's main computer does (PROTOCOL.md, "Your setup", Only the main computer):
// it adds computers and pairs phones. A member says so, naming it (a 409 with its words, for any
// client to show as it is), and the main computer and a box in no setup (one beside an older Mac)
// do them as before: a box you run alone is its own setup's main computer. A member says which computers a phone reaches from the setup's document.

import { isObject } from "../../shared/json";
import type { Hosts } from "../../shared/routes/mac";
import { IS_MAC } from "../home";
import { macDoc, macsOf } from "../peers/known";
import type { LinkState } from "../state";
import { setupDoc } from "./record";
import { sharedMachine } from "./settle";

/** The main computer of the setup this box is a member of: its key and name; null on the main
 * computer itself and in no setup. One set aside counts too (a shared machine, or its main computer
 * not naming it now): it's still that computer's, and stepping aside never opens pairing again. */
export function mainElsewhere(link: LinkState | null | undefined): { key: string; name: string } | null {
  const setup = link?.setup;
  if (!setup || setup.role !== "member" || typeof setup.primary !== "string") return null;
  return { key: setup.primary, name: macName(link, setup.primary) };
}

/** What a Mac that set this box up is called: as its own peers document names it (or the setup's,
 * for its main computer), else as it said over SSH; "" when neither does. */
export function macName(link: LinkState | null | undefined, mac: string): string {
  const doc = macDoc(link, mac, "peers") ?? (link?.setup?.primary === mac ? setupDoc(link) : null);
  const named = (Array.isArray(doc?.body.boxes) ? doc.body.boxes : []).find(box => isObject(box) && box.key === mac);
  return String((isObject(named) && typeof named.name === "string" && named.name) || link?.macNames?.[mac] || "").slice(0, 100);
}

const named = (main: { name: string }) => main.name || "your main computer";

/** What a member answers a pairing link asked of it (`kuvo/phones/pair`, `kuvo-link.js pair`). */
export const pairElsewhere = (main: { key: string; name: string }) => ({ message: `Pair new phones from ${named(main)}.`, primary: main.key });

/** What a member answers adding or removing computers (`kuvo/machines…`, `kuvo/hosts/…`, and
 * `kuvo/link/peers` from an app beside it that isn't the main computer's). */
export const addElsewhere = (main: { key: string; name: string }) => ({ message: `Add and remove computers from ${named(main)}.`, primary: main.key });

/** `kuvo/hosts` as a member says it, from the document of the setup it follows: every machine in
 * the setup a phone reaches directly (itself too), as a Mac lists its machines; the main computer's
 * Mac isn't one (a phone pairs with it). Set aside by its one Mac (which leads no setup now), from
 * that Mac's own peers document: its phones are all that Mac's. Null where this box is no member,
 * has no relay to name, holds no such document yet, or is shared: its Macs' phones aren't all one
 * Mac's, so no one Mac's list is theirs to read. */
export function memberHosts(link: LinkState | null | undefined): Hosts | null {
  if (IS_MAC || !mainElsewhere(link) || !link?.relay || sharedMachine(link)) return null;
  const doc = setupDoc(link) ?? (link.setup!.aside && macsOf(link).length === 1 ? macDoc(link, link.setup!.primary, "peers") : null);
  if (!doc) return null;
  const hosts: Hosts["hosts"][number][] = [];
  for (const box of Array.isArray(doc.body.boxes) ? doc.body.boxes.slice(0, 64) : []) {
    if (!isObject(box) || box.kind !== "machine" || typeof box.key !== "string" || typeof box.address !== "string" || hosts.some(each => each.key === box.key)) continue;
    const name = String(box.name ?? "").slice(0, 100);
    hosts.push({ kind: "machine", name, address: box.address, key: box.key, relay: link.relay, machine: typeof box.id === "string" && box.id ? box.id : name, anotherMac: false, removed: false });
  }
  return { hosts: hosts.sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0)) };
}
