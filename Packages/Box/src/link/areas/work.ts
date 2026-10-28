// A bot's work, as every client shows it (PROTOCOL.md, "Work"): `GET kuvo/work?bot=<id>`, its
// sessions and where each stands, the asks it answered for them, what it started today and the
// limits you set; `GET kuvo/work/events`, when each bot's work last changed, a line now and one for
// each change; `POST kuvo/bots/<id>/stop-all`, every session of its work stopped.

import { followed } from "../follow";
import { botHere } from "../bots/here";
import { stopSession } from "../engine/queue";
import { targetsOf } from "../letters/tools";
import { answersOn } from "../work/answers";
import { noteWorkChanged, readWorkChanges, WORK_FOLDER, workFollowers } from "../work/changes";
import { botLimits } from "../work/limits";
import { askingNow, describeWork, ofBot, workingNow, workSessions } from "../work/tree";
import type { BotWork, WorkAnswer } from "../../shared/routes/work";
import type { AnswerPiece, RouteContext } from "../server/context";

export const WORK_ROUTE = /^kuvo\/(?:work(?:\/events)?|bots\/([^/]+)\/stop-all)$/;

// A bot's work as clients show it.
async function botWork(bot: string, context: RouteContext): Promise<BotWork> {
  const { readEngine, bridge, signal } = context;
  const targets = targetsOf({ readEngine, bridge });
  const work = ofBot(bot, await workSessions(targets, signal ?? undefined));
  const working = await workingNow(targets, signal ?? undefined);
  // A few at a time: each asks the engine what it asks and said.
  const sessions: Awaited<ReturnType<typeof describeWork>>[] = [];
  const shown = work.slice(0, 60);
  for (let at = 0; at < shown.length; at += 8) {
    sessions.push(...await Promise.all(shown.slice(at, at + 8).map(each => describeWork(each, working, { replies: true, signal: signal ?? undefined }))));
  }
  const answered: WorkAnswer[] = work.flatMap(each => answersOn(each.data.metadata).map(answer => ({ ...answer, session: each.data.id }))).sort((a, b) => b.at - a.at).slice(0, 100);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const today = work.filter(each => (each.data.time?.created ?? 0) >= midnight);
  const cost = today.reduce((sum, each) => sum + (typeof each.data.cost === "number" ? each.data.cost : 0), 0);
  return {
    bot,
    sessions: sessions.map(({ askID: _, ...described }) => described),
    answered,
    today: {
      started: today.length,
      working: sessions.filter(each => each.state === "working" || each.state === "asking").length,
      tokens: today.reduce((sum, each) => sum + (each.data.tokens?.input ?? 0) + (each.data.tokens?.output ?? 0) + (each.data.tokens?.reasoning ?? 0), 0),
      ...(cost > 0 ? { cost } : {}),
    },
    limits: botLimits(bot),
  };
}

export async function* workRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  const method = request.method.toUpperCase();
  const route = request.path.split("?")[0];
  if (route === "kuvo/work/events") {
    if (method !== "GET") return yield* json(405, {});
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => ({ changed: readWorkChanges() }), workFollowers, signal ?? undefined, { folders: [WORK_FOLDER], recursive: false });
  }
  if (route === "kuvo/work") {
    if (method !== "GET") return yield* json(405, {});
    const bot = new URLSearchParams(request.path.split("?")[1] ?? "").get("bot") ?? "";
    if (!bot) return yield* json(400, { message: "Name the bot: kuvo/work?bot=<id>." });
    if (!botHere(bot)) return yield* json(404, { message: "There's no such bot here." });
    try {
      readEngine();
    } catch {
      return yield* json(503, { message: "The engine isn't running." });
    }
    return yield* json(200, await botWork(bot, context));
  }
  // Every session of a bot's work stopped.
  if (method !== "POST") return yield* json(405, {});
  const bot = decodeURIComponent(match[1] ?? "");
  if (!botHere(bot)) return yield* json(404, { message: "There's no such bot here." });
  const targets = targetsOf({ readEngine, bridge });
  if (!targets.length) return yield* json(503, { message: "The engine isn't running." });
  const work = ofBot(bot, await workSessions(targets, signal ?? undefined));
  const working = await workingNow(targets, signal ?? undefined);
  // Those working, and those waiting on an answer (which may not count as working).
  let stopped = 0;
  for (const each of work) {
    if (!working.has(each.data.id) && !(await askingNow(each, signal ?? undefined))) continue;
    if (await stopSession(each.target, each.data.id).then(() => true, () => false)) stopped += 1;
  }
  noteWorkChanged(bot);
  return yield* json(200, { stopped });
}
