// Searching what was said in a box's conversations (PROTOCOL.md, `kuvo/search`), on every box, for
// a client's sidebar search: sessions whose conversation has the words, archived ones too, the
// latest first, with the words around them; not for a word only the app's own labels have ("You",
// "Agent", "Read …" for a step), though a step's file is found; never a subagent's, a group chat
// seat's or a coding agent's turn. A conversation is read again only once its session changed.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/search.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-search-"));
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const folder = "/home/me/pomodoro";

function session(id, title, updated, extra = {}) {
  return { id, title, projectID: "p", time: { created: 1, updated }, location: { directory: folder }, ...extra };
}

/** What you said, and the agent's reply after it asked you something and read a file. */
function conversation(id, you, agent) {
  return [
    { id: `msg_${id}_1`, type: "user", time: { created: 1 }, text: you },
    { id: `msg_${id}_2`, type: "assistant", agent: "build", time: { created: 2, completed: 3 }, content: [
      { type: "tool", id: `call_${id}_q`, name: "question", state: { status: "completed", input: {} } },
      { type: "tool", id: `call_${id}_r`, name: "read", state: { status: "completed", input: { filePath: `${folder}/Sources/${id}.swift` } } },
      { type: "text", text: agent },
    ] },
  ];
}

/** An engine with these sessions and conversations, counting what it's asked. */
async function engine(t, sessions, conversations) {
  const asked = [];
  const server = http.createServer((request, response) => {
    asked.push(request.url);
    const reply = value => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    const url = new URL(request.url, "http://box");
    // A page at a time, as the engine pages them: `limit` of them, and the next page's cursor while
    // there are more (a cursor carries on where the last page ended).
    const paged = (all, size) => {
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? size);
      const data = all.slice(from, from + limit);
      return { data, cursor: from + limit < all.length ? { next: String(from + limit) } : null };
    };
    if (url.pathname === "/api/session") {
      if (sessions.fails) return response.writeHead(500).end("{}");
      return reply(paged(sessions.list.filter(each => !each.parentID), 100));
    }
    const messages = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
    // Newest first, as the engine pages them.
    if (messages) return reply(paged([...(conversations[decodeURIComponent(messages[1])] ?? [])].reverse(), 200));
    response.writeHead(404).end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const handle = link.engineHandler(() => ({ port: server.address().port, password: "pw" }), { name: "box" }, () => null);
  const search = async words => {
    const parts = [];
    for await (const part of handle({ method: "GET", path: `kuvo/search?q=${encodeURIComponent(words)}`, headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString() || "{}");
    return { status: parts[0].head.status, body, found: body.results?.map(result => result.session) };
  };
  return { asked, search };
}

test("finds what was said, the latest first, archived ones too, with the words around it", async t => {
  const sessions = { list: [
    session("ses_login", "Login", 30),
    session("ses_dark", "Theme", 20),
    session("ses_logs", "Old one", 10, { metadata: { "kuvo.archived": true } }),
  ] };
  const box = await engine(t, sessions, {
    ses_login: conversation("login", "The sign-in form forgets the email", "Fixed: the form keeps the email now."),
    ses_dark: conversation("dark", "Add a dark theme", "Done: the theme follows the system."),
    ses_logs: conversation("logs", "Why is the email log so big?", "It keeps every request."),
  });
  assert.deepEqual((await box.search("email")).found, ["ses_login", "ses_logs"]);
  assert.deepEqual((await box.search("THEME")).found, ["ses_dark"]);
  const forgets = (await box.search("forgets")).body.results[0].snippet;
  assert.ok(forgets.includes("forgets the email"), forgets);
  // Without caring for accents.
  assert.deepEqual((await box.search("emaíl")).found, ["ses_login", "ses_logs"]);
});

test("the app's own words for who spoke and for a step find nothing, but what a step worked on is found", async t => {
  const box = await engine(t, { list: [session("ses_dark", "Theme", 20)] }, { ses_dark: conversation("dark", "Add a dark theme", "Done: the theme follows the system.") });
  for (const word of ["you", "Agent", "asked", "read"]) assert.deepEqual((await box.search(word)).found, [], word);
  assert.deepEqual((await box.search("dark.swift")).found, ["ses_dark"]);
});

test("not a subagent's, a group chat seat's or a coding agent's turn, nor what Kuvo Code adds to a message", async t => {
  const box = await engine(t, { list: [
    session("ses_here", "Here", 40),
    session("ses_sub", "Sub", 30, { parentID: "ses_here" }),
    session("ses_seat", "Seat", 20, { metadata: { kuvo: { seat: "grp_1" } } }),
    session("ses_turn", "Turn", 10, { metadata: { kuvo: { engineFor: "ses_here" } } }),
  ] }, {
    ses_here: [
      { id: "msg_1", type: "user", text: "Check the release notes\n\n<sent-with>\nThe user sent this with a keyword, which Kuvo Code ran as they typed it:\n/plan\n</sent-with>" },
      { id: "msg_2", type: "user", text: "Picked the second\n\n<from-widget>\nThe user sent this from a widget shown in this conversation (show_widget), titled:\nRelease checklist\n</from-widget>" },
    ],
    ses_sub: conversation("sub", "release notes", "release notes"),
    ses_seat: conversation("seat", "release notes", "release notes"),
    ses_turn: conversation("turn", "release notes", "release notes"),
  });
  assert.deepEqual((await box.search("release notes")).found, ["ses_here"]);
  assert.deepEqual((await box.search("keyword")).found, [], "the keyword's note isn't what was said");
  assert.deepEqual((await box.search("show_widget")).found, [], "nor a widget's");
  assert.deepEqual((await box.search("picked the second")).found, ["ses_here"]);
});

test("a conversation is read again only once its session changed, and asking with nothing says so", async t => {
  const sessions = { list: [session("ses_again", "Login", 30)] };
  const conversations = { ses_again: conversation("again", "The sign-in form forgets the email", "Fixed.") };
  const box = await engine(t, sessions, conversations);
  const reads = () => box.asked.filter(url => url.includes("/message")).length;
  await box.search("email");
  await box.search("email");
  assert.equal(reads(), 1, "unchanged: read once");
  conversations.ses_again = conversation("again", "The sign-in form forgets the password", "Fixed.");
  sessions.list = [session("ses_again", "Login", 31)];
  assert.deepEqual((await box.search("password")).found, ["ses_again"]);
  assert.equal(reads(), 2);
  assert.equal((await box.search("  ")).status, 400);
});

test("every session is searched and every page of a long conversation, and each found comes with the session as listed", async t => {
  // More sessions than a page has, the oldest with the words, said at its very start.
  const list = Array.from({ length: 130 }, (_, index) => session(`ses_many${index}`, `Session ${index}`, 1000 - index));
  const long = [{ id: "msg_first", type: "user", text: "Remember the walrus" }];
  for (let index = 0; index < 450; index++) long.push({ id: `msg_${index}`, type: "assistant", content: [{ type: "text", text: `Step ${index}` }] });
  const box = await engine(t, { list }, { ses_many129: long });
  const found = await box.search("walrus");
  assert.deepEqual(found.found, ["ses_many129"]);
  assert.equal(found.body.results[0].info.title, "Session 129", "the session as the engine lists it");
  // Kept in the box's search folder, for a search from a process of its own (a Mac asking a
  // machine), and gone from it once its session is.
  const folder = path.join(home, "search");
  assert.ok(fs.readdirSync(folder).some(file => file.includes("ses_many129")));
  await box.search("walrus");
  assert.equal(box.asked.filter(url => url.includes("ses_many129/message")).length, 3, "read once, page by page");
});


test("a list that can't be read keeps what was kept, and a session gone takes its words with it", async t => {
  const sessions = { list: [session("ses_kept", "Login", 30), session("ses_gone", "Theme", 20)] };
  const box = await engine(t, sessions, {
    ses_kept: conversation("kept", "The sign-in form forgets the email", "Fixed."),
    ses_gone: conversation("gone", "Add a dark theme", "Done."),
  });
  const folder = path.join(home, "search");
  const kept = id => fs.readdirSync(folder).some(file => file.includes(id));
  const reads = () => box.asked.filter(url => url.includes("/message")).length;
  assert.deepEqual((await box.search("e")).found, ["ses_kept", "ses_gone"]);
  assert.equal(reads(), 2);
  // The engine can't list them for a moment (restarting): nothing is found, nothing forgotten.
  sessions.fails = true;
  assert.deepEqual((await box.search("email")).found, []);
  assert.ok(kept("ses_kept") && kept("ses_gone"));
  sessions.fails = false;
  assert.deepEqual((await box.search("email")).found, ["ses_kept"]);
  assert.equal(reads(), 2, "not read again");
  // Deleted: its words go from the folder.
  sessions.list = [session("ses_kept", "Login", 30)];
  await box.search("email");
  assert.ok(kept("ses_kept"));
  assert.ok(!kept("ses_gone"));
});
