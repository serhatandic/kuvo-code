// Which of this Mac's machines hold it back from leading its setup by their word (PROTOCOL.md,
// "Your setup"): `leadsNow` waits on them, and `kuvo/setup` and the card name them.

import { IS_MAC } from "../home";
import { peersOf } from "../peers/known";
import { awaySince, readReach } from "../peers/reach";
import { goneOf, LOST_FOR } from "../work-queue/numbers";
import { toldShared } from "../work-queue/told";
import { followedSetup } from "./record";
import type { LinkState } from "../state";

/** The machines whose word holds this Mac back from leading its setup (`kuvo/setup`'s `heldBy`):
 * to start leading, each that hasn't said it isn't shared (an older box); once it leads, each that
 * says it is. One that never told this Mac how it numbers, or that numbering counts as gone (not
 * heard for days), holds nothing back, so one stale machine never keeps a Mac out of a setup. Once it
 * leads, a machine unheard of for days stays gone until it's heard from again, however long the relay
 * hasn't looked (this Mac asleep overnight): so it never steps aside, and back, as it wakes. */
export function heldBy(link: LinkState | null | undefined, now = Date.now()): string[] {
  if (!IS_MAC || !link) return [];
  const leading = followedSetup(link)?.role === "primary";
  const reach = readReach();
  const gone = leading ? null : goneOf(link, now);
  const isGone = (key: string): boolean => {
    if (gone) return gone.has(key);
    const away = awaySince(key, reach);
    return away !== null && now - away > LOST_FOR;
  };
  return peersOf(link).filter(peer => {
    const shared = isGone(peer.key) ? null : toldShared(peer.key);
    return shared !== null && (leading ? shared === true : shared !== false);
  }).map(peer => peer.key);
}
