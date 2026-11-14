// A bot keeps its job with its set_job tool (the agent's tools on a machine, `kuvo-browser.js`),
// which its box keeps in the bot's record (`PATCH kuvo/bots/<id>` with `job`, through
// `kuvo-link.js box route`): the real tool and the real box script, on a box folder of the test's
// own. Only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/set-job.test.js`.
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

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-set-job-")));
removeAtEnd(home);
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const tool = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));
write(path.join(home, "bin", "kuvo-link.js"), fs.readFileSync(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url)));

// The engine: the bot's conversation, a subagent it started, and what each was told.
const told = [];
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const one = request.url.match(/^\/api\/session\/([^/]+)$/);
    if (one && request.method === "GET") {
      const id = decodeURIComponent(one[1]);
      if (id === "ses_scout") return reply({ data: { id, location: { directory: home } } });
      if (id === "ses_helper") return reply({ data: { id, parentID: "ses_scout", location: { directory: home } } });
      if (id === "ses_someone") return reply({ data: { id, location: { directory: home } } });
      return reply({ message: "No such session." }, 404);
    }
    if (request.method === "PUT" && request.url.includes("/instructions/entries/kuvo.bot")) told.push({ url: request.url, value: JSON.parse(body).value });
    reply({});
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p", version: "0.0.0" }));

// A bot here, as its folder is, and what its box makes bots with.
const folder = path.join(home, "bots", "bot_scout00001");
write(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
write(path.join(folder, "session"), "ses_scout");
write(path.join(folder, "MEMORY.md"), "# Scout's memory\n");
write(path.join(home, "bin", "bot-words.json"), JSON.stringify({
  kuvo: 1, templates: [], personalities: [], looks: { colors: ["sky"], shapes: ["round"], faces: ["calm"] },
  instructions: ["You are ⟦name⟧⟦jobLine⟧.", "⟦personality⟧", "⟦jobPart⟧", "Who sets what."], here: { mac: {}, machine: {} },
  job: { none: "", line: ": ⟦job⟧", details: "Your job:\n⟦jobDetails⟧" },
  personalityWords: "⟦name⟧", projectNote: "Project.", identityNote: "Who sets what.", memory: "# ⟦name⟧'s memory\n", greeting: "Hi.",
}));

// The tool, as the engine starts it, and its calls, as the engine makes them.
const mcp = spawn(process.execPath, [tool, "mcp"], { env: { ...process.env, KUVO_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
atEnd(() => mcp.kill());
const answers = new Map();
let buffer = "";
mcp.stdout.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    answers.get(message.id)?.(message.result);
  }
});
let next = 1;
function call(name, args, session) {
  const id = next++;
  return new Promise(resolve => {
    answers.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { "ai.opencode/sessionID": session } } }) + "\n");
  });
}

test("a bot keeps its job with set_job: its box keeps it, says it under its name and tells it to its conversation", async () => {
  const kept = await call("set_job", { summary: "Keeps CI green.", details: "Watch main.\nFix flaky tests." }, "ses_scout");
  assert.equal(kept.isError, false, kept.content[0].text);
  assert.equal(kept.content[0].text, 'Kept. Kuvo Code shows "Keeps CI green" under your name.');
  const record = JSON.parse(fs.readFileSync(path.join(folder, "job.json"), "utf8"));
  assert.deepEqual([record.line, record.details], ["Keeps CI green", "Watch main.\nFix flaky tests."]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).job, "Keeps CI green");
  assert.equal(told.at(-1).value, "You are Scout: Keeps CI green.\n\nYour job:\nWatch main.\nFix flaky tests.\n\nWho sets what.");
  assert.equal(fs.readFileSync(path.join(folder, "MEMORY.md"), "utf8"), "# Scout's memory\n", "its memory is its own");

  const details = ("Leads development of Kuvo Code.\n\nCoordinates work across the project.\n\n" ).repeat(30);
  const reported = await call("set_job", { job: "Leads development of Kuvo Code", details }, "ses_scout");
  assert.equal(reported.isError, false, reported.content[0].text);
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(path.join(folder, "job.json"), "utf8"))).slice(0, 2), ["Leads development of Kuvo Code", details.trim()]);
  assert.equal(reported.content[0].text, 'Kept. Kuvo Code shows "Leads development of Kuvo Code" under your name.');
  assert.equal(told.at(-1).value, `You are Scout: Leads development of Kuvo Code.\n\nYour job:\n${details.trim()}\n\nWho sets what.`);
  for (const args of [{ summary: "   ", details: "" }, { summary: "**", details: "" }, { summary: "Job:", details: "" }, {}, { summary: "", details: "" }, { summary: 42, details: "" }, { summary: "Something" }]) {
    assert.equal((await call("set_job", args, "ses_scout")).isError, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).job, "Leads development of Kuvo Code");
  }
  assert.equal((await call("set_job", { clear: true }, "ses_scout")).isError, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).job, "");

  // From a subagent it started: the bot's.
  const fromHelper = await call("set_job", { summary: "Keeps CI and docs green", details: "Watch main and the docs." }, "ses_helper");
  assert.equal(fromHelper.isError, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "job.json"), "utf8")).line, "Keeps CI and docs green");

  // What its box can't keep, it says why.
  const long = await call("set_job", { summary: "x".repeat(300), details: "" }, "ses_scout");
  assert.equal(long.isError, true);
  assert.match(long.content[0].text, /too long/);

  // A conversation that isn't a bot's keeps no job.
  const nobody = await call("set_job", { summary: "Anything", details: "" }, "ses_someone");
  assert.equal(nobody.isError, true);
  assert.match(nobody.content[0].text, /Only a bot keeps a job/);
});

// A coding agent's tools on a machine (Claude Code's, say): the agents bridge starts the tool for
// one conversation, named in KUVO_SESSION, and its calls name none. Its wake-ups are that
// conversation's, as its other tools are. (`kuvo-wake` is a stand-in that says what it was asked.)
test("a coding agent's wake-ups are its conversation's: the tool started for it knows which", async () => {
  const wakeScript = path.join(home, "bin", "kuvo-wake");
  write(wakeScript, "#!/bin/sh\necho \"$@\"\n");
  fs.chmodSync(wakeScript, 0o755);
  const agent = spawn(process.execPath, [tool, "mcp"], { env: { ...process.env, KUVO_HOME: home, KUVO_SESSION: "ses_scout" }, stdio: ["pipe", "pipe", "ignore"] });
  atEnd(() => agent.kill());
  const listed = await new Promise(resolve => {
    let pending = "";
    agent.stdout.on("data", chunk => {
      pending += chunk;
      const end = pending.indexOf("\n");
      if (end >= 0) resolve(JSON.parse(pending.slice(0, end)).result);
    });
    agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_wake_ups", arguments: {} } }) + "\n");
  });
  assert.equal(listed.isError, false, listed.content[0].text);
  assert.equal(listed.content[0].text, `${folder} list`, "the bot's own wake-ups");
});
