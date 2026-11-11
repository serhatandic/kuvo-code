// notify_user (PROTOCOL.md, "Agents' tools"): an agent tells you something on purpose, in one
// sentence, on your phones and in your clients' notifications. A reply of an agent working on its
// own (a wake-up, a watch, another agent's message) isn't news (news.ts, NOTIFY_RULE), so this is
// how it reaches you then. Limited, so an agent in a loop can't keep buzzing your phone.

import { isBot, projectNameOf } from "./news";
import { oneSentence } from "./sentence";
import { keepTold, tellingNow, type ToldNotice } from "./told";
import type { EngineSession } from "../engine/sessions";
import type { Notice } from "./notice";

/** What a tool says back to its agent. */
interface ToolAnswer {
  text: string;
  isError: boolean;
}

/** How many a conversation may send: in an hour, in a day, and how long after the last; and all
 * of this box's agents together in an hour (a bot's many sessions can't add up to a flood). */
export const NOTIFY_LIMITS = { hour: 3, day: 12, apart: 2 * 60_000, boxHour: 10 } as const;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The notice a conversation's `text` makes: who's telling (a bot by its name, a conversation by its
 * title, with its project) and the sentence. */
export function sentNotice(session: Partial<EngineSession> & { id: string }, name: string | null, sentence: string): Notice {
  const bot = isBot(session as EngineSession);
  return {
    title: (bot ? name : session.title) || session.title || "New Session",
    subtitle: bot ? undefined : projectNameOf(session.location?.directory ?? "", session),
    body: sentence,
    category: bot ? "report" : "finished",
    thread: session.id,
    data: { session: session.id },
  };
}

/** notify_user from the conversation `caller` (its session's data, and its name as agents know it):
 * its `text` told, as one sentence, unless it's past its limit or says the same as one it sent
 * today. */
export function notifyUserTool(caller: { session: string; data: Partial<EngineSession>; name: string | null }, args: Record<string, unknown>, now = Date.now(), telling = tellingNow): ToolAnswer {
  if (caller.data.metadata?.kuvo?.seat) return { text: "In a group chat, say it in the chat: the user reads it there.", isError: true };
  const sentence = oneSentence(args.text);
  if (!sentence) return { text: "Give the text: one sentence saying what you need from the user.", isError: true };
  // Nothing here would tell your phones (a machine whose bridge isn't running): said, not lost.
  if (!telling()) return { text: "Notifications can't be sent from this computer now. Put it in your reply.", isError: true };
  // (Looked at and kept at once, so two calls together can't both pass.)
  const why = (kept: ToldNotice[]): string | null => {
    const byAgents = kept.filter(each => each.by === "agent");
    const sent = byAgents.filter(each => each.notice.thread === caller.session);
    const lastHour = sent.filter(each => now - each.at < HOUR);
    const lastDay = sent.filter(each => now - each.at < DAY);
    const last = sent.at(-1);
    if (lastDay.some(each => each.notice.body === sentence)) return "You already sent the user that today. They'll see it; don't send it again.";
    if (last && now - last.at < NOTIFY_LIMITS.apart) return "You notified the user a moment ago. Wait for them: put anything more in your reply.";
    if (lastHour.length >= NOTIFY_LIMITS.hour) return `You've notified the user ${lastHour.length} times this hour, the most there is. Put it in your reply; they'll read it there.`;
    if (lastDay.length >= NOTIFY_LIMITS.day) return `You've notified the user ${lastDay.length} times today, the most there is. Put it in your reply; they'll read it there.`;
    if (byAgents.filter(each => now - each.at < HOUR).length >= NOTIFY_LIMITS.boxHour) return "The user has had many notifications from agents this hour. Put it in your reply; they'll read it there.";
    return null;
  };
  const told = keepTold(sentNotice({ ...caller.data, id: caller.session }, caller.name, sentence), { by: "agent", now, unless: why });
  if (!told) return { text: "The notification couldn't be sent just now. Put it in your reply.", isError: true };
  if ("refused" in told) return { text: told.refused, isError: true };
  return { text: `Sent to the user: “${sentence}”`, isError: false };
}
