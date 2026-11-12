// Chats, marked by the box (PROTOCOL.md, "Chats"): a session in its chats folder carries
// `kuvo.chat` in its metadata, naming that folder, so a client draws a chat from the session
// itself, never from its folder. The engine makes a session the newest for any write, so the box
// never marks one from before it first heard the engine (an upgrade leaves every chat where it was
// in every list, for clients to go by its folder); it marks those made, moved or written to while
// it wasn't heard as it's heard again, the oldest first so they keep their order, and keeps the mark
// right as sessions are made, moved and written to, leaving the rest of their metadata as it was.
// The real link's watch, in this process; only the engine is a stand-in.
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

// The engine: its sessions, newest first a page at a time, each read and written as the real one
// (2.2.5) does: PATCH replaces its metadata whole and makes it the newest. Every write that changed
// a chat mark kept; and its events, followed.
const sessions = new Map();
const writes = [];
const followers = [];
let onWrite = () => {};
// The engine's clock, as each write makes a session the newest.
let clock = 0;
let onFollowed = () => {};
// Told as the box reads the whole list (every session, not only the newest), as it catches up.
let onListed = () => {};
const engine = keepsIdle(http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const url = new URL(request.url, "http://x");
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      return onFollowed();
    }
    if (url.pathname === "/api/session" && request.method === "GET") {
      const newest = [...sessions.values()].sort((a, b) => b.time.updated - a.time.updated);
      const limit = Number(url.searchParams.get("limit")) || newest.length;
      const start = Number(url.searchParams.get("cursor") ?? 0);
      send({ data: newest.slice(start, start + limit), cursor: { next: start + limit < newest.length ? String(start + limit) : null } });
      if (!url.searchParams.has("parentID")) onListed();
      return;
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    const session = one && sessions.get(decodeURIComponent(one[1]));
    if (session && request.method === "GET") return send({ data: session });
    if (session && request.method === "PATCH") {
      const given = JSON.parse(body);
      const was = session.metadata?.kuvo?.chat;
      Object.assign(session, given);
      session.time.updated = clock = Math.max(Date.now(), clock + 1);
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

// The sessions by when each changed last, the newest first, with their metadata.
const listed = ids => [...sessions.values()].filter(each => ids.includes(each.id)).sort((a, b) => b.time.updated - a.time.updated).map(each => ({ id: each.id, updated: each.time.updated, metadata: each.metadata }));
const heard = path.join(home, ".kuvo-code", "run", "chats-heard.json");
const before = ["ses_oldchat", "ses_oldlinked", "ses_oldsub", "ses_oldmovedout", "ses_shop"];

test("an upgrade: the first time the box hears its engine, no session from before is written, so every chat keeps its place and time in every list; one made then is marked as it's made", { timeout: 60_000 }, async t => {
  // From before boxes marked chats: a chat kept archived, one through a link to the chats folder,
  // a chat's subagent, a project's session marked by a box that marked it once, a project's.
  made("ses_oldchat", chats, { "kuvo.archived": true, kuvo: { approval: "auto" } });
  made("ses_oldlinked", linked);
  made("ses_oldsub", chats, undefined, { parentID: "ses_oldchat" });
  made("ses_oldmovedout", project, { kuvo: { chat: chats } });
  made("ses_shop", project);
  const was = listed(before);
  // As it hears its engine for the first time, and again as it follows it once more.
  assert.equal(await link.markChatsSince(atEngine, "engine"), 0);
  assert.ok(fs.existsSync(heard), "when it heard its engine, kept");
  assert.equal(await link.markChatsSince(atEngine, "engine"), 0);
  assert.deepEqual(writes, [], "nothing from before written");
  assert.deepEqual(listed(before), was, "each in its place, as old as it was, its metadata as it was");

  const stop = new AbortController();
  t.signal.addEventListener("abort", () => stop.abort());
  const followed = new Promise(resolve => { onFollowed = resolve; });
  link.watchEvents(() => atEngine, () => true, stop.signal, () => {}, { notices: false, work: "engine" });
  await followed;
  // A chat made now (by a client that doesn't mark it): marked.
  sessions.set("ses_first", { id: "ses_first", location: { directory: chats }, time: { created: Date.now(), updated: Date.now() } });
  tell("session.created", { sessionID: "ses_first", location: { directory: chats } });
  await writtenTo("ses_first");
  assert.deepEqual(writes, [{ id: "ses_first", chat: chats }]);
  stop.abort();
});

test("back after a while it wasn't heard: what changed meanwhile is marked as its folder says, the oldest first so they keep their order; nothing from before", { timeout: 60_000 }, async t => {
  writes.length = 0;
  const was = listed(before);
  // Changed while the box wasn't listening (it was restarting): a chat made, one through a link, a
  // chat's subagent, a chat moved into a project, and a chat a box from before brought here from a
  // box that marked it there.
  const at = Math.max(Date.now(), clock + 1);
  const now = (id, directory, metadata, more = {}, step = 0) => sessions.set(id, { id, location: { directory }, time: { created: at + step, updated: at + step }, ...(metadata ? { metadata } : {}), ...more });
  now("ses_gapmoved", project, { kuvo: { chat: chats, filed: { folder: project, project } } }, {}, 0);
  now("ses_gapchat", chats, { "kuvo.pinned": true }, {}, 1);
  now("ses_gaplinked", linked, undefined, {}, 2);
  now("ses_gapsub", chats, undefined, { parentID: "ses_gapchat" }, 3);
  now("ses_gapbrought", chats, { kuvo: { chat: "/Users/me/Library/Application Support/run.kuvo.code/Chats" } }, {}, 4);
  now("ses_gapshop", project, undefined, {}, 5);
  const wrong = ["ses_gapmoved", "ses_gapchat", "ses_gaplinked", "ses_gapsub", "ses_gapbrought"];
  const order = listed(wrong).map(each => each.id);
  const stop = new AbortController();
  t.signal.addEventListener("abort", () => stop.abort());
  link.watchEvents(() => atEngine, () => true, stop.signal, () => {}, { notices: false, work: "engine" });
  // (The newest wrong one is written last.)
  await writtenTo("ses_gapbrought");

  assert.deepEqual(writes.map(each => each.id), wrong, "only those whose mark was wrong, the oldest first");
  assert.deepEqual(listed(wrong).map(each => each.id), order, "still in the order they were in among themselves");
  assert.deepEqual(sessions.get("ses_gapmoved").metadata, { kuvo: { filed: { folder: project, project } } }, "a project's session carries no mark");
  assert.deepEqual(sessions.get("ses_gapchat").metadata, { "kuvo.pinned": true, kuvo: { chat: chats } }, "marked, the rest of its metadata as it was");
  assert.equal(sessions.get("ses_gaplinked").metadata.kuvo.chat, linked, "the chats folder through a link is the chats folder, named as the session names it");
  assert.equal(sessions.get("ses_gapsub").metadata.kuvo.chat, chats, "a chat's subagent works in the chats too");
  assert.equal(sessions.get("ses_gapbrought").metadata.kuvo.chat, chats, "marked for where it is now");
  assert.equal(sessions.get("ses_gapshop").metadata, undefined);
  assert.deepEqual(listed(before), was, "nothing from before");
  stop.abort();
});

test("a chat made, moved into a project, and written whole by a client keeps the mark its folder gives it, and one made marked isn't written to", { timeout: 60_000 }, async t => {
  sessions.clear();
  writes.length = 0;
  const stop = new AbortController();
  t.signal.addEventListener("abort", () => stop.abort());
  const followed = new Promise(resolve => { onFollowed = resolve; });
  // (Caught up first: it has nothing from before to mark.)
  const caughtUp = new Promise(resolve => { onListed = resolve; });
  link.watchEvents(() => atEngine, () => true, stop.signal, () => {}, { notices: false, work: "engine" });
  await followed;
  await caughtUp;

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
