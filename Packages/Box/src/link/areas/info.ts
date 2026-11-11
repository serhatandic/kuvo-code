// `kuvo/info`: what this box is, its bridge's and engine's versions, whether they run, and what
// it answers (its features). A Mac's box says it for its Mac, with the app open or closed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FEATURES } from "../../shared/features";
import { processRuns as runs } from "../../shared/platform";
import type { EngineRecord } from "../../shared/records";
import { macFeatures } from "../../shared/routes/mac";
import type { BoxInfo, MachineInfo } from "../../shared/routes/box";
import { CHATS, ENGINE_FILE, IS_MAC, K, MAC_APP_VERSION, MAC_ENGINE_VERSION, RUN } from "../home";
import { macsOf } from "../peers/known";
import { macLink, readLink } from "../state";
import type { AnswerPiece, RouteContext } from "../server/context";
import { BRIDGE_VERSION } from "../version";
import { integrationCatalog } from "./integrations";

export async function* infoRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { readEngine, bridge, info } = context;
  let engine: Partial<EngineRecord> = {};
  try { engine = readEngine(); } catch {}
  // When the engine running now came up, in seconds since 1970 (each start writes its record):
  // a restart changes it.
  let started: number | null = null;
  if (engine.pid) try { started = fs.statSync(ENGINE_FILE).mtimeMs / 1000; } catch {}
  // Its folder of chats (conversations of no project), as a Mac names its own: made if it isn't
  // there yet, so a phone can start the first one.
  const chats = IS_MAC ? CHATS : path.join(K, "chats");
  try { fs.mkdirSync(chats, { recursive: true }); } catch {}
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify(IS_MAC ? macInfo(engine, started, chats, Boolean(bridge())) : machineInfo(engine, started, chats, Boolean(bridge()), info))) };
}

// A Mac's: its name and its app's version as its app last said them (kept for when it's closed),
// the engine's version (the one it brings while none runs), and its integrations' names by their
// MCP server's, for what a server asks.
function macInfo(engine: Partial<EngineRecord>, started: number | null, chats: string, agents: boolean): BoxInfo {
  const config = macLink.config;
  const integrations = Object.fromEntries(integrationCatalog().filter(each => typeof each.title === "string").map(each => [each.id, each.title]));
  return { kind: "mac", name: config?.name || os.hostname(), app: config?.app || MAC_APP_VERSION || "", engine: engine.version ?? MAC_ENGINE_VERSION ?? "",
    features: macFeatures() as BoxInfo["features"], agents, started, chats, integrations };
}

function machineInfo(engine: Partial<EngineRecord>, started: number | null, chats: string, agents: boolean, info: RouteContext["info"]): MachineInfo {
  // COMPAT(0.7 engine-stop): `stopped`, an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
  // Whether it runs now, and whether it's stopped on purpose (until it's started, from anywhere).
  const running = Boolean(engine.pid && runs(engine.pid, `${K}/engine/`));
  const stopped = fs.existsSync(path.join(RUN, "stopped"));
  // The Mac that started it, as its start noted (and its name, from a Mac that notes it).
  const notes = engine.notes ?? {};
  const home = typeof notes.mac === "string" ? { mac: notes.mac, ...(typeof notes.macName === "string" ? { name: notes.macName } : {}) } : undefined;
  // Who else uses it: the Macs that set it up, and the phones that reach it, which an uninstall
  // would stop it for.
  let link = null as ReturnType<typeof readLink>;
  try { link = readLink(); } catch {}
  const macs = macsOf(link).map(key => ({ key, ...(link?.macNames?.[key] ? { name: link.macNames[key] } : {}), seen: link?.macSeen?.[key] ?? 0 }));
  const phones = new Set((link?.phones ?? []).map(phone => phone.key)).size;
  return { kind: "machine", bridge: BRIDGE_VERSION, engine: engine.version ?? null, started, running, stopped, agents, chats, features: [...FEATURES], ...(home ? { home } : {}), macs, phones, ...info };
}
