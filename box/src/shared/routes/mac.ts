// What only this Mac's box answers, through its app (PhoneLink), or by itself while the app is closed:
// its own features, its machines, and the machines your phones reach directly. (Its other own
// route, `kuvo/mac`, has no scenario asking it yet.) Usage is every box's: `kuvo/agents/api/kuvo/usage…`.

import { FEATURES, type Feature } from "../features";
import { bool, type Infer, list, literal, NOTHING, object, type RouteShape, string } from "../shape";

/** What only a Mac answers, besides what every box does (`FEATURES`; PROTOCOL.md, "Features").
 * One a line, in order, as `FEATURES` are. */
export const MAC_FEATURES = [
  "accounts.ended",
  "hosts",
  "mac",
  "machines",
] as const;

/** What only a machine answers: it updates itself, starts an engine an older Mac's Stop left down,
 * sets up its own browser (a Mac's is the app's), and says which version its pieces run. One a line, in order. */
export const MACHINE_FEATURES = [
  "browser",
  "engine.start",
  "pieces",
  "update",
] as const satisfies readonly Feature[];

/** What a Mac's box answers, as its `kuvo/info` and its agents' mail say: every box's but a
 * machine's own, in their order, then the Mac's own. The box's list alone: its app keeps none. */
export const macFeatures = (): string[] => [...new Set([...FEATURES.filter(feature => !(MACHINE_FEATURES as readonly string[]).includes(feature)), ...MAC_FEATURES])];

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
];
