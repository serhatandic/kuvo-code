// A project's Changes on a box, as a Mac asks a machine's over SSH (`box route`) and a phone through
// the relay: what's changed, new files with their hashes, staging and unstaging, Discard putting a
// file back with anything in its way in Kuvo Code's trash, a picture's old side whole, and a commit.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-changes-")));
const home = path.join(root, "box");
const trash = path.join(root, "trash");
after(() => fs.rmSync(root, { recursive: true, force: true }));
const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xc3, 0x28]);

let repo;
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
const write = (name, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), text);
};
const read = name => fs.readFileSync(path.join(repo, name), "utf8");
const status = () => git("status", "--porcelain").split("\n").filter(Boolean).sort();

// A project with a commit: a readme, a source file in a folder, and a picture.
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(root, "project-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ada");
  git("config", "user.email", "ada@example.com");
  write("README.md", "Hello\n");
  write("src/app.js", "let a = 1\n");
  fs.writeFileSync(path.join(repo, "logo.png"), picture);
  git("add", "-A");
  git("commit", "-q", "-m", "First");
});

async function route(method, routePath, body) {
  const child = spawn(process.execPath, [script, "box", "route"], {
    env: { ...process.env, KUVO_HOME: home, KUVO_CHANGES_TRASH: trash, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.end(JSON.stringify({ method, path: routePath, ...(body ? { body } : {}) }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  return { ...answer, json: answer.body ? JSON.parse(answer.body) : undefined };
}
const changes = (scope = "uncommitted", directory = repo) => route("POST", "kuvo/git/changes", { directory, scope });
const trashed = () => (fs.existsSync(trash) ? fs.readdirSync(trash, { recursive: true }).map(String) : []);

test("what changed: an edit as git's diff with the whole file around it, and a new file with its hash", async () => {
  write("README.md", "Hello\nWorld\n");
  write("notes/todo.txt", "one\n");
  const { status: code, json } = await changes();
  assert.equal(code, 200);
  assert.equal(json.repository, true);
  assert.equal(json.root, repo);
  assert.equal(json.against, "HEAD");
  assert.match(json.patch, /diff --git a\/README\.md b\/README\.md[\s\S]* Hello\n\+World/);
  assert.deepEqual(json.untracked, ["notes/todo.txt"]);
  assert.equal(json.hashes["notes/todo.txt"], git("hash-object", "notes/todo.txt").trim());
  assert.equal(json.uncommitted, true);
});

test("an unchanged blank line keeps its place in what changed, whatever your git settings say", async () => {
  // Git told to write unchanged blank lines as nothing at all, which reads as no line.
  git("config", "diff.suppressBlankEmpty", "true");
  write("src/app.js", "let a = 1\n\nlet b = 2\n");
  git("commit", "-qam", "Blank line");
  write("src/app.js", "let a = 1\n\nlet b = 3\n");
  const { json } = await changes();
  assert.match(json.patch, /\n let a = 1\n \n-let b = 2\n\+let b = 3\n/);
});

test("what changed is the files' own lines, not what a converter of your git settings makes of them", async () => {
  // A textconv driver, as git-crypt or a .docx reader sets up: the lines it gives aren't the file's.
  git("config", "diff.shout.textconv", "tr a-z A-Z <");
  write(".gitattributes", "*.js diff=shout\n");
  git("add", ".gitattributes");
  git("commit", "-qm", "Shout");
  write("src/app.js", "let a = 2\n");
  const { json } = await changes();
  assert.match(json.patch, /\n-let a = 1\n\+let a = 2\n/);
});

test("a folder outside a repository has no changes to list", async () => {
  const plain = fs.mkdtempSync(path.join(root, "plain-"));
  const { status: code, json } = await changes("uncommitted", plain);
  assert.equal(code, 200);
  assert.deepEqual(json, { repository: false });
  assert.equal((await changes("uncommitted", path.join(root, "gone"))).status, 404);
});

test("Stage moves an edit to Staged, and Unstage moves it back", async () => {
  write("README.md", "Hello again\n");
  assert.equal((await route("POST", "kuvo/git/stage", { root: repo, path: "README.md", status: "modified", scope: "unstaged" })).status, 200);
  assert.deepEqual(status(), ["M  README.md"]);
  assert.match((await changes("staged")).json.patch, /\+Hello again/);
  assert.equal((await changes("unstaged")).json.patch, "");
  assert.equal((await route("POST", "kuvo/git/unstage", { root: repo, path: "README.md", status: "modified", scope: "staged" })).status, 200);
  assert.deepEqual(status(), [" M README.md"]);
});

test("Discard puts an edit back, and a new file goes to Kuvo Code's trash, not deleted for good", async () => {
  write("README.md", "Changed\n");
  write("draft.txt", "precious\n");
  assert.equal((await route("POST", "kuvo/git/discard", { root: repo, path: "README.md", status: "modified", scope: "uncommitted" })).status, 200);
  assert.equal(read("README.md"), "Hello\n");
  assert.equal((await route("POST", "kuvo/git/discard", { root: repo, path: "draft.txt", status: "added", scope: "uncommitted" })).status, 200);
  assert.equal(fs.existsSync(path.join(repo, "draft.txt")), false);
  assert.ok(trashed().some(name => name.endsWith("draft.txt")));
  assert.deepEqual(status(), []);
});

test("Discard with a file where a committed file's folder was: the folder's file comes back, the file in its way goes to the trash", async () => {
  fs.rmSync(path.join(repo, "src"), { recursive: true });
  write("src", "a file in the folder's place\n");
  assert.equal((await route("POST", "kuvo/git/discard", { root: repo, path: "src/app.js", status: "deleted", scope: "uncommitted" })).status, 200);
  assert.equal(read("src/app.js"), "let a = 1\n");
  assert.ok(trashed().some(name => path.basename(name) === "src"));
});

test("a file named like a pattern is the only one staged", async () => {
  write("app/[slug]/page.js", "1\n");
  write("app/s/page.js", "2\n");
  assert.equal((await route("POST", "kuvo/git/stage", { root: repo, path: "app/[slug]/page.js", status: "added" })).status, 200);
  assert.deepEqual(status(), ["?? app/s/", "A  app/[slug]/page.js"].sort());
});

test("a picture's old side comes back whole, and a file git doesn't have is said to be missing", async () => {
  fs.writeFileSync(path.join(repo, "logo.png"), Buffer.from("new"));
  const shown = await route("GET", `kuvo/git/show?root=${encodeURIComponent(repo)}&object=${encodeURIComponent("HEAD:logo.png")}`);
  assert.equal(shown.status, 200);
  assert.deepEqual(Buffer.from(shown.bodyBase64, "base64"), picture);
  assert.equal((await route("GET", `kuvo/git/show?root=${encodeURIComponent(repo)}&object=${encodeURIComponent("HEAD:nothing.png")}`)).status, 404);
  assert.equal((await route("GET", `kuvo/git/show?root=${encodeURIComponent(repo)}&object=--output=x`)).status, 400);
});

test("Commit with nothing staged takes the folder's changes, new files too; what it would take is there to write its message from", async () => {
  write("README.md", "Hello\nWorld\n");
  write("new.txt", "new\n");
  const before = await route("POST", "kuvo/git/commit-diff", { directory: repo });
  assert.equal(before.json.staged, false);
  assert.match(before.json.diff, /\+World[\s\S]*New files:\nnew\.txt/);
  assert.equal((await route("POST", "kuvo/git/commit", { directory: repo, message: "Say world", push: false })).status, 200);
  assert.deepEqual(status(), []);
  assert.equal(git("log", "-1", "--format=%s %an").trim(), "Say world Ada");
  const refused = await route("POST", "kuvo/git/commit", { directory: repo, message: "Nothing", push: false });
  assert.equal(refused.status, 422);
  assert.match(refused.json.message, /nothing to commit/);
});

test("Discard with a folder where a committed file was: the file comes back, the folder and what's in it go to the trash", async () => {
  fs.rmSync(path.join(repo, "README.md"));
  write("README.md/kept.txt", "precious\n");
  assert.equal((await route("POST", "kuvo/git/discard", { root: repo, path: "README.md", status: "modified" })).status, 200);
  assert.equal(read("README.md"), "Hello\n");
  assert.ok(trashed().some(name => name.endsWith(path.join("README.md", "kept.txt"))));
});

test("Discard of a move: the new name goes to the trash and the old one comes back", async () => {
  git("mv", "README.md", "GUIDE.md");
  assert.equal((await route("POST", "kuvo/git/discard", { root: repo, path: "GUIDE.md", oldPath: "README.md", status: "renamed" })).status, 200);
  assert.equal(read("README.md"), "Hello\n");
  assert.equal(fs.existsSync(path.join(repo, "GUIDE.md")), false);
  assert.deepEqual(status(), []);
});

test("Discard never takes the repository or a folder git keeps: a path that names one is refused or left be", async () => {
  for (const name of [".", "./", "/", "./README.md", "a//b", "a//", "../x", "/etc/hosts"]) {
    assert.equal((await route("POST", "kuvo/git/discard", { root: repo, path: name, status: "modified" })).status, 400, name);
  }
  // A folder git keeps, named as a file: git puts its files back as they were committed, and the
  // folder, with a new file in it, stays where it is.
  write("src/new.js", "mine\n");
  const before = trashed();
  await route("POST", "kuvo/git/discard", { root: repo, path: "src", status: "modified" });
  assert.equal(read("src/new.js"), "mine\n", "a folder git keeps isn't thrown away");
  assert.deepEqual(trashed(), before);
});

test("a repository inside the project, listed as \"web/\": staged, unstaged, and discarded whole to the trash", async () => {
  const web = path.join(repo, "web");
  fs.mkdirSync(web);
  const inWeb = (...args) => execFileSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: web, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  inWeb("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(web, "index.html"), "<p>hi</p>\n");
  inWeb("add", "-A");
  inWeb("commit", "-q", "-m", "Web");
  assert.deepEqual((await changes()).json.untracked, ["web/"]);
  assert.equal((await route("POST", "kuvo/git/stage", { root: repo, path: "web/", status: "added" })).status, 200);
  assert.deepEqual(status(), ["A  web"]);
  assert.equal((await route("POST", "kuvo/git/unstage", { root: repo, path: "web/", status: "added", scope: "staged" })).status, 200);
  assert.deepEqual(status(), ["?? web/"]);
  assert.equal((await route("POST", "kuvo/git/discard", { root: repo, path: "web/", status: "added" })).status, 200);
  assert.equal(fs.existsSync(web), false);
  assert.ok(trashed().some(name => name.endsWith(path.join("web", "index.html"))));
  assert.deepEqual(status(), []);
});

test("Unstage in a repository with no commits yet: out of what's staged, the file left as it is", async () => {
  repo = fs.mkdtempSync(path.join(root, "fresh-"));
  git("init", "-q", "-b", "main");
  write("first.txt", "one\n");
  git("add", "first.txt");
  const listed = await changes("staged");
  assert.equal(listed.json.against, "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  assert.match(listed.json.patch, /\+one/);
  assert.equal((await route("POST", "kuvo/git/unstage", { root: repo, path: "first.txt", status: "added", scope: "staged" })).status, 200);
  assert.deepEqual(status(), ["?? first.txt"]);
  assert.equal(read("first.txt"), "one\n");
});

test("a commit hook that leaves something running doesn't hold up the commit", async () => {
  write(".git/hooks/post-commit", "#!/bin/sh\nsleep 600 &\necho $! > .git/left.pid\n");
  fs.chmodSync(path.join(repo, ".git/hooks/post-commit"), 0o755);
  write("README.md", "Hello\nAgain\n");
  try {
    assert.equal((await route("POST", "kuvo/git/commit", { directory: repo, message: "Again" })).status, 200);
    assert.equal(git("log", "-1", "--format=%s").trim(), "Again");
  } finally {
    // What the hook left, stopped.
    try { process.kill(Number(read(".git/left.pid"))); } catch {}
  }
});

test("Branch: what the branch changed since it left its base, committed and not, and whether anything isn't committed yet", async () => {
  git("checkout", "-q", "-b", "feature");
  write("src/app.js", "let a = 2\n");
  git("commit", "-q", "-am", "Two");
  // main moves on meanwhile: not the branch's.
  git("checkout", "-q", "main");
  write("CHANGELOG.md", "On main\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Main's");
  git("checkout", "-q", "feature");
  write("README.md", "Hello\nWorld\n");

  const { json } = await route("POST", "kuvo/git/changes", { directory: repo, scope: "branch", base: "main" });
  assert.equal(json.against, git("merge-base", "HEAD", "main").trim());
  assert.match(json.patch, /\+let a = 2/);
  assert.match(json.patch, /\+World/);
  assert.doesNotMatch(json.patch, /CHANGELOG/);
  assert.equal(json.uncommitted, true);
  git("commit", "-q", "-am", "World");
  assert.equal((await route("POST", "kuvo/git/changes", { directory: repo, scope: "branch", base: "main" })).json.uncommitted, false);
});

test("Commit and Push: the commit reaches the remote, a new branch pushed and tracked", async () => {
  const remote = fs.mkdtempSync(path.join(root, "remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("remote", "add", "origin", remote);
  git("checkout", "-q", "-b", "feature");
  write("README.md", "Hello\nPushed\n");
  assert.equal((await route("POST", "kuvo/git/commit", { directory: repo, message: "Pushed", push: true })).status, 200);
  assert.equal(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "feature"], { encoding: "utf8" }).trim(), "Pushed");
  assert.equal(git("rev-parse", "--abbrev-ref", "feature@{upstream}").trim(), "origin/feature");
});
