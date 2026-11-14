// A bot makes projects (PROTOCOL.md, "Work"): make_project asks you first, on whichever client you
// use, and the box makes it once you allow it: a folder with a new git repository in the projects
// folder you pick (the first time, in the same answer), added to the box's projects, marked with the
// bot that made it. "Always" lets that bot go ahead from then on, until Edit Bot takes it back; a
// no is told to the bot, and an answer given after its tool stopped waiting reaches its
// conversation. Each call by a process of its own, as a machine's tools ask it (`kuvo-link.js box
// route`). The real box script on a folder of the test's own; only the engine is a stand-in.
//
// Run with `node --test box/bridge-tests/bots-projects.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-projects-")));
removeAtEnd(home);
const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const developer = path.join(home, "Developer");
const projectsFile = path.join(home, "box", "projects.json");
const readProjects = () => JSON.parse(fs.readFileSync(projectsFile, "utf8")).projects;

// Pixel, a bot here.
const pixelFolder = path.join(home, "bots", "bot_pixel00001");
const botFile = path.join(pixelFolder, "bot.json");
const pixel = () => JSON.parse(fs.readFileSync(botFile, "utf8"));

// The engine: the bot's conversation, and what each conversation was sent.
let prompts;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const url = new URL(request.url, "http://x");
    const pixelSession = { id: "ses_pixel", title: "Pixel", ...(pixelOnAutopilot ? { metadata: { kuvo: { autopilot: true } } } : {}), location: { directory: path.join(pixelFolder, "workspace") }, permissions: [], time: { created: 1, updated: 5 } };
    if (url.pathname === "/api/session" && request.method === "GET") return reply({ data: url.searchParams.get("parentID") && url.searchParams.get("parentID") !== "null" ? [] : [pixelSession] });
    if (url.pathname === "/api/session/active") return reply({ data: {} });
    if (url.pathname === "/api/session/ses_pixel" && request.method === "GET") return reply({ data: pixelSession });
    if (url.pathname === "/api/session/ses_pixel/prompt") {
      prompts.push(JSON.parse(body));
      return reply({});
    }
    reply({ message: "Not here." }, 404);
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });

beforeEach(() => {
  prompts = [];
  for (const each of ["box", "run", "Developer", "bots", "bin"]) fs.rmSync(path.join(home, each), { recursive: true, force: true });
  fs.mkdirSync(developer, { recursive: true });
  write(projectsFile, JSON.stringify({ projects: [] }));
  write(botFile, JSON.stringify({ kuvo: 1, id: "bot_pixel00001", name: "Pixel", job: "Builds apps.", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
  write(path.join(pixelFolder, "session"), "ses_pixel");
  fs.mkdirSync(path.join(pixelFolder, "workspace"), { recursive: true });
  write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));
  // What a box makes and changes bots with, as a client puts it beside the script.
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.copyFileSync(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), path.join(home, "bin", "bot-words.json"));
});

// The box's answer to one request, as a machine's tool asks it: a process of its own.
function route(method, pathname, body, env = {}) {
  return new Promise((resolve, reject) => {
    // (A variable given as undefined is left out.)
    const given = Object.fromEntries(Object.entries({ ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home, ...env }).filter(([, value]) => value !== undefined));
    const child = spawn(process.execPath, [script, "box", "route"], { env: given, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    child.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
}
let pixelOnAutopilot = false;
const tool = async (name, args, env) => (await route("POST", "kuvo/agent-tools", { name, arguments: args, session: "ses_pixel" }, env)).body;
// What's asked of you now, once there's something (a client follows them; this looks again).
async function asked() {
  for (;;) {
    const { body } = await route("GET", "kuvo/work/asks");
    if (body.asks.length) return body.asks;
  }
}

test("a bot's first project asks you, with a folder to pick; once you allow it, it's made there as a git repository, marked as the bot's", async () => {
  const making = tool("make_project", { name: "Tidepool" });
  const [ask] = await asked();
  assert.equal(ask.action, "makeProject");
  assert.equal(ask.name, "Pixel");
  assert.equal(ask.bot, "bot_pixel00001");
  assert.equal(ask.session, "ses_pixel");
  assert.equal(ask.project, "Tidepool");
  assert.equal(ask.folderName, "tidepool");
  assert.equal(ask.folder, null, "no projects folder is picked yet");
  assert.equal(ask.suggested, developer, "~/Developer is offered, as it's there");
  assert.equal(fs.existsSync(path.join(developer, "tidepool")), false, "nothing's made before you answer");
  // Its bot's work shows it too, for the card on its conversation.
  assert.equal((await route("GET", "kuvo/work?bot=bot_pixel00001")).body.asks[0].id, ask.id);

  const answer = await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow", folder: "~/Developer" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const said = await making;
  assert.equal(said.isError, false, said.text);
  assert.match(said.text, /^Made Tidepool at ~\/Developer\/tidepool, a new git repository, on this machine\. It's in the sidebar/);
  assert.ok(fs.existsSync(path.join(developer, "tidepool", ".git")));
  const [project] = readProjects();
  assert.equal(project.directory, path.join(developer, "tidepool"));
  assert.equal(project.name, "Tidepool");
  assert.equal(project.madeBy.bot, "bot_pixel00001");
  assert.equal(project.madeBy.name, "Pixel");
  assert.deepEqual((await route("GET", "kuvo/work/settings")).body, { projectsFolder: developer }, "the folder you picked is where new projects go from now on");
  assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, [], "answered, it's no longer asked");
  assert.equal((await route("GET", "kuvo/work?bot=bot_pixel00001")).body.projects[0].directory, project.directory, "the bot's work lists the projects it made");
  assert.deepEqual(pixel().work, undefined, "Allow is for this once");
});

test("Always lets the bot make projects without asking, until Edit Bot takes it back", async () => {
  const first = tool("make_project", { name: "Tidepool" });
  const [ask] = await asked();
  assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "always", folder: developer })).status, 200);
  assert.equal((await first).isError, false);
  assert.deepEqual(pixel().work.allowed, ["makeProject"]);
  const listed = (await route("GET", "kuvo/bots")).body.bots.find(bot => bot.id === "bot_pixel00001");
  assert.deepEqual(listed.allowed, ["makeProject"], "clients see what it may do without asking");

  const second = await tool("make_project", { name: "Lighthouse" });
  assert.equal(second.isError, false, second.text);
  assert.ok(fs.existsSync(path.join(developer, "lighthouse", ".git")), "made at once");

  // Taken back, with the limits you set left as they are.
  const limits = await route("PATCH", "kuvo/bots/bot_pixel00001", { work: { limits: { atOnce: 2 } } });
  assert.equal(limits.status, 200, JSON.stringify(limits.body));
  assert.deepEqual(pixel().work, { allowed: ["makeProject"], limits: { atOnce: 2 } }, "limits changed alone leave Always as it is");
  assert.equal((await route("PATCH", "kuvo/bots/bot_pixel00001", { work: { allowed: [] } })).status, 200);
  assert.deepEqual(pixel().work, { limits: { atOnce: 2 } }, "Always taken back alone leaves the limits");
  const third = tool("make_project", { name: "Harbor" });
  const [again] = await asked();
  assert.equal(again.project, "Harbor");
  assert.equal(again.folder, path.join(developer, "harbor"), "the folder's picked now: it says where it goes");
  await route("POST", `kuvo/work/asks/${again.id}`, { answer: "deny" });
  const denied = await third;
  assert.equal(denied.isError, true);
  assert.match(denied.text, /The user said no to making Harbor/);
  assert.equal(fs.existsSync(path.join(developer, "harbor")), false);
});

test("what would fail anyway isn't asked: a folder with files in it, a project there already, an address that isn't a repository's", async () => {
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  write(path.join(developer, "notes", "todo.md"), "mine");
  write(projectsFile, JSON.stringify({ projects: [{ directory: path.join(developer, "tidepool"), folders: [] }] }));
  fs.writeFileSync(botFile, JSON.stringify({ ...pixel(), work: { allowed: ["makeProject", "cloneProject"] } }));
  const there = await tool("make_project", { name: "Notes" });
  assert.equal(there.isError, true);
  assert.match(there.text, /There's a folder at ~\/Developer\/notes already, with files in it/);
  assert.equal(fs.readFileSync(path.join(developer, "notes", "todo.md"), "utf8"), "mine", "never touched");
  const listed = await tool("make_project", { name: "Tidepool" });
  assert.equal(listed.isError, true);
  assert.match(listed.text, /There's a project at ~\/Developer\/tidepool already/);
  const sneaky = await tool("make_project", { name: "Sneaky", clone: "--upload-pack=touch /tmp/x" });
  assert.equal(sneaky.isError, true);
  assert.match(sneaky.text, /isn't a repository address git can clone/);
  const local = await tool("make_project", { name: "Local", clone: "/etc" });
  assert.equal(local.isError, true, "a path here isn't cloned");
  assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, []);
});

test("turned on Autopilot while a project waits on you, it stays asked and the agent carries on", { timeout: 60_000 }, async () => {
  try {
    const making = tool("make_project", { name: "Lagoon" }, { KUVO_WORK_ASK_WAIT: "3600000" });
    const [ask] = await asked();
    assert.equal(ask.project, "Lagoon");
    pixelOnAutopilot = true;
    const said = await making;
    assert.match(said.text, /The user hasn't answered yet: it stays asked/);
    assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "deny" })).status, 200);
  } finally {
    pixelOnAutopilot = false;
  }
});

test("on Autopilot a project it can't make on its own stays asked, and it carries on at once", async () => {
  pixelOnAutopilot = true;
  // (Left waiting, it would wait out the test.)
  const said = await tool("make_project", { name: "Reef" }, { KUVO_WORK_ASK_WAIT: "3600000" });
  pixelOnAutopilot = false;
  assert.equal(said.isError, false);
  assert.match(said.text, /The user hasn't answered yet: it stays asked/);
  const [ask] = (await route("GET", "kuvo/work/asks")).body.asks;
  assert.equal(ask.project, "Reef", "still asked, for when you're back");
  assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "deny" })).status, 200);
});

test("an answer given after its tool stopped waiting reaches the bot's conversation", async () => {
  const said = await tool("make_project", { name: "Tidepool" }, { KUVO_WORK_ASK_WAIT: "1" });
  assert.equal(said.isError, false);
  assert.match(said.text, /The user hasn't answered yet: it stays asked/);
  const [ask] = (await route("GET", "kuvo/work/asks")).body.asks;
  assert.equal(ask.project, "Tidepool", "still asked");
  assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow", folder: developer })).status, 200);
  assert.ok(fs.existsSync(path.join(developer, "tidepool", ".git")));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].text, /^\[The user answered\] Made Tidepool at ~\/Developer\/tidepool/);
  // Answered once: a second answer (from another client) finds it gone.
  assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow" })).status, 404);
});

test("allowing needs a projects folder, and only a real one; a no doesn't", async () => {
  const making = tool("make_project", { name: "Tidepool" });
  const [ask] = await asked();
  const none = await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow" });
  assert.equal(none.status, 400);
  assert.match(none.body.message, /Pick the folder new projects go in/);
  const missing = await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow", folder: path.join(home, "Nowhere") });
  assert.equal(missing.status, 400);
  assert.match(missing.body.message, /There's no folder at/);
  assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "deny" })).status, 200);
  assert.equal((await making).isError, true);
  assert.deepEqual((await route("GET", "kuvo/work/settings")).body, { projectsFolder: null, suggested: developer });
});

test("a client makes a project in the projects folder, and changes where they go", async () => {
  const before = await route("POST", "kuvo/projects/new", { name: "Tidepool" });
  assert.equal(before.status, 403);
  assert.equal(before.body.needs, "projectsFolder");
  assert.equal((await route("PATCH", "kuvo/work/settings", { projectsFolder: "~/Developer" })).status, 200);
  const made = await route("POST", "kuvo/projects/new", { name: "Tidepool", git: false });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.project.directory, path.join(developer, "tidepool"));
  assert.equal(made.body.project.madeBy, undefined, "yours, not a bot's");
  assert.equal(fs.existsSync(path.join(developer, "tidepool", ".git")), false, "a plain folder, as asked");
  assert.equal((await route("POST", "kuvo/projects/new", { name: "Tidepool" })).status, 409);
  assert.equal((await route("PATCH", "kuvo/work/settings", { projectsFolder: "relative/path" })).status, 400);
});

test("a new project starts with a commit, so its sessions can each have a worktree at once: by whoever commits on this computer, or Kuvo Code where no one's set", async () => {
  // No one set to commit on this computer but in its ~/.gitconfig: not the system's, the XDG one or the environment.
  const noOne = { GIT_CONFIG_NOSYSTEM: "1", XDG_CONFIG_HOME: path.join(home, "no-config"), GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined };
  const git = (folder, ...args) => spawnSync("git", args, { cwd: folder, encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal((await route("PATCH", "kuvo/work/settings", { projectsFolder: "~/Developer" })).status, 200);
  assert.equal((await route("POST", "kuvo/projects/new", { name: "Tidepool" }, noOne)).status, 201);
  const tidepool = path.join(developer, "tidepool");
  assert.equal(git(tidepool, "log", "--format=%an <%ae>|%s").stdout.trim(), "Kuvo Code <kuvo-code@localhost>|Initial commit", "one commit, by the box's own name where no one's set");
  assert.equal(git(tidepool, "status", "--porcelain").stdout, "", "with nothing in it, nor left over");
  const step = git(tidepool, "worktree", "add", "-b", "step-1", path.join(home, "step-1"));
  assert.equal(step.status, 0, step.stderr);
  fs.rmSync(path.join(home, "step-1"), { recursive: true, force: true });

  // Who commits here, as your git settings say.
  write(path.join(home, ".gitconfig"), "[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n");
  try {
    const made = tool("make_project", { name: "Lighthouse" }, noOne);
    const [ask] = await asked();
    assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow" })).status, 200);
    assert.equal((await made).isError, false);
    assert.equal(git(path.join(developer, "lighthouse"), "log", "--format=%an <%ae>").stdout.trim(), "Ada Lovelace <ada@example.com>");
  } finally {
    fs.rmSync(path.join(home, ".gitconfig"), { force: true });
  }
});

test("list_projects says where each project is and who made it", async () => {
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  fs.mkdirSync(path.join(developer, "mine"), { recursive: true });
  write(projectsFile, JSON.stringify({ projects: [{ directory: path.join(developer, "mine"), name: "Mine", folders: [] }, { directory: path.join(developer, "gone"), folders: [], removed: true }] }));
  fs.writeFileSync(botFile, JSON.stringify({ ...pixel(), work: { allowed: ["makeProject"] } }));
  await tool("make_project", { name: "Tidepool" });
  const said = await tool("list_projects", {});
  assert.equal(said.isError, false);
  assert.match(said.text, /- Tidepool: ~\/Developer\/tidepool \(git\), made by Pixel/);
  assert.match(said.text, /- Mine: ~\/Developer\/mine \(not git\)/);
  assert.doesNotMatch(said.text, /gone/, "a removed project isn't listed");
  assert.match(said.text, /New ones go in ~\/Developer\./);
});

test("what would fail anyway isn't asked even without Always: a folder with files in it already", async () => {
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  write(path.join(developer, "notes", "todo.md"), "mine");
  const said = await tool("make_project", { name: "Notes" });
  assert.equal(said.isError, true);
  assert.match(said.text, /There's a folder at ~\/Developer\/notes already, with files in it/);
  assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, [], "you're never asked about it");
});

test("a project that can't be made is the bot's answer, and the ask isn't left half answered", async () => {
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  fs.chmodSync(developer, 0o555);
  try {
    const making = tool("make_project", { name: "Tidepool" });
    const [ask] = await asked();
    const answer = await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow" });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.isError, true);
    const said = await making;
    assert.equal(said.isError, true);
    assert.match(said.text, /Couldn't do it/);
    assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, [], "answered: no other client finds it stuck");
  } finally {
    fs.chmodSync(developer, 0o755);
  }
});

test("a folder sent with an answer once one is picked doesn't move it", async () => {
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  const elsewhere = path.join(home, "Elsewhere");
  fs.mkdirSync(elsewhere, { recursive: true });
  const making = tool("make_project", { name: "Tidepool" });
  const [ask] = await asked();
  assert.equal((await route("POST", `kuvo/work/asks/${ask.id}`, { answer: "allow", folder: elsewhere })).status, 200);
  assert.equal((await making).isError, false);
  assert.ok(fs.existsSync(path.join(developer, "tidepool")), "made where projects go");
  assert.deepEqual((await route("GET", "kuvo/work/settings")).body, { projectsFolder: developer });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test("a bot deleted while it asks leaves nothing asked", async () => {
  const making = tool("make_project", { name: "Tidepool" });
  await asked();
  fs.rmSync(pixelFolder, { recursive: true, force: true });
  assert.equal((await making).isError, false, "its tool stops waiting");
  assert.deepEqual((await route("GET", "kuvo/work/asks")).body.asks, []);
});

test("with Always, a project that can't be made is the bot's answer too", async () => {
  write(path.join(home, "box", "work.json"), JSON.stringify({ projectsFolder: developer }));
  fs.writeFileSync(botFile, JSON.stringify({ ...pixel(), work: { allowed: ["makeProject"] } }));
  fs.chmodSync(developer, 0o555);
  try {
    const said = await tool("make_project", { name: "Tidepool" });
    assert.equal(said.isError, true);
    assert.match(said.text, /Couldn't make it|Couldn't do it/);
  } finally {
    fs.chmodSync(developer, 0o755);
  }
});
