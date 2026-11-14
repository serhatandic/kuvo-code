// Searching what was said in a box's conversations (PROTOCOL.md, `kuvo/search`), on every box, for
// a client's sidebar search: sessions whose conversation has the words, archived ones too, the
// latest first, with the words around them; not for a word only the app's own labels have ("You",
// "Agent", "Read …" for a step), though a step's file is found; a subagent's words find the
// conversation it works for; never a group chat seat's or a coding agent's turn. A conversation is
// read again only once its session changed.
//
// Run with `node --test box/bridge-tests/search.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-search-"));
process.env.KUVO_HOME = home;
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
removeAtEnd(home);

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
      if (sessions.down) return response.writeHead(500).end("{}");
      // Those under none (`parentID=null`), or all of them, subagents' too.
      const roots = url.searchParams.get("parentID") === "null";
      return reply(paged(sessions.list.filter(each => !roots || !each.parentID), 100));
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

test("not a group chat seat's or a coding agent's turn, nor their subagents', nor what Kuvo Code adds to a message", async t => {
  const box = await engine(t, { list: [
    session("ses_here", "Here", 40),
    session("ses_seat", "Seat", 20, { metadata: { kuvo: { seat: "grp_1" } } }),
    session("ses_seat_sub", "Seat's subagent", 25, { parentID: "ses_seat" }),
    session("ses_turn", "Turn", 10, { metadata: { kuvo: { engineFor: "ses_here" } } }),
  ] }, {
    ses_here: [
      { id: "msg_1", type: "user", text: "Check the release notes\n\n<sent-with>\nThe user sent this with a keyword, which Kuvo Code ran as they typed it:\n/plan\n</sent-with>" },
      { id: "msg_2", type: "user", text: "Picked the second\n\n<from-widget>\nThe user sent this from a widget shown in this conversation (show_widget), titled:\nRelease checklist\n</from-widget>" },
      // /goal as a box sent it before it went in the block.
      { id: "msg_3", type: "user", text: "[Goal] Summarize the commits weekly\n\n(The user asked for this as a goal: plan it, check what it needs, and put it to them with propose_goal before doing any of the work.)" },
      // What the box told the bot, marked, and as it was before it marked it.
      { id: "msg_4", type: "user", text: "[Goal started] The user approved the plan. Work through it now: 1. Read 2. Write", metadata: { kuvo: { note: { from: "Goal", line: "Goal started" } } } },
      { id: "msg_5", type: "user", text: "[Not now] The user didn't start this goal. Don't start its work: ask them in a line what they'd like instead, if anything." },
    ],
    ses_seat: conversation("seat", "release notes", "release notes"),
    ses_seat_sub: conversation("seatsub", "release notes", "release notes"),
    ses_turn: conversation("turn", "release notes", "release notes"),
  });
  assert.deepEqual((await box.search("release notes")).found, ["ses_here"]);
  assert.deepEqual((await box.search("keyword")).found, [], "the keyword's note isn't what was said");
  assert.deepEqual((await box.search("show_widget")).found, [], "nor a widget's");
  assert.deepEqual((await box.search("picked the second")).found, ["ses_here"]);
  assert.deepEqual((await box.search("propose_goal")).found, [], "nor what a goal asked for told the bot");
  assert.deepEqual((await box.search("summarize the commits")).found, ["ses_here"]);
  assert.deepEqual((await box.search("approved the plan")).found, [], "nor what the box told the bot");
  assert.deepEqual((await box.search("didn't start this goal")).found, [], "nor what it told it before it marked it");
});

test("a review's part, read in a session of its own under the conversation, is never found: its review shows it", async t => {
  const box = await engine(t, { list: [
    session("ses_reviewed", "Login", 41),
    session("ses_part", "Review · part 1 of 2", 45, { parentID: "ses_reviewed", metadata: { kuvo: { reviewPart: { review: "rev_1", part: 1, of: 2 } } } }),
  ] }, {
    ses_reviewed: conversation("here", "Fix the login", "Done."),
    ses_part: conversation("part", "You review code with fresh eyes: the login", "The token is written to the log."),
  });
  assert.deepEqual((await box.search("token is written")).found, []);
  assert.deepEqual((await box.search("fresh eyes")).found, []);
  assert.deepEqual((await box.search("fix the login")).found, ["ses_reviewed"]);
});

test("a subagent's words find the conversation it works for, as that conversation, once, with the subagent that said them", async t => {
  const box = await engine(t, { list: [
    session("ses_timer", "Timer cycle", 50),
    session("ses_find", "Find the timer", 45, { parentID: "ses_timer" }),
    session("ses_deeper", "Read the settings", 44, { parentID: "ses_find" }),
    session("ses_other", "Theme", 40),
    session("ses_orphan", "Its conversation is gone", 60, { parentID: "ses_deleted" }),
  ] }, {
    ses_timer: conversation("timer", "Make the timer cycle", "Done: it cycles."),
    ses_find: conversation("find", "Find where the timer lives", "It's in TimerStore, next to the pomodoro count."),
    ses_deeper: conversation("deeper", "Read the settings file", "The cycle length is in the plist."),
    ses_other: conversation("other", "Add a dark theme", "Done: the pomodoro count is themed too."),
    ses_orphan: conversation("orphan", "pomodoro", "pomodoro"),
  });
  const found = await box.search("pomodoro count");
  assert.deepEqual(found.found, ["ses_timer", "ses_other"], "the conversation, the latest first; not a subagent whose conversation is gone");
  const [timer, other] = found.body.results;
  assert.equal(timer.info.title, "Timer cycle", "the conversation as listed");
  assert.equal(timer.subagent?.id, "ses_find", "with the subagent that said it");
  assert.ok(timer.snippet.includes("pomodoro count"), timer.snippet);
  assert.equal(other.subagent, undefined, "its own words: no subagent");
  // A subagent's subagent finds the same conversation.
  const deeper = await box.search("plist");
  assert.deepEqual(deeper.found, ["ses_timer"]);
  assert.equal(deeper.body.results[0].subagent?.id, "ses_deeper");
  // Its own words come first, and it's found once.
  const own = await box.search("timer");
  assert.deepEqual(own.found, ["ses_timer"]);
  assert.equal(own.body.results[0].subagent, undefined);
});

test("a subagent's words, once it has said more, are found as it says them now", async t => {
  const sessions = { list: [session("ses_top", "Top", 50), session("ses_sub", "Sub", 40, { parentID: "ses_top" })] };
  const conversations = { ses_top: conversation("top", "Look into it", "On it."), ses_sub: conversation("sub", "Find the walrus", "Not yet.") };
  const box = await engine(t, sessions, conversations);
  assert.deepEqual((await box.search("narwhal")).found, []);
  conversations.ses_sub = conversation("sub", "Find the walrus", "Found a narwhal instead.");
  sessions.list = [session("ses_top", "Top", 50), session("ses_sub", "Sub", 41, { parentID: "ses_top" })];
  const found = await box.search("narwhal");
  assert.deepEqual(found.found, ["ses_top"]);
  assert.equal(found.body.results[0].subagent?.id, "ses_sub");
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

test("an engine that doesn't answer says so rather than finding nothing, and what was kept stays", async t => {
  const sessions = { list: [session("ses_kept", "Kept", 30)] };
  const box = await engine(t, sessions, { ses_kept: conversation("kept", "The deploy script", "Done.") });
  assert.deepEqual((await box.search("deploy")).found, ["ses_kept"]);
  sessions.down = true;
  assert.equal((await box.search("deploy")).status, 503);
  sessions.down = false;
  await box.search("deploy");
  assert.equal(box.asked.filter(url => url.includes("ses_kept/message")).length, 1, "kept while the engine was away");
});

test("in any language, without case or accents, and a long conversation's latest words too", async t => {
  const long = [{ id: "msg_old", type: "user", text: "x".repeat(450_000) }, { id: "msg_new", type: "user", text: "Deploy to İstanbul, then 한국어 검색 and the café ☕" }];
  const box = await engine(t, { list: [session("ses_words", "Words", 30)] }, { ses_words: long });
  for (const words of ["istanbul", "검색", "CAFE", "☕"]) assert.deepEqual((await box.search(words)).found, ["ses_words"], words);
  assert.ok((await box.search("검색")).body.results[0].snippet.includes("한국어 검색"));
});


test("a session deleted takes its words with it, from the box's search folder too", async t => {
  const sessions = { list: [session("ses_kept", "Login", 30), session("ses_gone", "Theme", 20)] };
  const box = await engine(t, sessions, {
    ses_kept: conversation("kept", "The sign-in form forgets the email", "Fixed."),
    ses_gone: conversation("gone", "Add a dark theme", "Done."),
  });
  const kept = id => fs.readdirSync(path.join(home, "search")).some(file => file.includes(id));
  await box.search("theme");
  assert.ok(kept("ses_kept") && kept("ses_gone"));
  sessions.list = [session("ses_kept", "Login", 30)];
  await box.search("email");
  assert.ok(kept("ses_kept"));
  assert.ok(!kept("ses_gone"));
});
