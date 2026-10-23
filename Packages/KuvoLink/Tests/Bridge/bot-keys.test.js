// A bot's keys of its own on a machine, kept there and changed there, from a phone with the Mac
// closed or from the Mac (through `box route`): which it has, given one, taken away; its folder's
// settings naming its server with them, and what you wrote there by hand left alone; a bot in a
// project turned away; its servers kept as the machine's integrations change.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-bot-keys-"));
process.env.KUVO_HOME = home;
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const link = await import(script);
after(() => fs.rmSync(home, { recursive: true, force: true }));

const catalog = (version = "1.0.0") => ({ integrations: [
  { id: "todoist", title: "Todoist", summary: "Tasks", kind: "Code and Work", symbol: "checklist", site: "https://todoist.com", how: "Open source · your key", way: "package",
    keys: [{ name: "API_KEY", label: "API token", prompt: "From Todoist" }], variables: { API_KEY: "KUVO_KEY_TODOIST_API_KEY" },
    settings: { type: "local", command: ["kuvo-npx", `@doist/todoist-mcp@${version}`], environment: { API_KEY: "{file:~/.kuvo-code/box/keys/KUVO_KEY_TODOIST_API_KEY}" }, codemode: false } },
  { id: "linear", title: "Linear", summary: "Issues", kind: "Code and Work", symbol: "list.bullet", site: "https://linear.app", how: "Official · sign in", way: "official",
    settings: { type: "remote", url: "https://mcp.linear.app/mcp" } },
] });
const writeCatalog = version => {
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "integrations.json"), JSON.stringify(catalog(version)));
};
writeCatalog();
const bot = (id, name, project = null) => {
  const folder = path.join(home, "bots", id);
  fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id, name, job: "", look: {}, project, created: 0, updated: 0 }));
  fs.writeFileSync(path.join(folder, "session"), `ses_${id.slice(4)}`);
};
bot("bot_scout", "Scout");
bot("bot_atlas", "Atlas", "/srv/app");
const own = path.join(home, "keys", "KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT");
const folderSettings = path.join(home, "bots", "bot_scout", "workspace", ".opencode", "opencode.json");
const settings = () => JSON.parse(fs.readFileSync(folderSettings, "utf8"));
// What waits a moment (its server connecting again), run when the test says.
const waiting = [];
const later = (run, ms) => waiting.push({ run, ms });
const ask = (method, route, body, engine = null) => link.answerBotKeys(method, route, body, engine, undefined, later);

test("given a key of its own: kept here, its folder's settings naming its server with it, and its server connected again in its folder", async () => {
  const asked = [];
  const engine = http.createServer((request, response) => {
    asked.push({ method: request.method, url: request.url, folder: decodeURIComponent(request.headers["x-opencode-directory"] ?? "") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  after(() => { engine.closeAllConnections(); engine.close(); });

  assert.deepEqual((await ask("GET", "kuvo/bots/bot_scout/keys")).value, { keys: [{ integration: "todoist", own: false, shared: false }] }, "only those you bring a key for");
  fs.mkdirSync(path.join(home, "box", "keys"), { recursive: true });
  fs.writeFileSync(path.join(home, "box", "keys", "KUVO_KEY_TODOIST_API_KEY"), "shared");
  assert.equal((await ask("GET", "kuvo/bots/bot_scout/keys")).value.keys[0].shared, true, "the machine's shared key");

  const missing = await ask("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: {} });
  assert.equal(missing.status, 400);
  assert.match(missing.value.message, /API token/);
  // What you wrote in its folder's settings by hand stays.
  fs.mkdirSync(path.dirname(folderSettings), { recursive: true });
  fs.writeFileSync(folderSettings, JSON.stringify({ instructions: ["notes.md"], mcp: { servers: { notes: { type: "local", command: ["notes"] } } } }));

  const engineAt = { port: engine.address().port, password: "pw" };
  const given = await ask("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: " tok_scout " } }, engineAt);
  assert.equal(given.status, 200);
  assert.equal(fs.readFileSync(own, "utf8"), "tok_scout");
  assert.equal((fs.statSync(own).mode & 0o777).toString(8), "600", "only you can read it");
  assert.deepEqual(settings().mcp.servers.todoist.environment, { API_KEY: "{file:~/.kuvo-code/keys/KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT}" });
  assert.deepEqual(settings().mcp.servers.notes, { type: "local", command: ["notes"] });
  assert.deepEqual(settings().instructions, ["notes.md"]);
  assert.deepEqual(waiting.map(each => each.ms), [2_000], "once the engine has read it");
  await waiting.shift().run();
  assert.deepEqual(asked, [{ method: "POST", url: "/api/experimental/mcp/todoist/connect", folder: path.join(home, "bots", "bot_scout", "workspace") }]);

  assert.deepEqual((await ask("GET", "kuvo/bots/bot_scout/keys/todoist")).value, { keys: { API_KEY: "tok_scout" } });
  assert.equal((await ask("GET", "kuvo/bots/bot_scout/keys")).value.keys[0].own, true);
});

test("its servers follow the machine's integrations (a newer version), and taken away, its server goes and what you wrote stays", async () => {
  writeCatalog("1.1.0");
  link.refreshBotsKeys();
  assert.deepEqual(settings().mcp.servers.todoist.command, ["kuvo-npx", "@doist/todoist-mcp@1.1.0"]);

  waiting.length = 0;
  assert.equal((await ask("DELETE", "kuvo/bots/bot_scout/keys/todoist")).status, 200);
  assert.equal(fs.existsSync(own), false);
  assert.equal(settings().mcp.servers.todoist, undefined);
  assert.deepEqual(settings().mcp.servers.notes, { type: "local", command: ["notes"] });
  assert.equal((await ask("DELETE", "kuvo/bots/bot_scout/keys/todoist")).status, 404);
});

test("all of them, as it leaves the machine: gone, and with nothing else in its folder's settings, the file too", async () => {
  fs.writeFileSync(folderSettings, "{}");
  await ask("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: "tok_again" } });
  fs.writeFileSync(path.join(home, "keys", "KUVO_KEY_GONE_TOKEN__BOT_SCOUT"), "from an integration no longer here");
  fs.writeFileSync(path.join(home, "keys", "KUVO_KEY_TODOIST_API_KEY__BOT_SCOUTER"), "another bot's");
  assert.equal((await ask("DELETE", "kuvo/bots/bot_scout/keys")).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(home, "keys")), ["KUVO_KEY_TODOIST_API_KEY__BOT_SCOUTER"], "its own, every one; never another bot's");
  assert.equal(fs.existsSync(path.dirname(folderSettings)), false);
});

test("a bot in a project, one that isn't here, an integration it can't have a key for, and settings that aren't plain JSON: turned away, nothing written", async () => {
  assert.equal((await ask("GET", "kuvo/bots/bot_atlas/keys")).status, 409);
  assert.equal((await ask("GET", "kuvo/bots/bot_nobody/keys")).status, 404);
  assert.equal((await ask("PUT", "kuvo/bots/bot_scout/keys/linear", { keys: {} })).status, 404);
  fs.mkdirSync(path.dirname(folderSettings), { recursive: true });
  fs.writeFileSync(folderSettings, "// mine\n{}");
  assert.equal((await ask("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: "tok" } })).status, 409);
  assert.equal(fs.existsSync(own), false);
  fs.rmSync(path.dirname(folderSettings), { recursive: true });
});

test("from a Mac, over SSH, the same routes: `box route`", () => {
  const ran = spawnSync(process.execPath, [script, "box", "route"], {
    input: JSON.stringify({ method: "PUT", path: "kuvo/bots/bot_scout/keys/todoist", body: { keys: { API_KEY: "tok_from_mac" } } }),
    env: { ...process.env, KUVO_HOME: home },
    encoding: "utf8",
  });
  const answer = JSON.parse(ran.stdout.trim().split("\n").at(-1));
  assert.equal(answer.status, 200);
  assert.equal(JSON.parse(answer.body).own, true);
  assert.equal(fs.readFileSync(own, "utf8"), "tok_from_mac");
});
