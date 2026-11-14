// Integrations (PROTOCOL.md, "Integrations"): Settings › Integrations, each box its own, from the
// catalog its Mac leaves in its `bin` (`integrations.json`), with how each is doing there.

import { bool, type Infer, list, NOTHING, object, type RouteShape, string, words } from "../shape";

/** A key an integration takes: the variable its server reads, and how Settings asks for it. */
export const INTEGRATION_KEY = object({ name: string, label: string, prompt: string });

/** How an added one is doing: its server's status, then whether it waits for you (`waitsForCode`:
 * a server that signs in by itself with a code the first time it's used; `disabled`: turned off in
 * MCP Servers, so it won't start until it's turned on). */
export const INTEGRATION_HEALTH = words("connected", "starting", "waitsForCode", "needsSignIn", "failed", "disabled");

/** An integration as `kuvo/integrations` lists it: what it is and how it's added, as its Mac's
 * catalog says (`kind`, its section's title; `how`, the tag after its name; `way`, how it's
 * added; `keys`, `help`, `redirect`, `by` and `macOnly` where its way has them), then whether it's
 * added here, whether this box keeps its keys (left out while they can't be reached), and, added,
 * how it's doing (left out while its engine can't say) and the engine's integration it signs in
 * through, and, one that needs signing in, whether the sign-in it had ended (`signInEnded`: Sign In
 * Again, not Sign In). `siteSignedIn`: one used on its site, whether this box's browser is signed in there,
 * where it can tell (this Mac's). */
export const INTEGRATION = object({
  id: string,
  title: string,
  summary: string,
  kind: words("Mail and Calendar", "Chat", "Social", "Code and Work"),
  symbol: string,
  site: string,
  how: string,
  way: words("official", "token", "app", "package", "browser"),
  "keys?": list(INTEGRATION_KEY),
  "help?": string,
  "redirect?": string,
  "by?": string,
  "macOnly?": bool,
  added: bool,
  "keysSaved?": bool,
  "siteSignedIn?": bool,
  "health?": INTEGRATION_HEALTH,
  "signIn?": string,
  "signInEnded?": bool,
});

/** Every integration this box offers, in the page's order; `engineDown` while its engine isn't
 * running or doesn't answer, and `problem`, why its settings file can't be changed. */
export const INTEGRATIONS = object({ integrations: list(INTEGRATION), "engineDown?": bool, "problem?": string });

/** One just added (or written again), as the list has it. */
export const INTEGRATION_ADDED = object({ integration: INTEGRATION });

export type IntegrationKey = Infer<typeof INTEGRATION_KEY>;
export type IntegrationHealth = Infer<typeof INTEGRATION_HEALTH>;
export type Integration = Infer<typeof INTEGRATION>;
export type Integrations = Infer<typeof INTEGRATIONS>;
export type IntegrationAdded = Infer<typeof INTEGRATION_ADDED>;

export const INTEGRATION_ROUTES: RouteShape[] = [
  { route: "GET kuvo/integrations", answers: { 200: INTEGRATIONS } },
  { route: "POST kuvo/integrations/:id", answers: { 200: INTEGRATION_ADDED } },
  { route: "DELETE kuvo/integrations/:id", answers: { 200: NOTHING } },
];
