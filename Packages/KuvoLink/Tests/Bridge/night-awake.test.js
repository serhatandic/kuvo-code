// Keep-awake (PROTOCOL.md, "Work › A night"): while a bot's night runs on a Mac's box, the Mac
// doesn't sleep (on power, `caffeinate -s`, tied to the box's own process), and it sleeps again once
// the night ends. A machine doesn't sleep: nothing runs there. The real box code, as a Mac's box.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/night-awake.test.js`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-night-awake-")));
process.env.KUVO_HOME = home;
process.env.KUVO_BOX = "mac";
process.env.KUVO_ENGINE_CONFIG = path.join(home, "engine");
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const pixelFolder = path.join(home, "bots", "bot_pixel00001");
write(path.join(pixelFolder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_pixel00001", name: "Pixel", job: "Builds apps.", look: { color: "graphite", shape: "squircle", face: "bright" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
write(path.join(pixelFolder, "session"), "ses_pixel");
const nightsFile = path.join(home, "run", "work", "nights.json");
const night = state => ({ id: "night_one", bot: "bot_pixel00001", name: "Pixel", session: "ses_pixel", goal: "Launch Driftwood.", state, steps: [{ text: "Build the site", state: "doing" }], checks: [], spend: [], public: [], projects: [], wake: false, proposed: Date.now(), started: Date.now(), blockers: [], watching: [] });
// The caffeinate this box holds, by its process: what keeps the Mac awake.
const holding = () => spawnSync("pgrep", ["-f", `caffeinate -s -w ${process.pid}`], { encoding: "utf8" }).stdout.trim();
after(async () => {
  write(nightsFile, JSON.stringify({ nights: [] }));
  await link.lookAtNights(() => true, () => []);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the Mac stays awake while a night runs, and sleeps again once it ends; a machine has nothing to do", async () => {
  write(nightsFile, JSON.stringify({ nights: [night("running")] }));
  await link.lookAtNights(() => true, () => []);
  if (process.platform !== "darwin") {
    assert.equal(link.keptAwake(), false, "a machine doesn't sleep: nothing's held");
    return;
  }
  assert.equal(link.keptAwake(), true);
  assert.notEqual(holding(), "", "caffeinate holds it, tied to the box's own process");
  // Looking again holds no second one.
  await link.lookAtNights(() => true, () => []);
  assert.equal(holding().split("\n").length, 1);

  write(nightsFile, JSON.stringify({ nights: [{ ...night("done"), ended: Date.now(), report: "Done." }] }));
  await link.lookAtNights(() => true, () => []);
  assert.equal(link.keptAwake(), false);
  await link.letGo();
  assert.equal(holding(), "", "and the Mac may sleep again");
});
