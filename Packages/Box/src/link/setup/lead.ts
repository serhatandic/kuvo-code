// When a box leads a setup of its own (PROTOCOL.md, "Your setup"): this Mac's box, once it numbers
// on its own and none of its machines is shared with another Mac (so Macs that share a machine stay
// numbering as before, from the first one set up); a box no Mac set up (one you paired a phone with
// by itself, on Linux say). It's made once, at epoch 1, with this box as the main computer, and named
// in this Mac's peers document, which its machines take. Looked at once a minute, and as the box
// starts; with what follows it on this box: its card (`card.ts`) and its peers told.

import { noteDocsChanged } from "../documents/changed";
import { ownSign } from "../documents/format";
import { IS_MAC } from "../home";
import { macsOf, ownKey, peersOf } from "../peers/known";
import { updateLink } from "../state";
import { readTold } from "../work-queue/told";
import { rankedPrimary } from "../work-queue/numbers";
import { writeCard } from "./card";
import { newSetupID } from "./record";
import { settleSetup } from "./settle";
import type { LinkState } from "../state";

/** Whether this box leads its setup now: this Mac's box, while it's the first computer you set up as
 * it and its peers know (it numbers from none other) and no machine of it says another Mac shares it;
 * a machine, while no Mac set it up. */
export function leadsNow(link: LinkState): boolean {
  if (!IS_MAC) return !macsOf(link).length;
  return "self" in rankedPrimary(link) && !peersOf(link).some(peer => readTold(peer.key)?.shared);
}

/** This box's setup as it stands now (in place, under link.json's lock): one it leads made, or set
 * aside while it doesn't lead it; a machine's taken as its documents say. */
export function settleOwnSetup(link: LinkState): void {
  settleSetup(link);
  const own = ownKey(link);
  const sign = ownSign(link);
  if (!own || !sign || (!IS_MAC && macsOf(link).length)) return;
  const leads = leadsNow(link);
  // (Keys made anew, its folder kept: a new setup, as it's a new computer to the others.)
  if (!link.setup || link.setup.role !== "primary" || link.setup.primary !== own || link.setup.sign !== sign) {
    if (!leads) return;
    link.setup = { id: newSetupID(), epoch: 1, primary: own, sign, role: "primary" };
  }
  if (leads) delete link.setup.aside;
  else link.setup.aside = true;
}

let lookedAt = 0;
/** Looked at now and then (a box's rounds, every few seconds: once a minute at most, the first at
 * once): this box's setup settled, and when that changed it, its documents told to its peers (this
 * Mac's peers document names it, or stops); its card written. */
export function noteSetupNow(now = Date.now(), { soon = 60_000 }: { soon?: number } = {}): void {
  if (now - lookedAt < soon) return;
  lookedAt = now;
  let changed = false;
  try {
    updateLink(link => {
      if (!link) return null;
      const before = JSON.stringify(link.setup ?? null);
      settleOwnSetup(link);
      if (JSON.stringify(link.setup ?? null) === before) return null;
      changed = true;
      return link;
    });
  } catch {}
  if (changed) noteDocsChanged();
  try { writeCard(); } catch {}
}
