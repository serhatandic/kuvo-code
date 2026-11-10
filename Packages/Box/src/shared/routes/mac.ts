// What only this Mac's box answers, through its app (PhoneLink), or by itself while the app is closed:
// its own features, its machines, the machines your phones reach directly, and the usage panel's
// numbers. (Its other own routes, `kuvo/mac` and `kuvo/claude-code`, have no scenario asking them yet.)

import { FEATURES } from "../features";
import { any, bool, type Infer, list, literal, NOTHING, object, type RouteShape, string } from "../shape";

/** What only a Mac answers, besides what every box does (`FEATURES`): its usage panel's numbers
 * among them, which its app gives while it's open (PROTOCOL.md, "Features"). */
export const MAC_FEATURES = ["accounts.ended", "claude-code", "hosts", "mac", "machines", "usage"] as const;

/** What only a machine answers: it updates itself, and starts an engine an older Mac's Stop left down. */
export const MACHINE_FEATURES = ["engine.start", "update"] as const;

/** What a Mac's box answers, as its `kuvo/info` and its agents' mail say: every box's but a
 * machine's own, and the Mac's own. The box's list alone: its app keeps none. */
export const macFeatures = (): string[] => [...new Set([...FEATURES.filter(feature => !(MACHINE_FEATURES as readonly string[]).includes(feature)), ...MAC_FEATURES])].sort();

/** Your machines' bridges, which phones reach directly with the Mac closed: each by its id
 * (`machine`), where it is on the relay, whether another Mac gives it its settings (`anotherMac`),
 * and whether this Mac removed it (it runs on there, so a phone may forget it). */
export const HOSTS = object({
  hosts: list(object({ kind: literal("machine"), name: string, address: string, key: string, relay: string, machine: string, anotherMac: bool, removed: bool })),
});

export type Hosts = Infer<typeof HOSTS>;

/** Its machines as Settings › Machines has them. The open app says more of a connection (`failure`,
 * `action`, `step`, `home`, `alsoUsedBy`, `folded`: PROTOCOL.md); what's here is what this box says
 * by itself with the app closed too. */
export const MACHINES = object({
  machines: list(object({ id: string, name: string, otherAddresses: list(string), connection: string, status: string })),
  hosts: list(string),
});

export type MacMachines = Infer<typeof MACHINES>;

export const MAC_ROUTES: RouteShape[] = [
  { route: "GET kuvo/machines", answers: { 200: MACHINES } },
  { route: "GET kuvo/hosts", answers: { 200: HOSTS } },
  { route: "DELETE kuvo/hosts/:machine", answers: { 200: NOTHING } },
  // The usage panel's numbers, as UsageKit gives them to a phone: its own record.
  { route: "GET kuvo/usage", answers: { 200: any } },
  { route: "POST kuvo/usage/refresh", answers: { 200: NOTHING } },
];
