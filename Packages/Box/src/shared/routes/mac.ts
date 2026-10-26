// What only this Mac's box answers, through its app (PhoneLink): its own features, the machines
// your phones reach directly, and the usage panel's numbers. (Its other own routes, `kuvo/machines`,
// `kuvo/mac` and `kuvo/claude-code`, have no scenario asking them yet.)

import { any, bool, type Infer, list, literal, NOTHING, object, type RouteShape, string } from "../shape";

/** What only a Mac answers, besides what every box does (`FEATURES`): `usage` while it has the
 * usage panel (PROTOCOL.md, "Features"). */
export const MAC_FEATURES = ["accounts.ended", "claude-code", "hosts", "mac", "machines", "usage"] as const;

/** Your machines' bridges, which phones reach directly with the Mac closed: each by its id
 * (`machine`), where it is on the relay, whether another Mac gives it its settings (`anotherMac`),
 * and whether this Mac removed it (it runs on there, so a phone may forget it). */
export const HOSTS = object({
  hosts: list(object({ kind: literal("machine"), name: string, address: string, key: string, relay: string, machine: string, anotherMac: bool, removed: bool })),
});

export type Hosts = Infer<typeof HOSTS>;

export const MAC_ROUTES: RouteShape[] = [
  { route: "GET kuvo/hosts", answers: { 200: HOSTS } },
  { route: "DELETE kuvo/hosts/:machine", answers: { 200: NOTHING } },
  // The usage panel's numbers, as UsageKit gives them to a phone: its own record.
  { route: "GET kuvo/usage", answers: { 200: any } },
  { route: "POST kuvo/usage/refresh", answers: { 200: NOTHING } },
];
