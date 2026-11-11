// Which of this Mac's machines hold it back from leading its setup by their word (PROTOCOL.md,
// "Your setup"): `leadsNow` waits on them, and `kuvo/setup` and the card name them.

import { IS_MAC } from "../home";
import { peersOf } from "../peers/known";
import { goneOf } from "../work-queue/numbers";
import { readTold } from "../work-queue/told";
import { followedSetup } from "./record";
import type { LinkState } from "../state";

/** The machines whose word holds this Mac back from leading its setup (`kuvo/setup`'s `heldBy`):
 * to start leading, each that hasn't said it isn't shared (an older box); once it leads, each that
 * says it is. One that never told this Mac how it numbers, or that numbering counts as gone (not
 * heard for days), holds nothing back, so one stale machine never keeps a Mac out of a setup. */
export function heldBy(link: LinkState | null | undefined, now = Date.now()): string[] {
  if (!IS_MAC || !link) return [];
  const gone = goneOf(link, now);
  const leading = followedSetup(link)?.role === "primary";
  return peersOf(link).filter(peer => {
    const told = gone.has(peer.key) ? null : readTold(peer.key);
    return told !== null && (leading ? told.shared === true : told.shared !== false);
  }).map(peer => peer.key);
}
