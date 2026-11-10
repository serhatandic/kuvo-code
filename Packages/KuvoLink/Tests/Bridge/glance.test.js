// A session's row and card at a glance (PROTOCOL.md, "A session at a glance"): the branch a session
// has of its own, its pull request with its checks and size, the account it runs on, and since when
// it's waited on you, as the box states them for every client. The real box code; the engine is a
// stand-in, and so is GitHub's `gh`, which says what it was asked.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/glance.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-glance-")));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// GitHub's `gh`, standing in: what it answers each query (`answer.json`, or nothing at all with
// `gone`), and each query it was asked, one per line.
const bin = path.join(home, "bin");
fs.mkdirSync(bin);
const asked = path.join(home, "gh-asked");
const answer = path.join(home, "gh-answer.json");
fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh
for last; do :; done
printf '%s\\n' "$last" | tr '\\n' ' ' >> '${asked}'
echo >> '${asked}'
cat '${answer}'
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
const queries = () => (fs.existsSync(asked) ? fs.readFileSync(asked, "utf8").split("\n").filter(Boolean) : []);
const github = data => fs.writeFileSync(answer, JSON.stringify({ data }));

// A pull request as GitHub's GraphQL answers it, its checks counted by state.
const pr = (number, { state = "OPEN", isDraft = false, branch = "kuvo/timer", runs = { SUCCESS: 12, QUEUED: 2 }, statuses = {} } = {}) => ({
  number, url: `https://github.com/kuvo-test/app/pull/${number}`, state, isDraft, additions: 435, deletions: 4, headRefName: branch,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
    checkRunCountsByState: Object.entries(runs).map(([state, count]) => ({ state, count })),
    statusContextCountsByState: Object.entries(statuses).map(([state, count]) => ({ state, count })),
  } } } }] },
});

// A project with a worktree of the box's own for one session, on its branch with two commits
// since its base, and the project's checkout itself for the others.
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
const project = path.join(home, "work", "pomodoro");
const tree = path.join(home, "worktrees", "timer");
fs.mkdirSync(project, { recursive: true });
git(project, "init", "-q", "-b", "main");
git(project, "config", "user.name", "Ada");
git(project, "config", "user.email", "ada@example.com");
git(project, "remote", "add", "origin", "git@github.com:kuvo-test/app.git");
fs.writeFileSync(path.join(project, "timer.js"), "one\n");
git(project, "add", "-A");
git(project, "commit", "-q", "-m", "First");
git(project, "worktree", "add", "-q", "-b", "kuvo/timer", tree);
fs.writeFileSync(path.join(tree, "timer.js"), "one\ntwo\nthree\n");
git(tree, "commit", "-q", "-am", "More");
fs.writeFileSync(path.join(tree, "timer.js"), "one\nthree\n");
fs.mkdirSync(path.join(home, "box"), { recursive: true });
fs.writeFileSync(path.join(home, "box", "worktrees.json"), JSON.stringify({ worktrees: [{ project, root: tree, folder: tree, branch: "kuvo/timer", base: "main" }] }));

// The engine, standing in: its sessions, and the accounts it has.
const session = (id, directory, extra = {}) => ({ id, title: id, location: { directory }, time: { created: 1, updated: 1 }, model: { id: "claude-opus-5-5", providerID: "anthropic" }, ...extra });
const sessions = {
  ses_tree: session("ses_tree", tree),
  ses_mine: session("ses_mine", project),
  ses_other: session("ses_other", project, { model: { id: "gpt-5.5", providerID: "openai" } }),
  ses_helper: session("ses_helper", project, { parentID: "ses_mine" }),
};
const engine = http.createServer((request, response) => {
  const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (request.url === "/api/integration") return reply({ data: [{ id: "anthropic", name: "Anthropic" }, { id: "openai", name: "OpenAI" }] });
  const one = request.url.match(/^\/api\/session\/([^/?]+)$/);
  const found = one && sessions[decodeURIComponent(one[1])];
  return found ? reply({ data: found }) : reply({ message: "No such session." }, 404);
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const targets = [{ port: engine.address().port, password: "p" }];

let clock = 1_000_000_000_000;
// A pull request linked to `session`, once the catch has made the link (it reads the engine first).
const linked = session => new Promise((resolve, reject) => {
  const deadline = Date.now() + 10_000;
  const look = () => link.readPullLinks()[session] ? resolve() : Date.now() > deadline ? reject(new Error(`No pull request linked to ${session}.`)) : setTimeout(look, 10);
  look();
});
const now = () => clock;
const glance = ids => link.glances(ids, targets, undefined, now);

beforeEach(() => {
  clock += 3_600_000;
  for (const file of [asked, path.join(home, "run", "glance", "github.json"), path.join(home, "box", "pulls.json")]) fs.rmSync(file, { force: true });
  link.forgetAsks();
  github({ p0: { pullRequests: { nodes: [] } } });
});

test("a worktree's row: its branch with the lines it changed, its account, and nothing of a pull request it doesn't have", async () => {
  const shown = await glance(["ses_tree", "ses_mine"]);
  assert.deepEqual(shown.ses_tree, { branch: "kuvo/timer", additions: 1, deletions: 0, account: { name: "Anthropic" } });
  // In the project's own checkout: no branch of its own, so no mark on its row.
  assert.deepEqual(shown.ses_mine, { account: { name: "Anthropic" } });
  assert.match(queries()[0], /repository\(owner: "kuvo-test", name: "app"\) \{ pullRequests\(headRefName: "kuvo\/timer"/);
});

test("a worktree's branch with a pull request: its number, state, size and checks, and the lines are the pull request's", async () => {
  github({ p0: { pullRequests: { nodes: [pr(42)] } } });
  const shown = await glance(["ses_tree"]);
  assert.deepEqual(shown.ses_tree, {
    branch: "kuvo/timer", account: { name: "Anthropic" },
    pull: { number: 42, url: "https://github.com/kuvo-test/app/pull/42", state: "open", additions: 435, deletions: 4, checks: { passed: 12, failed: 0, pending: 2 } },
  });
});

test("checks as the card counts them: skipped and neutral passed, cancelled and timed out failed, so none waits for good", async () => {
  github({ p0: { pullRequests: { nodes: [pr(41, { runs: { SUCCESS: 10, SKIPPED: 2, NEUTRAL: 1, CANCELLED: 1, TIMED_OUT: 1, IN_PROGRESS: 1 }, statuses: { SUCCESS: 1, ERROR: 1, PENDING: 1 } })] } } });
  assert.deepEqual((await glance(["ses_tree"])).ses_tree.pull.checks, { passed: 14, failed: 3, pending: 2 });
  // A draft, merged and closed say so; one with no checks says none.
  github({ p0: { pullRequests: { nodes: [pr(41, { isDraft: true, runs: {} })] } } });
  clock += 61_000;
  const draft = (await glance(["ses_tree"])).ses_tree.pull;
  assert.equal(draft.state, "draft");
  assert.equal(draft.checks, undefined);
  github({ p0: { pullRequests: { nodes: [pr(41, { state: "MERGED" })] } } });
  // (Open with nothing under way: read again every few minutes, not each one.)
  clock += 61_000;
  assert.equal((await glance(["ses_tree"])).ses_tree.pull.state, "draft");
  clock += 5 * 60_000;
  assert.equal((await glance(["ses_tree"])).ses_tree.pull.state, "merged");
  // Merged: read again only every half hour.
  const read = queries().length;
  clock += 10 * 60_000;
  await glance(["ses_tree"]);
  assert.equal(queries().length, read);
});

test("a worktree's branch never shows a fork's pull request of the same name, or an earlier branch's", async () => {
  const made = fs.statSync(tree).birthtimeMs;
  const at = ms => new Date(ms).toISOString();
  github({ p0: { pullRequests: { nodes: [
    { ...pr(77), headRepositoryOwner: { login: "someone-else" }, createdAt: at(made + 3_600_000) },
    { ...pr(12, { state: "MERGED" }), headRepositoryOwner: { login: "kuvo-test" }, createdAt: at(made - 30 * 86_400_000) },
  ] } } });
  const shown = await glance(["ses_tree"]);
  assert.equal(shown.ses_tree.pull, undefined);
  assert.deepEqual([shown.ses_tree.additions, shown.ses_tree.deletions], [1, 0]);
  clock += 6 * 60_000;
  github({ p0: { pullRequests: { nodes: [{ ...pr(78), headRepositoryOwner: { login: "Kuvo-Test" }, createdAt: at(made + 60_000) }] } } });
  assert.equal((await glance(["ses_tree"])).ses_tree.pull.number, 78);
});

test("GitHub is read at most once a minute, in one query for every pull request asked for", async () => {
  await link.linkPull("ses_mine", "https://github.com/kuvo-test/app/pull/7");
  github({ p0: { pullRequest: pr(7, { branch: "fix" }) }, p1: { pullRequests: { nodes: [pr(42)] } } });
  const first = await glance(["ses_mine", "ses_tree"]);
  assert.equal(first.ses_mine.pull.number, 7);
  assert.equal(first.ses_tree.pull.number, 42);
  assert.equal(queries().length, 1, "one query for both");
  await glance(["ses_mine", "ses_tree"]);
  await glance(["ses_tree"]);
  assert.equal(queries().length, 1, "read within the minute: not again");
  clock += 61_000;
  github({ p0: { pullRequests: { nodes: [pr(42, { runs: { SUCCESS: 14 } })] } } });
  assert.deepEqual((await glance(["ses_tree"])).ses_tree.pull.checks, { passed: 14, failed: 0, pending: 0 });
  assert.equal(queries().length, 2);
  assert.doesNotMatch(queries()[1], /pullRequest\(number: 7\)/, "only what's asked for is read");
});

test("a session in the project's checkout shows the pull request it made, its head branch too, and never another's", async () => {
  await link.linkPull("ses_mine", "https://github.com/kuvo-test/app/pull/7");
  github({ p0: { pullRequest: pr(7, { branch: "fix-skip", runs: { SUCCESS: 13, FAILURE: 1 } }) } });
  const shown = await glance(["ses_mine", "ses_other"]);
  assert.equal(shown.ses_mine.branch, "fix-skip");
  assert.deepEqual(shown.ses_mine.pull.checks, { passed: 13, failed: 1, pending: 0 });
  assert.deepEqual(shown.ses_other, { account: { name: "OpenAI" } });
});

test("without gh, or signed out, a pull request a session made still shows its number, and GitHub isn't asked again for a while", async () => {
  await link.linkPull("ses_mine", "https://github.com/kuvo-test/app/pull/7");
  fs.writeFileSync(answer, "");
  assert.deepEqual((await glance(["ses_mine"])).ses_mine.pull, { number: 7, url: "https://github.com/kuvo-test/app/pull/7" });
  clock += 61_000;
  await glance(["ses_mine"]);
  assert.equal(queries().length, 1, "backed off");
  clock += 5 * 60_000;
  github({ p0: { pullRequest: pr(7) } });
  assert.equal((await glance(["ses_mine"])).ses_mine.pull.state, "open");
});

test("a session's own gh pr create, or its subagent's, links the pull request it printed to its conversation", async () => {
  const caught = link.pullCatcher(() => targets[0]);
  caught({ type: "session.tool.called", data: { sessionID: "ses_helper", id: "call_1", input: { command: "git push -u origin HEAD && gh pr create --fill" } } });
  caught({ type: "session.tool.success", data: { sessionID: "ses_helper", id: "call_1", content: [{ type: "text", text: "Fixes https://github.com/kuvo-test/app/pull/3\n\nhttps://github.com/kuvo-test/app/pull/9\n" }] } });
  // A command that only says it, and a pull request on a host its folder isn't on, aren't its own.
  caught({ type: "session.tool.called", data: { sessionID: "ses_other", id: "call_3", input: { command: "echo next: gh pr create" } } });
  caught({ type: "session.tool.success", data: { sessionID: "ses_other", id: "call_3", content: [{ type: "text", text: "https://github.com/kuvo-test/app/pull/5" }] } });
  caught({ type: "session.tool.called", data: { sessionID: "ses_tree", id: "call_4", input: { command: "gh pr create --fill" } } });
  caught({ type: "session.tool.success", data: { sessionID: "ses_tree", id: "call_4", content: [{ type: "text", text: "https://github.attacker.example/a/b/pull/1" }] } });
  // Another command's output naming a pull request isn't one it made.
  caught({ type: "session.tool.called", data: { sessionID: "ses_other", id: "call_2", input: { command: "gh pr view 9" } } });
  caught({ type: "session.tool.success", data: { sessionID: "ses_other", id: "call_2", content: [{ type: "text", text: "https://github.com/kuvo-test/app/pull/9" }] } });
  await linked("ses_mine");
  assert.deepEqual(Object.keys(link.readPullLinks()), ["ses_mine"]);
  assert.equal(link.readPullLinks().ses_mine.url, "https://github.com/kuvo-test/app/pull/9");
});

test("waiting on you: since its first ask came, its subagent's too, until it's answered", async () => {
  link.forgetAsksOn("engine");
  link.noteAskEvent({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_helper" } }, "engine", 5_000);
  link.noteAskEvent({ type: "form.created", data: { form: { id: "frm_1", sessionID: "ses_mine" } } }, "engine", 9_000);
  assert.equal((await glance(["ses_mine"])).ses_mine.asked, 5_000);
  link.noteAskEvent({ type: "permission.replied", data: { requestID: "per_1" } }, "engine");
  assert.equal((await glance(["ses_mine"])).ses_mine.asked, 9_000);
  // Its run ending lets what it asked go with it, and so does its deletion.
  link.noteAskEvent({ type: "session.execution.interrupted", data: { sessionID: "ses_mine" } }, "engine");
  assert.equal((await glance(["ses_mine"])).ses_mine.asked, undefined);
  link.noteAskEvent({ type: "permission.asked", data: { id: "per_3", sessionID: "ses_mine" } }, "engine", 6_000);
  link.noteAskEvent({ type: "session.deleted", data: { sessionID: "ses_mine" } }, "engine");
  assert.equal((await glance(["ses_mine"])).ses_mine.asked, undefined);
  // Its place heard again after it couldn't be (an engine restarts on another port): what was noted
  // of it goes, and the bridge's stays.
  link.noteAskEvent({ type: "permission.asked", data: { id: "per_2", sessionID: "ses_other" } }, "engine", 7_000);
  link.noteAskEvent({ type: "permission.asked", data: { id: "per_4", sessionID: "ses_tree" } }, "bridge", 8_000);
  link.forgetAsksOn("engine");
  const shown = await glance(["ses_other", "ses_tree"]);
  assert.equal(shown.ses_other.asked, undefined);
  assert.equal(shown.ses_tree.asked, 8_000);
});

test("followed: what it shows now, again only as it changes, and nothing more once it's let go", async () => {
  const handle = link.engineHandler(() => targets[0], { name: "box" }, () => { throw new Error("No bridge."); });
  const stop = new AbortController();
  const answer = handle({ method: "GET", path: "kuvo/sessions/glance/events?sessions=ses_mine", headers: {} }, {}, stop.signal);
  const next = async () => {
    const piece = (await answer.next()).value;
    return piece?.body ? JSON.parse(piece.body.toString()) : piece;
  };
  assert.equal((await next()).head.status, 200);
  assert.deepEqual(await next(), { sessions: { ses_mine: { account: { name: "Anthropic" } } } });
  // An ask comes: said at once, not a minute later.
  link.noteAskEvent({ type: "permission.asked", data: { id: "per_9", sessionID: "ses_mine" } }, "engine", 4_000);
  assert.deepEqual(await next(), { sessions: { ses_mine: { account: { name: "Anthropic" }, asked: 4_000 } } });
  stop.abort();
  assert.equal((await answer.next()).done, true);
});

test("an engine that isn't answering says nothing of its sessions, rather than say they're gone", async () => {
  await assert.rejects(link.glances(["ses_mine"], [{ port: 9, password: "p" }], undefined, now), error => error instanceof link.Unreached);
});

test("a session this box doesn't have is left out", async () => {
  assert.deepEqual(await glance(["ses_gone"]), {});
});
