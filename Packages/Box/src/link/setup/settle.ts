// What a box takes of your setup (PROTOCOL.md, "Your setup"): a machine follows the setup its Mac
// leads, as its peers document names it; it never goes back to a lower epoch of it, and at the same
// epoch keeps the main computer it has (noting the other). A machine more than one Mac set up, when
// those Macs aren't all in one setup, follows none (shared machines number as before, from the first
// Mac you set up, until they're joined). This Mac's box leads its own (`lead.ts`), and takes none.

import type { Doc } from "../../shared/documents";
import { isObject } from "../../shared/json";
import { IS_MAC } from "../home";
import { macDoc, macsOf } from "../peers/known";
import { macSign } from "../state";
import { followedSetup, ledSetup, setupDoc } from "./record";
import type { LinkState } from "../state";

// The boxes a peers document names as Macs (the main computer itself, and Macs in its setup).
const macsNamed = (doc: Doc | null | undefined): string[] => (Array.isArray(doc?.body.boxes) ? doc.body.boxes : [])
  .filter(box => isObject(box) && box.kind === "mac" && typeof box.key === "string").map(box => (box as { key: string }).key);

/** Whether this box is a machine shared between Macs not all in the setup it has: more than one Mac
 * set it up, and the setup's document doesn't name each as one of its Macs (with none, more than one
 * Mac). Such a machine follows no setup, and tells its Macs it's shared, so none leads one. */
export function sharedMachine(link: LinkState | null | undefined): boolean {
  if (IS_MAC || !link) return false;
  const macs = macsOf(link);
  if (macs.length < 2) return false;
  const setup = link.setup?.role === "member" ? link.setup : null;
  const doc = setup ? macDoc(link, setup.primary, "peers") ?? setupDoc(link) : null;
  const named = doc && setup ? new Set([setup.primary, ...macsNamed(doc)]) : new Set<string>();
  return !macs.every(mac => named.has(mac));
}

/** This box's setup brought up to date with the peers documents it holds (in place, under
 * link.json's lock). A machine with no Mac keeps what it leads (`lead.ts` makes it); one a Mac set
 * up gives that up (a setup of no other computer joins its Mac's), and follows the setup its Macs'
 * documents name, the one each names led by the Mac that signed it. */
export function settleSetup(link: LinkState): void {
  // (Within it: a machine with no Mac; one set up by a Mac; the setup it keeps, as its main
  // computer's newest document says it; one it takes; and set aside while it's shared.)
  if (IS_MAC) return;
  const macs = macsOf(link);
  if (!macs.length) {
    if (link.setup?.role === "member") delete link.setup;
    return;
  }
  if (link.setup?.role === "primary") delete link.setup;
  const offers = macs.map(mac => ({ mac, doc: macDoc(link, mac, "peers") })).map(({ mac, doc }) => ({ mac, doc, setup: ledSetup(doc) })).filter(each => each.setup && each.setup.primary === each.mac);
  const kept = link.setup;
  // (The key its main computer signs with, as its setup over SSH last gave it: the trust root.)
  if (kept && macSign(link, kept.primary)) kept.sign = macSign(link, kept.primary)!;
  if (kept) {
    // Its main computer's newest document: the setup as it says it now, or set aside by it.
    const own = offers.find(each => each.mac === kept.primary);
    const doc = macDoc(link, kept.primary, "peers");
    if (own && (own.setup!.id !== kept.id || own.setup!.epoch >= kept.epoch)) {
      // (Its main computer made it again, with its keys as they were and link.json lost: the same main computer.)
      if (own.setup!.id !== kept.id || own.setup!.epoch !== kept.epoch) delete kept.conflict;
      kept.id = own.setup!.id;
      kept.epoch = own.setup!.epoch;
      delete kept.aside;
    } else if (doc && !ledSetup(doc)) kept.aside = true;
  } else if (offers.length === 1) {
    const { setup, doc } = offers[0];
    link.setup = { id: setup!.id, epoch: setup!.epoch, primary: setup!.primary, sign: doc!.origin, role: "member" };
  }
  if (link.setup && sharedMachine(link)) link.setup.aside = true;
}

/** A peers document this box didn't take (`takeDoc`), looked at for one more thing: one of its own
 * Macs naming itself the main computer of the setup this box follows, at its epoch, which isn't the
 * main computer this box has. That's two main computers at once (PROTOCOL.md, "Your setup"): this box
 * keeps its own, and notes the other for clients to show. */
export function noteConflict(link: LinkState, doc: Doc): void {
  const setup = followedSetup(link);
  const said = ledSetup(doc);
  if (setup?.role !== "member" || !said || said.id !== setup.id || said.epoch !== setup.epoch || said.primary === setup.primary) return;
  if (!macsOf(link).includes(said.primary) || macSign(link, said.primary) !== doc.origin) return;
  setup.conflict = { primary: said.primary, epoch: said.epoch };
}
