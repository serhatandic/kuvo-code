// @ts-nocheck
// A bot that lives here, as its folder has it now: its description (as the app last wrote it, or
// as changed here), its conversation, and whether that runs with the coding agents; null for one
// without a description (made before them, until the Mac connects) or a conversation.

import path from "node:path";
import { DESCRIPTION } from "../areas/wakes";
import { textOf } from "../files";
import { BOTS } from "../home";

export function botHere(id) {
  if (typeof id !== "string" || !/^bot_[A-Za-z0-9]+$/.test(id)) return null;
  const folder = path.join(BOTS, id);
  let described;
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
export const isMoving = folder => (textOf(path.join(folder, "paused")) ?? "").trim() === "moving";
export const MOVING = "It’s moving to another computer. Try again once it’s there.";

export const isModel = model => Boolean(model) && typeof model.id === "string" && typeof model.providerID === "string";
export const sameModel = (a, b) => (a?.id ?? null) === (b?.id ?? null) && (a?.providerID ?? null) === (b?.providerID ?? null) && (a?.variant ?? null) === (b?.variant ?? null);

// Those following this box's bots (`kuvo/bots/events`), told of a change made here at once (one
// made beside it, by kuvo-wake or a move, they see as their folders change).
export const botFollowers = new Set();
export const noteBotsChanged = () => { for (const tell of botFollowers) tell(); };