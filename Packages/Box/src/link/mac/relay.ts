// This Mac's box on the relay (PROTOCOL.md, "This Mac's box: the relay")
// On a Mac, `serve` holds the relay connection a machine's `run` holds, in the same process: your
// phones' sessions, paired and pairing as on a machine, answered here. Its keys stay in your
// Keychain: the app gives them as the link starts (`link/identity`), and they're kept in memory
// only; without them the link stays off and says why, and never makes keys of its own. Its app says
// whether it's wanted (`kuvo/link/config`: the phone link on, machines to meet). Your other
// computers' mail is taken here, as a machine takes it: documents, agents, letters, group chats'.
// What a phone asks of the Mac's own routes, which only the app answers yet, goes to it through the
// host (`link/route`).

import os from "node:os";
import { engineConnect } from "../areas/engine";
import { EMPTY } from "../crypto/keys";
import { docsChanged } from "../documents/exchange";
import { peerTargets, readBridgeFile, readEngineFile } from "../engine/client";
import { appHost, forgetHostProof, proveHost } from "../host-interface";
import { announce } from "../peers/agents";
import { peerMail, receiveMail } from "../peers/mail";
import { authorizePhone, confirmPhone } from "../phones";
import { connectOnce, nextTry } from "../relay/connection";
import { LinkHost } from "../relay/host";
import { AGENTS } from "../server/forward";
import { engineHandler } from "../server/router";
import { macLink, readLink } from "../state";
import { QUEUE_ROUTE } from "../areas/queue";
import { macKeys, macLinkCheck, macLinkWait, macNeeded, setLinkStatus, tellUntold } from "./link";
import type { EngineRecord } from "../../shared/records";
import type { AnswerPiece, Asker, LinkHandler, LinkRequest } from "../server/context";
import type { LinkState } from "../state";

// What this Mac's box answers a phone itself: the areas that have moved onto it (PhoneLink's
// `boxRoutes`), and its phones. The rest the app answers, through the host.
export const MAC_BOX_ROUTES = ["kuvo/artifacts", "kuvo/projects", "kuvo/worktrees", "kuvo/plugins", "kuvo/folders", "kuvo/programs", "kuvo/providers", "kuvo/wakes", "kuvo/config", "kuvo/mcp/catalog", "kuvo/skills", "kuvo/skill-library",
  "kuvo/skill-trash", "kuvo/integrations", "kuvo/keys", "kuvo/bots", "kuvo/personalities", "kuvo/phones", "kuvo/attention", "kuvo/accounts/ended",
  "kuvo/accounts/credentials", "kuvo/accounts/found", "kuvo/file", "kuvo/sign-in/return", "kuvo/named", "kuvo/groups", "kuvo/agent-tools", "kuvo/moves", "kuvo/work", "kuvo/vault", "kuvo/sandbox"];
// (A plan signed out from a phone, `kuvo/accounts/<id>/forget`, a command stopped,
// `kuvo/shell/<id>/stop`, a session started with a task and a session's queue: the box's too.)
const macAnswersAlso = (route: string): boolean => /^kuvo\/accounts\/[^/]+\/forget$/.test(route) || /^kuvo\/shell\/[^/]+\/stop$/.test(route)
  || route === "kuvo/sessions" || QUEUE_ROUTE.test(route);
export const macAnswers = (route: string): boolean => MAC_BOX_ROUTES.some(area => route === area || route.startsWith(`${area}/`)) || macAnswersAlso(route);

const APP_NOT_ANSWERING = "Kuvo Code on this Mac isn't answering. Try again in a moment.";

// What a phone asks of the Mac's own routes, answered by the app (`link/route`), as it comes; 503,
// at once, when the app isn't answering, and a stream that ends when the app goes.
async function* toApp(request: LinkRequest, phone: Asker | undefined, signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
  let response: Response | null = null;
  const host = appHost();
  if (host) {
    try {
      // Nothing goes until it's proved it's this Mac's app: once for each host.json, which is
      // enough because this box (`serve`) ends with its app (its stdin closes), so no other
      // process can take the app's port while this box still trusts it, without the file changing.
      await proveHost(host);
      response = await fetch(`${host.url}/link/route`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
        body: JSON.stringify({
          method: request.method,
          path: request.path,
          headers: request.headers ?? {},
          body: Buffer.from(request.body ?? EMPTY).toString("base64"),
          phone: phone?.key?.toString("base64url") ?? null,
        }),
        signal,
      });
    } catch {
      // Gone from there (or not proved): proved again before anything more is sent there.
      if (!signal?.aborted) forgetHostProof();
      response = null;
    }
  }
  // The app's own answer says so (`x-kuvo-answer`), whatever its status: without it, the app
  // isn't there to answer (gone, starting again, or an older one).
  if (!response || response.headers.get("x-kuvo-answer") !== "1") {
    await response?.body?.cancel().catch(() => {});
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: APP_NOT_ANSWERING })) };
    return;
  }
  const headers: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/json" };
  const cache = response.headers.get("cache-control");
  if (cache) headers["cache-control"] = cache;
  yield { head: { status: response.status, headers } };
  if (!response.body) return;
  // One cut off as it came (the app gone halfway) ends as cut off, not as a whole answer.
  for await (const chunk of response.body) {
    if (signal?.aborted) break;
    yield { body: Buffer.from(chunk) };
  }
}

// A phone's request on this Mac: the box's own areas here, the rest from the app.
export function macFront(handle: LinkHandler = engineHandler(readEngineFile, { name: os.hostname() })): LinkHandler {
  return async function* (request: LinkRequest, phone: Asker | undefined, signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
    const route = String(request.path ?? "").split("?")[0];
    // (The engine's API and the coding agents', as a machine's bridge passes them on, who a message
    // names with "&" told: bridge 0.9.64.)
    if (macAnswers(route) || /^api(\/|$)/.test(route) || route.startsWith(AGENTS)) return yield* handle(request, phone, signal);
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
        mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerTargets)),
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