// A machine's worktrees, kept by the machine itself and answered for with the Mac closed: one
// made for a session on a branch of its own, named after the session by the machine (Mac
// connected or not), listed with what to know before removing it, and removed (not while an
// agent works there). Real git; the engine is a stand-in that makes and removes worktrees with
// git, as it does.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atEnd, removeAtEnd } from "./at-end.js";
import { keepsIdle } from "./keeps-idle.js";

// A cap on a test that follows the engine and makes, saves and removes worktrees with real git: each
// git takes a second or more on a busy computer, so ten seconds failed under load; a hang still fails.
const SLOW_STEPS = 60_000;

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-worktrees-")));
process.env.KUVO_HOME = path.join(home, ".kuvo-code");
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const project = path.join(home, "shop");
const emptyRepo = path.join(home, "empty");
fs.mkdirSync(project, { recursive: true });
git(project, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(project, "README.md"), "# Shop\n");
git(project, "add", "-A");
git(project, "commit", "-q", "-m", "First");

// The engine: its project, worktrees made beside the project with git, and its sessions. Like
// the real one, it knows which folder a request is about only from its header: without it, it's
// about its own workspace, which isn't a repository.
const folderOf = request => decodeURIComponent(request.headers["x-opencode-directory"] ?? encodeURIComponent(path.join(home, "workspace")));
const sessions = [];
const active = new Set();
const told = [];
// The engine's events, followed as each box follows them; and someone waiting for the next session told.
const followers = [];
let onTold = () => {};
let onActive = () => {};
// Worktrees made so far, for each a folder of its own.
let made = 0;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      return followers.push(response);
    }
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    // Any folder in the repository (through a link too) is the project's.
    const real = (() => { try { return fs.realpathSync(folderOf(request)); } catch { return ""; } })();
    // (Another repository here, "empty", is a project of its own.)
    if (url.pathname === "/api/location") return send({ directory: folderOf(request), project: { id: real === project || real.startsWith(project + "/") ? "prj_shop" : real === emptyRepo ? "prj_empty" : "prj_workspace" } });
    const projectID = JSON.parse(body || "{}").projectID;
    if (url.pathname.startsWith("/api/worktree") && projectID !== "prj_shop" && projectID !== "prj_empty") return send({ message: "Not a git project" }, 400);
    if (url.pathname === "/api/worktree" && request.method === "POST") {
      const folder = path.join(home, "worktrees", `brave-otter-${++made}`);
      git(projectID === "prj_empty" ? emptyRepo : project, "worktree", "add", "--detach", folder);
      return send({ directory: folder });
    }
    if (url.pathname === "/api/worktree" && request.method === "DELETE") {
      const sent = JSON.parse(body);
      // As the real one refuses one whose folder is gone.
      if (!fs.existsSync(sent.directory)) return send({ name: "WorktreeError", data: { message: `Worktree directory unavailable: ${sent.directory}` } }, 400);
      try { git(projectID === "prj_empty" ? emptyRepo : project, "worktree", "remove", ...(sent.force ? ["--force"] : []), sent.directory); } catch { return send({ message: "git refused" }, 400); }
      return send({});
    }
    if (url.pathname === "/api/session") {
      // A page at a time, the newest first, as the real one answers.
      const newest = [...sessions].reverse();
      const limit = Number(url.searchParams.get("limit")) || newest.length;
      const start = Number(url.searchParams.get("cursor") ?? 0);
      return send({ data: newest.slice(start, start + limit), cursor: { next: start + limit < newest.length ? String(start + limit) : null } });
    }
    if (request.method === "PUT" && url.pathname.includes("/instructions/entries/")) {
      told.push({ url: url.pathname, value: JSON.parse(body).value });
      onTold();
      return send({});
    }
    if (url.pathname.startsWith("/api/session/") && url.pathname !== "/api/session/active") return send({ data: sessions.find(each => each.id === decodeURIComponent(url.pathname.split("/").pop())) ?? null });
    if (url.pathname === "/api/session/active") {
      onActive();
      return send({ data: Object.fromEntries([...active].map(id => [id, {}])) });
    }
    send({}, 404);
  });
});
keepsIdle(engine);
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
const atEngine = { port: engine.address().port, password: "pw" };
removeAtEnd(home);
atEnd(() => {
  engine.closeAllConnections();
  engine.close();
});
const ask = (method, route, body) => link.answerWorktrees(method, route, body, atEngine, undefined);

test("made for a session on a branch of its own, named after it, listed with what to know, and removed as Settings removes it", async () => {
  const made = await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" });
  assert.equal(made.status, 200);
  const { root, branch, base, folder } = made.value;
  assert.equal(base, "main");
  assert.equal(branch, `kuvo/${path.basename(root)}`);
  assert.equal(folder, root);
  assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), branch);
  sessions.push({ id: "ses_tree", title: "Fix the total", location: { directory: root } });
  await link.nameWorktreeBranch(atEngine, "ses_tree");
  assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), "kuvo/fix-the-total");

  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "a");
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  const [entry] = (await ask("GET", "kuvo/worktrees")).value.worktrees;
  assert.equal(entry.path, root);
  assert.equal(entry.folder, root);
  assert.equal(entry.project, project);
  assert.equal(entry.branch, "kuvo/fix-the-total");
  assert.equal(entry.sessions, 1);
  assert.equal(entry.working, false);
  assert.equal(entry.uncommitted, true);
  assert.equal(entry.ahead, 1);
  assert.ok(entry.size > 0);
  // What it keeps, as a Mac reads it as it connects.
  assert.deepEqual((await ask("GET", "kuvo/worktrees?records=1")).value.worktrees, [{ project, root, folder: root, branch: "kuvo/fix-the-total", base: "main", made: branch, prefix: "kuvo/" }]);

  // Not while its agent works; with changes not committed only when they're to go.
  active.add("ses_tree");
  const busy = await ask("POST", "kuvo/worktrees/remove", { path: root });
  assert.equal(busy.status, 409);
  assert.match(busy.value.message, /still working/);
  active.delete("ses_tree");
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: root, discard: false })).status, 409);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: root })).status, 200);
  assert.equal(fs.existsSync(root), false);
  assert.notEqual(git(project, "branch", "--list", "kuvo/fix-the-total"), "", "not merged: its branch stays");
  assert.deepEqual((await ask("GET", "kuvo/worktrees")).value.worktrees, []);
  // A conversation that ran in it is still named after its project (a notice's subtitle).
  assert.equal(link.projectNameOf(root), path.basename(project));
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: root })).status, 404);
  // Recorded again by a Mac that still had it: it's gone, so it stays gone.
  assert.equal((await ask("POST", "kuvo/worktrees/record", { project, root, branch: "kuvo/fix-the-total" })).status, 404);
  assert.deepEqual((await ask("GET", "kuvo/worktrees?records=1")).value.worktrees, []);
});

test("not removed while a coding agent works there, nor while who works there can't be told", async () => {
  // The coding agents' bridge: its own sessions, as the engine lists them.
  const bridgeSessions = [];
  const bridgeActive = new Set();
  const bridge = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const send = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/api/session") return send({ data: bridgeSessions });
    if (url.pathname === "/api/session/active") return send({ data: Object.fromEntries([...bridgeActive].map(id => [id, { type: "busy" }])) });
    response.writeHead(404);
    response.end();
  });
  keepsIdle(bridge);
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const atBridge = { port: bridge.address().port, password: "pw" };
  try {
    const made = (await ask("POST", "kuvo/worktrees", { project })).value;
    bridgeSessions.push({ id: "ses_claude", title: "Fix the cart", location: { directory: made.folder } });
    bridgeActive.add("ses_claude");
    const busy = await link.answerWorktrees("POST", "kuvo/worktrees/remove", { path: made.root }, atEngine, undefined, atBridge);
    assert.equal(busy.status, 409);
    assert.match(busy.value.message, /still working/);
    const [listed] = (await link.answerWorktrees("GET", "kuvo/worktrees", null, atEngine, undefined, atBridge)).value.worktrees.filter(each => each.path === made.root);
    assert.equal(listed.sessions, 1);
    assert.equal(listed.working, true);
    // Taken back as made for nothing: not while a Claude Code session has it.
    bridgeActive.delete("ses_claude");
    assert.equal((await link.answerWorktrees("POST", "kuvo/worktrees/remove", { path: made.root, forget: true }, atEngine, undefined, atBridge)).status, 409);

    // The bridge stopped answering: nobody can say who's there, so the worktree and its branch stay.
    bridge.closeAllConnections();
    await new Promise(resolve => bridge.close(resolve));
    const unknown = await link.answerWorktrees("POST", "kuvo/worktrees/remove", { path: made.root, forget: true }, atEngine, undefined, atBridge);
    assert.equal(unknown.status, 503);
    assert.match(unknown.value.message, /couldn.t be told/);
    assert.ok(fs.existsSync(made.root));
    assert.notEqual(git(project, "branch", "--list", made.branch), "");

    // No engine running: it says so, and that the worktree stays.
    const down = await link.answerWorktrees("POST", "kuvo/worktrees/remove", { path: made.root }, undefined, undefined, atBridge);
    assert.equal(down.status, 503);
    assert.match(down.value.message, /engine isn.t running, so the worktree of .+ stays/);
    assert.ok(fs.existsSync(made.root));

    assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
  } finally {
    if (bridge.listening) { bridge.closeAllConnections(); bridge.close(); }
  }
});

test("one whose folder was deleted by hand can still be removed", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project })).value;
  fs.rmSync(made.root, { recursive: true, force: true });
  const removed = await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true });
  assert.equal(removed.status, 200, removed.value.message);
  assert.equal(link.readWorktrees().some(each => each.root === made.root), false);
  assert.equal(git(project, "worktree", "list").includes(made.root), false, "git forgot it too");
  assert.equal(git(project, "branch", "--list", made.branch), "", "made for nothing: its branch went");
});

test("commits on no branch in a worktree are kept on a branch of their own when it's removed", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  // The agent stopped mid-rebase, say: a commit on no branch.
  git(made.root, "switch", "-q", "--detach");
  fs.writeFileSync(path.join(made.root, "lost.txt"), "work\n");
  git(made.root, "add", "-A");
  git(made.root, "commit", "-q", "-m", "Work on no branch");
  const work = git(made.root, "rev-parse", "HEAD");
  const removed = await ask("POST", "kuvo/worktrees/remove", { path: made.root });
  assert.equal(removed.status, 200, removed.value.message);
  assert.equal(fs.existsSync(made.root), false);
  const keeping = git(project, "for-each-ref", "--contains", work, "--format=%(refname:short)", "refs/heads");
  assert.equal(keeping, `${made.branch}-kept`);
  git(project, "branch", "-D", keeping);
});

test("a repository with no commit yet gets an empty first one, and its worktree at once; what's staged stays staged", async () => {
  fs.mkdirSync(emptyRepo);
  git(emptyRepo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(emptyRepo, "notes.txt"), "draft\n");
  git(emptyRepo, "add", "notes.txt");
  const made = await ask("POST", "kuvo/worktrees", { project: emptyRepo, branchPrefix: "kuvo/" });
  assert.equal(made.status, 200, JSON.stringify(made.value));
  assert.equal(made.value.base, "main");
  assert.equal(git(emptyRepo, "log", "--format=%s"), "Initial commit");
  assert.equal(git(emptyRepo, "ls-tree", "-r", "--name-only", "HEAD"), "", "the first commit is empty");
  assert.equal(git(emptyRepo, "status", "--porcelain"), "A  notes.txt", "what you'd staged is still staged, not committed for you");
  assert.equal(git(made.value.root, "symbolic-ref", "--short", "HEAD"), made.value.branch);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.value.root })).status, 200);
});

test("a branch begun with nothing on it, in a repository with history, is left for you to begin", async () => {
  const site = path.join(home, "site");
  fs.mkdirSync(site);
  git(site, "init", "-q", "-b", "main");
  git(site, "commit", "-q", "--allow-empty", "-m", "first");
  git(site, "checkout", "-q", "--orphan", "pages");
  const refused = await ask("POST", "kuvo/worktrees", { project: site });
  assert.equal(refused.status, 409);
  assert.match(refused.value.message, /first commit/);
  assert.equal(git(site, "for-each-ref", "--format=%(refname)"), "refs/heads/main", "nothing committed on pages for you");
});

test("a branch prefix git can't use there is named", async () => {
  git(project, "branch", "taken");
  const refused = await ask("POST", "kuvo/worktrees", { project, branchPrefix: "taken/" });
  assert.equal(refused.status, 502);
  assert.match(refused.value.message, /“taken\/”.*Settings › Git/);
  git(project, "branch", "-D", "taken");
  assert.equal(git(project, "worktree", "list").split("\n").length, 1 + link.readWorktrees().filter(each => each.project === project && fs.existsSync(each.root)).length, "the worktree it made for it went");
});

test("a session a phone makes in a worktree it asked for is told it works there", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project })).value;
  sessions.push({ id: "ses_phone", location: { directory: made.folder } });
  told.length = 0;
  await link.tellWorktree(atEngine, "ses_phone");
  assert.deepEqual(told.map(each => each.url), ["/api/experimental/session/ses_phone/instructions/entries/kuvo.worktree"]);
  assert.match(told[0].value, new RegExp(`on the branch ${made.branch}, .* checkout at ${project} `));
  // One elsewhere: nothing.
  sessions.push({ id: "ses_plain", location: { directory: project } });
  await link.tellWorktree(atEngine, "ses_plain");
  assert.equal(told.length, 1);
  // Taken back as one made for nothing (`forget`): not while a session has it.
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 409);
  sessions.splice(sessions.findIndex(each => each.id === "ses_phone"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("a worktree asked for by any client starts its branch as Settings › Git says on that computer, as git takes it", async () => {
  const settings = path.join(process.env.KUVO_HOME, "box", "opencode.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ branch_prefix: " -ada:/ " }));
  try {
    const made = (await ask("POST", "kuvo/worktrees", { project })).value;
    assert.match(made.branch, /^ada\/brave-otter-\d+$/);
    assert.equal(made.prefix, "ada/");
    assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
  } finally {
    fs.rmSync(settings);
  }
});

test("the machine names a branch after its session's title, once, and only one it made", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "me/" })).value;
  sessions.push({ id: "ses_named", title: "Giriş düzeltmesi", location: { directory: made.folder } });
  await link.nameWorktreeBranch(atEngine, "ses_named");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "me/giris-duzeltmesi");
  sessions.at(-1).title = "Something else";
  await link.nameWorktreeBranch(atEngine, "ses_named");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "me/giris-duzeltmesi", "named once");
  assert.equal(link.branchSlug("Trim note titles"), "trim-note-titles");
  sessions.splice(sessions.findIndex(each => each.id === "ses_named"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("every session working in a worktree is told its branch's new name, not only the one whose title named it", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_first", location: { directory: made.folder } }, { id: "ses_second", title: "Speed up search", location: { directory: made.folder } });
  told.length = 0;
  await link.nameWorktreeBranch(atEngine, "ses_second");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "kuvo/speed-up-search");
  for (const id of ["ses_first", "ses_second"]) {
    const last = told.filter(each => each.url.includes(`/${id}/`)).at(-1);
    assert.match(last?.value ?? "", /on the branch kuvo\/speed-up-search,/, id);
  }
  sessions.splice(sessions.findIndex(each => each.id === "ses_first"), 2);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("a Claude Code session's title names the branch, and an engine session in the same worktree is told the new name too", async () => {
  // The coding agents' bridge, where the title was given: its session, told as the engine's are.
  const bridgeSessions = [];
  const bridgeTold = [];
  const bridge = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      const send = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (url.pathname === "/api/session") return send({ data: bridgeSessions });
      if (url.pathname === "/api/session/active") return send({ data: {} });
      if (request.method === "PUT") return bridgeTold.push(url.pathname) && send({});
      if (url.pathname.startsWith("/api/session/")) return send({ data: bridgeSessions.find(each => each.id === decodeURIComponent(url.pathname.split("/").pop())) ?? null });
      response.writeHead(404);
      response.end();
    });
  });
  keepsIdle(bridge);
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  // The box's engine, as its record says.
  const engineFile = path.join(process.env.KUVO_HOME, "run", "engine.json");
  fs.mkdirSync(path.dirname(engineFile), { recursive: true });
  fs.writeFileSync(engineFile, JSON.stringify(atEngine));
  try {
    const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
    sessions.push({ id: "ses_opencode", location: { directory: made.folder } });
    bridgeSessions.push({ id: "ses_claude_titled", title: "Speed up images", location: { directory: made.folder } });
    told.length = 0;
    await link.nameWorktreeBranch({ port: bridge.address().port, password: "pw" }, "ses_claude_titled");
    assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "kuvo/speed-up-images");
    assert.deepEqual(bridgeTold, ["/api/experimental/session/ses_claude_titled/instructions/entries/kuvo.worktree"]);
    assert.match(told.find(each => each.url.includes("/ses_opencode/"))?.value ?? "", /on the branch kuvo\/speed-up-images,/);
    sessions.splice(sessions.findIndex(each => each.id === "ses_opencode"), 1);
    assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
  } finally {
    fs.rmSync(engineFile, { force: true });
    bridge.closeAllConnections();
    bridge.close();
  }
});

test("a subagent's title, working in a session's worktree, doesn't name its branch", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_helper", parentID: "ses_lead", title: "Explore the codebase", location: { directory: made.folder } });
  await link.nameWorktreeBranch(atEngine, "ses_helper");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), made.branch);
  sessions.splice(sessions.findIndex(each => each.id === "ses_helper"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("a project in a folder of its repository, reached through a link: its session runs in that folder of the worktree", async () => {
  fs.mkdirSync(path.join(project, "web"));
  fs.writeFileSync(path.join(project, "web", "index.html"), "<p>Shop</p>\n");
  git(project, "add", "-A");
  git(project, "commit", "-q", "-m", "Web");
  const linked = path.join(home, "linked");
  fs.symlinkSync(project, linked);
  const made = (await ask("POST", "kuvo/worktrees", { project: path.join(linked, "web") })).value;
  assert.equal(made.folder, path.join(made.root, "web"));
  assert.ok(fs.existsSync(path.join(made.folder, "index.html")));
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("one a Mac made before the machine kept them is kept from then on; a folder that isn't a repository is turned away", async () => {
  const old = path.join(home, "worktrees", "old");
  git(project, "worktree", "add", "-q", "-b", "kuvo/old", old);
  const given = { project, root: old, folder: path.join(old, "web"), branch: "kuvo/old", base: "main" };
  assert.equal((await ask("POST", "kuvo/worktrees/record", given)).status, 200);
  assert.deepEqual(link.readWorktrees(), [given]);
  const plain = path.join(home, "plain");
  fs.mkdirSync(plain);
  assert.equal((await ask("POST", "kuvo/worktrees", { project: plain })).status, 409);
  assert.equal((await ask("POST", "kuvo/worktrees", { project: "relative/path" })).status, 400);
});

test("a Mac reading the machine's worktrees as their session gets its title finds the branch named, once, by the machine", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_titled", title: "Speed up checkout", location: { directory: made.folder } });
  const toldBefore = told.length;
  // The Mac's read comes before the machine heard of the title: named as it's read.
  const [record] = (await ask("GET", "kuvo/worktrees?records=1")).value.worktrees.filter(each => each.root === made.root);
  assert.equal(record.branch, "kuvo/speed-up-checkout");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "kuvo/speed-up-checkout");
  // The title's event, handled after: named already, so nothing more.
  await link.nameWorktreeBranch(atEngine, "ses_titled");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "kuvo/speed-up-checkout", "never kuvo/speed-up-checkout-2");
  assert.equal(git(project, "branch", "--list", "kuvo/speed-up-checkout-2"), "");
  assert.deepEqual(told.slice(toldBefore).map(each => each.url), ["/api/experimental/session/ses_titled/instructions/entries/kuvo.worktree"], "its session told the new name once");
  // No one else names it: the rename a Mac on 0.8.0-beta.1 still asks for through `box route` is
  // turned away (it reads the machine's records again then), and the name stays.
  const handle = link.engineHandler(() => atEngine, {}, () => null);
  let refused = 0;
  for await (const part of handle({ method: "POST", path: "kuvo/worktrees/rename", headers: {}, body: Buffer.from(JSON.stringify({ path: made.root, from: "kuvo/speed-up-checkout", branch: "kuvo/other" })) }, {}, undefined)) refused ||= part.head?.status ?? 0;
  assert.ok(refused >= 400, `answered ${refused}`);
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "kuvo/speed-up-checkout");
  sessions.splice(sessions.findIndex(each => each.id === "ses_titled"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("a session started in a worktree with its title given (by an agent, a bot) names its branch as the box hears of it, Mac closed, and is told that name", { timeout: SLOW_STEPS }, async t => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  told.length = 0;
  const heard = new Promise(resolve => { onTold = resolve; });
  const caughtUp = new Promise(resolve => { onActive = resolve; });
  const stop = new AbortController();
  // (Stopped should the test end first, as on the old code.)
  t.signal.addEventListener("abort", () => stop.abort());
  link.watchEvents(() => atEngine, () => true, stop.signal, () => {}, { notices: false });
  try {
    // Following the engine, it has looked for sessions titled meanwhile: none yet.
    await caughtUp;
    onActive = () => {};
    sessions.push({ id: "ses_given", title: "Fix the cart total", location: { directory: made.folder } });
    // The engine says it's made, with its title; it never says it's renamed.
    followers.at(-1).write(`data: ${JSON.stringify({ type: "session.created", data: { sessionID: "ses_given" } })}\n\n`);
    await heard;
  } finally {
    stop.abort();
    onTold = () => {};
  }
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "kuvo/fix-the-cart-total");
  assert.match(told[0].value, /on the branch kuvo\/fix-the-cart-total,/, "told the name it works on");
  sessions.splice(sessions.findIndex(each => each.id === "ses_given"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("a session titled while the box wasn't listening (it was restarting) has its branch named once the box follows its engine again", { timeout: SLOW_STEPS }, async t => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_missed", title: "Tidy the footer", location: { directory: made.folder } });
  told.length = 0;
  const heard = new Promise(resolve => { onTold = resolve; });
  const stop = new AbortController();
  // (Stopped should the test end first: on the old code it's never named.)
  t.signal.addEventListener("abort", () => stop.abort());
  link.watchEvents(() => atEngine, () => true, stop.signal, () => {}, { notices: false });
  try {
    await heard;
  } finally {
    stop.abort();
    onTold = () => {};
  }
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "kuvo/tidy-the-footer");
  assert.match(told[0].value, /on the branch kuvo\/tidy-the-footer,/);
  sessions.splice(sessions.findIndex(each => each.id === "ses_missed"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("a branch is named after its session's title, in any language, and gets a number when the name is taken", async () => {
  for (const [title, slug] of [
    ["Trim note titles", "trim-note-titles"],
    ["Giriş düzeltmesi", "giris-duzeltmesi"],
    ["Café: crème brûlée!", "cafe-creme-brulee"],
    ["Исправить вход", "ispravit-vhod"],
    ["Йога", "joga"],
    ["Διόρθωση σύνδεσης", "diorthose-syndeses"],
    ["修复登录", ""],
    ["Fix #42 — login (again)", "fix-42-login-again"],
    ["A very long title that keeps going well past the limit of forty", "a-very-long-title-that-keeps-going-well"],
  ]) assert.equal(link.branchSlug(title), slug, title);

  git(project, "branch", "kuvo/fix-the-cart");
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_cart", title: "Fix the cart", location: { directory: made.folder } });
  await link.nameWorktreeBranch(atEngine, "ses_cart");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "kuvo/fix-the-cart-2");
  sessions.splice(sessions.findIndex(each => each.id === "ses_cart"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
  git(project, "branch", "-D", "kuvo/fix-the-cart");
});

test("a branch already pushed keeps its name: its pull request would lose track of it", async () => {
  const remote = path.join(home, "remote.git");
  git(home, "init", "-q", "--bare", remote);
  git(project, "remote", "add", "origin", remote);
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  git(made.root, "push", "-q", "-u", "origin", made.branch);
  sessions.push({ id: "ses_pushed", title: "Fix login", location: { directory: made.folder } });
  await link.nameWorktreeBranch(atEngine, "ses_pushed");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), made.branch);
  sessions.splice(sessions.findIndex(each => each.id === "ses_pushed"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
  // Pushed without tracking it (`git push origin HEAD`, as agents do): pushed all the same.
  const plain = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  git(plain.root, "push", "-q", "origin", "HEAD");
  sessions.push({ id: "ses_pushed_plain", title: "Fix signup", location: { directory: plain.folder } });
  await link.nameWorktreeBranch(atEngine, "ses_pushed_plain");
  assert.equal(git(plain.root, "symbolic-ref", "--short", "HEAD"), plain.branch);
  sessions.splice(sessions.findIndex(each => each.id === "ses_pushed_plain"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: plain.root, forget: true })).status, 200);
  // A name a remote has already (an old pull request's branch, deleted here): taken with a number.
  git(project, "update-ref", "refs/remotes/origin/kuvo/fix-checkout", "HEAD");
  const again = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_again", title: "Fix checkout", location: { directory: again.folder } });
  await link.nameWorktreeBranch(atEngine, "ses_again");
  assert.equal(git(again.root, "symbolic-ref", "--short", "HEAD"), "kuvo/fix-checkout-2");
  sessions.splice(sessions.findIndex(each => each.id === "ses_again"), 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: again.root, forget: true })).status, 200);
  git(project, "remote", "remove", "origin");
});

test("its records followed: a line now, and another when one is made or removed", async () => {
  const handle = link.engineHandler(() => atEngine, { name: "box" }, () => null);
  const abort = new AbortController();
  const lines = [];
  let made;
  for await (const part of handle({ method: "GET", path: "kuvo/worktrees/events", headers: {}, body: Buffer.alloc(0) }, {}, abort.signal)) {
    if (part.head) assert.equal(part.head.headers["content-type"], "application/x-ndjson");
    if (!part.body) continue;
    lines.push(JSON.parse(part.body.toString()));
    if (lines.length === 1) made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
    if (lines.length === 2) {
      assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
    }
    if (lines.length === 3) abort.abort();
  }
  // (Others' from the tests before stay as they were.)
  assert.deepEqual(lines.map(line => line.worktrees.some(tree => tree.root === made.root)), [false, true, false]);
});

test("one a phone asks for starts with the prefix a Mac last gave, and a Mac's old record doesn't undo how the box keeps one", async () => {
  const mine = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "sa/" })).value;
  const phones = (await ask("POST", "kuvo/worktrees", { project })).value;
  assert.ok(phones.branch.startsWith("sa/"), phones.branch);
  // A Mac handing over what it kept of one the box has: the box's stays, still to be named.
  assert.equal((await ask("POST", "kuvo/worktrees/record", { project, root: phones.root, folder: phones.folder, branch: phones.branch })).status, 200);
  const kept = link.readWorktrees().find(each => each.root === phones.root);
  assert.equal(kept.made, phones.branch);
  for (const made of [mine, phones]) assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
  await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" }).then(made => ask("POST", "kuvo/worktrees/remove", { path: made.value.root, forget: true }));
});

test("one made and removed at once: a follower is told of both, in order", { timeout: SLOW_STEPS }, async () => {
  const handle = link.engineHandler(() => atEngine, { name: "box" }, () => null);
  const abort = new AbortController();
  const seen = [];
  let made;
  for await (const part of handle({ method: "GET", path: "kuvo/worktrees/events", headers: {}, body: Buffer.alloc(0) }, {}, abort.signal)) {
    if (!part.body) continue;
    seen.push(JSON.parse(part.body.toString()).worktrees.some(tree => tree.root === made?.root));
    if (seen.length === 1) {
      made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
      assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
    }
    if (seen.length === 3) abort.abort();
  }
  assert.deepEqual(seen, [false, true, false]);
});

// A worktree goes with its last session (PROTOCOL.md, "Worktrees"), whoever archived or deleted it.
const tidy = () => link.tidyWorktrees(undefined, atEngine, null);
const records = async () => (await ask("GET", "kuvo/worktrees?records=1")).value;
const statusIn = folder => git(folder, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).sort();
const without = id => sessions.splice(sessions.findIndex(each => each.id === id), 1);

test("archiving a worktree's last session removes it, keeping what wasn't committed, and Restore Worktree brings it all back as it was", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  const session = { id: "ses_archived", title: "Tidy the cart", location: { directory: made.folder } };
  sessions.push(session);
  fs.writeFileSync(path.join(made.root, "cart.js"), "total()\n");
  git(made.root, "add", "-A");
  git(made.root, "commit", "-q", "-m", "cart");
  // Not committed: a change, a staged new file, an untracked one; and one git ignores.
  fs.writeFileSync(path.join(made.root, "README.md"), "# Shop, tidied\n");
  fs.writeFileSync(path.join(made.root, "staged.txt"), "staged\n");
  git(made.root, "add", "staged.txt");
  fs.mkdirSync(path.join(made.root, "notes"));
  fs.writeFileSync(path.join(made.root, "notes", "todo.txt"), "todo\n");
  fs.writeFileSync(path.join(made.root, ".gitignore"), "build/\n");
  fs.mkdirSync(path.join(made.root, "build"));
  fs.writeFileSync(path.join(made.root, "build", "out.js"), "built\n");
  const before = statusIn(made.root);

  // Open, it stays.
  await tidy();
  assert.ok(fs.existsSync(made.root));
  session.metadata = { "kuvo.archived": true };
  await tidy();
  assert.equal(fs.existsSync(made.root), false, "gone with its last session");
  const { worktrees, restorable } = await records();
  assert.equal(worktrees.some(each => each.root === made.root), false);
  assert.deepEqual(restorable.find(each => each.root === made.root), { project, root: made.root, folder: made.folder, branch: made.branch, base: "main", restorable: true, saved: true, ahead: 1 });
  assert.notEqual(git(project, "branch", "--list", made.branch), "", "not merged: its branch stays");

  told.length = 0;
  const restored = await ask("POST", "kuvo/worktrees/restore", { folder: made.folder });
  assert.equal(restored.status, 200, restored.value.message);
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), made.branch);
  assert.equal(git(made.root, "log", "-1", "--format=%s"), "cart", "its commits as they were, and nothing committed for it");
  assert.equal(fs.readFileSync(path.join(made.root, "README.md"), "utf8"), "# Shop, tidied\n");
  // Back not committed, untracked files untracked; what git ignores wasn't kept.
  assert.deepEqual(statusIn(made.root), before.map(line => line.replace(/^A /, "??")).sort());
  assert.equal(fs.existsSync(path.join(made.root, "build")), false);
  assert.equal(git(project, "for-each-ref", "refs/kuvo/worktrees"), "", "what was kept for it goes once it's back");
  const now = await records();
  assert.equal(now.restorable.some(each => each.root === made.root), false);
  assert.ok(told.some(each => each.url.includes("ses_archived")), "its session told where it works again");
  // Its session still archived, the next sweep leaves it: it waits for the session to be open.
  await tidy();
  assert.ok(fs.existsSync(made.root), "not removed again straight away");
  delete session.metadata;
  await tidy();
  assert.equal((await records()).worktrees.find(each => each.root === made.root)?.used, true);
  session.metadata = { "kuvo.archived": true };
  await tidy();
  assert.equal(fs.existsSync(made.root), false, "archived again, it goes again");
  assert.equal((await ask("POST", "kuvo/worktrees/restore", { folder: made.folder })).status, 200);

  without("ses_archived");
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root })).status, 200);
  await tidy();
});

test("deleting a worktree's last session removes it with what wasn't committed, and nothing is kept for it", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_deleted", title: "Try a thing", location: { directory: made.folder } });
  fs.writeFileSync(path.join(made.root, "thing.txt"), "thing\n");
  await tidy();
  without("ses_deleted");
  await tidy();
  assert.equal(fs.existsSync(made.root), false);
  assert.equal((await records()).restorable.some(each => each.root === made.root), false, "no session left to bring it back");
  assert.equal(git(project, "for-each-ref", "refs/kuvo/worktrees"), "");
  assert.equal(git(project, "branch", "--list", made.branch), "", "merged (nothing on it): its branch went");
});

test("a worktree stays while another session in it is open, while an agent works there, and before any session has run in it", async () => {
  const fresh = (await ask("POST", "kuvo/worktrees", { project })).value;
  const shared = (await ask("POST", "kuvo/worktrees", { project })).value;
  const first = { id: "ses_first", title: "First", location: { directory: shared.folder } };
  const second = { id: "ses_second", title: "Second", location: { directory: shared.folder } };
  sessions.push(first, second);
  await tidy();
  assert.ok(fs.existsSync(fresh.root), "made for a session that's starting: not one a session left");

  first.metadata = { "kuvo.archived": true };
  await tidy();
  assert.ok(fs.existsSync(shared.root), "its other session is open");
  second.metadata = { "kuvo.archived": true };
  active.add("ses_second");
  await tidy();
  assert.ok(fs.existsSync(shared.root), "an agent still works there");
  active.delete("ses_second");
  await tidy();
  assert.equal(fs.existsSync(shared.root), false);

  // Its sessions deleted later: it can't come back, and what was kept for it goes.
  without("ses_first");
  without("ses_second");
  await tidy();
  assert.equal((await records()).restorable.some(each => each.root === shared.root), false);
  assert.equal((await ask("POST", "kuvo/worktrees/restore", { folder: shared.folder })).status, 404);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: fresh.root, forget: true })).status, 200);
});

test("one removed in Settings comes back on its branch while its session is here, and can't once its work is gone", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_settings", title: "Settings", location: { directory: made.folder } });
  fs.writeFileSync(path.join(made.root, "kept.txt"), "kept\n");
  git(made.root, "add", "-A");
  git(made.root, "commit", "-q", "-m", "kept");
  fs.writeFileSync(path.join(made.root, "thrown.txt"), "thrown\n");
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root })).status, 200);
  assert.deepEqual((await records()).restorable.find(each => each.root === made.root), { project, root: made.root, folder: made.folder, branch: made.branch, base: "main", restorable: true, saved: false, ahead: 1 });
  assert.equal((await ask("POST", "kuvo/worktrees/restore", { folder: made.folder })).status, 200);
  assert.ok(fs.existsSync(path.join(made.root, "kept.txt")));
  assert.equal(fs.existsSync(path.join(made.root, "thrown.txt")), false, "thrown away, as Remove said");

  // Restored by git, not the engine, it can still be removed.
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root })).status, 200, "removed again");
  assert.equal(git(project, "worktree", "list").includes(made.root), false);
  git(project, "branch", "-D", made.branch);
  // Its commits gone from git too (it cleaned them up): nothing to make it again from.
  git(project, "reflog", "expire", "--expire=now", "--all");
  git(project, "gc", "-q", "--prune=now");
  assert.equal((await records()).restorable.find(each => each.root === made.root)?.restorable, false);
  const refused = await ask("POST", "kuvo/worktrees/restore", { folder: made.folder });
  assert.equal(refused.status, 409);
  assert.match(refused.value.message, /is gone/);
  without("ses_settings");
  await tidy();
});

test("a session archived from anywhere, Mac closed: the box hears it and its worktree goes, and a follower is told", { timeout: SLOW_STEPS }, async t => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  const session = { id: "ses_heard", title: "Heard", location: { directory: made.folder } };
  sessions.push(session);
  await tidy();
  // As this box finds its engine.
  const engineFile = path.join(process.env.KUVO_HOME, "run", "engine.json");
  fs.mkdirSync(path.dirname(engineFile), { recursive: true });
  fs.writeFileSync(engineFile, JSON.stringify(atEngine));
  const stop = new AbortController();
  t.signal.addEventListener("abort", () => stop.abort());
  const handle = link.engineHandler(() => atEngine, { name: "box" }, () => null);
  const caughtUp = new Promise(resolve => { onActive = resolve; });
  link.watchEvents(() => atEngine, () => true, stop.signal, () => {}, { notices: false });
  try {
    await caughtUp;
    onActive = () => {};
    for await (const part of handle({ method: "GET", path: "kuvo/worktrees/events", headers: {}, body: Buffer.alloc(0) }, {}, stop.signal)) {
      if (!part.body) continue;
      const line = JSON.parse(part.body.toString());
      if (line.restorable.some(each => each.root === made.root)) {
        assert.equal(line.worktrees.some(each => each.root === made.root), false);
        break;
      }
      if (session.metadata) continue;
      session.metadata = { "kuvo.archived": true };
      followers.at(-1).write(`data: ${JSON.stringify({ type: "session.metadata.updated", data: { sessionID: "ses_heard", metadata: session.metadata } })}\n\n`);
    }
  } finally {
    stop.abort();
    fs.rmSync(engineFile, { force: true });
  }
  assert.equal(fs.existsSync(made.root), false);
  without("ses_heard");
  await tidy();
});

test("a session further back than the newest page still keeps its worktree, and what was saved for an archived one", async () => {
  const open = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  const archived = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  sessions.push({ id: "ses_old_open", title: "Old, open", location: { directory: open.folder } });
  const old = { id: "ses_old_archived", title: "Old, archived", location: { directory: archived.folder } };
  sessions.push(old);
  fs.writeFileSync(path.join(open.root, "work.txt"), "not committed\n");
  fs.writeFileSync(path.join(archived.root, "work.txt"), "not committed\n");
  await tidy();
  old.metadata = { "kuvo.archived": true };
  await tidy();
  assert.equal(fs.existsSync(archived.root), false);
  // A busy box: bots and wake-ups make hundreds of newer sessions.
  const newer = Array.from({ length: 450 }, (_, index) => ({ id: `ses_newer_${index}`, title: "Newer", location: { directory: project } }));
  sessions.push(...newer);
  try {
    await tidy();
    assert.ok(fs.existsSync(path.join(open.root, "work.txt")), "its open session is still here: nothing of it goes");
    assert.equal((await records()).restorable.find(each => each.root === archived.root)?.saved, true, "what was saved for it stays");
    assert.notEqual(git(project, "for-each-ref", "refs/kuvo/worktrees"), "");
  } finally {
    sessions.splice(sessions.length - newer.length, newer.length);
  }
  without("ses_old_open");
  without("ses_old_archived");
  await tidy();
  assert.equal(git(project, "for-each-ref", "refs/kuvo/worktrees"), "");
});

test("while the coding agents' bridge is down, no worktree goes: its sessions can't be counted", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  const session = { id: "ses_bridge_down", title: "Engine side", location: { directory: made.folder } };
  sessions.push(session);
  await tidy();
  session.metadata = { "kuvo.archived": true };
  // Its record still there, its process gone (restarting for an update, say).
  const bridgeFile = path.join(process.env.KUVO_HOME, "run", "bridge.json");
  fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });
  fs.writeFileSync(bridgeFile, JSON.stringify({ port: 1, password: "x", pid: 999_999 }));
  try {
    await link.tidyWorktrees(undefined, atEngine);
    assert.ok(fs.existsSync(made.root), "a Claude Code session may still be working there");
  } finally {
    fs.rmSync(bridgeFile, { force: true });
  }
  await link.tidyWorktrees(undefined, atEngine);
  assert.equal(fs.existsSync(made.root), false, "no bridge at all: the engine's sessions are all there is");
  without("ses_bridge_down");
  await tidy();
});

test("one whose branch was merged and deleted comes back at the commit it was at", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
  const session = { id: "ses_merged", title: "Merged", location: { directory: made.folder } };
  sessions.push(session);
  fs.writeFileSync(path.join(made.root, "merged.txt"), "merged\n");
  git(made.root, "add", "-A");
  git(made.root, "commit", "-q", "-m", "merged");
  await tidy();
  session.metadata = { "kuvo.archived": true };
  await tidy();
  assert.equal(fs.existsSync(made.root), false);
  git(project, "merge", "-q", "--ff-only", made.branch);
  git(project, "branch", "-d", made.branch);
  assert.equal((await records()).restorable.find(each => each.root === made.root)?.restorable, true);
  delete session.metadata;
  assert.equal((await ask("POST", "kuvo/worktrees/restore", { folder: made.folder })).status, 200);
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), made.branch);
  assert.ok(fs.existsSync(path.join(made.root, "merged.txt")));
  without("ses_merged");
  await tidy();
  assert.equal(fs.existsSync(made.root), false);
});

test("what's kept of a removed worktree goes through the repository's own filters, as your git add would: what git-crypt keeps encrypted stays so", async () => {
  // A filter of the repository's own, as git-crypt sets one up: what's committed is what it makes of the file.
  git(project, "config", "filter.secret.clean", "tr a-z A-Z");
  git(project, "config", "filter.secret.smudge", "cat");
  try {
    const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "kuvo/" })).value;
    const session = { id: "ses_secret", title: "Keep a secret", location: { directory: made.folder } };
    sessions.push(session);
    fs.writeFileSync(path.join(made.root, ".gitattributes"), "secret.txt filter=secret\n");
    fs.writeFileSync(path.join(made.root, "secret.txt"), "plain words\n");
    await tidy();
    session.metadata = { "kuvo.archived": true };
    await tidy();
    assert.equal(fs.existsSync(made.root), false);
    const kept = git(project, "for-each-ref", "--format=%(refname)", "refs/kuvo/worktrees").split("\n").find(each => each.includes(path.basename(made.root)));
    assert.ok(kept, "what wasn't committed is kept");
    assert.equal(git(project, "cat-file", "blob", `${kept}:secret.txt`), "PLAIN WORDS");
    delete session.metadata;
    assert.equal((await ask("POST", "kuvo/worktrees/restore", { folder: made.folder })).status, 200);
    assert.equal(fs.readFileSync(path.join(made.root, "secret.txt"), "utf8"), "PLAIN WORDS\n", "back through its smudge filter");
    without("ses_secret");
    await tidy();
    assert.equal(fs.existsSync(made.root), false);
  } finally {
    git(project, "config", "--remove-section", "filter.secret");
  }
});
