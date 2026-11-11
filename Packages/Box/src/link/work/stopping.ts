// Stopping a session someone started, for the user (Stop on its row, Stop All) rather than its lead
// (stop_session): its lead is told once that the user stopped it, if it was still waiting on it, so
// it never waits on a session that won't finish now (PROTOCOL.md, "Work › Background work ›
// Stopping"). Nothing more comes from it after that until it's written to again.

import type { Target } from "../../shared/records";
import { stopSession } from "../engine/queue";
import type { EngineSession } from "../engine/sessions";
import { hasWakeUps, readBackground, readStopped, stopWork } from "./background";
import { askingNow, isArchived, startedByOf, wakesOf, workingNow, type Listed } from "./tree";
import { finishHeld, stoppedLine, tellStarters } from "./wakes";

type Session = Partial<EngineSession> & { id: string };

/** Who's to hear that the user stopped `data`: its starter, when it follows its finishes and still
 * waits on it (a turn under way, what it left running, its finish held, a wake-up of its own, or a
 * question of its waiting); null for none, or one stopped already. `atWork`: known to be already.
 * Asked before it's stopped. */
export async function leadWaitingOn(target: Target, data: Session, atWork = false, signal?: AbortSignal): Promise<string | null> {
  const starter = startedByOf(data);
  if (!starter || !wakesOf(data).includes("finished") || isArchived(data) || readStopped()[data.id] !== undefined) return null;
  if (atWork || readBackground()[data.id] || finishHeld(data.id) || hasWakeUps(data.id)) return starter;
  if ((await workingNow([target], signal)).has(data.id)) return starter;
  return (await askingNow({ target, data } as Listed, signal).catch(() => null)) ? starter : null;
}

/** Stop for any conversation, from a client: one someone started goes as `stopWork`, and its lead is
 * told the user stopped it; your own conversation stops its turn and keeps what you left running and
 * set to come back (as Stop does in Claude Code and Codex: a command in the background ends from its
 * own row). */
export async function stopConversation(target: Target, data: Session): ReturnType<typeof stopSession> {
  if (!startedByOf(data)) return stopSession(target, data.id);
  const lead = await leadWaitingOn(target, data).catch(() => null);
  const state = await stopWork(target, data.id, true);
  if (lead) tellStarters([{ starter: lead, line: stoppedLine(data) }]);
  return state;
}
