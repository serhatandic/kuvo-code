// notify_user (PROTOCOL.md, "Agents' tools"): an agent tells you something on purpose, in one
// sentence, on your phones and in your clients' notifications. A reply of an agent working on its
// own (a wake-up, a watch, another agent's message) isn't news (news.ts, NOTIFY_RULE), so this is
// how it reaches you then. Limited, so an agent in a loop can't keep buzzing your phone.

import { isBot, projectNameOf } from "./news";
import { oneSentence } from "./sentence";
import { keepTold, readTold } from "./told";
import type { EngineSession } from "../engine/sessions";
import type { Notice } from "./notice";

/** What a tool says back to its agent. */
interface ToolAnswer {
  text: string;
  isError: boolean;
}

/** How many a conversation may send: in an hour, in a day, and how long after the last. */
export const NOTIFY_LIMITS = { hour: 3, day: 12, apart: 2 * 60_000 } as const;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The notice a conversation's `text` makes: who's telling (a bot by its name, a conversation by its
 * title, with its project) and the sentence. */
export function sentNotice(session: Partial<EngineSession> & { id: string }, name: string | null, sentence: string): Notice {
  const bot = isBot(session as EngineSession);
  return {
    title: (bot ? name : session.title) || session.title || "New Session",
    subtitle: bot ? undefined : projectNameOf(session.location?.directory ?? ""),
    body: sentence,
    category: bot ? "report" : "finished",
    thread: session.id,
    data: { session: session.id },
  };
}

/** notify_user from the conversation `caller` (its session's data, and its name as agents know it):
 * its `text` told, as one sentence, unless it's past its limit or says the same as one it sent
 * today. */
export function notifyUserTool(caller: { session: string; data: Partial<EngineSession>; name: string | null }, args: Record<string, unknown>, now = Date.now()): ToolAnswer {
  if (caller.data.metadata?.kuvo?.seat) return { text: "In a group chat, say it in the chat: the user reads it there.", isError: true };
  const sentence = oneSentence(args.text);
  if (!sentence) return { text: "Give the text: one sentence saying what you need from the user.", isError: true };
  const sent = readTold().filter(each => each.by === "agent" && each.notice.thread === caller.session);
  const lastHour = sent.filter(each => now - each.at < HOUR);
  const lastDay = sent.filter(each => now - each.at < DAY);
  const last = sent.at(-1);
  if (lastDay.some(each => each.notice.body === sentence)) return { text: "You already sent the user that today. They'll see it; don't send it again.", isError: true };
  if (last && now - last.at < NOTIFY_LIMITS.apart) return { text: "You notified the user a moment ago. Wait for them: put anything more in your reply.", isError: true };
  if (lastHour.length >= NOTIFY_LIMITS.hour || lastDay.length >= NOTIFY_LIMITS.day) {
    return { text: `You've notified the user ${lastHour.length >= NOTIFY_LIMITS.hour ? `${lastHour.length} times this hour` : `${lastDay.length} times today`}, the most there is. Put it in your reply; they'll read it there.`, isError: true };
  }
  const told = keepTold(sentNotice({ ...caller.data, id: caller.session }, caller.name, sentence), { by: "agent", now });
  if (!told) return { text: "The notification couldn't be sent just now. Put it in your reply.", isError: true };
  return { text: `Sent to the user: “${sentence}”`, isError: false };
}
