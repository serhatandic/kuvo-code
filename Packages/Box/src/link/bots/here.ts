// A bot that lives here: what its folder has, whether it's moving, its model, and who follows its
// changes.

import fs from "node:fs";
import path from "node:path";
import { locked, textOf } from "../files";
import type { Fields } from "../../shared/json";
import type { BotLook, BotModel } from "../../shared/routes/bots";
import { BOTS } from "../home";

// What the Mac answers for them (PROTOCOL.md, `kuvo/bots` and `kuvo/wakes`), answered here from
// the folders the app keeps on the machine, so a phone has them with the Mac closed: a bot's
// description (`bot.json`, which the app writes from its list), its session, and the wake-ups,
// watches and pause that `kuvo-wake` keeps beside them.
// The version of `bot.json` this reads (the app's `Bot.Descriptor`).
export const DESCRIPTION = 1;

/** A bot's description (`bot.json`), as the app writes it from its list (`Bot.Descriptor`) or as
 * it's changed here: what this reads of it, and the rest as it's kept. */
export interface BotDescription {
  kuvo: typeof DESCRIPTION;
  id: string;
  name: string;
  personality?: string;
  model?: BotModel | null;
  project?: string;
  // (The rest of what the app writes: its job, its look, when it was made.)
  [more: string]: unknown;
}

/** A bot that lives here: its folder, its description, its conversation, and whether that runs
 * with the coding agents. */
export interface BotHere {
  folder: string;
  described: BotDescription;
  session: string;
  agents: boolean;
}

// A bot that lives here, as its folder has it now: its description (as the app last wrote it, or
// as changed here), its conversation, and whether that runs with the coding agents; null for one
// without a description (made before them, until the Mac connects) or a conversation.
export function botHere(id: unknown): BotHere | null {
  if (typeof id !== "string" || !/^bot_[A-Za-z0-9]+$/.test(id)) return null;
  const folder = path.join(BOTS, id);
  let described: BotDescription;
  try {
    described = JSON.parse(textOf(path.join(folder, "bot.json")) ?? "");
  } catch {
    return null;
  }
  const session = (textOf(path.join(folder, "session")) ?? "").trim();
  if (described?.kuvo !== DESCRIPTION || described.id !== id || typeof described.name !== "string" || !session) return null;
  return { folder, described, session, agents: (textOf(path.join(folder, "via")) ?? "").trim() === "bridge" };
}

// On its way to another computer: a move holds its wake-ups (the Mac's Moves.hold), and nothing
// reaches it or changes here until it's there, as on the Mac.
export const isMoving = (folder: string): boolean => (textOf(path.join(folder, "paused")) ?? "").trim() === "moving";
export const MOVING = "It’s moving to another computer. Try again once it’s there.";
// How long a step of making or deleting a bot waits on the engine, once it's under way: it goes on
// without the phone's request, which may end first.
export const BOT_STEP = 30_000;

/** A model as `isModel` checks it: its id and its account's are text; its variant, and anything
 * else that came with it, aren't checked (`botModel` keeps a variant only when it's text). */
export type GivenModel = Pick<BotModel, "id" | "providerID"> & Fields<"variant">;

export const isModel = (model: unknown): model is GivenModel => Boolean(model) && typeof (model as Fields<"id">).id === "string" && typeof (model as Fields<"providerID">).providerID === "string";
// A look and a model as a bot keeps them, made or changed: their own fields, nothing else that came
// with them.
export const botLook = (look: BotLook): BotLook => ({ color: look.color, shape: look.shape, face: look.face });
export const botModel = (model: GivenModel): BotModel => ({ id: model.id, providerID: model.providerID, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) });
export const sameModel = (a: Partial<BotModel> | null | undefined, b: Partial<BotModel> | null | undefined): boolean => (a?.id ?? null) === (b?.id ?? null) && (a?.providerID ?? null) === (b?.providerID ?? null) && (a?.variant ?? null) === (b?.variant ?? null);

// Those following this box's bots (`kuvo/bots/events`), told of a change made here at once (one
// made beside it, by kuvo-wake or a move, they see as their folders change).
export const botFollowers = new Set<() => void>();
export const noteBotsChanged = () => { for (const tell of botFollowers) tell(); };
/** A bot's description (`bot.json`) written as `change` makes it from what's there now, one process
 * at a time: an Edit Bot save and an "Always" answered at once both land. */
export function changeDescription(folder: string, change: (now: BotDescription | null) => BotDescription): BotDescription {
  return locked(path.join(folder, ".bot.lock"), () => {
    let now: BotDescription | null = null;
    try { now = JSON.parse(textOf(path.join(folder, "bot.json")) ?? ""); } catch {}
    const next = change(now);
    const file = path.join(folder, "bot.json");
    fs.writeFileSync(`${file}.new`, JSON.stringify(next, null, 2));
    fs.renameSync(`${file}.new`, file);
    return next;
  });
}
