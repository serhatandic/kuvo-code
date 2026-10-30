// Bots (PROTOCOL.md, `kuvo/bots`): the bots that live on the box asked, New Bot's templates, a bot
// made, changed, deleted, brought here from another computer and told what it is now, and its keys
// of its own ("Bots' own keys").

import { bool, type Infer, list, map, NOTHING, nullable, number, object, type RouteShape, string, words } from "../shape";
import { LIMITS } from "./work";

/** How a bot looks: its colour, shape and face, by their names (`kuvo/bots/templates`' `looks`). */
/** The colors, shapes and faces a bot can have: those the apps draw (bot-words.json's `looks`). */
export const LOOKS = {
  colors: ["mint", "sky", "indigo", "violet", "pink", "coral", "orange", "amber", "lime", "graphite"],
  shapes: ["round", "squircle", "pebble", "gem", "bloom"],
  faces: ["calm", "happy", "sleepy", "wink", "curious", "bright"],
} as const;
export const LOOK = object({ color: words(...LOOKS.colors), shape: words(...LOOKS.shapes), face: words(...LOOKS.faces) });
/** A model as a bot names it: its id, its provider, and the variant (effort) it runs at, if any. */
export const MODEL = object({ id: string, providerID: string, "variant?": string });

/** A bot that lives here, by its session: its name and look; its job's line (what shows under its
 * name) and all of it; whether its wake-ups are paused, the next one (seconds since 1970, left out
 * when none waits) and how many things it watches; whether it runs with the coding agents; its
 * personality's id and its model, left out when it has none; its folder, the project it works in
 * (left out for a folder of its own) and when it was made, and the limits you set for its work
 * (left out for none). `machine`: the machine's name, left out on a Mac. */
export const BOT = object({
  id: string,
  session: string,
  name: string,
  look: LOOK,
  "machine?": string,
  job: string,
  jobDetails: string,
  paused: bool,
  "wakes?": number,
  watching: number,
  agents: bool,
  "personality?": string,
  "model?": MODEL,
  folder: string,
  "project?": string,
  "created?": string,
  "limits?": LIMITS,
  "allowed?": list(words("makeProject", "cloneProject")),
});
/** The bots that live here, the first made first. */
export const BOTS = object({ bots: list(BOT) });

/** What New Bot offers here: its templates (a template's `personality` left out when it has
 * none), the personalities a bot can have (Kuvo Code's own, then yours, `custom`), the looks it
 * can have, the model a new bot starts on by its place (`mac`, or the machine's name; null for
 * none) and the projects it can work in (each with its machine's name, left out on a Mac). */
export const TEMPLATES = object({
  templates: list(object({ id: string, name: string, job: string, instructions: string, look: LOOK, "personality?": string, wantsProject: bool })),
  personalities: list(object({ id: string, name: string, description: string, "custom?": bool })),
  looks: object({ colors: list(string), shapes: list(string), faces: list(string) }),
  startingModel: map(nullable(MODEL)),
  projects: list(object({ directory: string, name: string, "machine?": string })),
});

/** A bot just made, and its job for your composer to send (from a template or a shared bot's
 * job), or null when it writes first. */
export const MADE = object({ bot: BOT, firstMessage: nullable(string) });
/** A bot as it is after a change, or once it's settled here from another computer (null should it
 * not list now). */
export const CHANGED = object({ bot: nullable(BOT) });

/** The integrations a bot here can have keys of its own for, as Edit Bot shows them: whether it
 * has its own and whether the box has shared ones, the integration's name and symbol, the keys it
 * takes and where to get them (`help`, left out when there's nothing to say). */
export const BOT_KEYS = object({
  keys: list(object({
    integration: string,
    own: bool,
    shared: bool,
    title: string,
    symbol: string,
    keys: list(object({ name: string, label: string, prompt: string })),
    "help?": string,
  })),
});
/** A bot's own keys for one integration, by their names. */
export const BOT_KEY_VALUES = object({ keys: map(string) });
/** One integration's keys of a bot's own, just kept: it has them now, and whether the box has
 * shared ones too. */
export const BOT_KEY_KEPT = object({ integration: string, own: bool, shared: bool });

export type BotLook = Infer<typeof LOOK>;
export type BotModel = Infer<typeof MODEL>;
export type ListedBot = Infer<typeof BOT>;
export type Bots = Infer<typeof BOTS>;
export type BotTemplates = Infer<typeof TEMPLATES>;
export type MadeBot = Infer<typeof MADE>;
export type ChangedBot = Infer<typeof CHANGED>;
export type BotKeys = Infer<typeof BOT_KEYS>;
export type BotKeyValues = Infer<typeof BOT_KEY_VALUES>;
export type BotKeyKept = Infer<typeof BOT_KEY_KEPT>;

export const BOT_ROUTES: RouteShape[] = [
  { route: "GET kuvo/bots", answers: { 200: BOTS } },
  { route: "POST kuvo/bots", answers: { 201: MADE } },
  { route: "GET kuvo/bots/templates", answers: { 200: TEMPLATES } },
  { route: "POST kuvo/bots/retell", answers: { 200: NOTHING } },
  { route: "POST kuvo/bots/keys/refresh", answers: { 200: NOTHING } },
  { route: "PATCH kuvo/bots/:id", answers: { 200: CHANGED } },
  { route: "DELETE kuvo/bots/:id", answers: { 200: NOTHING } },
  { route: "POST kuvo/bots/:id/arrived", answers: { 200: CHANGED } },
  { route: "GET kuvo/bots/:id/keys", answers: { 200: BOT_KEYS } },
  { route: "DELETE kuvo/bots/:id/keys", answers: { 200: NOTHING } },
  { route: "GET kuvo/bots/:id/keys/:integration", answers: { 200: BOT_KEY_VALUES } },
  { route: "PUT kuvo/bots/:id/keys/:integration", answers: { 200: BOT_KEY_KEPT } },
  { route: "DELETE kuvo/bots/:id/keys/:integration", answers: { 200: NOTHING } },
];
