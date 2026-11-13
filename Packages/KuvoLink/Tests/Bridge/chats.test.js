// Chats, marked by the box (PROTOCOL.md, "Chats"): a session in its chats folder carries
// `kuvo.chat` in its metadata, naming that folder, so a client draws a chat from the session
// itself, never from its folder. The engine (2.2.6) makes a session the newest for any write, so
// the box writes the mark only as a session is made, moved or has its metadata written, never on a
// session from before: an upgrade, an old chat written to since, and the box hearing its engine
// again after a while leave every session where it was in every list, for clients to go by its
// folder. The real link's watch, in this process; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/chats.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";
import { keepsIdle } from "./keeps-idle.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-chats-")));
removeAtEnd(home);
process.env.KUVO_HOME = path.join(home, ".kuvo-code");
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// A machine's chats folder, a project, and the chats folder again through a link.
const chats = path.join(home, ".kuvo-code", "chats");
const project = path.join(home, "shop");
const linked = path.join(home, "chats-link");
fs.mkdirSync(chats, { recursive: true });
fs.mkdirSync(project, { recursive: true });
fs.symlinkSync(chats, linked);

// The engine: its sessions, a page at a time in the order asked (the newest first for `desc`),
// each read and written as the real one (2.2.6) does: PATCH replaces its metadata whole and makes
// it the newest. Every write that changed a chat mark kept, every read of all its sessions (not
// one's subagents) counted; and its events, followed.
const sessions = new Map();
const writes = [];
const followers = [];
let listedAll = 0;
let onWrite = () => {};
let onFollowed = () => {};
// The engine's clock, as each write makes a session the newest.
let clock = 0;
const tick = () => (clock = Math.max(Date.now(), clock + 1));
// Requests it's answering now, and who waits for none to be left.
let answering = 0;
let onIdle = () => {};
const engine = keepsIdle(http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      return onFollowed();
    }
    answering += 1;
    const send = (value, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
      answering -= 1;
      if (!answering) onIdle();
    };
    if (url.pathname === "/api/session" && request.method === "GET") {
      if (!url.searchParams.has("parentID")) listedAll += 1;
      const page = url.searchParams.get("cursor") ? JSON.parse(Buffer.from(url.searchParams.get("cursor"), "base64url").toString()) : { order: url.searchParams.get("order") ?? "desc", start: 0 };
      const all = [...sessions.values()].sort((a, b) => (page.order === "asc" ? a.time.updated - b.time.updated : b.time.updated - a.time.updated));
      const limit = Number(url.searchParams.get("limit")) || all.length;
      const next = page.start + limit < all.length ? Buffer.from(JSON.stringify({ ...page, start: page.start + limit })).toString("base64url") : null;
      return send({ data: all.slice(page.start, page.start + limit), cursor: { next } });
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    const session = one && sessions.get(decodeURIComponent(one[1]));
    if (session && request.method === "GET") return send({ data: session });
    if (session && request.method === "PATCH") {
      const given = JSON.parse(body);
      const was = session.metadata?.kuvo?.chat;
      Object.assign(session, given);
      session.time.updated = tick();
      if (session.metadata?.kuvo?.chat !== was) writes.push({ id: session.id, chat: session.metadata?.kuvo?.chat ?? null });
      onWrite();
      return send({ data: session });
    }
    send({}, 404);
  });
}));
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
const atEngine = { port: engine.address().port, password: "pw" };
atEnd(() => {
  for (const each of followers) each.end();
  engine.closeAllConnections();
  engine.close();
});

let updated = 1_000;
const made = (id, directory, metadata, more = {}) => sessions.set(id, { id, location: { directory }, time: { created: updated, updated: updated++ }, ...(metadata ? { metadata } : {}), ...more });
const tell = (type, data) => followers.at(-1).write(`data: ${JSON.stringify({ id: `evt_${type}`, type, data })}\n\n`);
// Until `id` was written (`times` writes of it in all), whatever else was.
const writtenTo = (id, times = 1) => new Promise(resolve => {
  const look = () => { if (writes.filter(each => each.id === id).length >= times) resolve(); };
  onWrite = look;
  look();
});
// Until nothing the box asked is still being answered.
const idle = () => new Promise(resolve => {
  onIdle = resolve;
  if (!answering) resolve();
});
// Every session, the newest first, as a client's list has them.
const list = () => [...sessions.values()].sort((a, b) => b.time.updated - a.time.updated).map(each => each.id);

// The box follows its engine (again): once it's heard a chat a client made just now (without its
// mark, as one from before would) and marked it, and nothing it asked is still being answered.
async function follows(t, marker) {
  const stop = new AbortController();
  t.signal.addEventListener("abort", () => stop.abort());
  const followed = new Promise(resolve => { onFollowed = resolve; });
  link.watchEvents(() => atEngine, () => true, stop.signal, () => {}, { notices: false, work: "engine" });
  await followed;
  sessions.set(marker, { id: marker, location: { directory: chats }, time: { created: tick(), updated: clock } });
  tell("session.created", { sessionID: marker, location: { directory: chats } });
  await writtenTo(marker);
  await idle();
  return stop;
}

const old = ["ses_oldchat", "ses_oldlinked", "ses_oldsub", "ses_oldmovedout", "ses_shop", "ses_shop2"];

test("an upgrade: as the box first hears its engine, no session from before is written, so every chat keeps its place and time in every list; one made then is marked", { timeout: 60_000 }, async t => {
  // From before boxes marked chats: a chat kept archived, one through a link to the chats folder,
  // a chat's subagent, a project's session left marked by a box that marked it once, projects'.
  made("ses_oldchat", chats, { "kuvo.archived": true, kuvo: { approval: "auto" } });
  made("ses_shop", project);
  made("ses_oldlinked", linked);
  made("ses_oldsub", chats, undefined, { parentID: "ses_oldchat" });
  made("ses_oldmovedout", project, { kuvo: { chat: chats } });
  made("ses_shop2", project);
  // (More than a page of them, so one that reads them all reads page after page.)
  for (let i = 0; i < 220; i++) made(`ses_older${i}`, project);
  const was = list();
  const metadata = Object.fromEntries(old.map(id => [id, structuredClone(sessions.get(id).metadata)]));

  const stop = await follows(t, "ses_first");
  assert.deepEqual(writes, [{ id: "ses_first", chat: chats }], "nothing from before written");
  assert.deepEqual(list(), ["ses_first", ...was], "every session where it was, the new chat on top");
  for (const id of old) assert.deepEqual(sessions.get(id).metadata, metadata[id], `${id}: its metadata as it was`);
  assert.equal(listedAll, 0, "it never reads every session to look for one to mark");
  stop.abort();
});

test("an old chat written to after the box first heard its engine (a message), then a project's session after it (renamed), then the box hears its engine again: the old chat is never written, and the list stays in that order", { timeout: 60_000 }, async t => {
  writes.length = 0;
  // A message to the old chat, then a rename of a project's session: each the newest in turn.
  sessions.get("ses_oldchat").time.updated = tick();
  sessions.get("ses_shop").time.updated = tick();
  sessions.get("ses_shop").title = "Checkout";
  const was = list();
  assert.deepEqual(was.slice(0, 3), ["ses_shop", "ses_oldchat", "ses_first"]);

  // The box stopped hearing its engine (the app quit, the engine restarted) and hears it again.
  const stop = await follows(t, "ses_second");
  assert.deepEqual(writes, [{ id: "ses_second", chat: chats }], "the old chat never written");
  assert.deepEqual(list(), ["ses_second", ...was], "every session where it was, the new chat on top");
  assert.equal(sessions.get("ses_oldchat").metadata.kuvo.chat, undefined, "no mark: clients go by its folder");
  assert.equal(listedAll, 0, "it never reads every session to look for one to mark");
  stop.abort();
});

test("a chat made, moved into a project, and written whole by a client keeps the mark its folder gives it, and one made marked isn't written to", { timeout: 60_000 }, async t => {
  sessions.clear();
  writes.length = 0;
  const stop = new AbortController();
  t.signal.addEventListener("abort", () => stop.abort());
  const followed = new Promise(resolve => { onFollowed = resolve; });
  link.watchEvents(() => atEngine, () => true, stop.signal, () => {}, { notices: false, work: "engine" });
  await followed;

  // Made by a client that doesn't mark it (an older one, or the engine itself): marked, as the
  // engine's event shows it, once its approval's written (which writes its metadata too), with
  // both kept.
  made("ses_new", chats, { kuvo: { approval: "askFirst" } });
  tell("session.created", { sessionID: "ses_new", location: { directory: chats }, metadata: { kuvo: { approval: "askFirst" } } });
  await writtenTo("ses_new");
  assert.deepEqual(sessions.get("ses_new").metadata, { kuvo: { approval: "askFirst", applied: "askFirst", chat: chats } });

  // Made marked already (by a box's own start, a move): nothing to write; nor for a project's.
  made("ses_given", chats, { kuvo: { chat: chats } });
  tell("session.created", { sessionID: "ses_given", location: { directory: chats }, metadata: { kuvo: { chat: chats } } });
  made("ses_work", project);
  tell("session.created", { sessionID: "ses_work", location: { directory: project } });

  // Moved into a project: no longer a chat.
  sessions.get("ses_new").location = { directory: project };
  tell("session.moved", { sessionID: "ses_new" });
  await writtenTo("ses_new", 2);
  assert.deepEqual(sessions.get("ses_new").metadata, { kuvo: { approval: "askFirst", applied: "askFirst" } });

  // A client wrote a chat's metadata whole without the mark (a pin, from what it read before):
  // marked again, the pin kept.
  made("ses_pinned", chats, { kuvo: { chat: chats } });
  sessions.get("ses_pinned").metadata = { "kuvo.pinned": true };
  tell("session.metadata.updated", { sessionID: "ses_pinned", metadata: { "kuvo.pinned": true } });
  await writtenTo("ses_pinned");
  assert.deepEqual(sessions.get("ses_pinned").metadata, { "kuvo.pinned": true, kuvo: { chat: chats } });

  assert.deepEqual(writes, [{ id: "ses_new", chat: chats }, { id: "ses_new", chat: null }, { id: "ses_pinned", chat: chats }], "no mark changed for one marked right");
  stop.abort();
});
