// This Mac's box on the relay (PROTOCOL.md, "This Mac's box: the relay")
// On a Mac, `serve` holds the relay connection a machine's `run` holds, in the same process: your
// phones' sessions, paired and pairing as on a machine, answered here. Its keys stay in your
// Keychain: the app gives them as the link starts (`link/identity`), and they're kept in memory
// only; without them the link stays off and says why, and never makes keys of its own. Its app says
// whether it's wanted (`kuvo/link/config`: the phone link on, machines to meet), which it keeps for
// when it starts again before the app opens. Your other computers' mail is taken here, as a machine
// takes it: documents, agents, letters, group chats'. What a phone asks it answers itself, but the
// Mac's own routes (`MAC_APP_ROUTES`), which go to the app through the host (`link/route`); of
// those it answers what it can of its machines while the app isn't there (`machines`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { engineConnect } from "../areas/engine";
import { docsChanged } from "../documents/exchange";
import { peerPlaces, readBridgeFile, readEngineFile } from "../engine/client";
import { announce } from "../peers/agents";
import { peerMail, receiveMail } from "../peers/mail";
import { authorizePhone, confirmPhone } from "../phones";
import { connectOnce, nextTry } from "../relay/connection";
import { LinkHost } from "../relay/host";
import { engineHandler } from "../server/router";
import { RUN } from "../home";
import { macLink, readLink } from "../state";
import { appAnswer, passedOn } from "./app-route";
import { macKeys, macLinkCheck, macLinkWait, macNeeded, savedMacConfig, setLinkStatus, tellUntold } from "./link";
import { isMachinesRoute, machinesRoute } from "./machines";
import type { AppTiming } from "./machines";
import type { EngineRecord } from "../../shared/records";
import type { AnswerPiece, Asker, LinkHandler, LinkRequest } from "../server/context";
import type { LinkState } from "../state";

// What only this Mac's app answers a phone, by area: its machines (which this box answers in part
// with the app closed: machines.ts), the machines your phones reach directly, its usage panel's
// numbers, what its panel's browser asks you, its macOS services (`kuvo/mac`), and its engine's
// restart while the app runs this box itself (`boxAnswers`). The one list of them: the app keeps
// none, and hands its own requests for anything else to this box. Everything else a phone asks
// this box answers itself, as a machine's does, with the app open or closed.
export const MAC_APP_ROUTES = ["kuvo/machines", "kuvo/hosts", "kuvo/usage", "kuvo/asks", "kuvo/mac", "kuvo/engine"];
export const macAppAnswers = (route: string): boolean => MAC_APP_ROUTES.some(area => route === area || route.startsWith(`${area}/`));

/** Those of the app's areas this box answers itself now, with the app closed too: its engine's
 * restart while the keeper runs this box (`kuvo-start restart` asks it, as a machine's box asks
 * its own). While the app runs the box itself, the app restarts the engine: `bin/kuvo-start` stays
 * once a keeper has run, and would answer 202 with nothing to ask. */
export const boxAnswers = (route: string): boolean => route === "kuvo/engine/restart" && keeperRuns();

/** Whether this Mac's keeper runs this box now: its record in `run/keeper.json` names the process
 * that started it, alive. (A record a keeper left as it crashed, its ID another's since, isn't.)
 * So the keeper starts the box itself, nothing between them: `MacBoxTests.theBoxIsItsKeepersOwnChild`. */
export function keeperRuns(): boolean {
  let pid = 0;
  try { pid = Number(JSON.parse(fs.readFileSync(path.join(RUN, "keeper.json"), "utf8"))?.pid); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0 || pid !== process.ppid) return false;
  // (Another user's process with its ID, after a restart, isn't it: the keeper is always yours.)
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const APP_NOT_ANSWERING = "Kuvo Code on this Mac isn't answering. Try again in a moment.";

// What a phone asks of the Mac's own routes, answered by the app (`link/route`), as it comes; 503,
// at once, when the app isn't answering, and a stream that ends when the app goes.
async function* toApp(request: LinkRequest, phone: Asker | undefined, signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
  const response = await appAnswer(request, phone, signal);
  if (response) return yield* passedOn(response, signal);
  yield { head: { status: 503, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ message: APP_NOT_ANSWERING })) };
}

// A phone's request on this Mac: the app's own areas from the app (its machines answered here too
// while it isn't there), everything else here (from #191 step 2; before, the box answered only the
// areas that had moved onto it, and the app the rest).
export function macFront(handle: LinkHandler = engineHandler(readEngineFile, { name: os.hostname() }), timing?: AppTiming): LinkHandler {
  return async function* (request: LinkRequest, phone: Asker | undefined, signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
    const route = String(request.path ?? "").split("?")[0];
    if (isMachinesRoute(route)) return yield* machinesRoute(request, phone, signal, route, timing);
    if (macAppAnswers(route) && !boxAnswers(route)) return yield* toApp(request, phone, signal);
    yield* handle(request, phone, signal);
  };
}

// This Mac's box's link: up while it's wanted, its keys from the app, your phones answered here,
// what's the app's yet passed to it. Nothing it meets (the relay gone, a frame that isn't one, the
// app away) stops the box's own routes.
export async function runMacLink(): Promise<void> {
  let attempt = 0;
  macLink.stopped = false;
  // As its app last said, until it says again: the link comes back after a restart, the app closed.
  macLink.config ??= savedMacConfig();
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