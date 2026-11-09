// A bot's work stopped (Stop All, and Stop the Night): every session of its work that's working or
// waiting on an answer, and the bot's own turn with what it was still to hear of them, since it
// would only start them again; and its work on your other computers, told to each (`stop_work`).

import { stopSession } from "../engine/queue";
import { botHere } from "../bots/here";
import { noteWorkChanged } from "./changes";
import { atWorkNow, hasWakeUps, stopWork } from "./background";
import { askingNow, ofBot, workSessions, workingNow } from "./tree";
import { forgetWakes } from "./wakes";
import { leaveCall } from "../letters/calls";
import { stopBotWorkElsewhere } from "../letters/start-call";
import type { Target } from "../../shared/records";

/** How many of `bot`'s sessions were stopped. */
export async function stopBotWork(bot: string, targets: Target[], signal?: AbortSignal): Promise<number> {
  const work = ofBot(bot, await workSessions(targets, signal));
  const [working, turns] = await Promise.all([atWorkNow(targets, signal), workingNow(targets, signal)]);
  // Those working (what they left running too), those waiting on an answer (which may not count as
  // working), and those waiting on a timer of their own: nothing comes of them, then, until they're
  // written to.
  let stopped = 0;
  for (const each of work) {
    const asking = !turns.has(each.data.id) && await askingNow(each, signal);
    if (!working.has(each.data.id) && !hasWakeUps(each.data.id) && !asking) continue;
    // (What waits is held only where a turn stopped: with none running, its next message just goes.)
    if (await stopWork(each.target, each.data.id, turns.has(each.data.id) || Boolean(asking)).then(() => true, () => false)) stopped += 1;
  }
  const own = botHere(bot)?.session;
  if (own) {
    forgetWakes(own);
    if (turns.has(own)) {
      for (const target of targets) if (await stopSession(target, own).then(() => true, () => false)) break;
    }
  }
  // Its work on your other computers too: each is told, now or once it's back.
  stopBotWorkElsewhere(bot, (peer, from, call) => leaveCall(peer, from, call, { wait: false, quiet: true }));
  noteWorkChanged(bot);
  return stopped;
}
