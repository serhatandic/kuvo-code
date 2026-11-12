// The box's routes
// What a phone, or this Mac's app, asks of this box: each route to the area that answers it, the
// first that takes a request answering it; what none takes goes on to the engine (`engineRoute`).
// Which route answers is by its path alone: a query string never changes it (as on a Mac).

import { processRuns as runs } from "../../shared/platform";
import { accountsRoute, credentialsRoute } from "../areas/accounts";
import { agentToolsRoute, startRoute } from "../areas/agent-tools";
import { SESSION_MOVE_ROUTE, sessionMoveRoute } from "../areas/session-move";
import { foundRoute } from "../areas/found";
import { searchRoute } from "../areas/search";
import { setupRoute } from "../areas/setup";
import { changesRoute } from "../areas/changes";
import { askAnswerRoute, asksRoute } from "../areas/asks";
import { appNoticeRoute, attentionRoute } from "../areas/attention";
import { botKeysRefreshRoute, botKeysRoute } from "../areas/bot-keys";
import { arrivedRoute, botEventsRoute, botRoute, botsRoute, botTemplatesRoute, newBotRoute, retellRoute } from "../areas/bots";
import { CARRY_ROUTE, carryRoute } from "../areas/carry";
import { engineControlRoute, signInReturnRoute } from "../areas/engine";
import { fileAt } from "../areas/file";
import { foldersRoute } from "../areas/folders";
import { ARTIFACT_ROUTE, artifactsRoute } from "../areas/artifacts";
import { GROUP_ROUTE, groupsRoute } from "../areas/groups";
import { infoRoute } from "../areas/info";
import { integrationsRoute } from "../areas/integrations";
import { namedRoute } from "../areas/named";
import { noticesRoute } from "../areas/notices";
import { personalitiesDocumentRoute, personalityEventsRoute, personalityRoute } from "../areas/personalities";
import { pairingRoute, phonesRemoveRoute, phonesRoute } from "../areas/phones";
import { QUEUE_ROUTE, queueRoute } from "../areas/queue";
import { GLANCE_ROUTE, glanceRoute } from "../areas/glance";
import { SESSION_MODELS_ROUTE, sessionModelsRoute } from "../areas/session-models";
import { READ_ALL_ROUTE, readAllRoute } from "../areas/read-all";
import { WORK_QUEUE_ROUTE, workQueueRoute } from "../areas/work-queue";
import { pluginSearchRoute } from "../areas/plugins";
import { programsRoute } from "../areas/programs";
import { backupsRoute } from "../areas/backups";
import { approvalRoute, SESSION_APPROVAL_ROUTE, SESSION_DECISIONS_ROUTE } from "../areas/approval";
import { autopilotRoute, SESSION_AUTOPILOT_ROUTE } from "../areas/autopilot";
import { sandboxRoute } from "../areas/sandbox";
import { providerModelsRoute } from "../areas/providers";
import { answerProjects } from "../areas/projects";
import { settingsRoute } from "../areas/settings";
import { skillsRoute } from "../areas/skills";
import { moveEventsRoute, movePlacesRoute, movesRoute } from "../areas/moves";
import { sessionWakesRoute, wakeEventsRoute, wakesRoute } from "../areas/wakes";
import { worktreeEventsRoute, worktreesRoute } from "../areas/worktrees";
import { APP_ICON_ROUTE, appIconRoute, newProjectRoute, GOALS_ROUTE, goalsRoute, WORK_ASKS_ROUTE, WORK_ROUTE, workAsksRoute, workRoute } from "../areas/work";
import { phoneHere } from "../compat/leave-running";
import { readBridgeFile, readEngineFile } from "../engine/client";
import { linkRoute } from "../mac/routes";
import { updateRoute } from "../updates/update";
import { browserRoute } from "../browser/install";
import { IS_MAC } from "../home";
import { vaultRoute } from "../areas/vault";
import { AGENTS, agentsRoute, engineRoute } from "./forward";
import type { BridgeRecord, EngineRecord } from "../../shared/records";
import type { NoticeHold } from "../notices/hold";
import type { Answer, AnswerPiece, Asker, LinkHandler, LinkRequest, RouteContext } from "./context";

/** One of the box's routes: `when(route, request)` says whether it takes the request, and gives
 * what its `answer(context, match)` is given: the route's match for one with a part of its own
 * (`Match` a RegExpMatchArray), else `true`. */
export interface Route<Match = true> {
  when: (route: string, request: LinkRequest) => Match | false | null;
  answer: (context: RouteContext, match: Match) => Answer;
}

// `when(route, request)`: whether it takes the request (a route's match, for one with a part of its
// own); `answer(context, match)`: its answer, as it comes.
// Their order counts where they overlap: a list and its events come before the route for one of
// its own ("events" isn't an id), as personalities', asks' and wake-ups' do.
const ROUTES: (Route | Route<RegExpMatchArray>)[] = [
  { when: route => route === "kuvo/info", answer: infoRoute },
  { when: route => route === "kuvo/vault" || route.startsWith("kuvo/vault/"), answer: vaultRoute },
  { when: route => route === "kuvo/sandbox" || route.startsWith("kuvo/sandbox/"), answer: sandboxRoute },
  { when: route => route === "kuvo/file", answer: ({ request, json }: RouteContext) => fileAt(request.path, json) },
  { when: route => route === "kuvo/update", answer: updateRoute },
  // (A machine's: this Mac's agents browse in its app's panel.)
  { when: route => !IS_MAC && route === "kuvo/browser", answer: browserRoute },
  { when: (route, request) => /^kuvo\/integrations(\/|\?|$)/.test(request.path), answer: integrationsRoute },
  { when: route => route === "kuvo/folders", answer: foldersRoute },
  { when: route => route === "kuvo/plugins/search", answer: pluginSearchRoute },
  { when: route => route === "kuvo/programs", answer: programsRoute },
  { when: route => route === "kuvo/providers/models", answer: providerModelsRoute },
  { when: (route, request) => /^kuvo\/(skills|skill-library|skill-trash)(\/|\?|$)/.test(request.path), answer: skillsRoute },
  { when: (route, request) => /^kuvo\/(config|mcp\/catalog|keys)(\/|\?|$)/.test(request.path), answer: settingsRoute },
  { when: route => route === "kuvo/setup" || route === "kuvo/setup/events" || route === "kuvo/setup/judge" || route === "kuvo/setup/attached", answer: setupRoute },
  { when: route => route === "kuvo/phones", answer: phonesRoute },
  { when: route => route === "kuvo/phones/remove", answer: phonesRemoveRoute },
  { when: route => route === "kuvo/phones/pair", answer: pairingRoute },
  { when: route => route === "kuvo/link" || route.startsWith("kuvo/link/"), answer: linkRoute },
  { when: route => route === "kuvo/attention/notice" || route === "kuvo/attention/answered", answer: appNoticeRoute },
  { when: route => route === "kuvo/attention", answer: attentionRoute },
  { when: route => route === "kuvo/notices" || route === "kuvo/notices/events", answer: noticesRoute },
  { when: route => route === "kuvo/named", answer: namedRoute },
  { when: route => route === "kuvo/agent-tools", answer: agentToolsRoute },
  { when: route => route === "kuvo/sessions", answer: startRoute },
  { when: route => SESSION_MOVE_ROUTE.test(route), answer: sessionMoveRoute },
  { when: route => route === "kuvo/approval" || SESSION_APPROVAL_ROUTE.test(route) || SESSION_DECISIONS_ROUTE.test(route), answer: approvalRoute },
  { when: route => SESSION_AUTOPILOT_ROUTE.test(route), answer: autopilotRoute },
  { when: route => route.match(QUEUE_ROUTE), answer: queueRoute },
  // A session at a glance: its row's and card's (PROTOCOL.md, "A session at a glance").
  { when: route => route.match(GLANCE_ROUTE), answer: glanceRoute },
  // What a session's model button shows, and whether its model can run (PROTOCOL.md, "A session's model").
  { when: route => route === SESSION_MODELS_ROUTE, answer: sessionModelsRoute },
  // Mark All as Read (PROTOCOL.md, "What's been read").
  { when: route => route === READ_ALL_ROUTE, answer: readAllRoute },
  // The Work Queue (PROTOCOL.md, "The Work Queue"), before a bot's work, whose routes it starts like.
  { when: route => route.match(WORK_QUEUE_ROUTE), answer: workQueueRoute },
  { when: route => route === "kuvo/search", answer: searchRoute },
  { when: route => route === "kuvo/git/backups" || route === "kuvo/git/backups/restore", answer: backupsRoute },
  { when: route => route.startsWith("kuvo/git/"), answer: changesRoute },
  { when: route => route === "kuvo/asks" || route === "kuvo/asks/events", answer: asksRoute },
  { when: route => route.match(/^kuvo\/asks\/([^/]+)$/), answer: askAnswerRoute },
  { when: route => route.match(/^kuvo\/engine\/(start|restart)$/), answer: engineControlRoute },
  { when: route => route === "kuvo/sign-in/return", answer: signInReturnRoute },
  { when: (route, request) => request.path.startsWith(AGENTS), answer: agentsRoute },
  { when: route => route === "kuvo/accounts/ended" || route === "kuvo/accounts/refreshable" || /^kuvo\/accounts\/[^/]+\/(forget|refresh)$/.test(route), answer: accountsRoute },
  { when: route => route === "kuvo/accounts/credentials", answer: credentialsRoute },
  { when: route => route === "kuvo/accounts/found" || route === "kuvo/accounts/found/use", answer: foundRoute },
  { when: route => route === "kuvo/personalities/events", answer: personalityEventsRoute },
  { when: route => route === "kuvo/personalities/document" || route === "kuvo/personalities/take", answer: personalitiesDocumentRoute },
  { when: route => route.match(/^kuvo\/personalities(?:\/([^/]+))?$/), answer: personalityRoute },
  { when: route => route === "kuvo/bots/templates", answer: botTemplatesRoute },
  // (A new bot; reading them is `botsRoute`, further on.)
  { when: (route, request) => request.method.toUpperCase() === "POST" && route === "kuvo/bots", answer: newBotRoute },
  // The box's projects, as the sidebar and Edit Project change them (PROTOCOL.md, "Projects").
  { when: route => route === "kuvo/projects/new", answer: newProjectRoute },
  { when: route => route === "kuvo/projects" || route === "kuvo/projects/events", answer: ({ request, readEngine, readBridge, signal }: RouteContext) => answerProjects(request, readEngine, readBridge, signal) },
  { when: route => route === "kuvo/worktrees/events", answer: worktreeEventsRoute },
  { when: route => /^kuvo\/worktrees(\/(remove|restore|record|where))?$/.test(route), answer: worktreesRoute },
  // A bot's work (PROTOCOL.md, "Work"), its stop-all before a bot's own route.
  { when: route => route.match(WORK_ROUTE), answer: workRoute },
  { when: route => route.match(WORK_ASKS_ROUTE), answer: workAsksRoute },
  { when: route => route.match(GOALS_ROUTE), answer: goalsRoute },
  { when: route => route === APP_ICON_ROUTE, answer: appIconRoute },
  // (Before the bot keys' route, which would take "keys" for a bot.)
  { when: route => route === "kuvo/bots/keys/refresh", answer: botKeysRefreshRoute },
  { when: route => /^kuvo\/bots\/[^/]+\/keys(\/[^/]+)?$/.test(route), answer: botKeysRoute },
  { when: route => route.match(CARRY_ROUTE), answer: carryRoute },
  { when: (route, request) => ["PATCH", "DELETE"].includes(request.method.toUpperCase()) && route.match(/^kuvo\/bots\/([^/]+)$/), answer: botRoute },
  { when: route => GROUP_ROUTE.test(route), answer: groupsRoute },
  { when: route => ARTIFACT_ROUTE.test(route), answer: artifactsRoute },
  { when: route => route.match(/^kuvo\/bots\/([^/]+)\/arrived$/), answer: arrivedRoute },
  { when: route => route === "kuvo/bots/retell", answer: retellRoute },
  { when: route => route === "kuvo/bots/events", answer: botEventsRoute },
  { when: route => route === "kuvo/bots", answer: botsRoute },
  { when: route => route === "kuvo/moves", answer: movesRoute },
  { when: route => route === "kuvo/moves/events", answer: moveEventsRoute },
  { when: route => route === "kuvo/moves/places", answer: movePlacesRoute },
  { when: route => route === "kuvo/wakes", answer: wakesRoute },
  { when: route => route === "kuvo/wakes/events", answer: wakeEventsRoute },
  { when: route => route.match(/^kuvo\/wakes\/([^/]+)(?:\/(cancel|now|pause|watch))?$/), answer: sessionWakesRoute },
];

// The handler LinkHost runs for each request. `hold`: the running bridge's notices held while
// you're at a computer (none in `box route`, a command of its own). `info`: every box passes its
// name; only a test's handler leaves it out (and its `kuvo/info` has none), so its `{}` is cast.
export function engineHandler(readEngine: () => EngineRecord = readEngineFile, info: RouteContext["info"] = {} as RouteContext["info"], readBridge: () => BridgeRecord = readBridgeFile, phonesChanged: RouteContext["phonesChanged"] = () => {}, hold: NoticeHold | null = null): LinkHandler {
  // The agents' bridge, while it runs: its record, while the process it names is still it.
  const bridge = (): BridgeRecord | null => {
    try {
      const found = readBridge();
      return found?.port && found?.password && runs(found.pid, "kuvo-agents") ? found : null;
    } catch {
      return null;
    }
  };
  return async function* (request: LinkRequest, phone: Asker | undefined, signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
    const text = (status: number, words: string): AnswerPiece[] => [{ head: { status, headers: { "content-type": "text/plain" } } }, { body: Buffer.from(words) }];
    const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
    // A phone using this machine, whatever it asks; not the app beside a Mac's own box.
    if (!request.fromApp) phoneHere();
    const route = request.path.split("?")[0];
    const context: RouteContext = { request, phone, signal, route, readEngine, readBridge, bridge, info, phonesChanged, hold, json, text };
    for (const { when, answer } of ROUTES) {
      const match = when(route, request);
      // (Each answer is given what its own `when` gave: a pairing TypeScript can't follow through
      // the loop, so `never`.)
      if (match) return yield* answer(context, match as never);
    }
    return yield* engineRoute(context);
  };
}
