// Kuvo Code's own tools on a box (PROTOCOL.md, "Agents' tools"): a conversation's wake-ups and
// watches, a bot's job, and the checks before a file or a widget is shown, answered by the box itself
// (`POST kuvo/agent-tools`), so every tool server (this Mac's app and keeper, a machine's
// kuvo-browser.js) only passes the call on. Each call by a process of its own, as a machine's tools
// ask it (`kuvo-link.js box route`). The real box script and the real kuvo-wake, on a folder of the
// test's own; the engine and the coding agents' bridge are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/own-tools.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-own-tools-")));
removeAtEnd(home);
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = file => fs.readFileSync(file, "utf8");
const project = path.join(home, "work", "api");
fs.mkdirSync(project, { recursive: true });
write(path.join(project, "notes.md"), "# Notes\n");

// The box's own kuvo-wake, as a machine has it in its `bin`.
const swift = read(new URL("../../../OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift", import.meta.url));
const opening = 'public static let script = #"""\n';
const from = swift.indexOf(opening) + opening.length;
write(path.join(home, "bin", "kuvo-wake"), swift.slice(from, swift.indexOf('\n    """#', from)).split("\n").map(line => line.replace(/^ {4}/, "")).join("\n") + "\n");
fs.chmodSync(path.join(home, "bin", "kuvo-wake"), 0o755);

// The engine's conversations: one at work and its subagent, a bot's, one that asks before commands
// (from before watches asked, and since), an archived one, and a group chat's seat.
const shellAsks = { action: "shell", resource: "*", effect: "ask" };
const sessions = new Map([
  ["ses_work", { id: "ses_work", title: "Work", location: { directory: project } }],
  ["ses_sub", { id: "ses_sub", parentID: "ses_work", title: "Helper", location: { directory: project } }],
  ["ses_scout", { id: "ses_scout", title: "Scout", location: { directory: path.join(home, "bots", "bot_scout00001", "workspace") } }],
  ["ses_scouthelp", { id: "ses_scouthelp", parentID: "ses_scout", title: "Scout's helper", location: { directory: project } }],
  ["ses_oldasks", { id: "ses_oldasks", title: "Old", location: { directory: project }, permissions: [shellAsks] }],
  ["ses_asks", { id: "ses_asks", title: "Asks", location: { directory: project }, permissions: [shellAsks, { action: "kuvo-browser_watch_for_change", resource: "*", effect: "ask" }] }],
  ["ses_away", { id: "ses_away", title: "Put away", location: { directory: project }, metadata: { "kuvo.archived": true } }],
  ["ses_quiet", { id: "ses_quiet", title: "Quiet", location: { directory: project } }],
  ["ses_seat", { id: "ses_seat", title: "Seat", location: { directory: project }, metadata: { kuvo: { seat: "grp_1" } } }],
]);
const told = [];
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const one = request.url.match(/^\/api\/session\/([^/?]+)$/);
    if (one && request.method === "GET") {
      const found = sessions.get(decodeURIComponent(one[1]));
      return found ? reply({ data: found }) : reply({ message: "No such session." }, 404);
    }
    if (request.method === "PUT" && request.url.includes("/instructions/entries/kuvo.bot")) told.push(JSON.parse(body).value);
    if (request.url.startsWith("/api/session") && request.method === "GET") return reply({ data: [] });
    reply({});
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));

// The coding agents' bridge, with a Claude Code conversation; a process named as the bridge is, as
// the box checks it's still that one.
const bridge = http.createServer((request, response) => {
  const one = request.url.match(/^\/api\/session\/([^/?]+)$/);
  const found = one && decodeURIComponent(one[1]) === "ses_claude";
  response.writeHead(found ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(found ? { data: { id: "ses_claude", title: "Claude", location: { directory: project } } } : {}));
});
await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
const stand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
write(path.join(home, "run", "bridge.json"), JSON.stringify({ pid: stand.pid, port: bridge.address().port, password: "x" }));
atEnd(() => { stand.kill(); bridge.closeAllConnections(); bridge.close(); });

// A bot here, as its folder is, and what its box makes bots with.
const bot = path.join(home, "bots", "bot_scout00001");
write(path.join(bot, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
write(path.join(bot, "session"), "ses_scout");
write(path.join(bot, "MEMORY.md"), "# Scout's memory\n");
fs.mkdirSync(path.join(bot, "workspace"), { recursive: true });
write(path.join(home, "bin", "bot-words.json"), JSON.stringify({
  kuvo: 1, templates: [], personalities: [], looks: { colors: ["sky"], shapes: ["round"], faces: ["calm"] },
  instructions: ["You are ⟦name⟧⟦jobLine⟧.", "⟦personality⟧", "⟦jobPart⟧"], here: { mac: {}, machine: {} },
  job: { none: "", line: ": ⟦job⟧", details: "Your job:\n⟦jobDetails⟧" },
  personalityWords: "⟦name⟧", projectNote: "Project.", identityNote: "", memory: "# ⟦name⟧'s memory\n", greeting: "Hi.",
}));

// The box's answer to one request, as a machine's tool asks it: a process of its own.
function route(body) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: home }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    child.stdin.end(JSON.stringify({ method: "POST", path: "kuvo/agent-tools", body }));
  });
}
const tool = async (name, args, session, more = {}) => {
  const { status, body } = await route({ name, arguments: args, ...(session ? { session } : {}), ...more });
  assert.equal(status, 200, JSON.stringify(body));
  return body;
};
const sessionFolder = session => path.join(home, "wakes", session);
const waiting = folder => fs.existsSync(path.join(folder, "wakes")) ? fs.readdirSync(path.join(folder, "wakes")) : [];

test("a subagent's wake-up is its conversation's, kept with its summary in a folder that knows where it works; listed and canceled by its id", async () => {
  const made = await tool("schedule_wake_up", { when: "+2h", note: "Look at the last CI run.", summary: "Check CI" }, "ses_sub");
  assert.equal(made.isError, false, made.text);
  const folder = sessionFolder("ses_work");
  assert.equal(read(path.join(folder, "session")), "ses_work");
  assert.equal(read(path.join(folder, "directory")), project);
  assert.equal(fs.existsSync(sessionFolder("ses_sub")), false, "not the subagent's own");
  const [wake] = waiting(folder);
  assert.equal(read(path.join(folder, "wakes", wake)), "Look at the last CI run.");
  const letters = wake.split("-")[1];
  assert.equal(read(path.join(folder, "summaries", letters)), "Check CI");

  const listed = await tool("list_wake_ups", {}, "ses_work");
  assert.equal(listed.isError, false);
  assert.match(listed.text, /Look at the last CI run\./);
  assert.match(listed.text, new RegExp(letters), "named by the id it's canceled by");
  const canceled = await tool("cancel_wake_up", { id: letters }, "ses_work");
  assert.equal(canceled.isError, false, canceled.text);
  assert.deepEqual(waiting(folder), []);
});

test("a bot's wake-up is kept in its own folder, from a subagent it started too", async () => {
  const made = await tool("schedule_wake_up", { when: "+1d", note: "Read the overnight build." }, "ses_scouthelp");
  assert.equal(made.isError, false, made.text);
  assert.equal(waiting(bot).length, 1);
  assert.equal(fs.existsSync(sessionFolder("ses_scout")), false);
  assert.equal(fs.existsSync(sessionFolder("ses_scouthelp")), false);
});

test("what a wake-up is missing, or a conversation that can't keep one, comes back saying why", async () => {
  assert.deepEqual(await tool("schedule_wake_up", { note: "Later." }, "ses_work"), { text: "Say when (when): +20m, +2h, +1d, or a time like 2026-10-21T09:00.", isError: true });
  assert.deepEqual(await tool("schedule_wake_up", { when: "+2h", note: " " }, "ses_work"), { text: "Add a note for yourself (note): what to do when you wake up.", isError: true });
  assert.deepEqual(await tool("cancel_wake_up", {}, "ses_work"), { text: "Say which one (id), from list_wake_ups.", isError: true });
  assert.deepEqual(await tool("schedule_wake_up", { when: "+2h", note: "Later." }), { text: "This needs a conversation of its own.", isError: true });
  assert.deepEqual(await tool("schedule_wake_up", { when: "+2h", note: "Meet." }, "ses_seat"),
    { text: "Not from a group chat: a chat can meet on a schedule instead (its editor's Meets on a Schedule).", isError: true });
  assert.deepEqual(await tool("schedule_wake_up", { when: "+2h", note: "Later." }, "ses_nobody"), { text: "Kuvo Code doesn't know this conversation yet. Try again in a moment.", isError: true });
  // Nothing kept yet: none to cancel, and none listed (no folder made for either).
  assert.deepEqual(await tool("cancel_wake_up", { id: "abc" }, "ses_quiet"), { text: 'No wake-up "abc". See list_wake_ups.', isError: true });
  assert.deepEqual(await tool("list_wake_ups", {}, "ses_quiet"), { text: "No wake-ups scheduled.", isError: false });
  // kuvo-wake's own refusal, in its words, before anything's kept.
  const early = await tool("schedule_wake_up", { when: "yesterday-ish", note: "Later." }, "ses_quiet");
  assert.equal(early.isError, true);
  assert.match(early.text, /Couldn't read the time/);
  assert.equal(fs.existsSync(sessionFolder("ses_quiet")), false, "no folder for nothing kept");
});

test("an archived conversation's wake-up waits with it, held as archiving holds it", async () => {
  const made = await tool("schedule_wake_up", { when: "+2h", note: "Look again." }, "ses_away");
  assert.equal(made.isError, false, made.text);
  assert.equal(read(path.join(sessionFolder("ses_away"), "paused")), "archived");
  assert.equal(waiting(sessionFolder("ses_away")).length, 1);
});

test("a coding agent's conversation's wake-ups go through the agents' bridge", async () => {
  const made = await tool("schedule_wake_up", { when: "+2h", note: "Look again." }, "ses_claude");
  assert.equal(made.isError, false, made.text);
  assert.equal(read(path.join(sessionFolder("ses_claude"), "via")), "bridge");
});

test("a watch in a conversation that asks before commands is made only once the user was asked; otherwise the agent's told to ask with the command", async () => {
  const unasked = await tool("watch_for_change", { every: "10m", check: "echo green", note: "Say what changed." }, "ses_oldasks");
  assert.equal(unasked.isError, true);
  assert.match(unasked.text, /^This conversation asks before running commands, .* kuvo-wake watch <every>/);
  assert.equal(fs.existsSync(sessionFolder("ses_oldasks")), false, "nothing kept");
  // One made since watches asked: the engine asked the user before the tool ran.
  const asked = await tool("watch_for_change", { every: "10m", check: "echo green", note: "Say what changed.", summary: "Build state" }, "ses_asks");
  assert.equal(asked.isError, false, asked.text);
  const [watch] = fs.readdirSync(path.join(sessionFolder("ses_asks"), "watches"));
  assert.equal(read(path.join(sessionFolder("ses_asks"), "watches", watch, "check")), "echo green");
  assert.equal(read(path.join(sessionFolder("ses_asks"), "watches", watch, "summary")), "Build state");
  assert.deepEqual(await tool("watch_for_change", { every: "10m", note: "Say what changed." }, "ses_work"),
    { text: "Give how often (every), the check (a shell command) and a note for when it changes.", isError: true });
});

test("a bot keeps its job with set_job (from a subagent it started too), and a conversation that isn't a bot's keeps none", async () => {
  const kept = await tool("set_job", { summary: "Keeps CI green.", details: "Watch main." }, "ses_scouthelp");
  assert.deepEqual(kept, { text: 'Kept. Kuvo Code shows "Keeps CI green" under your name.', isError: false });
  assert.equal(JSON.parse(read(path.join(bot, "bot.json"))).job, "Keeps CI green");
  assert.match(told.at(-1), /^You are Scout: Keeps CI green\./);
  assert.deepEqual(await tool("set_job", { summary: "Keeps CI green." }, "ses_scout"), { text: "Provide a non-empty summary and details, or clear: true to clear your job.", isError: true });
  assert.deepEqual(await tool("set_job", { summary: "Anything", details: "" }, "ses_work"), { text: "Only a bot keeps a job, and this conversation isn't one.", isError: true });
  assert.deepEqual(await tool("set_job", { clear: true }, "ses_scout"), { text: "Kept: you have no job now.", isError: false });
  assert.equal(JSON.parse(read(path.join(bot, "bot.json"))).job, "");
});

test("show_file, mark_final and show_widget go ahead only with what they name there to show", async () => {
  const notes = path.join(project, "notes.md");
  assert.deepEqual(await tool("show_file", { path: notes }, "ses_work"), { text: `Shown in the conversation: the file ${notes}. The user sees it there, on their Mac and their phone.`, isError: false });
  assert.deepEqual(await tool("show_file", { path: project }, "ses_work"), { text: `${project} is a folder: show a file in it, or the folder with show_in_panel.`, isError: true });
  assert.deepEqual(await tool("show_file", { path: path.join(project, "gone.png") }, "ses_work"), { text: `There's nothing at ${path.join(project, "gone.png")}.`, isError: true });
  assert.deepEqual(await tool("show_file", { path: "notes.md" }, "ses_work"), { text: "Give the file's full path.", isError: true });
  assert.deepEqual(await tool("show_file", { path: "~/notes.md" }, "ses_work"), { text: `Give the file's full path: ${path.join(home, "notes.md")}`, isError: true }, "shown from the path as given");
  assert.deepEqual(await tool("show_file", { path: `${project}/../api/notes.md` }, "ses_work"), { text: "Give the file's full path.", isError: true });

  assert.deepEqual(await tool("mark_final", { path: notes }, "ses_work"), { text: `Marked final: ${notes}. It's kept at the top of what you made, for the user.`, isError: false });
  assert.deepEqual(await tool("mark_final", { path: project }, "ses_work"), { text: `There's no file at ${project}.`, isError: true });

  assert.equal((await tool("show_widget", { html: "<p>Hi</p>" }, "ses_work")).isError, false);
  assert.deepEqual(await tool("show_widget", { html: "  " }, "ses_work"), { text: "Missing html.", isError: true });
});

test("show_in_panel takes a full path (a relative one is named in full from the conversation's folder) and says whether the user sees it now, where the client can tell", async () => {
  const notes = path.join(project, "notes.md");
  assert.deepEqual(await tool("show_in_panel", { path: notes }, "ses_work", { inView: true }), { text: `Shown: the file ${notes} is open in Kuvo Code's side panel, beside this conversation.`, isError: false });
  assert.match((await tool("show_in_panel", { path: `${project}/` }, "ses_work", { inView: false })).text, new RegExp(`^Kept for later: the folder ${project} opens in Kuvo Code's side panel when the user comes back`));
  assert.match((await tool("show_in_panel", { path: notes }, "ses_work")).text, new RegExp(`^Sent: the file ${notes} opens in Kuvo Code's side panel beside this conversation`));
  assert.deepEqual(await tool("show_in_panel", { path: "notes.md" }, "ses_sub"), { text: `Give the full path: ${notes}`, isError: true });
  assert.deepEqual(await tool("show_in_panel", { path: path.join(project, "gone") }, "ses_work"), { text: `There's nothing at ${path.join(project, "gone")}.`, isError: true });
  assert.deepEqual(await tool("show_in_panel", {}, "ses_work"), { text: "Missing path.", isError: true });
});
