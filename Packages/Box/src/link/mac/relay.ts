// This Mac's box on the relay (PROTOCOL.md, "This Mac's box: the relay")
// On a Mac, `serve` holds the relay connection a machine's `run` holds, in the same process: your
// phones' sessions, paired and pairing as on a machine, answered here. Its keys stay in your
// Keychain: the app gives them as the link starts (`link/identity`), and they're kept in memory
// only; without them the link stays off and says why, and never makes keys of its own. Its app says
// whether it's wanted (`kuvo/link/config`: the phone link on, machines to meet). Your other
// computers' mail is taken here, as a machine takes it: documents, agents, letters, group chats'.
// What a phone asks of the Mac's own routes goes to the app through the host (`link/route`), and
// this box answers what it can of its machines while the app isn't there (`machines`).

import os from "node:os";
import { engineConnect } from "../areas/engine";
import { docsChanged } from "../documents/exchange";
import { peerPlaces, readBridgeFile, readEngineFile } from "../engine/client";
import { announce } from "../peers/agents";
import { peerMail, receiveMail } from "../peers/mail";
import { authorizePhone, confirmPhone } from "../phones";
import { connectOnce, nextTry } from "../relay/connection";
import { LinkHost } from "../relay/host";
import { AGENTS } from "../server/forward";
import { engineHandler } from "../server/router";
import { macLink, readLink } from "../state";
import { QUEUE_ROUTE } from "../areas/queue";
import { SESSION_APPROVAL_ROUTE, SESSION_DECISIONS_ROUTE } from "../areas/approval";
import { appAnswer, passedOn } from "./app-route";
import { macKeys, macLinkCheck, macLinkWait, macNeeded, setLinkStatus, tellUntold } from "./link";
import { isMachinesRoute, machinesRoute } from "./machines";
import type { AppTiming } from "./machines";
import type { EngineRecord } from "../../shared/records";
import type { AnswerPiece, Asker, LinkHandler, LinkRequest } from "../server/context";
import type { LinkState } from "../state";

// What this Mac's box answers a phone itself: the areas that have moved onto it (PhoneLink's
// `boxRoutes`, all but the link's own, `kuvo/link`, which are the app's alone), and its phones.
// The rest the app answers, through the host.
export const MAC_BOX_ROUTES = ["kuvo/artifacts", "kuvo/projects", "kuvo/worktrees", "kuvo/plugins", "kuvo/folders", "kuvo/programs", "kuvo/providers", "kuvo/wakes", "kuvo/config", "kuvo/mcp/catalog", "kuvo/skills", "kuvo/skill-library",
  "kuvo/skill-trash", "kuvo/integrations", "kuvo/keys", "kuvo/bots", "kuvo/personalities", "kuvo/phones", "kuvo/attention", "kuvo/accounts/ended",
  "kuvo/accounts/refreshable", "kuvo/accounts/credentials", "kuvo/accounts/found", "kuvo/file", "kuvo/sign-in/return", "kuvo/named", "kuvo/groups", "kuvo/agent-tools", "kuvo/moves", "kuvo/work", "kuvo/vault", "kuvo/sandbox",
  "kuvo/approval", "kuvo/search", "kuvo/git"];
// (A plan signed out from a phone, `kuvo/accounts/<id>/forget`, its models asked of again (`…/refresh`), a command stopped,
// `kuvo/shell/<id>/stop`, a session started with a task, a session's queue and its approval: the box's too.)
const macAnswersAlso = (route: string): boolean => /^kuvo\/accounts\/[^/]+\/(forget|refresh)$/.test(route) || /^kuvo\/shell\/[^/]+\/stop$/.test(route)
  || route === "kuvo/sessions" || QUEUE_ROUTE.test(route) || SESSION_APPROVAL_ROUTE.test(route) || SESSION_DECISIONS_ROUTE.test(route);
export const macAnswers = (route: string): boolean => MAC_BOX_ROUTES.some(area => route === area || route.startsWith(`${area}/`)) || macAnswersAlso(route);

const APP_NOT_ANSWERING = "Kuvo Code on this Mac isn't answering. Try again in a moment.";

// What a phone asks of the Mac's own routes, answered by the app (`link/route`), as it comes; 503,
// at once, when the app isn't answering, and a stream that ends when the app goes.
async function* toApp(request: LinkRequest, phone: Asker | undefined, signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
  const response = await appAnswer(request, phone, signal);
  if (response) return yield* passedOn(response, signal);
  yield { head: { status: 503, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ message: APP_NOT_ANSWERING })) };
}

// A phone's request on this Mac: the box's own areas here, the rest from the app.
export function macFront(handle: LinkHandler = engineHandler(readEngineFile, { name: os.hostname() }), timing?: AppTiming): LinkHandler {
  return async function* (request: LinkRequest, phone: Asker | undefined, signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
    const route = String(request.path ?? "").split("?")[0];
    // (The engine's API and the coding agents', as a machine's bridge passes them on, who a message
    // names with "&" told: bridge 0.9.64.)
    if (macAnswers(route) || /^api(\/|$)/.test(route) || route.startsWith(AGENTS)) return yield* handle(request, phone, signal);
    if (isMachinesRoute(route)) return yield* machinesRoute(request, phone, signal, route, timing);
    yield* toApp(request, phone, signal);
  };
}

// This Mac's box's link: up while it's wanted, its keys from the app, your phones answered here,
// what's the app's yet passed to it. Nothing it meets (the relay gone, a frame that isn't one, the
// app away) stops the box's own routes.
export async function runMacLink(): Promise<void> {
  let attempt = 0;
  macLink.stopped = false;
  while (!macLink.stopped) {
    try {
      const config = macLink.config;
      // Its keys as soon as it's on (a pairing link needs them before any phone's paired).
      if (!(await macKeys())) {
        await macLinkWait(30_000);
        continue;
      }
      if (macLink.stopped) break;
      if (!macNeeded(readLink())) {
        setLinkStatus("off");
        attempt = 0;
        await macLinkWait(60_000);
        continue;
      }
      // (Wanted, with its keys: the app's overlay gives it these, and its config is there, as
      // macNeeded says no without one.)
      const link = readLink() as LinkState & Required<Pick<LinkState, "key" | "secret" | "relay">>;
      setLinkStatus("connecting");
      let engine: Partial<EngineRecord> = {};
      try { engine = readEngineFile(); } catch {}
      const host = new LinkHost({
        key: Buffer.from(link.key, "base64url"),
        hello: { v: 1, kind: "mac", name: config!.name, app: config!.app, engine: engine.version ?? null },
        // Phones only while the phone link's on (the relay can be up for your machines alone).
        authorize: (key, hello, address) => Boolean(macLink.config?.phones) && authorizePhone(key, hello, address),
        confirmed: confirmPhone,
        // Mail from your machines, taken here as a machine takes it (`peerMail`).
        mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerPlaces)),
        handle: macFront(engineHandler(readEngineFile, { name: config!.name }, readBridgeFile, changed => host.keepOnly(new Set((changed.phones ?? []).map(phone => phone.key))), macLink.hold)),
        connect: engineConnect(readEngineFile),
        send: () => {},
      });
      macLink.host = host;
      // A pairing can run out while it's up: looked at now and then.
      const looking = setInterval(macLinkCheck, 30_000);
      const started = Date.now();
      const welcomed = await connectOnce(link.relay, Buffer.from(link.secret, "base64url"), host, () => {
        setLinkStatus("connected");
        // Meeting your machines: who this Mac's agents are, asking for theirs; this Mac's
        // documents as they are now, and its digest to each; and those removed while it was away
        // hear it.
        announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
        try { docsChanged(host, { greet: true }); } catch {}
        try { tellUntold(); } catch {}
      });
      clearInterval(looking);
      if (macLink.host === host) macLink.host = null;
      if (macLink.stopped) break;
      // Not wanted any more: off now, not after a wait.
      if (!macNeeded(readLink())) {
        setLinkStatus("off");
        attempt = 0;
        continue;
      }
      const next = nextTry(attempt, welcomed, Date.now() - started);
      attempt = next.attempt;
      if (!welcomed) setLinkStatus("failed", `Can't reach the relay at ${new URL(link.relay).host}.`);
      else setLinkStatus("connecting");
      await macLinkWait(next.wait);
    } catch (error) {
      macLink.host = null;
      setLinkStatus("failed", String((error as Error | undefined)?.message ?? error));
      await macLinkWait(5_000);
    }
  }
  setLinkStatus("off");
}