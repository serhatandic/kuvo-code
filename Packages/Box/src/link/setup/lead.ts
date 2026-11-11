// When a box leads a setup of its own (PROTOCOL.md, "Your setup"): this Mac's box, once it numbers
// on its own and each of its machines has said it isn't shared with another Mac (so Macs that share a
// machine stay numbering as before, from the first one set up); a box no Mac set up (one you paired a phone with
// by itself, on Linux say). It's made once, at epoch 1, with this box as the main computer, and named
// in this Mac's peers document, which its machines take. Looked at once a minute, and as the box
// starts; with what follows it on this box: its card (`card.ts`) and its peers told.

import { noteDocsChanged } from "../documents/changed";
import { ownSign } from "../documents/format";
import { IS_MAC } from "../home";
import { macsOf, ownKey } from "../peers/known";
import { updateLink } from "../state";
import { rankedPrimary } from "../work-queue/numbers";
import { writeCard } from "./card";
import { heldBy } from "./held";
import { followedSetup, newSetupID } from "./record";
import { settleSetup } from "./settle";
import type { LinkState } from "../state";

/** Whether this box leads its setup now: this Mac's box, while it's the first computer you set up as
 * it and its peers know (it numbers from none other) and no machine of it says another Mac shares it;
 * to start leading (or lead again), each machine must have said so (one that hasn't, an older box,
 * holds it back: nothing changes meanwhile), while one that leads goes on through a machine that
 * hasn't said yet (one just added, its first word still on its way); one that never told it how it
 * numbers, or is gone, counts for neither (`heldBy`). A machine leads while no Mac set it up and it
 * numbers on its own. */
export function leadsNow(link: LinkState, now = Date.now()): boolean {
  // (A machine its Mac let go waits for that Mac as numbering always has, days, before it numbers
  // on its own: never at once.)
  if (!IS_MAC) return !macsOf(link).length && "self" in rankedPrimary(link, undefined, now);
  return "self" in rankedPrimary(link, undefined, now) && !heldBy(link, now).length;
}

/** This Mac's static key noted (in place, under link.json's lock): one made anew since the last is
 * kept among the keys before, for its machines to let the old one go as it sets them up again. */
export function noteKeyNow(link: LinkState): void {
  const own = IS_MAC ? ownKey(link) : null;
  if (!own) return;
  if (link.keyNow && link.keyNow !== own) link.keysBefore = [...(link.keysBefore ?? []).filter(key => key !== own && key !== link.keyNow), link.keyNow].slice(-8);
  link.keyNow = own;
}

/** This box's setup as it stands now (in place, under link.json's lock): one it leads made, or set
 * aside while it doesn't lead it; a machine's taken as its documents say. */
export function settleOwnSetup(link: LinkState, now = Date.now()): void {
  noteKeyNow(link);
  settleSetup(link);
  const own = ownKey(link);
  const sign = ownSign(link);
  if (!own || !sign || (!IS_MAC && macsOf(link).length)) return;
  const leads = leadsNow(link, now);
  // (Keys made anew, its folder kept: a new setup, as it's a new computer to the others; the one
  // it led with its old keys is no longer its own.)
  if (!link.setup || link.setup.role !== "primary" || link.setup.primary !== own || link.setup.sign !== sign) {
    if (!leads) {
      if (link.setup?.role === "primary") delete link.setup;
      return;
    }
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
      settleOwnSetup(link, now);
      if (JSON.stringify(link.setup ?? null) === before) return null;
      changed = true;
      return link;
    });
  } catch {}
  if (changed) noteDocsChanged();
  try { writeCard(); } catch {}
}
