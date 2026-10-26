// @ts-nocheck
// `kuvo/info`: what this box is, its bridge's and engine's versions, whether they run, and what
// it answers (its features).

import fs from "node:fs";
import path from "node:path";
import { FEATURES } from "../../shared/features";
import { processRuns as runs } from "../../shared/platform";
import { ENGINE_FILE, K, RUN } from "../home";
import { BRIDGE_VERSION } from "../version";

export async function* infoRoute(context) {
  const { readEngine, bridge, info } = context;
  let engine = {};
  try { engine = readEngine(); } catch {}
  // When the engine running now came up, in seconds since 1970 (each start writes its record):
  // a restart changes it.
  let started = null;
  if (engine.pid) try { started = fs.statSync(ENGINE_FILE).mtimeMs / 1000; } catch {}
  // COMPAT(0.7 engine-stop): `stopped`, an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
  // Whether it runs now, and whether it's stopped on purpose (until it's started, from anywhere).
  const running = Boolean(engine.pid && runs(engine.pid, `${K}/engine/`));
  const stopped = fs.existsSync(path.join(RUN, "stopped"));
  // Its folder of chats (conversations of no project), as a Mac names its own: made if it isn't
  // there yet, so a phone can start the first one.
  const chats = path.join(K, "chats");
  try { fs.mkdirSync(chats, { recursive: true }); } catch {}
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ kind: "machine", bridge: BRIDGE_VERSION, engine: engine.version ?? null, started, running, stopped, agents: Boolean(bridge()), chats, features: FEATURES, ...info })) };
  return;
}
