// A bot's work, as every client shows it (PROTOCOL.md, "Work"): `GET kuvo/work?bot=<id>`, its
// sessions and where each stands, the asks it answered for them, what it started today and the
// limits you set; `GET kuvo/work/events`, when each bot's work last changed, a line now and one for
// each change; `POST kuvo/bots/<id>/stop-all`, every session of its work stopped, and the bot's own
// turn with what it was still to hear of them. What a bot asks
// you before it does it (`kuvo/work/asks`, its events, and your answer, `POST kuvo/work/asks/<id>`),
// where new projects go (`kuvo/work/settings`), a project made (`POST kuvo/projects/new`), and a
// bot's night (`kuvo/work/nights`, its events, and your answer, `POST kuvo/work/nights/<id>`).

import { isObject, parsed } from "../../shared/json";
import { followed } from "../follow";
import { botHere } from "../bots/here";
import { targetsOf } from "../letters/tools";
import { answersOn } from "../work/answers";
import { noteWorkChanged, readWorkChanges, WORK_FOLDER, workFollowers } from "../work/changes";
import { stopBotWork } from "../work/stop";
import { botLimits } from "../work/limits";
import { answerWork, askFollowers, workAsks } from "../work/asks";
import { madeWords, makeProject } from "../work/projects";
import { setProjectsFolder, workSettings } from "../work/settings";
import { answerNight, nightFollowers, nights } from "../work/night";
import { readProjects } from "./projects";
import { HERE } from "../home";
import { describeWork, ofBot, workingNow, workSessions } from "../work/tree";
import type { BotWork, WorkAnswer } from "../../shared/routes/work";
import type { AnswerPiece, RouteContext } from "../server/context";

export const WORK_ROUTE = /^kuvo\/(?:work(?:\/events)?|bots\/([^/]+)\/stop-all)$/;
export const WORK_ASKS_ROUTE = /^kuvo\/work\/(?:settings|asks(?:\/([^/]+))?)$/;
export const NIGHTS_ROUTE = /^kuvo\/work\/nights(?:\/([^/]+))?$/;

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
    asks: workAsks().filter(ask => ask.bot === bot),
    projects: readProjects().filter(project => !project.removed && project.madeBy?.bot === bot),
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
  const stopped = await stopBotWork(bot, targets, signal ?? undefined);
  return yield* json(200, { stopped });
}

// What's asked of you, your answers, and where new projects go.
export async function* workAsksRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  const method = request.method.toUpperCase();
  const route = request.path.split("?")[0];
  if (route === "kuvo/work/settings") {
    if (method === "GET") return yield* json(200, workSettings());
    if (method !== "PATCH") return yield* json(405, {});
    const given = parsed(request.body);
    if (!isObject(given) || !("projectsFolder" in given)) return yield* json(400, { message: "Send {projectsFolder}: a full path, or null." });
    const set = setProjectsFolder(given.projectsFolder);
    if ("refused" in set) return yield* json(400, { message: set.refused });
    return yield* json(200, workSettings());
  }
  if (route === "kuvo/work/asks" || match[1] === "events") {
    if (method !== "GET") return yield* json(405, {});
    if (route === "kuvo/work/asks") return yield* json(200, { asks: workAsks() });
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => ({ asks: workAsks() }), askFollowers, signal ?? undefined, { folders: [WORK_FOLDER], recursive: false });
  }
  if (method !== "POST") return yield* json(405, {});
  const given = parsed(request.body);
  const outcome = await answerWork(decodeURIComponent(match[1] ?? ""), isObject(given) ? given : {}, () => targetsOf({ readEngine, bridge }));
  if ("refused" in outcome) return yield* json(outcome.refused.status, { message: outcome.refused.message });
  return yield* json(200, { answer: outcome.answered.answer, text: outcome.answered.text, isError: outcome.answered.isError });
}

// A project made by a client, as New Project would, in the projects folder (`{name, git?, clone?}`).
export async function* newProjectRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const given = parsed(request.body);
  if (!isObject(given)) return yield* json(400, { message: "Send {name}, and git or clone." });
  const outcome = await makeProject(given, null);
  if ("refused" in outcome) {
    const { status, ...refusal } = outcome.refused;
    return yield* json(status, refusal);
  }
  return yield* json(201, { project: outcome.made.project, text: madeWords(outcome.made, HERE) });
}

// The nights here (each bot's latest), their events, and your answer to one: start (with your
// switches), decline or stop.
export async function* nightsRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  const method = request.method.toUpperCase();
  if (!match[1] || match[1] === "events") {
    if (method !== "GET") return yield* json(405, {});
    if (!match[1]) return yield* json(200, { nights: nights() });
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => ({ nights: nights() }), nightFollowers, signal ?? undefined, { folders: [WORK_FOLDER], recursive: false });
  }
  if (method !== "POST") return yield* json(405, {});
  const given = parsed(request.body);
  const outcome = await answerNight(decodeURIComponent(match[1]), isObject(given) ? given : {}, () => targetsOf({ readEngine, bridge }));
  if ("refused" in outcome) {
    const { status, ...refusal } = outcome.refused;
    return yield* json(status, refusal);
  }
  return yield* json(200, outcome);
}
