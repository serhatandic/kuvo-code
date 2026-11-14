// Keep-awake (PROTOCOL.md, "Work › Goals"): while a bot's goal is at work on a Mac's box (the bot or
// one of its sessions running), the Mac doesn't sleep (on power, `caffeinate -s`, tied to the box's
// own process), and it sleeps again once nothing of it runs, the goal still on. A machine doesn't
// sleep: nothing runs there. The real box code, as a Mac's box; only the engine is a stand-in.
//
// Run with `node --test box/bridge-tests/goal-awake.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-goal-awake-")));
process.env.KUVO_HOME = home;
process.env.KUVO_BOX = "mac";
process.env.KUVO_ENGINE_CONFIG = path.join(home, "engine");
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const pixelFolder = path.join(home, "bots", "bot_pixel00001");
write(path.join(pixelFolder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_pixel00001", name: "Pixel", job: "Builds apps.", look: { color: "graphite", shape: "squircle", face: "bright" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
write(path.join(pixelFolder, "session"), "ses_pixel");
const goalsFile = path.join(home, "run", "work", "goals.json");
const goal = state => ({ id: "goal_one", bot: "bot_pixel00001", name: "Pixel", session: "ses_pixel", goal: "Launch Driftwood.", state, steps: [{ id: "s1", text: "Build the site", state: "doing" }], checks: [], spend: [], public: [{ id: "p1", text: "Publish", on: true }], projects: [], wake: false, digest: "none", proposed: Date.now(), started: Date.now(), waiting: [], paused: [], waited: 0, watching: [] });

// The engine: Pixel's conversation, at work or not.
let busy = false;
const pixel = { id: "ses_pixel", title: "Pixel", location: { directory: path.join(pixelFolder, "workspace") }, permissions: [], time: { created: 1, updated: 1 } };
const engine = http.createServer((request, response) => {
  const reply = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  const url = new URL(request.url, "http://x");
  if (url.pathname === "/api/session/active") return reply({ data: busy ? { ses_pixel: {} } : {} });
  if (url.pathname === "/api/session") return reply(url.searchParams.get("parentID") && url.searchParams.get("parentID") !== "null" ? { data: [] } : { data: [pixel], cursor: null });
  if (url.pathname === "/api/session/ses_pixel") return reply({ data: pixel });
  reply({ data: [] });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
const target = () => [{ port: engine.address().port, password: "p" }];
// The caffeinate this box holds, by its process: what keeps the Mac awake.
const holding = () => spawnSync("pgrep", ["-f", `caffeinate -s -w ${process.pid}`], { encoding: "utf8" }).stdout.trim();
removeAtEnd(home);
atEnd(async () => {
  write(goalsFile, JSON.stringify({ goals: [] }));
  await link.lookAtGoals(() => true, () => []);
  await link.letGo();
  engine.closeAllConnections();
  engine.close();
});

test("the Mac stays awake while a goal's work runs, and may sleep while it waits or once it's done; a machine has nothing to do", async () => {
  write(goalsFile, JSON.stringify({ goals: [goal("running")] }));
  busy = true;
  await link.lookAtGoals(() => true, target);
  if (process.platform !== "darwin") {
    assert.equal(link.keptAwake(), false, "a machine doesn't sleep: nothing's held");
    return;
  }
  assert.equal(link.keptAwake(), true);
  assert.notEqual(holding(), "", "caffeinate holds it, tied to the box's own process");
  await link.lookAtGoals(() => true, target);
  assert.equal(holding().split("\n").length, 1, "looking again holds no second one");

  // Waiting on something (nothing at work): it may sleep, the goal still on.
  busy = false;
  await link.lookAtGoals(() => true, target);
  assert.equal(link.keptAwake(), false);
  await link.letGo();
  assert.equal(holding(), "");

  busy = true;
  write(goalsFile, JSON.stringify({ goals: [{ ...goal("done"), ended: Date.now(), report: "Done." }] }));
  await link.lookAtGoals(() => true, target);
  assert.equal(link.keptAwake(), false, "done, it lets go");
});
