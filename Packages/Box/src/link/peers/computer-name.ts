// What another of your computers is called to agents and in what they're told. Its own module, with
// nothing of the link's imported: the modules that use it import each other in a ring
// (letters/calls.ts, letters/start-call.ts, work-queue/across.ts…), and a name one of them read as
// it loaded wasn't there yet when the ring was entered elsewhere (test/load-order.test.ts).

import { plainName } from "../../shared/text";
import type { Peer } from "./known";

/** What a box is called by agents here: a machine by its name, a Mac by its own or "the Mac". */
export const computerName = (peer: Pick<Peer, "kind" | "name" | "id">): string => (peer.kind === "mac" ? plainName(peer.name) || "the Mac" : peer.id || plainName(peer.name) || "another computer");
