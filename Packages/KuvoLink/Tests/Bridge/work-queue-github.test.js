// GitHub's issues and pull requests in the Work Queue (PROTOCOL.md, "The Work Queue", Issues and pull
// requests): an agent adds one as an item, or makes an item of its own one, and every client shows
// it by its name on GitHub with GitHub's title and state, Done once it's closed or merged there.
// Read with the box's own `gh`, only for what a client shows (and once as an agent adds it); never
// written to. The real box code, as clients and agents reach it; the engine and GitHub's `gh` are
// stand-ins (`gh` says what it was asked, and answers what the test says GitHub would).
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/work-queue-github.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-work-queue-github-")));
removeAtEnd(home);
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const queues = path.join(home, "run", "work-queue");
const seenFile = path.join(queues, "seen.json");

// GitHub's `gh`, standing in: each query it was asked, one per line; what it answers (`answer.json`);
// or, with `fail` there, what it says on stderr as it fails (signed out, say).
const bin = path.join(home, "bin");
fs.mkdirSync(bin);
const asked = path.join(home, "gh-asked");
const answer = path.join(home, "gh-answer.json");
const fail = path.join(home, "gh-fail");
fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
for last; do :; done
printf '%s\\n' "$last" | tr '\\n' ' ' >> '${asked}'
echo >> '${asked}'
if [ -f '${fail}' ]; then cat '${fail}' >&2; exit 1; fi
cat '${answer}'
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const queries = () => (fs.existsSync(asked) ? fs.readFileSync(asked, "utf8").split("\n").filter(Boolean) : []);

// An issue or a pull request as GitHub's GraphQL answers it, for each of the aliases asked.
const issue = (number, { state = "OPEN", stateReason = null, title = "Upload retries drop the file name", body = "When an upload is retried the name falls back to \"file\"." } = {}) => ({
  __typename: "Issue", id: `I_kw${number}`, number, title, url: `https://github.com/kuvo-test/app/issues/${number}`, state, stateReason, closedAt: state === "CLOSED" ? "2026-11-10T09:00:00Z" : null, body,
});
const pull = (number, { state = "OPEN", isDraft = false, merged = false, title = "Keep the name on retry" } = {}) => ({
  __typename: "PullRequest", id: `PR_kw${number}`, number, title, url: `https://github.com/kuvo-test/app/pull/${number}`, state, isDraft, merged, closedAt: state === "OPEN" ? null : "2026-11-10T10:00:00Z", body: "",
});
const github = (...nodes) => {
  fs.rmSync(fail, { force: true });
  fs.writeFileSync(answer, JSON.stringify({ data: Object.fromEntries(nodes.map((node, index) => [`p${index}`, { issueOrPullRequest: node }])) }));
};
// What was read made old, so the next look reads it again (a minute on).
const ageReads = () => {
  const kept = JSON.parse(fs.readFileSync(seenFile, "utf8"));
  for (const read of Object.values(kept.reads)) {
    read.at -= 3_600_000;
    if (read.checked) read.checked -= 3_600_000;
  }
  fs.writeFileSync(seenFile, JSON.stringify(kept));
};

// The engine: two conversations, and the tool call each is making now.
const sessions = new Map([
  ["ses_lead", { id: "ses_lead", title: "Lead", location: { directory: home }, time: { created: 1, updated: 5 } }],
  ["ses_other", { id: "ses_other", title: "Release notes", location: { directory: home }, time: { created: 3, updated: 4 } }],
]);
const calling = new Map();
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/session" && request.method === "GET") return reply({ data: [...sessions.values()] });
    if (url.pathname === "/api/session/active") return reply({ data: {} });
    const one = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    const id = one && decodeURIComponent(one[1]);
    if (one && !one[2]) return sessions.has(id) ? reply({ data: sessions.get(id) }) : reply({ message: "No such session." }, 404);
    if (one?.[2] === "/message") {
      const call = calling.get(id);
      return reply({ data: call ? [{ id: "msg_1", type: "assistant", content: [{ type: "tool", name: `kuvo-browser_${call.name}`, callID: "call_1", state: { status: "running", input: call.args } }] }] : [] });
    }
    reply({ data: [] });
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));

beforeEach(() => {
  fs.rmSync(queues, { recursive: true, force: true });
  fs.rmSync(asked, { force: true });
  fs.rmSync(fail, { force: true });
  calling.clear();
});

const handle = link.engineHandler();
async function route(method, pathname, body) {
  const pieces = [];
  for await (const piece of handle({ method, path: pathname, headers: {}, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)), fromApp: true }, undefined)) pieces.push(piece);
  const head = pieces.find(each => each.head).head;
  const text = Buffer.concat(pieces.filter(each => each.body).map(each => each.body)).toString();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: head.status, body: parsed };
}
async function tool(name, args, session = "ses_lead") {
  calling.set(session, { name, args });
  try {
    return (await route("POST", "kuvo/work-queue/tools", { name, arguments: args, session })).body;
  } finally {
    calling.delete(session);
  }
}
const view = async (owner = "ses_lead") => (await route("GET", `kuvo/work-queue?owner=${owner}`)).body;
const kept = () => JSON.parse(fs.readFileSync(path.join(queues, "queues", "ses_lead.json"), "utf8")).items;

test("an agent adds a GitHub issue: the item is that issue, named by it, with GitHub's title, never numbered", async () => {
  github(issue(12));
  const added = await tool("queue_add", { issue: "gh:kuvo-test/app#12", working: true });
  assert.equal(added.isError, false, added.text);
  assert.equal(added.text, 'Added gh:kuvo-test/app#12 "Upload retries drop the file name" (open on GitHub) to Next, linked to you: it shows In progress while you work. Refer to it as gh:kuvo-test/app#12. Its title and description are GitHub\'s, and it\'s Done once it\'s closed there.');
  assert.equal(queries().length, 1, "read once, as it was added");
  assert.match(queries()[0], /repository\(owner: "kuvo-test", name: "app"\) \{ issueOrPullRequest\(number: 12\)/);

  const [item] = (await view()).items;
  assert.equal(item.number, undefined);
  assert.equal(item.title, "Upload retries drop the file name");
  assert.equal(item.category, "next");
  assert.deepEqual(item.source, { kind: "github", ref: "gh:kuvo-test/app#12", url: "https://github.com/kuvo-test/app/issues/12", host: "github.com", id: "I_kw12", name: "app#12" });
  assert.equal(item.seen.state, "open");
  assert.equal(queries().length, 1, "just read: the panel doesn't ask again");
  const whole = (await route("GET", `kuvo/work-queue/items/${encodeURIComponent("gh:kuvo-test/app#12")}`)).body.item;
  assert.equal(whole.body, "When an upload is retried the name falls back to \"file\".");

  // Its page names it too, and it's one item for each issue.
  const again = await tool("queue_add", { issue: "https://github.com/kuvo-test/app/issues/12" });
  assert.deepEqual(again, { isError: true, text: 'gh:kuvo-test/app#12 "Upload retries drop the file name" is in your Work Queue already: refer to it as gh:kuvo-test/app#12.' });
  // An agent names it by its ref; its title and description stay GitHub's.
  assert.equal((await tool("queue_update", { item: "gh:kuvo-test/app#12", progress_note: "Writing the failing test first" })).isError, false);
  const retitled = await tool("queue_update", { item: "gh:kuvo-test/app#12", title: "Mine" });
  assert.deepEqual(retitled, { isError: true, text: 'gh:kuvo-test/app#12 "Upload retries drop the file name" takes its title and description from GitHub: change them there.' });
  // Read again a minute on and found the same: what's shown of it doesn't change (no line for it).
  const since = (await view()).items[0].seen.at;
  ageReads();
  assert.equal((await view()).items[0].seen.at, since - 3_600_000, "since when GitHub has said so, not when it was asked");
  assert.equal(queries().length, 2);
  // Named by another case, or by an old name GitHub still answers to: GitHub's own name, and still
  // one item.
  const renamed = await tool("queue_add", { issue: "gh:kuvo-test/old-app#12" });
  assert.equal(renamed.isError, true);
  assert.match(renamed.text, /is in your Work Queue already: refer to it as gh:kuvo-test\/app#12\./);
  // A number handed out later is the next one: it took none.
  assert.match((await tool("queue_add", { title: "Local work" })).text, /^Added #1 /);
});

test("GitHub's word on screen: read again only once it's due, closed is Done (its place kept for a reopen), and a read never changes the queue", async () => {
  github(issue(12));
  await tool("queue_add", { issue: "gh:kuvo-test/app#12", category: "later" });
  const before = kept();

  // Closed on GitHub as completed: Done, kept in Later.
  github(issue(12, { state: "CLOSED", stateReason: "COMPLETED", title: "Upload retries drop the name" }));
  ageReads();
  let [item] = (await view()).items;
  assert.equal(queries().length, 2);
  assert.deepEqual([item.category, item.keptIn, item.seen.state, item.title], ["done", "later", "completed", "Upload retries drop the name"]);
  assert.equal(item.doneAt, Date.parse("2026-11-10T09:00:00Z"));
  assert.deepEqual(kept(), before, "the queue file is as it was: GitHub's word is kept beside it");

  // Done is GitHub's: neither you nor an agent moves it in or out.
  const moved = await route("POST", `kuvo/work-queue/items/${item.id}/move`, { category: "next" });
  assert.equal(moved.status, 400);
  assert.equal(moved.body.message, 'gh:kuvo-test/app#12 "Upload retries drop the name" is closed on GitHub, so it\'s Done: it\'s back in its place once it\'s reopened there.');
  // Agents read what was last read, and never ask GitHub themselves.
  ageReads();
  assert.match((await tool("queue_list", { done: true })).text, /Done:\n- gh:kuvo-test\/app#12 "Upload retries drop the name" · closed on GitHub/);
  assert.match((await tool("queue_show", { item: "gh:kuvo-test/app#12" })).text, /^gh:kuvo-test\/app#12 "Upload retries drop the name" · Done \(kept in Later\)\nOn GitHub: closed, as read /);
  assert.equal(queries().length, 2, "no read for an agent's list");

  // Reopened: back in Later.
  github(issue(12, { title: "Upload retries drop the name" }));
  [item] = (await view()).items;
  assert.equal(queries().length, 3);
  assert.deepEqual([item.category, item.keptIn, item.seen.state, item.doneAt], ["later", undefined, "open", undefined]);
  const intoDone = await route("POST", `kuvo/work-queue/items/${item.id}/move`, { category: "done" });
  assert.equal(intoDone.status, 400, "nor you, into Done");
  const done = await tool("queue_update", { item: "gh:kuvo-test/app#12", category: "done" });
  assert.deepEqual(done, { isError: true, text: 'gh:kuvo-test/app#12 "Upload retries drop the name" is Done once it\'s closed on GitHub (or, a pull request, merged): close it there, or let the pull request that fixes it close it.' });

  // Not planned: Done too, said so.
  github(issue(12, { state: "CLOSED", stateReason: "NOT_PLANNED" }));
  ageReads();
  [item] = (await view()).items;
  assert.deepEqual([item.category, item.seen.state], ["done", "not_planned"]);
});

test("an item of the queue's own becomes the issue it's about: named by it from then on, its number still finding it", async () => {
  await tool("queue_add", { title: "Fix upload names", body: "Seen in the logs on Friday." });
  github(issue(9, { title: "Session restore on launch", body: "" }));
  const linked = await tool("queue_update", { item: "#1", issue: "https://github.com/kuvo-test/app/issues/9" });
  assert.equal(linked.isError, false, linked.text);
  assert.equal(linked.text, '#1 is gh:kuvo-test/app#9 "Session restore on launch" now (open on GitHub), in Next: refer to it as gh:kuvo-test/app#9 (#1 still finds it). Its title and description are GitHub\'s (what it said before is kept as a note), and it\'s Done once it\'s closed there.');
  const [item] = (await view()).items;
  assert.deepEqual([item.number, item.title, item.source.name], [1, "Session restore on launch", "app#9"]);
  // (GitHub had no description: the item's own stays.)
  assert.equal((await route("GET", "kuvo/work-queue/items/1")).body.item.body, "Seen in the logs on Friday.");

  // A chip of either name draws the issue.
  const refs = (await route("POST", "kuvo/work-queue/refs", { refs: ["#1", "gh:kuvo-test/app#9", "gh:kuvo-test/app#10"] })).body.refs;
  assert.equal(refs["#1"].source.ref, "gh:kuvo-test/app#9");
  assert.deepEqual(refs["gh:kuvo-test/app#9"], refs["#1"]);
  assert.deepEqual(refs["gh:kuvo-test/app#9"].seen.state, "open");
  assert.equal(refs["gh:kuvo-test/app#10"], null, "one not in a queue stays plain text");

  // A second issue can't be the same item, nor another item that same issue.
  const twice = await tool("queue_update", { item: "#1", issue: "gh:kuvo-test/app#12" });
  assert.equal(twice.text, 'gh:kuvo-test/app#9 "Session restore on launch" is gh:kuvo-test/app#9 already: one item is one issue or pull request.');
  await tool("queue_add", { title: "Another" });
  const taken = await tool("queue_update", { item: "#2", issue: "gh:kuvo-test/app#9" });
  assert.equal(taken.text, 'gh:kuvo-test/app#9 "Session restore on launch" is in your Work Queue already: refer to it as gh:kuvo-test/app#9.');
});

test("a pull request is an item too: Done once it's merged, or closed unmerged", async () => {
  github(pull(57, { isDraft: true }));
  assert.equal((await tool("queue_add", { issue: "https://github.com/kuvo-test/app/pull/57" })).isError, false);
  let [item] = (await view()).items;
  assert.deepEqual([item.source.kind, item.seen.state, item.category], ["github-pr", "draft", "next"]);
  github(pull(57, { state: "MERGED", merged: true }));
  ageReads();
  [item] = (await view()).items;
  assert.deepEqual([item.seen.state, item.category], ["merged", "done"]);
  github(pull(57, { state: "CLOSED" }));
  ageReads();
  [item] = (await view()).items;
  assert.deepEqual([item.seen.state, item.category], ["closed", "done"]);
});

test("what gh can't read is said in words, and nothing is added; one gone later keeps what was last read", async () => {
  fs.writeFileSync(fail, "To get started with GitHub CLI, please run:  gh auth login\n");
  const signedOut = await tool("queue_add", { issue: "gh:kuvo-test/app#12" });
  assert.deepEqual(signedOut, { isError: true, text: "gh isn't signed in to GitHub on this machine: gh auth login signs it in." });
  github(null);
  const missing = await tool("queue_add", { issue: "gh:kuvo-test/app#404" });
  assert.deepEqual(missing, { isError: true, text: "GitHub has no issue or pull request gh:kuvo-test/app#404 that gh on this machine may see (gh auth status says which account it uses)." });
  assert.deepEqual(await tool("queue_add", { issue: "https://gitlab.com/kuvo/app/-/issues/3" }), { isError: true, text: "Give the issue or pull request (issue) as gh:owner/repo#12, or its address on github.com." });
  assert.equal((await view()).items.length, 0);

  fs.rmSync(asked);
  github(issue(12));
  await tool("queue_add", { issue: "gh:kuvo-test/app#12" });
  // No longer visible (a token's access taken away, or the issue deleted): shown as last read.
  github(null);
  ageReads();
  const [item] = (await view()).items;
  assert.deepEqual([item.title, item.seen.state, item.seen.gone, item.category], ["Upload retries drop the file name", "open", true, "next"]);
  // Signed out since: not asked again for a while.
  fs.writeFileSync(fail, "gh auth login\n");
  ageReads();
  await view();
  await view();
  assert.equal(queries().length, 3, "added, found gone, then signed out: held off since");
});

test("an issue's own description is GitHub's: its bare #n are that repository's, said so to agents", async () => {
  github(issue(12, { body: "Duplicate of #45." }));
  await tool("queue_add", { issue: "gh:kuvo-test/app#12" });
  assert.match((await tool("queue_show", { item: "gh:kuvo-test/app#12" })).text, /Its description on GitHub \(a bare #n there is gh:kuvo-test\/app's, not a Work Queue item\):\nDuplicate of #45\./);
});

test("what this box tells your other computers carries GitHub's word, so they show it without gh", async () => {
  github(issue(12, { state: "CLOSED", stateReason: "COMPLETED" }));
  await tool("queue_add", { issue: "gh:kuvo-test/app#12", category: "parked" });
  const told = (await link.queueTellingNow([{ port: engine.address().port, password: "p" }], null)).payload.told;
  const [item] = told.items;
  assert.deepEqual([item.category, item.keptIn, item.seen.state, item.source.name], ["done", "parked", "completed", "app#12"]);
  assert.equal(typeof item.seen.checked, "number", "when it last asked GitHub, so the others don't ask again soon");
});
