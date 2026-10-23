// Wake-ups added and paused from a phone on a machine, with the Mac closed (PROTOCOL.md,
// `kuvo/wakes/<session>`): through the machine's own kuvo-wake (the real one, as every box has it),
// for a bot or a session, its folder made with the first; a pause of your own. The engine is a
// stand-in.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-wakes-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// kuvo-wake, as Wakes.swift has it and BoxFiles puts it in every box's bin.
const swift = fs.readFileSync(new URL("../../../OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift", import.meta.url), "utf8");
const opening = 'public static let script = #"""\n';
const from = swift.indexOf(opening) + opening.length;
const script = swift.slice(from, swift.indexOf('\n    """#', from)).split("\n").map(line => line.replace(/^ {4}/, "")).join("\n");
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.writeFileSync(path.join(home, "bin", "kuvo-wake"), script + "\n", { mode: 0o755 });

// The engine: one session, archived or not.
let archived = false;
const engine = http.createServer((request, response) => {
  const reply = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (request.url === "/api/session/ses_plain") return reply(200, { data: { id: "ses_plain", location: { directory: home }, metadata: { "kuvo.archived": archived } } });
  reply(404, {});
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
after(() => { engine.closeAllConnections(); engine.close(); });
const handle = link.engineHandler(() => ({ port: engine.address().port, password: "p" }), { name: "lab" }, () => null);
async function ask(method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

test("a session's first wake-up makes its folder; it repeats, and it's listed as the Mac lists it", async () => {
  const due = inAnHour();
  const added = await ask("POST", "kuvo/wakes/ses_plain", { due, every: "1d", note: "Check the build" });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.wakes.length, 1);
  assert.equal(added.json.wakes[0].note, "Check the build");
  assert.equal(added.json.wakes[0].every, "1d");
  assert.ok(Math.abs(added.json.wakes[0].due - due) < 120, "at its time");
  const folder = path.join(home, "wakes", "ses_plain");
  assert.equal(fs.readFileSync(path.join(folder, "session"), "utf8"), "ses_plain");
  assert.equal(fs.readFileSync(path.join(folder, "directory"), "utf8"), home);
  assert.deepEqual((await ask("GET", "kuvo/wakes")).json.sessions.map(each => each.session), ["ses_plain"]);

  // Paused by you, and back.
  assert.equal((await ask("POST", "kuvo/wakes/ses_plain/pause", { paused: true })).json.paused, true);
  assert.equal(fs.readFileSync(path.join(folder, "paused"), "utf8"), "paused");
  assert.equal((await ask("POST", "kuvo/wakes/ses_plain/pause", { paused: false })).json.paused, false);
  assert.equal(fs.existsSync(path.join(folder, "paused")), false);
});

test("a bot's goes in its folder; what can't be is said, and nothing's added", async () => {
  const bot = path.join(home, "bots", "bot_scout00001");
  fs.mkdirSync(bot, { recursive: true });
  fs.writeFileSync(path.join(bot, "session"), "ses_scout");
  assert.equal((await ask("POST", "kuvo/wakes/ses_scout", { due: inAnHour(), note: "Morning digest" })).status, 200);
  assert.equal(link.readWakes(bot).wakes.length, 1);

  for (const [body, status] of [
    [{ due: inAnHour(), note: "  " }, 400],
    [{ due: Math.floor(Date.now() / 1000) + 10, note: "Too soon" }, 400],
    [{ due: inAnHour(), every: "08h", note: "A bad repeat" }, 400],
    [{ note: "When?" }, 400],
  ]) assert.equal((await ask("POST", "kuvo/wakes/ses_scout", body)).status, status, JSON.stringify(body));
  assert.equal(link.readWakes(bot).wakes.length, 1);
  assert.equal((await ask("POST", "kuvo/wakes/ses_nobody", { due: inAnHour(), note: "Hi" })).status, 404);
  assert.equal((await ask("POST", "kuvo/wakes/ses_scout/pause", { paused: "yes" })).status, 400);
  fs.writeFileSync(path.join(bot, "paused"), "moving");
  assert.equal((await ask("POST", "kuvo/wakes/ses_scout", { due: inAnHour(), note: "Later" })).status, 409, "on its way to another computer");
});

test("an archived session's first wake-up waits with it", async () => {
  archived = true;
  fs.rmSync(path.join(home, "wakes", "ses_plain"), { recursive: true, force: true });
  const added = await ask("POST", "kuvo/wakes/ses_plain", { due: inAnHour(), note: "After the break" });
  assert.equal(added.status, 200);
  assert.equal(added.json.paused, true);
  archived = false;
});
