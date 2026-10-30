// A bot's work stopped (Stop All, and Stop the Night): every session of its work that's working or
// waiting on an answer, and the bot's own turn with what it was still to hear of them, since it
// would only start them again.

import { stopSession } from "../engine/queue";
import { botHere } from "../bots/here";
import { noteWorkChanged } from "./changes";
import { askingNow, ofBot, workingNow, workSessions } from "./tree";
import { forgetWakes } from "./wakes";
import type { Target } from "../../shared/records";

/** How many of `bot`'s sessions were stopped. */
export async function stopBotWork(bot: string, targets: Target[], signal?: AbortSignal): Promise<number> {
  const work = ofBot(bot, await workSessions(targets, signal));
  const working = await workingNow(targets, signal);
  // Those working, and those waiting on an answer (which may not count as working).
  let stopped = 0;
  for (const each of work) {
    if (!working.has(each.data.id) && !(await askingNow(each, signal))) continue;
    if (await stopSession(each.target, each.data.id).then(() => true, () => false)) stopped += 1;
  }
  const own = botHere(bot)?.session;
  if (own) {
    forgetWakes(own);
    if (working.has(own)) {
      for (const target of targets) if (await stopSession(target, own).then(() => true, () => false)) break;
    }
  }
  noteWorkChanged(bot);
  return stopped;
}
