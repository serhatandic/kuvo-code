// `kuvo/info`: what this box is, its bridge's and engine's versions, whether they run, and what
// it answers (its features). A Mac's box says it for its Mac, with the app open or closed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleBuild } from "../../shared/bundle";
import { keeperEngine } from "../../shared/engines";
import { FEATURES } from "../../shared/features";
import { processRuns as runs } from "../../shared/platform";
import type { BridgeRecord, EngineRecord } from "../../shared/records";
import { macFeatures } from "../../shared/routes/mac";
import type { BoxInfo, MachineInfo } from "../../shared/routes/box";
import { textOf } from "../files";
import { BRIDGE_FILE, CHATS, ENGINE_FILE, IS_MAC, K, MAC_APP_VERSION, MAC_ENGINE_VERSION, PID_FILE, RUN, VERSION_FILE } from "../home";
import { macsOf } from "../peers/known";
import { macLink, readLink } from "../state";
import type { AnswerPiece, RouteContext } from "../server/context";
import { newerVersion } from "../updates/update";
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
  const chats = CHATS;
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
  return { kind: "machine", bridge: BRIDGE_VERSION, engine: engine.version ?? null, started, running, stopped, agents, chats, features: [...FEATURES], ...(home ? { home } : {}), macs, phones, pieces: pieces(engine, running), ...info };
}

type Pieces = NonNullable<MachineInfo["pieces"]>;

// Which version each of a machine's pieces runs, against the one its files hold now (PROTOCOL.md,
// "A new version while it works"). A Mac brings new files while the box works; each piece takes
// them as it starts again.
export function pieces(engine: Partial<EngineRecord>, engineRuns: boolean): Pieces {
  const mtime = (file: string) => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
  // The link (the process that keeps the relay), from the version it noted as it started; the one
  // here is this process's. Asked through the running link that's its own; a Mac asks with a
  // process of its own (`box route`), from the files in place, which tells the two apart.
  const linkRuns = runs(Number(textOf(PID_FILE)), "kuvo-link");
  const linkVersion = linkRuns ? textOf(VERSION_FILE)?.trim() || null : null;
  // The coding agents' bridge, by the build it says it runs; one from before it said (an older
  // one) by when it started, against when its bundle was put in place.
  const script = path.join(K, "bin", "kuvo-agents.js");
  let bridge: Partial<BridgeRecord> = {};
  try { bridge = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8")) ?? {}; } catch {}
  const bridgeRuns = runs(bridge.pid, "kuvo-agents");
  const current = bundleBuild(script);
  const build = bridgeRuns && typeof bridge.build === "string" ? bridge.build : null;
  const agentsBehind = bridgeRuns && (build ? current !== null && build !== current : mtime(script) > mtime(BRIDGE_FILE));
  const renewal = agentsBehind && bridge.renewal && typeof bridge.renewal.since === "number" ? { since: bridge.renewal.since, holding: bridge.renewal.holding === true } : null;
  // What it waits for: one that doesn't say its build doesn't make way by itself.
  const said = bridge.renewal?.waits;
  const waits = !agentsBehind ? null : !build ? "restart" : said === "holding" || said === "engine" || said === "restart" ? said : "quiet";
  // The engine, against the one its keeper starts (`bin/kuvo-start`'s, while it's there, else the
  // newest there is).
  const running = engineRuns ? engine.version ?? null : null;
  const currentEngine = keeperEngine(K);
  return {
    link: { running: linkVersion, current: BRIDGE_VERSION, behind: linkVersion !== null && linkVersion !== BRIDGE_VERSION },
    agents: { running: build, current, behind: agentsBehind, renewal, waits },
    engine: { running, current: currentEngine, behind: running !== null && currentEngine !== null && newerVersion(currentEngine, running) },
  };
}
