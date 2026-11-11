// A bot's work stopped (Stop All, and Stop the Night): every session of its work that's working or
// waiting on an answer, and the bot's own turn with what it was still to hear of them, since it
// would only start them again; and its work on your other computers, told to each (`stop_work`).
// Each lead hears once, in one message, which of its sessions you stopped (as Stop on one's row
// tells it), so none waits on them; the bot itself as it goes on (your next message, or Resume), its
// queue held until then, so this doesn't set it going.

import { changeQueue, stopSession } from "../engine/queue";
import { botHere } from "../bots/here";
import { noteWorkChanged } from "./changes";
import { atWorkNow, hasWakeUps, readStopped, stopWork } from "./background";
import { askingNow, ofBot, workSessions, workingNow } from "./tree";
import { leadWaitingOn } from "./stopping";
import { forgetWakes, stoppedLine, tellStarters } from "./wakes";
import { leaveCall } from "../letters/calls";
import { stopBotWorkElsewhere } from "../letters/start-call";
import type { Target } from "../../shared/records";

/** How many of `bot`'s sessions were stopped. `tell`: their leads hear it (not for a goal whose end
 * came, which the bot was told of). */
export async function stopBotWork(bot: string, targets: Target[], signal?: AbortSignal, { tell = true }: { tell?: boolean } = {}): Promise<number> {
  const work = ofBot(bot, await workSessions(targets, signal));
  const [working, turns] = await Promise.all([atWorkNow(targets, signal), workingNow(targets, signal)]);
  // Those working (what they left running too), those waiting on an answer (which may not count as
  // working), and those waiting on a timer of their own: nothing comes of them, then, until they're
  // written to.
  let stopped = 0;
  const told: { starter: string; line: string }[] = [];
  for (const each of work) {
    const asking = !turns.has(each.data.id) && await askingNow(each, signal);
    if (!working.has(each.data.id) && !hasWakeUps(each.data.id) && !asking) continue;
    const lead = await leadWaitingOn(each.target, each.data, { turn: turns.has(each.data.id), asking: Boolean(asking) }, signal).catch(() => null);
    // (What waits is held only where a turn stopped: with none running, its next message just goes.)
    if (!await stopWork(each.target, each.data.id, turns.has(each.data.id) || Boolean(asking)).then(() => true, () => false)) continue;
    stopped += 1;
    if (lead && tell) told.push({ starter: lead, line: stoppedLine(each.data) });
  }
  const own = botHere(bot)?.session;
  if (own) {
    forgetWakes(own);
    if (turns.has(own)) {
      for (const target of targets) if (await stopSession(target, own).then(() => true, () => false)) break;
    }
  }
  // (After what it was still to hear is dropped: only that they were stopped, and not to one stopped
  // itself, which its own lead hears of.)
  const marked = readStopped();
  const telling = told.filter(each => marked[each.starter] === undefined);
  if (own && telling.some(each => each.starter === own)) changeQueue(own, state => ({ ...state, paused: true }));
  tellStarters(telling);
  // Its work on your other computers too: each is told, now or once it's back.
  stopBotWorkElsewhere(bot, (peer, from, call) => leaveCall(peer, from, call, { wait: false, quiet: true }));
  noteWorkChanged(bot);
  return stopped;
}
