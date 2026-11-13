// A bot's work, as every client shows it (PROTOCOL.md, "Work"): `GET kuvo/work?bot=<id>`, its
// sessions and where each stands, the asks it answered for them, what it started today and the
// limits you set; `GET kuvo/work/events`, when each bot's work last changed, a line now and one for
// each change; `POST kuvo/bots/<id>/stop-all`, every session of its work stopped, and the bot's own
// turn with what it was still to hear of them. What a bot asks
// you before it does it (`kuvo/work/asks`, its events, and your answer, `POST kuvo/work/asks/<id>`),
// where new projects go (`kuvo/work/settings`), a project made (`POST kuvo/projects/new`), and a
// bot's goal (`kuvo/work/goals`, its events, a goal asked for, `POST kuvo/work/goals/ask`, and your
// answer to one, `POST kuvo/work/goals/<id>`), and the icon of an app its steps are done in
// (`kuvo/work/apps/icon`).

import fs from "node:fs";
import { isObject, parsed } from "../../shared/json";
import { followed } from "../follow";
import { botHere } from "../bots/here";
import { targetsOf } from "../letters/tools";
import { answersOn } from "../work/answers";
import { noteWorkChanged, readWorkChanges, WORK_FOLDER, workFollowers } from "../work/changes";
import { stopBotWork } from "../work/stop";
import { oversightFollowers, readOversight } from "../work/oversight";
import { botLimits } from "../work/limits";
import { answerWork, askFollowers, workAsks } from "../work/asks";
import { madeWords, makeProject } from "../work/projects";
import { startOfDay } from "../work/clock";
import { folderGiven, setKeepsAwake, setProjectsFolder, workSettings } from "../work/settings";
import { awakeForWork, keepsMacAwakeItself } from "../work/awake";
import { unansweringList, unansweringNow } from "../work/unanswering";
import { answerGoal, askGoal, goalFollowers, goalPlans } from "../work/goals";
import { call } from "../engine/client";
import { appIcon, isAppID } from "../work/apps";
import { readProjects } from "./projects";
import { HERE } from "../home";
import { atWorkNow, backgroundFollowers, readBackground } from "../work/background";
import { botOfConversation, describeWork, ofBot, workSessions } from "../work/tree";
import { workAccounts } from "../work/accounts";
import type { BotWork, WorkAnswer } from "../../shared/routes/work";
import type { AnswerPiece, RouteContext } from "../server/context";

export const WORK_ROUTE = /^kuvo\/(?:work(?:\/events|\/oversight(?:\/events)?|\/background(?:\/events)?)?|bots\/([^/]+)\/stop-all)$/;
export const WORK_ASKS_ROUTE = /^kuvo\/work\/(?:settings|unanswering|asks(?:\/([^/]+))?)$/;
export const GOALS_ROUTE = /^kuvo\/work\/goals(?:\/([^/]+))?$/;
export const APP_ICON_ROUTE = "kuvo/work/apps/icon";

// A bot's work as clients show it.
async function botWork(bot: string, context: RouteContext): Promise<BotWork> {
  const { readEngine, bridge, signal } = context;
  const targets = targetsOf({ readEngine, bridge });
  const work = ofBot(bot, await workSessions(targets, signal ?? undefined));
  const working = await atWorkNow(targets, signal ?? undefined);
  // A few at a time: each asks the engine what it asks and said.
  const sessions: Awaited<ReturnType<typeof describeWork>>[] = [];
  const shown = work.slice(0, 60);
  // (The accounts they run on, meanwhile: each provider asked once where it runs.)
  const asked = workAccounts(shown.map(each => ({ id: each.data.id, target: each.target, provider: each.data.model?.providerID })), signal ?? undefined);
  for (let at = 0; at < shown.length; at += 8) {
    sessions.push(...await Promise.all(shown.slice(at, at + 8).map(each => describeWork(each, working, { replies: true, signal: signal ?? undefined }))));
  }
  const answered: WorkAnswer[] = work.flatMap(each => answersOn(each.data.metadata).map(answer => ({ ...answer, session: each.data.id }))).sort((a, b) => b.at - a.at).slice(0, 100);
  const accounts = await asked;
  const midnight = startOfDay(Date.now());
  const today = work.filter(each => (each.data.time?.created ?? 0) >= midnight);
  const cost = today.reduce((sum, each) => sum + (typeof each.data.cost === "number" ? each.data.cost : 0), 0);
  return {
    bot,
    // (A reply from before it was stopped at rest isn't how the stopped work ended: a row can't say so.)
    sessions: sessions.map(({ askID: _, replyBeforeStop, lastReply, ...described }) => {
      const account = accounts.get(described.session);
      const shown = !replyBeforeStop && lastReply ? { ...described, lastReply } : described;
      return account ? { ...shown, account } : shown;
    }),
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
  // What still runs for each session besides its turn: a list now, and again as it changes.
  if (route === "kuvo/work/background" || route === "kuvo/work/background/events") {
    if (method !== "GET") return yield* json(405, {});
    if (route === "kuvo/work/background") return yield* json(200, { sessions: readBackground() });
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => ({ sessions: readBackground() }), backgroundFollowers, signal ?? undefined, { folders: [WORK_FOLDER], recursive: false });
  }
  // What bots just did to their sessions: a list now, and again with each mark.
  if (route === "kuvo/work/oversight" || route === "kuvo/work/oversight/events") {
    if (method !== "GET") return yield* json(405, {});
    if (route === "kuvo/work/oversight") return yield* json(200, { marks: readOversight() });
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => ({ marks: readOversight() }), oversightFollowers, signal ?? undefined, { folders: [WORK_FOLDER], recursive: false });
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
  // What can't answer now, as bots are told: for a client's model picker to say so too.
  if (route === "kuvo/work/unanswering") {
    if (method !== "GET") return yield* json(405, {});
    const held = unansweringNow();
    // (Which of an account's models a hold on its paid or free ones covers: as its engine prices them.)
    const listed = held.some(each => each.paid || each.free) ? await Promise.resolve().then(() => call(readEngine(), "GET", "/api/model", undefined, signal)).catch(() => null) : null;
    return yield* json(200, unansweringList(held, Array.isArray(listed) ? listed : null));
  }
  if (route === "kuvo/work/settings") {
    // (Keep This Mac Awake only where the box keeps its Mac awake itself: the process that does,
    // `serve`, holds or lets go by its next look, ten seconds at most.)
    const awake = () => keepsMacAwakeItself() ? { now: awakeForWork() } : undefined;
    if (method === "GET") return yield* json(200, workSettings(undefined, awake()));
    if (method !== "PATCH") return yield* json(405, {});
    const given = parsed(request.body);
    const keepsAwake = keepsMacAwakeItself() && isObject(given) && "keepsAwake" in given;
    if (!isObject(given) || (!("projectsFolder" in given) && !keepsAwake)) {
      return yield* json(400, { message: keepsMacAwakeItself() ? "Send {projectsFolder}: a full path, or null; or {keepsAwake}: true or false." : "Send {projectsFolder}: a full path, or null." });
    }
    // Both checked before either is kept.
    if (keepsAwake && typeof given.keepsAwake !== "boolean") return yield* json(400, { message: "Say whether to keep this Mac awake while agents work: keepsAwake, true or false." });
    if ("projectsFolder" in given && given.projectsFolder !== null) {
      const checked = folderGiven(given.projectsFolder);
      if ("refused" in checked) return yield* json(400, { message: checked.refused });
    }
    if (keepsAwake) setKeepsAwake(given.keepsAwake);
    if ("projectsFolder" in given) {
      const set = setProjectsFolder(given.projectsFolder);
      if ("refused" in set) return yield* json(400, { message: set.refused });
    }
    return yield* json(200, workSettings(undefined, awake()));
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

// The goals here (each bot's latest), their events, a goal asked for in a bot's chat (/goal), and
// your answer to one: start (with your switches and limits), decline or stop.
export async function* goalsRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  const method = request.method.toUpperCase();
  if (!match[1] || match[1] === "events") {
    if (method !== "GET") return yield* json(405, {});
    if (!match[1]) return yield* json(200, { goals: goalPlans() });
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => ({ goals: goalPlans() }), goalFollowers, signal ?? undefined, { folders: [WORK_FOLDER], recursive: false });
  }
  if (method !== "POST") return yield* json(405, {});
  const given = parsed(request.body);
  const targets = () => targetsOf({ readEngine, bridge });
  if (match[1] === "ask") {
    if (!isObject(given) || typeof given.session !== "string" || !botOfConversation(given.session)) return yield* json(400, { message: "Send {session, goal}: a bot's conversation, and the goal in your words." });
    const outcome = await askGoal(given.session, typeof given.goal === "string" ? given.goal : "", targets);
    if ("refused" in outcome) return yield* json(outcome.refused.status, { message: outcome.refused.message });
    return yield* json(200, outcome);
  }
  const outcome = await answerGoal(decodeURIComponent(match[1]), isObject(given) ? given : {}, targets);
  if ("refused" in outcome) {
    const { status, ...refusal } = outcome.refused;
    return yield* json(status, refusal);
  }
  return yield* json(200, outcome);
}

// `kuvo/work/apps/icon?app=<id>`: the icon of an app on this computer that a goal's step or what
// waits names, by the id the box gave it: a PNG; 404 for one it has none of.
export async function* appIconRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const id = new URLSearchParams(request.path.split("?")[1] ?? "").get("app");
  if (!isAppID(id)) return yield* json(400, { message: "Name the app by its id: kuvo/work/apps/icon?app=<id>." });
  const file = appIcon(id);
  let bytes: Buffer | null = null;
  try { bytes = file ? fs.readFileSync(file) : null; } catch {}
  if (!bytes) return yield* json(404, { message: "There's no icon for that app here." });
  yield { head: { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.length) } } };
  yield { body: bytes };
}
