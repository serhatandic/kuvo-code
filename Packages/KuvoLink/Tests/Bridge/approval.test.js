// A conversation's approval, kept on the box (PROTOCOL.md, "Approval"): what a client reads and
// sets (`kuvo/sessions/<id>/approval`), the computer's Full Access switch (`kuvo/approval`), and
// the engine's rules the box writes for each. The real box script on a folder of the test's own,
// each request by a process of its own as a machine's tools ask it; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/approval.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-approval-")));
removeAtEnd(home);
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const project = path.join(home, "work", "api");
fs.mkdirSync(project, { recursive: true });

const ASK_FIRST = ["edit", "write", "patch", "shell", "webfetch", "kuvo-browser_browser_save_pdf", "kuvo-browser_browser_upload", "kuvo-browser_watch_for_change"].map(action => ({ action, resource: "*", effect: "ask" }));
const NEVER_RM = { action: "shell", resource: "rm -rf /*", effect: "deny" };
const OTHER_FOLDER = { action: "external_directory", resource: "/srv/shared/*", effect: "allow" };

// The engine: its sessions, as PATCH changes them, and what the box wrote into each.
let sessions = new Map();
let written = [];
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/session" && request.method === "GET") return reply({ data: [...sessions.values()] });
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && request.method === "GET") return sessions.has(id) ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    const prompt = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
    if (prompt && request.method === "POST") { written.push({ session: decodeURIComponent(prompt[1]), ...JSON.parse(body) }); return reply({ data: true }); }
    if (one && request.method === "PATCH" && sessions.has(id)) {
      const given = JSON.parse(body);
      sessions.set(id, { ...sessions.get(id), ...given });
      return reply({ data: sessions.get(id) });
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));
// A bot here, as its folder is.
const bot = path.join(home, "bots", "bot_scout00001");
write(path.join(bot, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout00001", name: "Scout", job: "Watches the build.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
write(path.join(bot, "session"), "ses_scout");

// Settings › Permissions on this box, where it keeps its own (a machine's).
const settingsFile = path.join(home, "box", "opencode.json");
const session = (id, permissions, more = {}) => ({ id, title: id, location: { directory: project }, permissions, time: { created: 1, updated: 1 }, ...more });

beforeEach(() => {
  sessions = new Map([
    ["ses_careful", session("ses_careful", [...ASK_FIRST, NEVER_RM, OTHER_FOLDER])],
    ["ses_free", session("ses_free", [NEVER_RM])],
    ["ses_scout", session("ses_scout", [], { location: { directory: path.join(bot, "workspace") } })],
    // Work Scout started, whose rules a client from before made again with only its folders.
    ["ses_work", session("ses_work", [...ASK_FIRST, OTHER_FOLDER], { metadata: { kuvo: { startedBy: "ses_scout", by: { bot: "bot_scout00001", name: "Scout" }, depth: 1 } } })],
  ]);
  written = [];
  fs.rmSync(path.join(home, "box", "approval.json"), { force: true });
  fs.rmSync(path.join(home, "box", "reviews"), { recursive: true, force: true });
  fs.rmSync(settingsFile, { force: true });
});

// The box's answer to one request, as a machine's tool asks it, with the sandbox running here or
// not (`sandbox`: a test box's own say, `KUVO_TEST_SANDBOX_ON`).
function route(method, pathname, body, { sandbox = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home, ...(sandbox ? { KUVO_TEST_SANDBOX_ON: "1" } : {}) };
    if (!sandbox) delete env.KUVO_TEST_SANDBOX_ON;
    const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
}
const rules = id => sessions.get(id).permissions;
const asks = (id, action) => rules(id).some(rule => rule.action === action && rule.resource === "*" && rule.effect === "ask");

test("a conversation from before reads as its rules say, and can be set to any of them it can have", async () => {
  const careful = await route("GET", "kuvo/sessions/ses_careful/approval");
  assert.equal(careful.status, 200);
  assert.equal(careful.body.approval, "askFirst");
  assert.equal(careful.body.stored, false);
  assert.equal(careful.body.plan, false);
  // Nothing asks (Approve All): Full Access, as it ran, with the sandbox or without, and whether or
  // not you confirmed it here: never Auto's reviewer, which it didn't have.
  for (const sandbox of [false, true]) {
    const free = (await route("GET", "kuvo/sessions/ses_free/approval", undefined, { sandbox })).body;
    assert.deepEqual({ approval: free.approval, effective: free.effective, stored: free.stored }, { approval: "fullAccess", effective: "fullAccess", stored: false });
  }
  // A bot's from before starts with this computer's default (Auto, the first time), which asks first
  // where the sandbox doesn't run.
  const scout = (await route("GET", "kuvo/sessions/ses_scout/approval")).body;
  assert.deepEqual({ approval: scout.approval, effective: scout.effective, reason: scout.held?.reason }, { approval: "auto", effective: "askFirst", reason: "sandbox" });
  // Full Access can't be picked without its switch; Auto can, and would ask first without the sandbox.
  const options = Object.fromEntries(careful.body.options.map(each => [each.approval, each.unavailable ? `can't: ${each.unavailable.reason}` : each.held ? `held: ${each.held.reason}` : null]));
  assert.deepEqual(options, { askFirst: null, acceptEdits: null, auto: "held: sandbox", fullAccess: "can't: fullAccessOff" });
  const gone = await route("GET", "kuvo/sessions/ses_gone/approval");
  assert.equal(gone.status, 404);
  assert.equal(typeof gone.body.message, "string");
});

test("Accept Edits lets edits go ahead and still asks before commands; what Settings never allows stays so, and its own folders stay its", async () => {
  const set = await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "acceptEdits" });
  assert.equal(set.status, 200);
  assert.deepEqual({ approval: set.body.approval, effective: set.body.effective, stored: set.body.stored }, { approval: "acceptEdits", effective: "acceptEdits", stored: true });
  assert.equal(asks("ses_careful", "shell"), true);
  assert.equal(asks("ses_careful", "edit"), false);
  assert.equal(asks("ses_careful", "write"), false);
  assert.ok(rules("ses_careful").some(rule => rule.action === NEVER_RM.action && rule.resource === NEVER_RM.resource && rule.effect === "deny"));
  assert.ok(rules("ses_careful").some(rule => rule.resource === OTHER_FOLDER.resource && rule.effect === "allow"));
  assert.deepEqual(sessions.get("ses_careful").metadata, { kuvo: { approval: "acceptEdits", applied: "acceptEdits" } });
  // Read again, it's the one kept.
  assert.equal((await route("GET", "kuvo/sessions/ses_careful/approval")).body.approval, "acceptEdits");
  // Back to Ask First: edits ask again.
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "askFirst" });
  assert.equal(asks("ses_careful", "edit"), true);
  assert.equal((await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "yolo" })).status, 400);
});

test("Auto runs without asking only where the sandbox runs: set where it doesn't, it's kept and asks first until it does", async () => {
  const held = await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "auto" });
  assert.equal(held.status, 200);
  assert.deepEqual({ approval: held.body.approval, effective: held.body.effective, stored: held.body.stored, reason: held.body.held?.reason }, { approval: "auto", effective: "askFirst", stored: true, reason: "sandbox" });
  assert.equal(asks("ses_careful", "shell"), true);

  // The sandbox runs: the box's round makes it so (here, as the switch is set, as it was).
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  const running = await route("GET", "kuvo/sessions/ses_careful/approval", undefined, { sandbox: true });
  assert.deepEqual({ effective: running.body.effective, held: running.body.held }, { effective: "auto", held: undefined });
  assert.equal(asks("ses_careful", "shell"), false);
  assert.equal(asks("ses_careful", "edit"), false);
  assert.ok(rules("ses_careful").some(rule => rule.resource === NEVER_RM.resource && rule.effect === "deny"), "what Settings never allows still holds");

  // It stops: it asks first again, still kept as Auto, saying why.
  await route("PATCH", "kuvo/approval", { fullAccess: false });
  const stopped = (await route("GET", "kuvo/sessions/ses_careful/approval")).body;
  assert.deepEqual({ approval: stopped.approval, effective: stopped.effective, reason: stopped.held?.reason }, { approval: "auto", effective: "askFirst", reason: "sandbox" });
  assert.equal(asks("ses_careful", "shell"), true);
  assert.equal(asks("ses_careful", "edit"), true);
});

test("Auto's file tools still ask outside its folders where Settings says so (the sandbox holds only commands); Full Access doesn't", async () => {
  write(settingsFile, JSON.stringify({ permissions: [{ action: "external_directory", resource: "*", effect: "ask" }, NEVER_RM] }));
  const outside = id => rules(id).findLast(rule => rule.action === "external_directory" && rule.resource === "*")?.effect;
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "auto" }, { sandbox: true });
  assert.equal(asks("ses_careful", "shell"), false);
  assert.equal(outside("ses_careful"), "ask");
  assert.ok(rules("ses_careful").some(rule => rule.resource === OTHER_FOLDER.resource && rule.effect === "allow"), "its own folders stay its");
  await route("PATCH", "kuvo/approval", { fullAccess: true });
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "fullAccess" }, { sandbox: true });
  assert.equal(outside("ses_careful"), "allow");
  assert.ok(rules("ses_careful").some(rule => rule.resource === NEVER_RM.resource && rule.effect === "deny"), "what Settings never allows still holds");
});

test("a bot's conversation from before is kept with Auto, asks first where the sandbox doesn't run, and loses the asks a box before put in a bot's", async () => {
  assert.equal(asks("ses_scout", "shell"), false, "as it was made");
  // What a box before 0.9.189 asked of a bot whatever its mode.
  const former = [{ action: "shell", resource: "stripe *", effect: "ask" }, { action: "shell", resource: "gh pr create*", effect: "ask" }, { action: "shell", resource: "vercel*", effect: "ask" }];
  sessions.set("ses_scout", { ...sessions.get("ses_scout"), permissions: [...sessions.get("ses_scout").permissions, ...former] });
  // The box's round, as it starts (here, as the switch is set).
  await route("PATCH", "kuvo/approval", { fullAccess: false });
  assert.deepEqual(sessions.get("ses_scout").metadata, { kuvo: { approval: "auto", applied: "askFirst" } });
  assert.equal(asks("ses_scout", "shell"), true);
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  assert.equal(asks("ses_scout", "shell"), false);
  for (const rule of former) assert.ok(!rules("ses_scout").some(each => each.resource === rule.resource), `${rule.resource} no longer asks: a bot in Auto runs as any conversation in Auto`);
});

test("Accept Edits lets edits go ahead even where Settings asks for them, and reads as Ask First once a client asks for edits again", async () => {
  write(settingsFile, JSON.stringify({ permissions: [{ action: "edit", resource: "*", effect: "ask" }, { action: "edit", resource: "*.env", effect: "deny" }] }));
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "acceptEdits" });
  const edits = rules("ses_careful").filter(rule => rule.action === "edit");
  assert.equal(edits.findLast(rule => rule.resource === "*")?.effect, "allow");
  assert.ok(edits.indexOf(edits.find(rule => rule.resource === "*.env")) > edits.findIndex(rule => rule.resource === "*"), "a Don't Allow in Settings still wins, after");
  assert.equal(asks("ses_careful", "shell"), true);
  // An older client puts its Ask First back: edits ask, so it is Ask First, never passed on as more.
  sessions.set("ses_careful", { ...sessions.get("ses_careful"), permissions: [...ASK_FIRST, NEVER_RM] });
  const read = (await route("GET", "kuvo/sessions/ses_careful/approval")).body;
  assert.deepEqual({ approval: read.approval, stored: read.stored }, { approval: "askFirst", stored: false });
});

test("a bot's work changed to any approval asks as any conversation in that approval does, nothing more", async () => {
  for (const approval of ["acceptEdits", "auto"]) {
    assert.equal((await route("PUT", "kuvo/sessions/ses_work/approval", { approval }, { sandbox: true })).status, 200);
    for (const resource of ["stripe *", "gh pr create*", "git push *--force*", "sendmail *", "rm *", "sudo *", "chmod *", "ssh-add *"]) {
      assert.ok(!rules("ses_work").some(rule => rule.action === "shell" && rule.resource === resource && rule.effect === "ask"), `${approval}: ${resource} no longer asks`);
    }
    assert.deepEqual(sessions.get("ses_work").metadata.kuvo.by, { bot: "bot_scout00001", name: "Scout" }, "its other notes kept");
  }
  // Full Access too, once it's switched on here, as any conversation's.
  await route("PATCH", "kuvo/approval", { fullAccess: true });
  const full = await route("PUT", "kuvo/sessions/ses_work/approval", { approval: "fullAccess" });
  assert.deepEqual({ status: full.status, effective: full.body.effective }, { status: 200, effective: "fullAccess" });
  assert.equal(asks("ses_work", "shell"), false, "its commands go ahead");
});

test("a change to Settings › Permissions reaches every conversation kept with an approval at once, whichever client made it", async () => {
  write(settingsFile, JSON.stringify({ permissions: [NEVER_RM] }));
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "acceptEdits" });
  await route("PUT", "kuvo/sessions/ses_free/approval", { approval: "auto" }, { sandbox: true });
  const NEVER_PUSH = { action: "shell", resource: "git push*", effect: "deny" };
  const changed = await route("PATCH", "kuvo/config", { changes: [{ path: ["permissions"], value: [NEVER_RM, NEVER_PUSH] }] }, { sandbox: true });
  assert.equal(changed.status, 200);
  const denies = id => rules(id).some(rule => rule.action === "shell" && rule.resource === NEVER_PUSH.resource && rule.effect === "deny");
  assert.equal(denies("ses_careful"), true, "Accept Edits");
  assert.equal(denies("ses_free"), true, "Auto");
  // Each still what it was, its own folders its own.
  assert.equal(asks("ses_careful", "shell"), true);
  assert.equal(asks("ses_careful", "edit"), false);
  assert.equal(asks("ses_free", "shell"), false);
  assert.ok(rules("ses_careful").some(rule => rule.resource === OTHER_FOLDER.resource && rule.effect === "allow"));
  // Taken out again: it goes from them too.
  await route("PATCH", "kuvo/config", { changes: [{ path: ["permissions"], value: [NEVER_RM] }] }, { sandbox: true });
  assert.equal(denies("ses_careful"), false);
  assert.equal(denies("ses_free"), false);
});

test("a folder Settings › Permissions asks about, then doesn't allow, stays out of a conversation in Auto, however often its rules are made", async () => {
  const SHARED = "/srv/shared/*";
  write(settingsFile, JSON.stringify({ permissions: [NEVER_RM] }));
  await route("PUT", "kuvo/sessions/ses_free/approval", { approval: "auto" }, { sandbox: true });
  const set = effect => route("PATCH", "kuvo/config", { changes: [{ path: ["permissions"], value: [NEVER_RM, { action: "external_directory", resource: SHARED, effect }] }] }, { sandbox: true });
  const shared = () => rules("ses_free").filter(rule => rule.action === "external_directory" && rule.resource === SHARED);
  assert.equal((await set("ask")).status, 200);
  await set("ask");
  const once = shared().length;
  await set("ask");
  assert.equal(shared().length, once, "made again, the same rules");
  await set("deny");
  assert.equal(shared().at(-1)?.effect, "deny", "the last rule for it wins, and it's Settings' Don't Allow");
  await route("PATCH", "kuvo/config", { changes: [{ path: ["permissions"], value: [NEVER_RM] }] }, { sandbox: true });
  assert.deepEqual(shared(), [], "taken out of Settings, it's gone from the conversation too");
});

test("rules a client changed on its own are never made again behind its back", async () => {
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "auto" }, { sandbox: true });
  // A client from before sets Ask First by its rules alone.
  sessions.set("ses_careful", { ...sessions.get("ses_careful"), permissions: [...ASK_FIRST, NEVER_RM] });
  assert.equal((await route("GET", "kuvo/sessions/ses_careful/approval", undefined, { sandbox: true })).body.approval, "askFirst");
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  assert.equal(asks("ses_careful", "shell"), true, "still asks first, as the client set it");
});

test("Full Access only once it's switched on for this computer, for a bot's conversation too", async () => {
  assert.equal((await route("GET", "kuvo/approval")).body.fullAccess, false);
  const off = await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "fullAccess" });
  assert.equal(off.status, 409);
  assert.equal(off.body.reason, "fullAccessOff");

  const here = await route("PATCH", "kuvo/approval", { fullAccess: true });
  assert.equal(here.status, 200);
  assert.equal(here.body.fullAccess, true);
  assert.equal(here.body.auto.engine.held.reason, "sandbox");
  const set = await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "fullAccess" });
  assert.equal(set.status, 200);
  assert.equal(set.body.effective, "fullAccess");
  assert.equal(asks("ses_careful", "shell"), false);

  const forBot = await route("PUT", "kuvo/sessions/ses_scout/approval", { approval: "fullAccess" });
  assert.equal(forBot.status, 200);
  assert.equal(forBot.body.effective, "fullAccess");
  assert.equal(asks("ses_scout", "shell"), false);

  // Switched off: what had it comes down to what it can be (Auto where the sandbox runs, saying the
  // switch holds it there; Ask First where it doesn't, saying the sandbox does).
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  assert.equal(asks("ses_careful", "shell"), false);
  let now = (await route("GET", "kuvo/sessions/ses_careful/approval", undefined, { sandbox: true })).body;
  assert.deepEqual({ approval: now.approval, effective: now.effective, reason: now.held?.reason }, { approval: "fullAccess", effective: "auto", reason: "fullAccessOff" });
  now = (await route("GET", "kuvo/sessions/ses_careful/approval")).body;
  assert.deepEqual({ approval: now.approval, effective: now.effective, reason: now.held?.reason }, { approval: "fullAccess", effective: "askFirst", reason: "sandbox" });
  // (A read changes nothing; the box's round, where the sandbox stops, does.)
  await route("PATCH", "kuvo/approval", { fullAccess: false });
  assert.equal(asks("ses_careful", "shell"), true);
  assert.equal((await route("PATCH", "kuvo/approval", { fullAccess: "yes" })).status, 400);
});

test("a new conversation a client made without saying gets this computer's default: Auto the first time, then the last one picked here; Approve All from a client from before never becomes Full Access", async () => {
  assert.equal((await route("GET", "kuvo/approval")).body.default, "auto");
  // Made since, with nothing asking (an older client's Approve All): Auto, never Full Access.
  sessions.set("ses_new", session("ses_new", [NEVER_RM], { time: { created: Date.now() + 60_000, updated: Date.now() + 60_000 } }));
  const fresh = (await route("GET", "kuvo/sessions/ses_new/approval", undefined, { sandbox: true })).body;
  assert.deepEqual({ approval: fresh.approval, effective: fresh.effective }, { approval: "auto", effective: "auto" });
  // The box keeps it so, its rules made for it.
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  assert.deepEqual(sessions.get("ses_new").metadata, { kuvo: { approval: "auto", applied: "auto" } });
  assert.ok(rules("ses_new").some(rule => rule.resource === NEVER_RM.resource && rule.effect === "deny"), "what Settings never allows still holds");
  // One a client made with the one it picked gets that.
  sessions.set("ses_picked", session("ses_picked", [NEVER_RM], { time: { created: Date.now() + 60_000, updated: Date.now() + 60_000 }, metadata: { kuvo: { approval: "acceptEdits" } } }));
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  assert.deepEqual(sessions.get("ses_picked").metadata, { kuvo: { approval: "acceptEdits", applied: "acceptEdits" } });
  assert.equal(asks("ses_picked", "shell"), true);
  // The last one you pick here is the next one's.
  await route("PATCH", "kuvo/approval", { fullAccess: true });
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "fullAccess" });
  assert.equal((await route("GET", "kuvo/approval")).body.default, "fullAccess");
  sessions.set("ses_next", session("ses_next", [], { time: { created: Date.now() + 60_000, updated: Date.now() + 60_000 } }));
  assert.equal((await route("GET", "kuvo/sessions/ses_next/approval")).body.approval, "fullAccess");
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "askFirst" });
  assert.equal((await route("GET", "kuvo/approval")).body.default, "askFirst");
  // A bot's too, as any conversation's.
  await route("PUT", "kuvo/sessions/ses_work/approval", { approval: "auto" }, { sandbox: true });
  assert.equal((await route("GET", "kuvo/approval")).body.default, "auto");
});

test("what the box makes itself, a conversation that runs nothing, and a Full Access switched off since are never a new conversation's Full Access", async () => {
  await route("PATCH", "kuvo/approval", { fullAccess: true });
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "fullAccess" });
  assert.equal((await route("GET", "kuvo/approval")).body.default, "fullAccess");
  const now = Date.now() + 60_000;
  // A group chat's seat, read before its mark lands: it holds back whole tools, so it's no client's Approve All.
  sessions.set("ses_seat", session("ses_seat", ["shell", "edit", "external_directory"].map(action => ({ action, resource: "*", effect: "deny" })), { time: { created: now, updated: now } }));
  // Ones the box made and marked, made since and from before.
  for (const [id, mark, created] of [["ses_part", { reviewPart: "x" }, now], ["ses_old_seat", { seat: { group: "grp_a", bot: "bot_scout00001" } }, 1], ["ses_engine_for", { engineFor: "ses_x" }, 1]]) {
    sessions.set(id, session(id, [], { time: { created, updated: created }, metadata: { kuvo: mark } }));
  }
  for (const id of ["ses_seat", "ses_part", "ses_old_seat", "ses_engine_for"]) {
    const read = (await route("GET", `kuvo/sessions/${id}/approval`, undefined, { sandbox: true })).body;
    assert.notEqual(read.effective, "fullAccess", id);
  }
  // The box's round leaves them as they are.
  await route("PATCH", "kuvo/approval", { fullAccess: true }, { sandbox: true });
  for (const id of ["ses_seat", "ses_part", "ses_old_seat", "ses_engine_for"]) assert.equal(sessions.get(id).metadata?.kuvo?.applied, undefined, id);
  // Switched off here since: the next new one is Auto, and comes back to Full Access only once you pick it again.
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  assert.equal((await route("GET", "kuvo/approval")).body.default, "auto");
  sessions.set("ses_after", session("ses_after", [], { time: { created: now, updated: now } }));
  assert.equal((await route("GET", "kuvo/sessions/ses_after/approval", undefined, { sandbox: true })).body.approval, "auto");
  // Switched on again, it's still Auto until you pick Full Access.
  await route("PATCH", "kuvo/approval", { fullAccess: true }, { sandbox: true });
  assert.equal((await route("GET", "kuvo/approval")).body.default, "auto");
});

test("a new conversation with your Don't Allows on whole tools still gets your default; one kept before, whose rules a client changed, never takes it again", async () => {
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "askFirst" }, { sandbox: true });
  assert.equal((await route("GET", "kuvo/approval")).body.default, "askFirst");
  const now = Date.now() + 60_000;
  sessions.set("ses_denies", session("ses_denies", [{ action: "webfetch", resource: "*", effect: "deny" }, NEVER_RM], { time: { created: now, updated: now } }));
  const denies = (await route("GET", "kuvo/sessions/ses_denies/approval", undefined, { sandbox: true })).body;
  assert.deepEqual({ approval: denies.approval, stored: denies.stored }, { approval: "askFirst", stored: false });
  // An older client's Approve All on one kept as Ask First: what its rules say now, never the default again.
  const kept = sessions.get("ses_careful");
  sessions.set("ses_careful", { ...kept, permissions: [NEVER_RM], time: { created: now, updated: now } });
  const changed = (await route("GET", "kuvo/sessions/ses_careful/approval", undefined, { sandbox: true })).body;
  assert.deepEqual({ approval: changed.approval, stored: changed.stored }, { approval: "auto", stored: false });
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  assert.ok(!asks("ses_careful", "shell"));
});

test("Auto and Full Access read .env files without asking, a Don't Allow in Settings still winning; one kept from before gets that too", async () => {
  const envReads = id => rules(id).filter(rule => rule.action === "read" && /\.env/.test(rule.resource));
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "auto" }, { sandbox: true });
  assert.deepEqual(envReads("ses_careful").map(rule => [rule.resource, rule.effect]), [["*.env", "allow"], ["*.env.*", "allow"]]);
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "askFirst" });
  assert.deepEqual(envReads("ses_careful"), [], "Ask First leaves the engine's own asks");
  write(settingsFile, JSON.stringify({ permissions: [{ action: "read", resource: "*.env", effect: "deny" }] }));
  await route("PATCH", "kuvo/approval", { fullAccess: true });
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "fullAccess" });
  assert.equal(envReads("ses_careful").findLast(rule => rule.resource === "*.env").effect, "deny", "your own Don't Allow, after, still holds");
  fs.rmSync(settingsFile, { force: true });
  // Kept with Auto by a box before, without them: made again as the box comes round.
  sessions.set("ses_kept", session("ses_kept", [NEVER_RM], { metadata: { kuvo: { approval: "auto", applied: "auto" } } }));
  await route("PATCH", "kuvo/approval", { fullAccess: false }, { sandbox: true });
  assert.deepEqual(envReads("ses_kept").map(rule => rule.effect), ["allow", "allow"]);
});

test("in Full Access and Auto, an agent making the same call again and again carries on, as in Claude Code and Codex, and isn't held for you; Ask First still asks; one kept from before gets that too", async () => {
  const loops = id => rules(id).filter(rule => rule.action === "doom_loop").map(rule => rule.effect);
  write(settingsFile, JSON.stringify({ permissions: [] }));
  await route("PATCH", "kuvo/approval", { fullAccess: true });
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "fullAccess" });
  assert.deepEqual(loops("ses_careful"), ["allow"]);
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "auto" }, { sandbox: true });
  assert.deepEqual(loops("ses_careful"), ["allow"]);
  await route("PUT", "kuvo/sessions/ses_careful/approval", { approval: "askFirst" });
  assert.deepEqual(loops("ses_careful"), [], "Ask First leaves the engine's own ask");
  fs.rmSync(settingsFile, { force: true });
  // Kept with Full Access by a box before, without it: made again as the box comes round.
  sessions.set("ses_looping", session("ses_looping", [{ action: "read", resource: "*.env", effect: "allow" }, { action: "read", resource: "*.env.*", effect: "allow" }], { metadata: { kuvo: { approval: "fullAccess", applied: "fullAccess" } } }));
  await route("PATCH", "kuvo/approval", { fullAccess: true });
  assert.deepEqual(loops("ses_looping"), ["allow"]);
});

test("one Auto's reviewer held back is approved from any client: allowed once, the agent told, and a paused conversation goes on", async () => {
  sessions.set("ses_auto", session("ses_auto", [], { metadata: { kuvo: { approval: "auto", applied: "auto" } } }));
  const decisions = [
    { id: "rd_aaaaaa", at: 1, action: "make deploy", kind: "command", decision: "refused", reason: "Not what you asked.", by: "model", why: "reviewer", held: true, key: "command make deploy" },
    { id: "rd_bbbbbb", at: 2, action: "rm -rf ~", kind: "command", decision: "refused", reason: "It deletes your home folder.", by: "code" },
  ];
  write(path.join(home, "box", "reviews", "ses_auto.json"), JSON.stringify({ decisions, refusedInRow: 3, refused: 3, paused: 2 }));
  const read = await route("GET", "kuvo/sessions/ses_auto/decisions");
  assert.equal(read.status, 200);
  assert.equal(read.body.paused, 2);
  assert.ok(read.body.decisions.every(each => !("key" in each)), "how it's matched stays on the box");
  const approved = await route("POST", "kuvo/sessions/ses_auto/decisions", { approve: "rd_aaaaaa" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.paused, undefined);
  assert.equal(typeof approved.body.decisions.find(each => each.id === "rd_aaaaaa").approved, "number");
  assert.equal(written.length, 1);
  assert.equal(written[0].session, "ses_auto");
  assert.equal(written[0].delivery, "steer");
  assert.match(written[0].text, /^\[The user approved what Auto's reviewer held back\] make deploy/);
  // Once; and a hard line can't be.
  assert.equal((await route("POST", "kuvo/sessions/ses_auto/decisions", { approve: "rd_aaaaaa" })).status, 404);
  assert.equal((await route("POST", "kuvo/sessions/ses_auto/decisions", { approve: "rd_bbbbbb" })).status, 404);
  assert.equal((await route("POST", "kuvo/sessions/ses_auto/decisions", {})).status, 400);
});

test("a folder Auto allowed edits in for the session shows as a decision, and any client can take it back: changes there are judged again (#422)", async () => {
  sessions.set("ses_place", session("ses_place", [], { metadata: { kuvo: { approval: "auto", applied: "auto" } } }));
  const decisions = [
    { id: "rd_change", at: 1, action: "Change /tmp/eval/T2/a.js", kind: "file", decision: "allowed", reason: "Part of the evaluation.", by: "model" },
    { id: "rd_place", at: 1, action: "Change /tmp/eval/T2", kind: "file", decision: "allowed", reason: "Auto allowed edits in /tmp/eval/T2 for this session.", by: "model", place: "/tmp/eval/T2" },
  ];
  const file = path.join(home, "box", "reviews", "ses_place.json");
  write(file, JSON.stringify({ decisions, refusedInRow: 0, refused: 0, places: ["/tmp/eval/T2"] }));
  const read = await route("GET", "kuvo/sessions/ses_place/decisions");
  assert.equal(read.body.decisions.find(each => each.id === "rd_place").place, "/tmp/eval/T2");
  assert.ok(!("places" in read.body), "where it goes ahead stays on the box, but as its decisions say");
  const revoked = await route("POST", "kuvo/sessions/ses_place/decisions", { revoke: "rd_place" });
  assert.equal(revoked.status, 200);
  assert.equal(typeof revoked.body.decisions.find(each => each.id === "rd_place").revoked, "number");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).places, []);
  // Once; and only a place.
  assert.equal((await route("POST", "kuvo/sessions/ses_place/decisions", { revoke: "rd_place" })).status, 404);
  assert.equal((await route("POST", "kuvo/sessions/ses_place/decisions", { revoke: "rd_change" })).status, 404);
  // Out of Auto, every folder it allowed goes: back in Auto, each change there is judged again.
  write(file, JSON.stringify({ decisions: [...decisions, { ...decisions[1], id: "rd_again", place: "/tmp/eval/T3" }], refusedInRow: 0, refused: 0, places: ["/tmp/eval/T3"] }));
  assert.equal((await route("PUT", "kuvo/sessions/ses_place/approval", { approval: "askFirst" })).status, 200);
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(kept.places, []);
  assert.equal(typeof kept.decisions.find(each => each.id === "rd_again").revoked, "number");
});

test("what Auto held back, looked at on one client, isn't news on another, but what it holds back after is", async () => {
  sessions.set("ses_seen", session("ses_seen", [], { metadata: { kuvo: { approval: "auto", applied: "auto" } } }));
  const held = (id, at) => ({ id, at, action: `make ${id}`, kind: "command", decision: "refused", reason: "Not what you asked.", by: "model", why: "reviewer", held: true, key: `command make ${id}` });
  const file = path.join(home, "box", "reviews", "ses_seen.json");
  write(file, JSON.stringify({ decisions: [held("rd_first", 1)], refusedInRow: 1, refused: 1 }));
  assert.equal((await route("GET", "kuvo/sessions/ses_seen/decisions")).body.seen, undefined, "never looked: all of it is news");
  const looked = await route("POST", "kuvo/sessions/ses_seen/decisions", { seen: true });
  assert.equal(looked.status, 200);
  assert.ok(looked.body.seen >= 1);
  // Held back later (as the box keeps one): after what was seen.
  const kept = JSON.parse(fs.readFileSync(file, "utf8"));
  write(file, JSON.stringify({ ...kept, decisions: [...kept.decisions, held("rd_later", looked.body.seen + 1)] }));
  const read = await route("GET", "kuvo/sessions/ses_seen/decisions");
  assert.deepEqual(read.body.decisions.filter(each => each.at > read.body.seen).map(each => each.id), ["rd_later"]);
});
