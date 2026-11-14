// Whether a peer is one of your own computers here (#701, PROTOCOL.md "Plan limits", "Across your
// computers", Whose): not when this box is a machine Macs of two setups share, when the peer says
// it's such a machine (in its agents' mail, or its numbering mail, which an older box or one whose
// engine isn't answering still sends), or when it follows another setup than this box's. What only
// your own computers do for each other (resets and usage totals, changes to each other's bots) goes
// by it.

import type { ToldAgents } from "../../shared/records";
import { followedSetup } from "../setup/record";
import { sharedMachine } from "../setup/settle";
import { readLink } from "../state";
import type { LinkState } from "../state";
import { toldShared } from "../work-queue/told";
import { readPeerAgents } from "./directory";

/** Whether the peer `key` says it's a machine Macs of two setups share. */
export const saysShared = (key: string, told: Record<string, ToldAgents> = readPeerAgents()): boolean => told[key]?.shared === true || toldShared(key) === true;

/** Whether the peer `key` isn't one of your own computers to this box. */
export function isApart(key: string, link: LinkState | null = readLink(), told: Record<string, ToldAgents> = readPeerAgents()): boolean {
  const setup = followedSetup(link);
  return sharedMachine(link) || saysShared(key, told) || (!!setup && !!told[key]?.setup && told[key]!.setup !== setup.id);
}
