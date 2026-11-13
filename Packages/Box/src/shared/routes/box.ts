// The box itself (PROTOCOL.md, "Messages in a session" and "Updates"): what it is and runs, its
// updates, the phones paired with it, whether you're at a computer, and who `&` can name.

import { FEATURES } from "../features";
import { bool, BYTES, type Infer, list, literal, map, NOTHING, nullable, number, object, oneOf, type RouteShape, string, words } from "../shape";
import { MAC_FEATURES } from "./mac";

/** One of a machine's pieces (`kuvo/info`'s `pieces`): the version it runs (null while it doesn't,
 * or doesn't say), the one its files hold now, and whether it runs another than those (`behind`). */
const PIECE = object({ running: nullable(string), current: nullable(string), behind: bool });

/** What the box is and runs (`kuvo/info`): a Mac's names its app's version and its integrations, a
 * machine's its bridge's version and whether its engine runs or is stopped on purpose. `started`:
 * when the engine running now came up, in seconds since 1970 (null while none runs). A machine's
 * `home`: the Mac that started its engine (its id, and its name where it noted one). `macs`: the
 * Macs that set it up (each one's key, its name where it said one, when it was last heard from, ms),
 * and `phones`, how many phones reach it: who an uninstall would stop it for. A machine's `pieces`:
 * which version its link, coding agents' bridge and engine each run, against the one in place, and
 * while a newer bridge waits to take over, since when and whether new turns wait for it. */
export const INFO = oneOf(
  object({
    kind: literal("mac"),
    name: string,
    app: string,
    engine: string,
    features: list(words(...FEATURES, ...MAC_FEATURES)),
    agents: bool,
    started: nullable(number),
    chats: string,
    integrations: map(string),
  }),
  object({
    kind: literal("machine"),
    name: string,
    bridge: string,
    engine: nullable(string),
    features: list(words(...FEATURES)),
    agents: bool,
    started: nullable(number),
    chats: string,
    running: bool,
    stopped: bool,
    "home?": object({ mac: string, "name?": string }),
    "macs?": list(object({ key: string, "name?": string, seen: number })),
    "phones?": number,
    "pieces?": object({
      link: PIECE,
      agents: object({
        running: nullable(string), current: nullable(string), behind: bool, renewal: nullable(object({ since: number, holding: bool })),
        waits: nullable(words("quiet", "holding", "engine", "restart")),
      }),
      engine: PIECE,
    }),
  }),
);

/** An update's step under way. */
const STEP = words("checking", "downloading", "downloading the engine", "checking it", "installing", "starting");
/** How the last one went: `from` and `to` once one's done, or what it said. */
const LAST_UPDATE = object({
  at: number,
  result: words("updated", "current", "waiting", "busy", "off", "blocked", "failed"),
  "version?": string,
  "message?": string,
  "from?": string,
  "to?": string,
});
/** This box's updates (`kuvo/update`): whether they're set up, its version and its engine's, the
 * latest it knows of, how the last one went, the step under way, why it can't update, and the
 * version of a release offered from a folder here (`kuvo/box/update`) that waits to be taken. */
export const UPDATE = object({
  setUp: bool,
  version: nullable(string),
  engine: nullable(string),
  latest: nullable(string),
  last: nullable(LAST_UPDATE),
  updating: nullable(STEP),
  blocked: nullable(string),
  "offered?": string,
});

/** A step of moving this Mac's box into a home of its own (PROTOCOL.md, "Moving this Mac's box"). */
const REHOME_STEP = words("plan", "install", "clone", "rewrite", "check", "place", "fix", "clear", "done");
/** How moving this Mac's box into a home of its own stands (`kuvo/box/rehome`): its state (none
 * yet; `waiting` for a quiet moment; `moving` or `clearing`, under way, and the step; `done`;
 * `failed`, gone back; `back`, moved back), which way, its tries and the next one, since when it
 * waits and whether that's three days (`overdue`), why it last failed, when it moved and when its
 * kept copy goes, what the app still owes it, Move Now or Move Back asked, and both folders. */
export const REHOME = object({
  state: nullable(words("waiting", "moving", "clearing", "done", "failed", "back")),
  way: nullable(words("move", "back")),
  step: nullable(REHOME_STEP),
  tries: number,
  nextTry: nullable(number),
  waitingSince: nullable(number),
  overdue: bool,
  failed: nullable(object({ at: number, step: nullable(REHOME_STEP), message: string })),
  movedAt: nullable(number),
  keptUntil: nullable(number),
  owed: list(words("keychain", "agent")),
  asked: nullable(words("now", "back")),
  from: nullable(string),
  to: nullable(string),
});

/** The browser agents use on a machine (`kuvo/browser`, PROTOCOL.md, "The browser on a machine"):
 * `missing` (none, and none being set up), `checking`, `downloading` (with `progress`, 0 to 1),
 * `installing`, `ready`, or `failed` (`message`, and when it tries again by itself, ms, or null for
 * never). `chromium` is the version this box pins, `installed` the one in use (an older one works
 * while a newer one is set up). */
export const BROWSER = object({
  state: words("missing", "checking", "downloading", "installing", "ready", "failed"),
  chromium: nullable(string),
  installed: nullable(string),
  progress: nullable(number),
  message: nullable(string),
  retryAt: nullable(number),
});

/** The phones paired here, `you` being the one asking. */
export const PHONES = object({ phones: list(object({ key: string, name: string, added: nullable(number), pairing: string, you: bool })) });
/** A link for another phone to pair with (good once), and when it ends, in seconds since 1970. */
export const PAIRING = object({ link: string, ends: number });

/** Your setup as this box says it (`kuvo/setup`, PROTOCOL.md "Your setup"): its id and epoch, its
 * main computer, this box (its key, and its role, null in no setup), each computer in it, another
 * main computer named at the same epoch (never taken), the #181 switch: the value you set, or
 * null, and what it is then; and the machines holding this Mac back from leading a setup, by key. */
export const SETUP = object({
  setup: nullable(string),
  epoch: nullable(number),
  primary: nullable(object({ key: string, name: string, kind: words("mac", "machine") })),
  you: object({ key: nullable(string), role: nullable(words("primary", "member")) }),
  computers: list(object({ key: string, name: string, kind: words("mac", "machine"), role: words("primary", "member"), app: bool })),
  "conflict?": object({ primary: string, epoch: number }),
  startsFromOthers: object({ value: nullable(words("on", "off")), default: words("on", "off") }),
  heldBy: list(string),
});

/** One box found on a computer, as `kuvo/setup/judge` and `kuvo-link.js here` judge it: where it
 * is (its folder, from the home folder; `app`, Kuvo Code's own box on a Mac), its verdict, and what
 * it says of itself (its key, name and kind; its setup, role and main computer, `heard` when that
 * was last heard from, ms; the Macs that set it up; how many computers and Work Queue items). */
const JUDGED_BOX = object({
  folder: string,
  app: bool,
  verdict: words("self", "free", "ours", "older", "elsewhere", "main"),
  key: nullable(string),
  name: string,
  kind: nullable(words("mac", "machine")),
  setup: nullable(string),
  role: nullable(words("primary", "member")),
  primary: nullable(object({ key: string, name: string, heard: nullable(number) })),
  macs: list(object({ key: string, name: string })),
  computers: nullable(number),
  items: nullable(number),
});

/** What's on a computer, judged (PROTOCOL.md, "Your setup", "Already in a setup?"): one verdict,
 * whether adding it joins its setup with nothing to ask (`joins`: another setup's main computer, no
 * Mac's own app, with no other computer and no work in it), and each box found there. */
export const JUDGED = object({ verdict: words("self", "free", "ours", "older", "elsewhere", "main", "two"), joins: bool, boxes: list(JUDGED_BOX) });

/** What `kuvo-link.js here` prints as Kuvo Code opens on a Mac (PROTOCOL.md, "Already in a
 * setup?"): one verdict, whether the app uses its own box or the one already here (`attach`), how it
 * opens (`main`: its setup's main computer; `window`: onto a setup another computer is main of, its
 * box one of its members), that box, and the app's own. While a move of this Mac's box into its home
 * is under way (its journal there, not done), `moving`, to `wait`: neither the app nor its keeper
 * starts a box then. Not a route: the app decodes it as it opens. */
export const HERE = object({
  verdict: words("self", "free", "ours", "older", "elsewhere", "main", "two", "moving"),
  use: words("own", "attach", "wait"),
  opens: words("main", "window"),
  runs: nullable(words("running", "stopped", "gone")),
  box: nullable(JUDGED_BOX),
  own: nullable(JUDGED_BOX),
});

/** Whether a client's in use here, and how many notices wait. */
export const ATTENTION = object({ inUse: bool, held: number });

/** Who `&` can name in a message here: this box's bots and latest sessions (`machine` null), then
 * those its other computers told it of. */
export const NAMED = object({
  agents: list(object({ session: string, name: string, kind: words("bot", "session"), machine: nullable(string), project: nullable(string), about: nullable(string) })),
});

/** The plans whose sign-in ran out and couldn't be renewed, by provider. */
export const ENDED = object({ providers: list(string) });
/** This box's sign-ins. */
export const CREDENTIALS = object({ credentials: list(object({ id: string, integrationID: string, label: string, active: bool })) });
/** A provider's models asked of again: the folders that get them once their work is done. */
export const MODELS_REFRESHED = object({ waiting: list(string) });
/** The providers Refresh Models brings new models to. */
export const REFRESHABLE = object({ providers: list(string) });

/** What this computer already has that Kuvo Code can use, for the first launch (names only, never a
 * key): the coding agents' programs and their sign-ins; the keys (`key`, brought over with
 * `kuvo/accounts/found/use`) and sign-ins (`signIn`, done again here) of an opencode used apart
 * from Kuvo Code, `connected` when the engine has one for it already; and the keys in the shell
 * the engine uses; and the engine's providers signed in to already (`connected`, by integration).
 * `unread` names the parts whose server isn't running or didn't answer (`engine`, `agents`): theirs
 * are empty for now, not signed out. */
export const FOUND = object({
  agents: list(object({ id: string, name: string, installed: bool, signedIn: bool, "label?": string })),
  opencode: list(object({ id: string, integrationID: string, name: string, kind: words("key", "signIn"), connected: bool })),
  shell: list(object({ integrationID: string, name: string, variable: string })),
  "connected?": list(string),
  "unread?": list(words("engine", "agents")),
});

export type BoxInfo = Infer<typeof INFO>;
/** A machine's, as its link answers. */
export type MachineInfo = Extract<BoxInfo, { kind: "machine" }>;
export type UpdateStatus = Infer<typeof UPDATE>;
export type UpdateStep = Infer<typeof STEP>;
export type LastUpdate = Infer<typeof LAST_UPDATE>;
export type RehomeStatus = Infer<typeof REHOME>;
export type RehomeStep = Infer<typeof REHOME_STEP>;
export type BrowserStatus = Infer<typeof BROWSER>;
export type Phones = Infer<typeof PHONES>;
export type Named = Infer<typeof NAMED>;
export type Credentials = Infer<typeof CREDENTIALS>;
export type ModelsRefreshed = Infer<typeof MODELS_REFRESHED>;
export type Found = Infer<typeof FOUND>;

export const BOX_ROUTES: RouteShape[] = [
  { route: "GET kuvo/info", answers: { 200: INFO } },
  { route: "GET kuvo/update", answers: { 200: UPDATE } },
  { route: "POST kuvo/update", answers: { 202: UPDATE } },
  { route: "POST kuvo/box/update", answers: { 202: UPDATE } },
  { route: "GET kuvo/box/rehome", answers: { 200: REHOME } },
  { route: "POST kuvo/box/rehome", answers: { 200: REHOME } },
  { route: "GET kuvo/browser", answers: { 200: BROWSER } },
  { route: "POST kuvo/browser", answers: { 202: BROWSER } },
  { route: "GET kuvo/file", answers: { 200: BYTES } },
  { route: "GET kuvo/phones", answers: { 200: PHONES } },
  { route: "POST kuvo/phones/remove", answers: { 200: NOTHING } },
  { route: "POST kuvo/phones/pair", answers: { 200: PAIRING } },
  { route: "DELETE kuvo/phones/pair", answers: { 200: NOTHING } },
  { route: "GET kuvo/setup", answers: { 200: SETUP } },
  { route: "GET kuvo/setup/events", answers: { 200: SETUP } },
  { route: "POST kuvo/setup/judge", answers: { 200: JUDGED } },
  { route: "POST kuvo/setup/attached", answers: { 200: NOTHING } },
  { route: "GET kuvo/attention", answers: { 200: ATTENTION } },
  { route: "POST kuvo/attention", answers: { 200: object({ for: number }) } },
  { route: "POST kuvo/attention/notice", answers: { 200: NOTHING } },
  { route: "POST kuvo/attention/answered", answers: { 200: NOTHING } },
  { route: "GET kuvo/named", answers: { 200: NAMED } },
  { route: "GET kuvo/accounts/ended", answers: { 200: ENDED } },
  { route: "POST kuvo/accounts/:provider/forget", answers: { 200: NOTHING } },
  { route: "GET kuvo/accounts/refreshable", answers: { 200: REFRESHABLE } },
  { route: "POST kuvo/accounts/:provider/refresh", answers: { 200: MODELS_REFRESHED } },
  { route: "GET kuvo/accounts/credentials", answers: { 200: CREDENTIALS } },
  { route: "GET kuvo/accounts/found", answers: { 200: FOUND } },
  { route: "POST kuvo/accounts/found/use", answers: { 200: NOTHING } },
  { route: "POST kuvo/engine/:control", answers: { 202: NOTHING } },
  { route: "POST kuvo/shell/:id/stop", answers: { 200: object({ stopped: words("signal", "removed") }) } },
];
