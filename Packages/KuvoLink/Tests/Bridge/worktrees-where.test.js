// Settings › Worktrees' folder, as each box answers where new worktrees would go with it: the
// engine's own folder for each project, one beside the projects, one in your home folder, and one
// in the repository that git would list as new files until it's ignored. Real git; the engine is a
// stand-in that says which project a folder is, as the real one does.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-where-")));
process.env.KUVO_HOME = path.join(home, ".kuvo-code");
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const code = path.join(home, "code");
const shop = path.join(code, "shop");
fs.mkdirSync(path.join(shop, "web"), { recursive: true });
git(shop, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(shop, "web", "index.html"), "<p>Shop</p>\n");
git(shop, "add", "-A");
git(shop, "commit", "-q", "-m", "First");
// Notes: a folder that isn't a repository, so no worktrees.
const notes = path.join(code, "notes");
fs.mkdirSync(notes);

// The engine: the project any folder of the repository is, and its own checkout.
const engine = http.createServer((request, response) => {
  const folder = decodeURIComponent(request.headers["x-opencode-directory"] ?? "");
  const send = value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (new URL(request.url, "http://x").pathname !== "/api/location") return send({});
  send({ directory: folder, project: folder.startsWith(shop) ? { id: "4f1c9a2b7e", canonical: shop } : { id: "global", canonical: folder } });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
const atEngine = { port: engine.address().port, password: "pw" };
after(() => {
  engine.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const where = (directory, projects = [shop, notes], at = atEngine) => link.worktreesWhere(directory, at, undefined, projects);

test("by default each project's go in the engine's own folder, one for each project; a folder that isn't a repository has none", async () => {
  const answer = await where(null);
  const engineFolder = path.join(home, ".kuvo-code", "data", "opencode", "worktree");
  assert.equal(answer.directory, null);
  assert.equal(answer.default, engineFolder);
  assert.equal(answer.home, os.homedir());
  assert.deepEqual(answer.projects, [{ project: shop, name: "shop", folder: path.join(engineFolder, "4f1c9a"), exists: false, canMake: true }]);
});

test("a folder beside the projects, named relative to them, is where it says, for a project in a folder of its repository too", async () => {
  const answer = await where("../worktrees", [path.join(shop, "web")]);
  // From the repository's own checkout, not from the project's folder in it.
  assert.deepEqual(answer.projects, [{ project: path.join(shop, "web"), name: "web", folder: path.join(code, "worktrees"), exists: false, canMake: true }]);
  fs.mkdirSync(path.join(code, "worktrees"));
  assert.equal((await where("../worktrees")).projects[0].exists, true);
});

test("one in your home folder, written with ~/", async () => {
  const [entry] = (await where("~/Worktrees")).projects;
  assert.equal(entry.folder, path.join(os.homedir(), "Worktrees"));
});

test("one in the repository is said to be there, until git ignores it", async () => {
  const [inside] = (await where(".worktrees")).projects;
  assert.equal(inside.folder, path.join(shop, ".worktrees"));
  assert.equal(inside.inside, true);
  assert.equal(inside.ignored, false);
  fs.writeFileSync(path.join(shop, ".gitignore"), ".worktrees/\n");
  assert.equal((await where(".worktrees")).projects[0].ignored, true);
  // An absolute one elsewhere isn't in it.
  assert.equal((await where(path.join(home, "elsewhere"))).projects[0].inside, undefined);
});

test("one that can't be made is said so", async () => {
  const file = path.join(home, "a-file");
  fs.writeFileSync(file, "");
  const [entry] = (await where(path.join(file, "trees"))).projects;
  assert.equal(entry.exists, false);
  assert.equal(entry.canMake, false);
});

test("with the engine not running, a named folder is still found from git; the engine's own isn't known yet", async () => {
  assert.equal((await where("../worktrees", [shop], null)).projects[0].folder, path.join(code, "worktrees"));
  assert.equal((await where(null, [shop], null)).projects[0].folder, null);
});

test("a client goes through this box's folders to choose one: repositories marked, hidden ones left out, and no folder said so", () => {
  fs.mkdirSync(path.join(code, ".cache"));
  fs.mkdirSync(path.join(code, "app10"));
  fs.mkdirSync(path.join(code, "app9"));
  fs.writeFileSync(path.join(code, "README.md"), "");
  const listed = link.listFolders(`kuvo/folders?path=${encodeURIComponent(code)}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.value.path, code);
  assert.equal(listed.value.parent, home);
  assert.deepEqual(listed.value.folders.map(each => each.name), ["app9", "app10", "notes", "shop", "worktrees"]);
  assert.deepEqual(listed.value.folders.find(each => each.name === "shop"), { name: "shop", repository: true });
  assert.ok(link.listFolders(`kuvo/folders?path=${encodeURIComponent(code)}&hidden=1`).value.folders.some(each => each.name === ".cache"));
  // None, or ~: the home folder.
  assert.equal(link.listFolders("kuvo/folders").value.path, os.homedir());
  assert.equal(link.listFolders("kuvo/folders").value.home, os.homedir());
  assert.equal(link.listFolders(`kuvo/folders?path=${encodeURIComponent(path.join(code, "nowhere"))}`).status, 404);
  assert.equal(link.listFolders(`kuvo/folders?path=${encodeURIComponent(path.join(code, "README.md"))}`).status, 404);
  assert.equal(link.listFolders("kuvo/folders?path=code").status, 400);
});
