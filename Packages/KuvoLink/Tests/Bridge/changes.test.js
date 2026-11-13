// A project's Changes on a box, as a Mac asks a machine's over SSH (`box route`) and a phone through
// the relay: what's changed, new files with their stamps, staging and unstaging, Discard putting a
// file back with anything in its way in Kuvo Code's trash, a picture's old side whole, a commit and a
// push, and a branch's work brought back: Merge into… and Create Pull Request.
import "./test-safety.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeAtEnd } from "./at-end.js";

const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-changes-")));
const home = path.join(root, "box");
const trash = path.join(root, "trash");
removeAtEnd(root);
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

async function route(method, routePath, body, env = {}) {
  const child = spawn(process.execPath, [script, "box", "route"], {
    env: { ...process.env, KUVO_HOME: home, KUVO_CHANGES_TRASH: trash, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
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

test("what changed: an edit as git's diff with the whole file around it, and a new file with its stamp", async () => {
  write("README.md", "Hello\nWorld\n");
  write("notes/todo.txt", "one\n");
  // Just written, however long the box takes to answer: a time it has yet to reach.
  const soon = new Date(Date.now() + 3_600_000);
  fs.utimesSync(path.join(repo, "notes/todo.txt"), soon, soon);
  const { status: code, json } = await changes();
  assert.equal(code, 200);
  assert.equal(json.repository, true);
  assert.equal(json.root, repo);
  assert.equal(json.against, "HEAD");
  assert.match(json.patch, /diff --git a\/README\.md b\/README\.md[\s\S]* Hello\n\+World/);
  assert.deepEqual(json.untracked, ["notes/todo.txt"]);
  assert.deepEqual(Object.keys(json.hashes), [], "just written: no stamp yet, read each look");
  assert.equal(json.uncommitted, true);
});

test("every new file has a stamp, the same until it changes, also after an install with no .gitignore", async () => {
  // Written a while ago: one changed in the last few seconds has no stamp yet, as git treats it.
  const earlier = new Date(Date.now() - 3_600_000);
  for (let at = 0; at < 600; at++) {
    write(`node_modules/pkg${at}/index.js`, `module.exports = ${at}\n`);
    fs.utimesSync(path.join(repo, `node_modules/pkg${at}/index.js`), earlier, earlier);
  }
  const first = (await changes()).json;
  assert.equal(first.untracked.length, 600);
  assert.equal(Object.keys(first.hashes).length, 600, "a client reads each only once");
  const again = (await changes()).json;
  assert.deepEqual(again.hashes, first.hashes);
  write("node_modules/pkg7/index.js", "module.exports = 'seven'\n");
  // Just changed, however long the box takes to answer: a time it has yet to reach.
  const soon = new Date(Date.now() + 3_600_000);
  fs.utimesSync(path.join(repo, "node_modules/pkg7/index.js"), soon, soon);
  const after = (await changes()).json;
  assert.equal(after.hashes["node_modules/pkg7/index.js"], undefined, "just changed: read each look for now");
  fs.utimesSync(path.join(repo, "node_modules/pkg7/index.js"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const settled = (await changes()).json;
  assert.notEqual(settled.hashes["node_modules/pkg7/index.js"], first.hashes["node_modules/pkg7/index.js"]);
  assert.equal(after.hashes["node_modules/pkg8/index.js"], first.hashes["node_modules/pkg8/index.js"]);
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

const count = (scope = "uncommitted", directory = repo, base) => route("POST", "kuvo/git/changes/count", { directory, scope, ...(base ? { base } : {}) });
// The files a client lists from the whole changes: each path in the diff once (its new one, as git
// writes it, in quotes when it has a tab: "b/t\tab"), and each new file not already there.
const listed = json => {
  const named = header => (header.endsWith('"') ? JSON.parse(header.slice(header.lastIndexOf(' "') + 1)) : header.split(" b/").at(-1)).replace(/^b\//, "");
  const paths = new Set([...json.patch.matchAll(/^diff --git (.*)$/gm)].map(match => named(match[1])).concat([...json.patch.matchAll(/^diff --cc (.*)$/gm)].map(match => match[1])));
  for (const name of json.untracked) paths.add(name);
  return paths.size;
};

test("how much changed, in each scope, as many files as the whole changes list, without the diff", async () => {
  git("checkout", "-q", "-b", "feature");
  write("src/app.js", "let a = 2\n");
  git("commit", "-qam", "Two");
  write("README.md", "Hello\nWorld\n");
  git("add", "README.md");
  fs.writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  write("notes/todo.txt", "one\ntwo");
  const expected = {
    staged: { files: 1, additions: 1, deletions: 0, untracked: 0 },
    unstaged: { files: 2, additions: 0, deletions: 0, untracked: 1 },
    uncommitted: { files: 3, additions: 1, deletions: 0, untracked: 1 },
    branch: { files: 4, additions: 2, deletions: 1, untracked: 1 },
  };
  for (const [scope, numbers] of Object.entries(expected)) {
    const base = scope === "branch" ? "main" : undefined;
    const { status: code, json } = await count(scope, repo, base);
    assert.equal(code, 200, scope);
    const whole = (await route("POST", "kuvo/git/changes", { directory: repo, scope, ...(base ? { base } : {}) })).json;
    assert.deepEqual(json, { repository: true, root: repo, against: whole.against, ...numbers, uncommitted: true }, scope);
    assert.equal(json.files, listed(whole), `${scope}: as many as a client lists`);
  }
  // Everything committed: Since its base still has the branch's work, and nothing waits to be committed.
  git("add", "-A");
  git("commit", "-qm", "Rest");
  assert.deepEqual((await count("branch", repo, "main")).json, {
    repository: true, root: repo, against: git("merge-base", "HEAD", "main").trim(), files: 4, additions: 4, deletions: 1, untracked: 0, uncommitted: false,
  });
});

test("a move, a file that became a link, a repository inside this one, a conflict and a name with a tab count once each", async () => {
  git("mv", "README.md", "GUIDE.md");
  fs.rmSync(path.join(repo, "src/app.js"));
  fs.symlinkSync("../logo.png", path.join(repo, "src/app.js"));
  fs.mkdirSync(path.join(repo, "web"));
  execFileSync("git", ["init", "-q"], { cwd: path.join(repo, "web") });
  fs.writeFileSync(path.join(repo, "web/index.html"), "<p>\n");
  const { json } = await count();
  assert.equal(json.files, 3);
  assert.equal(json.untracked, 1);
  assert.equal(json.files, listed((await changes()).json));

  git("reset", "-q", "--hard");
  fs.rmSync(path.join(repo, "web"), { recursive: true });
  write("t\tab.txt", "one\n");
  git("add", "-A");
  git("commit", "-qm", "Tab");
  git("checkout", "-q", "-b", "other");
  write("README.md", "Hello from other\n");
  git("commit", "-qam", "Other");
  git("checkout", "-q", "main");
  write("README.md", "Hello from main\n");
  git("commit", "-qam", "Main");
  assert.throws(() => git("merge", "-q", "other"));
  git("mv", "t\tab.txt", "t\tab moved.txt");
  for (const scope of ["uncommitted", "unstaged", "staged"]) {
    const counted = (await count(scope)).json;
    assert.equal(counted.files, listed((await changes(scope)).json), scope);
  }
  assert.equal((await count()).json.files, 2, "the conflict and the move");
  assert.equal((await count("staged")).json.files, 1, "the move: the conflict isn't staged");
});

test("a submodule that moved counts as the list shows it, whatever diff.submodule says", async () => {
  fs.mkdirSync(path.join(repo, "web"));
  const web = (...args) => execFileSync("git", ["-c", "user.name=Ada", "-c", "user.email=ada@example.com", ...args], { cwd: path.join(repo, "web"), env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  web("init", "-q");
  web("commit", "-q", "--allow-empty", "-m", "One");
  git("add", "web");
  git("commit", "-qm", "Web");
  web("commit", "-q", "--allow-empty", "-m", "Two");
  git("config", "diff.submodule", "log");
  const whole = (await changes()).json;
  assert.match(whole.patch, /^diff --git a\/web b\/web$/m);
  assert.equal((await count()).json.files, 1);
  assert.equal(listed(whole), 1);
});

test("no changes: a repository with nothing changed counts none, and a folder outside one isn't a repository", async () => {
  assert.deepEqual((await count()).json, { repository: true, root: repo, against: "HEAD", files: 0, additions: 0, deletions: 0, untracked: 0, uncommitted: true });
  for (const scope of ["unstaged", "staged"]) assert.equal((await count(scope)).json.files, 0, scope);
  const plain = fs.mkdtempSync(path.join(root, "plain-"));
  assert.deepEqual((await count("uncommitted", plain)).json, { repository: false });
  assert.equal((await count("uncommitted", path.join(root, "gone"))).status, 404);
  assert.equal((await count("everything")).status, 400);
});

test("a big change is counted without sending its diff, and many new files without reading them", async () => {
  const lines = n => Array.from({ length: n }, (_, at) => `line ${at} ${"x".repeat(40)}\n`).join("");
  write("big.txt", lines(100_000));
  git("add", "big.txt");
  git("commit", "-qm", "Big");
  write("big.txt", lines(100_000).replaceAll("x", "y"));
  const answer = await route("POST", "kuvo/git/changes/count", { directory: repo });
  assert.ok(answer.body.length < 500, `${answer.body.length} bytes`);
  assert.deepEqual(answer.json, { repository: true, root: repo, against: "HEAD", files: 1, additions: 100_000, deletions: 100_000, untracked: 0, uncommitted: true });
  assert.ok((await changes()).body.length > 5_000_000, "the whole changes are that big");
  for (let at = 0; at < 300; at++) write(`node_modules/pkg${at}/index.js`, `module.exports = ${at}\n`);
  const many = await route("POST", "kuvo/git/changes/count", { directory: repo });
  assert.ok(many.body.length < 500, `${many.body.length} bytes`);
  assert.equal(many.json.files, 301);
  assert.equal(many.json.untracked, 300);
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

test("a commit's hooks run with none of the box's own variables, and on a Mac with your login shell's environment as it is now, as a new terminal window has it", async () => {
  // A login shell of the test's own, whose startup file says what it sets, and a hook that writes
  // down what it ran with.
  const shellFolder = fs.mkdtempSync(path.join(root, "shell-"));
  const profile = path.join(shellFolder, "profile");
  const shell = path.join(shellFolder, "shell");
  const seen = path.join(shellFolder, "seen");
  fs.writeFileSync(shell, `#!/bin/sh\n. "${profile}"\nshift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, ".git/hooks/pre-commit"), `#!/bin/sh\nenv > "${seen}"\n`, { mode: 0o755 });
  const startup = tty => `export GPG_TTY=${tty}\nexport DYLD_INSERT_LIBRARIES=/nowhere\nexport NODE_OPTIONS=--require=/nowhere\nexport KUVO_HOST_PASSWORD=secret\nexport BUN_BE_BUN=1\n`;
  const ranWith = () => Object.fromEntries(fs.readFileSync(seen, "utf8").split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  // The box as the engine's Bun runs it, started with a GPG_TTY of its own (whatever the runner's).
  const env = { SHELL: shell, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", GPG_TTY: "/dev/ttys000" };

  fs.writeFileSync(profile, startup("/dev/ttys041"));
  write("README.md", "Hello\nWorld\n");
  assert.equal((await route("POST", "kuvo/git/commit", { directory: repo, message: "World", push: false }, env)).status, 200);
  let vars = ranWith();
  for (const name of ["BUN_BE_BUN", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "DYLD_INSERT_LIBRARIES", "KUVO_HOST_PASSWORD", "KUVO_HOME", "KUVO_CHANGES_TRASH"]) assert.equal(vars[name], undefined, name);
  assert.notEqual(vars.NODE_OPTIONS, "--require=/nowhere");
  assert.equal(vars.GPG_TTY, process.platform === "darwin" ? "/dev/ttys041" : "/dev/ttys000");

  // Your startup file changed since: what the next commit's hooks get, on a Mac.
  fs.writeFileSync(profile, startup("/dev/ttys042"));
  write("README.md", "Hello\nWorld, again\n");
  assert.equal((await route("POST", "kuvo/git/commit", { directory: repo, message: "Again", push: false }, env)).status, 200);
  vars = ranWith();
  assert.equal(vars.GPG_TTY, process.platform === "darwin" ? "/dev/ttys042" : "/dev/ttys000");
  assert.equal(vars.BUN_BE_BUN, undefined);
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

test("Commit and Push whose push doesn't go through says it committed, and Push sends it once the remote is there", async () => {
  const remote = path.join(fs.mkdtempSync(path.join(root, "remote-")), "app.git");
  git("remote", "add", "origin", remote);
  write("README.md", "Hello\nLater\n");
  const { status: code, json } = await route("POST", "kuvo/git/commit", { directory: repo, message: "Later", push: true });
  assert.equal(code, 422);
  assert.match(json.message, /^Committed, but the push didn’t go through/);
  assert.equal(json.committed, true, "a client offers Push, not the commit again");
  assert.equal(json.pushed, false);
  assert.equal(git("log", "-1", "--format=%s").trim(), "Later");

  const failed = await route("POST", "kuvo/git/push", { directory: repo });
  assert.equal(failed.status, 422);
  assert.ok(failed.json.message, "git's own words");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  assert.equal((await route("POST", "kuvo/git/push", { directory: repo })).status, 200);
  assert.equal(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "main"], { encoding: "utf8" }).trim(), "Later");
  assert.equal(git("rev-parse", "--abbrev-ref", "main@{upstream}").trim(), "origin/main", "tracked from now on");
  assert.equal(git("status", "--porcelain").trim(), "", "nothing committed twice");
});

/** A worktree of the project on a branch of its own, as a session in one has, kept by the box. */
async function worktree(branch = "kuvo/feature", recorded = true) {
  const folder = path.join(fs.mkdtempSync(path.join(root, "tree-")), "app");
  git("worktree", "add", "-q", "-b", branch, folder);
  if (recorded) assert.equal((await route("POST", "kuvo/worktrees/record", { project: repo, root: folder, branch, base: "main" })).status, 200);
  const there = (...args) => execFileSync("git", args, { cwd: folder, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  return { folder, there, write: (name, text) => fs.writeFileSync(path.join(folder, name), text) };
}

test("Merge into…: a worktree's commits go into the project's branch; work not committed, nothing new, a conflict and a merge of yours under way are refused with why, the project left as it was", async () => {
  const tree = await worktree();
  const merge = (body = {}) => route("POST", "kuvo/git/merge", { directory: tree.folder, into: "main", ...body });
  tree.write("README.md", "Hello\nFrom the worktree\n");
  let answer = await merge();
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "Commit the changes first. Only what’s committed goes.");
  tree.there("commit", "-q", "-am", "From the worktree");
  assert.equal((await merge()).status, 200);
  assert.equal(read("README.md"), "Hello\nFrom the worktree\n", "in the project's folder, on main");
  assert.equal(git("log", "-1", "--format=%s", "main").trim(), "From the worktree");
  answer = await merge();
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "kuvo/feature has nothing main doesn’t have yet.");

  // Both moved on, on a box with no git name of its own: a merge commit, by your shell's author.
  write("CHANGELOG.md", "On main\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Main's");
  tree.write("NOTES.md", "On the branch\n");
  tree.there("add", "-A");
  tree.there("commit", "-q", "-m", "The branch's");
  git("config", "--unset", "user.name");
  git("config", "--unset", "user.email");
  const author = { GIT_AUTHOR_NAME: "Grace", GIT_AUTHOR_EMAIL: "grace@example.com", GIT_COMMITTER_NAME: "Grace", GIT_COMMITTER_EMAIL: "grace@example.com" };
  assert.equal((await merge({ author })).status, 200);
  assert.equal(git("log", "-1", "--format=%an %P").split(" ").length, 3, "a merge commit");
  assert.equal(git("log", "-1", "--format=%an").trim(), "Grace");
  assert.equal(read("NOTES.md"), "On the branch\n");
  git("config", "user.name", "Ada");
  git("config", "user.email", "ada@example.com");

  // main and the branch change the same line.
  write("src/app.js", "let a = 2\n");
  git("commit", "-q", "-am", "Two on main");
  tree.write("src/app.js", "let a = 3\n");
  tree.there("commit", "-q", "-am", "Three on the branch");
  answer = await merge();
  assert.equal(answer.status, 409);
  assert.deepEqual(answer.json.conflicts, ["src/app.js"]);
  assert.equal(answer.json.message, "main changed some of the same lines: src/app.js. Nothing was merged.");
  assert.equal(read("src/app.js"), "let a = 2\n");
  assert.equal(git("status", "--porcelain").trim(), "", "taken back: not left in the middle of a merge");

  // A merge you're in the middle of in the project's folder is yours: left as it is.
  assert.throws(() => git("merge", "--no-edit", "kuvo/feature"));
  answer = await merge();
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "The project’s folder is in the middle of a merge. Finish it there first.");
  assert.match(git("status", "--porcelain"), /UU src\/app\.js/, "your merge still under way");
  git("merge", "--abort");

  answer = await route("POST", "kuvo/git/merge", { directory: tree.folder, into: "elsewhere" });
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "The project’s folder is on main now. Switch it back to elsewhere to merge, or create a pull request.");
  assert.equal((await route("POST", "kuvo/git/merge", { directory: tree.folder, into: "--abort" })).status, 400);
});

test("Merge into… with no branch named goes into the one the worktree was made from, and says which, as a conflict does", async () => {
  const tree = await worktree();
  tree.write("README.md", "Hello\nFrom the worktree\n");
  tree.there("commit", "-q", "-am", "From the worktree");
  let answer = await route("POST", "kuvo/git/merge", { directory: tree.folder });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { into: "main" });
  assert.equal(git("log", "-1", "--format=%s", "main").trim(), "From the worktree");

  write("src/app.js", "let a = 2\n");
  git("commit", "-q", "-am", "Two on main");
  tree.write("src/app.js", "let a = 3\n");
  tree.there("commit", "-q", "-am", "Three on the branch");
  answer = await route("POST", "kuvo/git/merge", { directory: tree.folder });
  assert.equal(answer.status, 409);
  assert.deepEqual(answer.json, { message: "main changed some of the same lines: src/app.js. Nothing was merged.", conflicts: ["src/app.js"], into: "main" });

  // The project's folder on another branch now: refused, the branch it was made from named.
  git("checkout", "-q", "-b", "elsewhere");
  answer = await route("POST", "kuvo/git/merge", { directory: tree.folder });
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "The project’s folder is on elsewhere now. Switch it back to main to merge, or create a pull request.");
});

test("Merge into… from a worktree this box has no record of (one made with git, or by the app's own box before it attached to this one) goes into its repository's folder", async () => {
  const tree = await worktree("kuvo/unrecorded", false);
  tree.write("README.md", "Hello\nFrom elsewhere\n");
  tree.there("commit", "-q", "-am", "From elsewhere");
  const answer = await route("POST", "kuvo/git/merge", { directory: tree.folder });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { into: "main" });
  assert.equal(git("log", "-1", "--format=%s", "main").trim(), "From elsewhere");
  // The project's own folder isn't a worktree's.
  assert.equal((await route("POST", "kuvo/git/merge", { directory: repo, into: "main" })).json.message, "Only a worktree’s branch is merged here. Create a pull request instead.");
});

test("Create Pull Request pushes the branch and makes it with gh against the worktree's base, or gives the host's page without gh", async () => {
  const tree = await worktree();
  const remote = fs.mkdtempSync(path.join(root, "remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("remote", "add", "origin", "git@github.com:kuvo-test/app.git");
  // Pushed here, while the remote reads as GitHub's.
  git("config", "remote.origin.pushurl", remote);
  // gh stands in for GitHub's own program: one not signed in, then one that makes it (and says what it was asked).
  const bin = fs.mkdtempSync(path.join(root, "bin-"));
  const asked = path.join(bin, "asked");
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'To get started with GitHub CLI, please run:  gh auth login' >&2\nexit 4\n", { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const pullRequest = body => route("POST", "kuvo/git/pull-request", { directory: tree.folder, ...body }, env);

  tree.write("README.md", "Hello\nReviewed\n");
  let answer = await pullRequest({});
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "Commit the changes first. Only what’s committed goes.");
  tree.there("commit", "-q", "-am", "Reviewed");

  answer = await pullRequest({ title: "Say reviewed", body: "Why & how" });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.compareURL, "https://github.com/kuvo-test/app/compare/main...kuvo/feature?expand=1&title=Say+reviewed&body=Why+%26+how");
  assert.equal(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "kuvo/feature"], { encoding: "utf8" }).trim(), "Reviewed");

  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${asked}'\necho https://github.com/kuvo-test/app/pull/7\n`, { mode: 0o755 });
  answer = await pullRequest({ title: "Say reviewed", body: "Why" });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { url: "https://github.com/kuvo-test/app/pull/7" });
  assert.deepEqual(fs.readFileSync(asked, "utf8").trim().split("\n"), ["pr", "create", "--repo", "github.com/kuvo-test/app", "--head", "kuvo/feature", "--base", "main", "--title", "Say reviewed", "--body", "Why"]);

  // gh says one is already open for the branch: that one.
  fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'a pull request for branch \"kuvo/feature\" into branch \"main\" already exists:' >&2\necho https://github.com/kuvo-test/app/pull/7 >&2\nexit 1\n", { mode: 0o755 });
  assert.deepEqual((await pullRequest({})).json, { url: "https://github.com/kuvo-test/app/pull/7" });
  // Made from a session: kept as that session's, for its row and card on every client; none before.
  const pulls = path.join(home, "box", "pulls.json");
  assert.equal(fs.existsSync(pulls), false);
  assert.deepEqual((await pullRequest({ session: "ses_review" })).json, { url: "https://github.com/kuvo-test/app/pull/7" });
  assert.deepEqual(Object.entries(JSON.parse(fs.readFileSync(pulls, "utf8")).sessions).map(([session, { url }]) => [session, url]), [["ses_review", "https://github.com/kuvo-test/app/pull/7"]]);
});

test("Create Pull Request's confirmation says its base, a title from the commits and whether gh makes it on the box, before anything is pushed", async () => {
  const tree = await worktree("dark-mode_toggle");
  const remote = fs.mkdtempSync(path.join(root, "remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("remote", "add", "origin", "git@github.com:kuvo-test/app.git");
  git("config", "remote.origin.pushurl", remote);
  // gh stands in for GitHub's own program; a box without it has only git.
  const bin = fs.mkdtempSync(path.join(root, "bin-"));
  const bare = fs.mkdtempSync(path.join(root, "bin-"));
  fs.symlinkSync(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), path.join(bare, "git"));
  const gh = signedIn => fs.writeFileSync(path.join(bin, "gh"), signedIn ? "#!/bin/sh\nexit 0\n" : "#!/bin/sh\necho 'You are not logged into any GitHub hosts.' >&2\nexit 1\n", { mode: 0o755 });
  const draft = (PATH = `${bin}${path.delimiter}${process.env.PATH}`, asked = {}) => route("POST", "kuvo/git/pull-request/draft", { directory: tree.folder, ...asked }, { PATH });

  tree.write("README.md", "Hello\nDark\n");
  let answer = await draft();
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "Commit the changes first. Only what’s committed goes.");

  tree.there("commit", "-q", "-am", "Add a dark mode", "-m", "Follows the system’s.");
  gh(true);
  answer = await draft();
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json, { branch: "dark-mode_toggle", base: "main", title: "Add a dark mode", body: "Follows the system’s.", host: "github", creates: true });
  // What it brings, only for a model to write them from.
  assert.match((await draft(undefined, { summary: true })).json.summary, /- Add a dark mode[\s\S]*README\.md[\s\S]*\+Dark/);

  // Not signed in, or not there: GitHub's page opens instead, and the confirmation says why.
  gh(false);
  answer = await draft();
  assert.equal(answer.json.creates, false);
  assert.equal(answer.json.gh, "signed-out");
  answer = await draft(bare);
  assert.equal(answer.json.creates, false);
  assert.equal(answer.json.gh, "missing");

  // Two commits: the branch's name, and the commits listed.
  tree.write("README.md", "Hello\nDark\nToggle\n");
  tree.there("commit", "-q", "-am", "Add a toggle");
  gh(true);
  answer = await draft();
  assert.equal(answer.json.title, "Dark mode toggle");
  assert.equal(answer.json.body, "- Add a dark mode\n- Add a toggle");
  assert.equal(execFileSync("git", ["--git-dir", remote, "branch", "--list"], { encoding: "utf8" }), "", "nothing pushed yet");

  // GitLab's: its page, gh not asked.
  git("remote", "set-url", "origin", "https://gitlab.com/kuvo-test/app.git");
  answer = await draft();
  assert.equal(answer.json.host, "gitlab");
  assert.equal(answer.json.creates, false);
  assert.equal(answer.json.gh, undefined);
});

test("Create Pull Request outside a worktree goes into origin's main branch, never from it, and gives GitLab's page", async () => {
  const remote = fs.mkdtempSync(path.join(root, "remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("remote", "add", "origin", "https://gitlab.com/kuvo-test/app.git");
  git("config", "remote.origin.pushurl", remote);
  git("push", "-q", "-u", "origin", "main");
  git("update-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const pullRequest = () => route("POST", "kuvo/git/pull-request", { directory: repo, title: "Fix" });
  let answer = await pullRequest();
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "main is the branch a pull request goes into. Make one from a branch of its own.");
  git("checkout", "-q", "-b", "fix/typo");
  answer = await pullRequest();
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "fix/typo has nothing main doesn’t have yet.");
  write("README.md", "Hello!\n");
  git("commit", "-q", "-am", "Fix");
  answer = await pullRequest();
  assert.equal(answer.status, 200);
  assert.equal(answer.json.compareURL, "https://gitlab.com/kuvo-test/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%2Ftypo&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=Fix");
  assert.equal(execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%s", "fix/typo"], { encoding: "utf8" }).trim(), "Fix");
});

test("Create Pull Request where git hasn't heard origin's main branch goes into main all the same, and waits for what isn't committed", async () => {
  // A remote added by hand and pushed to: no origin/HEAD.
  const remote = fs.mkdtempSync(path.join(root, "remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("remote", "add", "origin", "git@github.com:kuvo-test/app.git");
  git("config", "remote.origin.pushurl", remote);
  git("push", "-q", "-u", "origin", "main");
  git("checkout", "-q", "-b", "fix/typo");
  write("README.md", "Hello!\n");
  git("commit", "-q", "-am", "Fix the greeting");
  write("README.md", "Hello!!\n");
  const draft = () => route("POST", "kuvo/git/pull-request/draft", { directory: repo });
  let answer = await draft();
  assert.equal(answer.status, 409);
  assert.equal(answer.json.message, "Commit the changes first. Only what’s committed goes.");
  git("checkout", "--", "README.md");
  answer = await draft();
  assert.equal(answer.json.base, "main");
  assert.equal(answer.json.title, "Fix the greeting");
});

test("Discard on a submodule with edits of its own says to discard them there, and leaves them", async () => {
  const library = fs.mkdtempSync(path.join(root, "library-"));
  const inLibrary = (...args) => execFileSync("git", args, { cwd: library, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  inLibrary("init", "-q", "-b", "main");
  inLibrary("config", "user.name", "Ada");
  inLibrary("config", "user.email", "ada@example.com");
  fs.writeFileSync(path.join(library, "lib.js"), "let lib = 1\n");
  inLibrary("add", "-A");
  inLibrary("commit", "-q", "-m", "Library");
  git("-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "lib");
  git("commit", "-q", "-m", "Add the library");
  write("lib/lib.js", "let lib = 2\n");
  const { status: code, json } = await route("POST", "kuvo/git/discard", { root: repo, path: "lib", status: "modified" });
  assert.equal(code, 422);
  assert.equal(json.message, "lib is a submodule: its changes are in its own repository, so discard them there.");
  assert.equal(read("lib/lib.js"), "let lib = 2\n");
});

// A commit on the branch checked out, dated `when` (seconds since 1970), as git sorts branches by it.
const commitAt = (when, name) => {
  write(`${name}.txt`, `${name}\n`);
  git("add", "-A");
  execFileSync("git", ["commit", "-q", "-m", name], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_COMMITTER_DATE: `${when} +0000`, GIT_AUTHOR_DATE: `${when} +0000` } });
};

test("the branch menu: a repository's branches, the latest commit first, by their names, the one checked out, and none outside one", async () => {
  commitAt(1_000_000_000, "first");
  git("switch", "-q", "-c", "older");
  commitAt(2_000_000_000, "older");
  git("switch", "-q", "-c", "newer");
  commitAt(2_000_000_100, "newer");
  git("switch", "-q", "older");
  // A tag of a branch's name: still the branch's own name.
  git("tag", "newer");
  const { status: code, json } = await route("POST", "kuvo/git/branches", { directory: path.join(repo, "src") });
  assert.equal(code, 200);
  assert.deepEqual(json, { repository: true, root: repo, current: "older", branches: ["newer", "older", "main"] });

  git("switch", "-q", "--detach");
  assert.equal((await route("POST", "kuvo/git/branches", { directory: repo })).json.current, null);
  const plain = fs.mkdtempSync(path.join(root, "plain-"));
  assert.deepEqual((await route("POST", "kuvo/git/branches", { directory: plain })).json, { repository: false });
  assert.equal((await route("POST", "kuvo/git/branches", { directory: path.join(root, "gone") })).status, 404);
});

test("switching branches: to one there, or a new one with the changes not committed coming along, its hooks run as in your terminal; git's words when it can't", async () => {
  git("branch", "other");
  const mark = path.join(root, `checked-out-${path.basename(repo)}`);
  fs.writeFileSync(path.join(repo, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch "${mark}"\n`, { mode: 0o755 });
  assert.equal((await route("POST", "kuvo/git/switch", { directory: repo, branch: "other" })).status, 200);
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "other");
  assert.ok(fs.existsSync(mark), "post-checkout ran");

  write("README.md", "Hello\nWorld\n");
  assert.equal((await route("POST", "kuvo/git/switch", { directory: repo, branch: "idea", create: true })).status, 200);
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "idea");
  assert.equal(read("README.md"), "Hello\nWorld\n", "what wasn't committed came along");

  // A change in the way: git says so, and nothing moves.
  git("commit", "-qam", "World");
  write("README.md", "Hello\nThere\n");
  const refused = await route("POST", "kuvo/git/switch", { directory: repo, branch: "main" });
  assert.equal(refused.status, 422);
  assert.match(refused.json.message, /README\.md/);
  assert.equal(git("symbolic-ref", "--short", "HEAD").trim(), "idea");
  // A name that's an option, or none, is no branch.
  for (const branch of ["-f", "--orphan=x", "", "  ", "a\nb", undefined]) assert.equal((await route("POST", "kuvo/git/switch", { directory: repo, branch })).status, 400, String(branch));
  assert.equal((await route("POST", "kuvo/git/switch", { directory: repo, branch: "-wip", create: true })).json.message, "A branch’s name can’t start with “-”.");
  assert.equal((await route("POST", "kuvo/git/switch", { directory: repo, branch: "nowhere" })).status, 422);
});

test("whether anything isn't committed, as Delete asks before a worktree goes: a change, a new file, a submodule's change its ignore setting hides", async () => {
  const status = directory => route("POST", "kuvo/git/status", { directory });
  assert.deepEqual((await status(repo)).json, { repository: true, root: repo, uncommitted: false });
  write("notes.txt", "new\n");
  assert.equal((await status(path.join(repo, "src"))).json.uncommitted, true);
  fs.rmSync(path.join(repo, "notes.txt"));
  write("src/app.js", "let a = 2\n");
  assert.equal((await status(repo)).json.uncommitted, true);
  git("checkout", "--", "src/app.js");

  const library = fs.mkdtempSync(path.join(root, "library-"));
  const inLibrary = (...args) => execFileSync("git", args, { cwd: library, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  inLibrary("init", "-q", "-b", "main");
  inLibrary("config", "user.name", "Ada");
  inLibrary("config", "user.email", "ada@example.com");
  fs.writeFileSync(path.join(library, "lib.js"), "let lib = 1\n");
  inLibrary("add", "-A");
  inLibrary("commit", "-q", "-m", "Library");
  git("-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "lib");
  git("config", "-f", ".gitmodules", "submodule.lib.ignore", "all");
  git("add", "-A");
  git("commit", "-q", "-m", "Add the library");
  assert.equal((await status(repo)).json.uncommitted, false);
  write("lib/lib.js", "let lib = 2\n");
  assert.equal(git("status", "--porcelain").trim(), "", "git's own status leaves it out");
  assert.equal((await status(repo)).json.uncommitted, true);

  const plain = fs.mkdtempSync(path.join(root, "plain-"));
  assert.deepEqual((await status(plain)).json, { repository: false });
  assert.equal((await status(path.join(root, "gone"))).status, 404);
});

test("every file under a folder, for the file filter and @: git's list without what it ignores, by names as they are; a folder outside git, or one its repository ignores, walked without the heavy folders", async () => {
  const tree = folder => route("GET", `kuvo/folders/tree?path=${encodeURIComponent(folder)}`);
  write(".gitignore", "*.log\n");
  write("café notes.md", "b\n");
  git("add", "-A");
  git("commit", "-qm", "Notes");
  write("new.swift", "c\n");
  write("debug.log", "d\n");
  let { status: code, json } = await tree(repo);
  assert.equal(code, 200);
  assert.equal(json.git, true);
  assert.deepEqual(json.files.sort(), [".gitignore", "README.md", "café notes.md", "logo.png", "new.swift", "src/app.js"]);
  assert.deepEqual((await tree(path.join(repo, "src"))).json.files, ["app.js"]);
  // Asked for, when each last changed, in the same order, for a list that puts the newest first.
  fs.utimesSync(path.join(repo, "new.swift"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const dated = (await route("GET", `kuvo/folders/tree?path=${encodeURIComponent(repo)}&dated=1`)).json;
  assert.equal(dated.modified.length, dated.files.length);
  assert.equal(dated.modified[dated.files.indexOf("new.swift")], 1_700_000_000_000);
  assert.equal(json.modified, undefined, "not unless asked");

  // A folder its repository ignores (a dotfiles repository at home that ignores everything).
  write(".gitignore", "*\n!.gitignore\n");
  write("projects/site/index.html", "x\n");
  write("projects/site/css/style.css", "y\n");
  ({ json } = await tree(path.join(repo, "projects/site")));
  assert.equal(json.git, false);
  assert.deepEqual(json.files.sort(), ["css/style.css", "index.html"]);

  const plain = fs.mkdtempSync(path.join(root, "plain-"));
  for (const name of ["index.html", "js/main.js", "node_modules/lib/index.js", ".next/cache.json"]) {
    fs.mkdirSync(path.dirname(path.join(plain, name)), { recursive: true });
    fs.writeFileSync(path.join(plain, name), "x");
  }
  fs.symlinkSync(plain, path.join(plain, "js/loop"));
  ({ json } = await tree(plain));
  assert.deepEqual(json.files.sort(), ["index.html", "js/loop", "js/main.js"]);

  const gone = await tree(path.join(root, "gone"));
  assert.equal(gone.status, 404);
  assert.equal(gone.json.reason, "No such folder");
  assert.equal((await tree(path.join(plain, "index.html"))).status, 404);
  assert.equal((await route("GET", "kuvo/folders/tree")).status, 400, "never the whole home folder by default");
});
