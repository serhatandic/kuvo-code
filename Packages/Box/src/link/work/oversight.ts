// What each bot does to its sessions, a moment at a time (`run/work/oversight.json`): it started one,
// wrote to one, read one, answered what one asked, stopped one, or one finished. Clients show the bot
// looking after its sessions with it (`kuvo/work/oversight/events`): each mark played once, as it's
// made, then gone. Only the latest minute is kept; a client that wasn't there missed nothing it
// should still show. Every process that acts for a bot notes it here (a tool's `box route` too).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { locked, writePrivate } from "../files";
import { WORK_FOLDER } from "./changes";
import { botOfConversation, worksFor } from "./tree";
import type { OversightKind, OversightMark } from "../../shared/routes/work";
import type { EngineSession } from "../engine/sessions";

export const OVERSIGHT = path.join(WORK_FOLDER, "oversight.json");
const KEPT_FOR = 60_000;
const KEPT_AT_MOST = 50;
const KINDS: readonly OversightKind[] = ["started", "told", "read", "answered", "stopped", "finished"];

/** Those following it here, in this process: told at once of a mark made here. */
export const oversightFollowers = new Set<() => void>();

/** The marks of the latest minute, the oldest first. */
export function readOversight(file = OVERSIGHT, now = Date.now()): OversightMark[] {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(kept)) return [];
    return kept.filter((mark): mark is OversightMark => isObject(mark) && typeof mark.id === "string" && typeof mark.bot === "string"
      && typeof mark.session === "string" && KINDS.includes(mark.kind as OversightKind) && typeof mark.at === "number" && now - mark.at < KEPT_FOR);
  } catch {
    return [];
  }
}

/** `bot` did `kind` to its session `session`, now. */
export function noteOversight(bot: string, session: string, kind: OversightKind, file = OVERSIGHT): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    locked(path.join(path.dirname(file), ".oversight.lock"), () => {
      const now = Date.now();
      const marks = [...readOversight(file, now), { id: crypto.randomUUID(), bot, session, kind, at: now }];
      writePrivate(file, JSON.stringify(marks.slice(-KEPT_AT_MOST)));
    });
  } catch {}
  for (const tell of oversightFollowers) tell();
}

/** What the conversation `caller` did to `data`, noted when it's a bot's and the session works for
 * that bot; nothing for anyone else's. */
export function noteOversightBy(caller: string | null | undefined, data: Partial<EngineSession> & { id?: string }, kind: OversightKind): void {
  const bot = botOfConversation(caller)?.bot;
  if (bot && data.id && worksFor(data)?.bot === bot) noteOversight(bot, data.id, kind);
}
