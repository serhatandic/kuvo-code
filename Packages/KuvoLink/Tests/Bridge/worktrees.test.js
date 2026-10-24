// A machine's worktrees, kept by the machine itself and answered for with the Mac closed: one
// made for a session on a branch of its own, named after the session (by a Mac, or by the machine
// with no Mac there), listed with what to know before removing it, and removed (not while an
// agent works there). Real git; the engine is a stand-in that makes and removes worktrees with
// git, as it does.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-worktrees-")));
process.env.KUVO_HOME = path.join(home, ".kuvo-code");
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const project = path.join(home, "shop");
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
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const url = new URL(request.url, "http://x");
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    // Any folder in the repository (through a link too) is the project's.
    const real = (() => { try { return fs.realpathSync(folderOf(request)); } catch { return ""; } })();
    if (url.pathname === "/api/location") return send({ directory: folderOf(request), project: { id: real === project || real.startsWith(project + "/") ? "prj_shop" : "prj_workspace" } });
    if (url.pathname.startsWith("/api/worktree") && JSON.parse(body || "{}").projectID !== "prj_shop") return send({ message: "Not a git project" }, 400);
    if (url.pathname === "/api/worktree" && request.method === "POST") {
      const folder = path.join(home, "worktrees", `brave-otter-${sessions.length}`);
      git(project, "worktree", "add", "--detach", folder);
      return send({ directory: folder });
    }
    if (url.pathname === "/api/worktree" && request.method === "DELETE") {
      const sent = JSON.parse(body);
      try { git(project, "worktree", "remove", ...(sent.force ? ["--force"] : []), sent.directory); } catch { return send({ message: "git refused" }, 400); }
      return send({});
    }
    if (url.pathname === "/api/session") return send({ data: sessions });
    if (request.method === "PUT" && url.pathname.includes("/instructions/entries/")) {
      told.push({ url: url.pathname, value: JSON.parse(body).value });
      return send({});
    }
    if (url.pathname.startsWith("/api/session/") && url.pathname !== "/api/session/active") return send({ data: sessions.find(each => each.id === decodeURIComponent(url.pathname.split("/").pop())) ?? null });
    if (url.pathname === "/api/session/active") return send({ data: Object.fromEntries([...active].map(id => [id, {}])) });
    send({}, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
const atEngine = { port: engine.address().port, password: "pw" };
after(() => {
  engine.closeAllConnections();
  engine.close();
  fs.rmSync(home, { recursive: true, force: true });
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
  sessions.push({ id: "ses_tree", location: { directory: root } });

  const renamed = await ask("POST", "kuvo/worktrees/rename", { path: root, from: branch, branch: "kuvo/fix-the-total" });
  assert.deepEqual(renamed.value, { branch: "kuvo/fix-the-total" });
  assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), "kuvo/fix-the-total");
  // The same rename asked twice (the session's title came twice): the second finds it named.
  assert.equal((await ask("POST", "kuvo/worktrees/rename", { path: root, from: branch, branch: "kuvo/fix-the-total" })).status, 409);
  assert.equal(git(root, "symbolic-ref", "--short", "HEAD"), "kuvo/fix-the-total", "never kuvo/fix-the-total-2");

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
  assert.deepEqual((await ask("GET", "kuvo/worktrees?records=1")).value, { worktrees: [{ project, root, folder: root, branch: "kuvo/fix-the-total", base: "main", made: branch, prefix: "kuvo/" }] });

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
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: root })).status, 404);
  // Recorded again by a Mac that still had it: it's gone, so it stays gone.
  assert.equal((await ask("POST", "kuvo/worktrees/record", { project, root, branch: "kuvo/fix-the-total" })).status, 404);
  assert.deepEqual((await ask("GET", "kuvo/worktrees?records=1")).value.worktrees, []);
});

test("a session a phone makes in a worktree it asked for is told it works there", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project })).value;
  sessions.push({ id: "ses_phone", location: { directory: made.folder } });
  await link.tellWorktree(atEngine, "ses_phone");
  assert.deepEqual(told.map(each => each.url), ["/api/experimental/session/ses_phone/instructions/entries/kuvo.worktree"]);
  assert.match(told[0].value, new RegExp(`on the branch ${made.branch}, .* checkout at ${project} `));
  // One elsewhere: nothing.
  sessions.push({ id: "ses_plain", location: { directory: project } });
  await link.tellWorktree(atEngine, "ses_plain");
  assert.equal(told.length, 1);
  assert.equal((await ask("POST", "kuvo/worktrees/remove", { path: made.root, forget: true })).status, 200);
});

test("with no Mac there, the machine names a branch after its session's title, once, and only one it made", async () => {
  const made = (await ask("POST", "kuvo/worktrees", { project, branchPrefix: "me/" })).value;
  sessions.push({ id: "ses_named", title: "Giriş düzeltmesi", location: { directory: made.folder } });
  await link.nameWorktreeBranch(atEngine, "ses_named");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "me/giris-duzeltmesi");
  sessions.at(-1).title = "Something else";
  await link.nameWorktreeBranch(atEngine, "ses_named");
  assert.equal(git(made.root, "symbolic-ref", "--short", "HEAD"), "me/giris-duzeltmesi", "named once");
  assert.equal(link.branchSlug("Trim note titles"), "trim-note-titles");
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
