// What agents ask you for while they browse (PROTOCOL.md, `kuvo/asks`): a sign-in, a code or a
// step only you can do, as the cards over the composer show them, and a client's answer.

import { bool, type Infer, list, NOTHING, object, type RouteShape, string, words } from "../shape";

/** One ask: what kind, on which site, and the machine whose browser it is (by name; left out for
 * a Mac's own), the conversation it's for and its name (`asker`), when known. A sign-in says
 * whether it wants a username and a password, the accounts saved for the site (a Mac's Passwords;
 * none on a machine, never their passwords), and whether what's typed is kept unless you say
 * otherwise; a code has its prompt, a step what to do. `passkey` when the site asked for a passkey,
 * which the browser can't use yet (so you sign in another way). `box`, from a Mac listing one of its
 * machines' asks: that machine's box by its link address (as `kuvo/hosts` gives it), whose ask it
 * is and where its answer goes too. */
export const ASK = object({
  id: string,
  kind: words("signIn", "code", "action"),
  host: string,
  "machine?": string,
  "box?": string,
  "session?": string,
  "asker?": string,
  "username?": bool,
  "password?": bool,
  "saved?": list(string),
  "offersToSave?": bool,
  "prompt?": string,
  "instruction?": string,
  "passkey?": bool,
});
/** What's asked now. */
export const ASKS = object({ asks: list(ASK) });

export type ListedAskShape = Infer<typeof ASK>;
export type Asks = Infer<typeof ASKS>;

export const ASK_ROUTES: RouteShape[] = [
  { route: "GET kuvo/asks", answers: { 200: ASKS } },
  { route: "POST kuvo/asks/:id", answers: { 200: NOTHING } },
];
