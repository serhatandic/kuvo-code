// Settings › Integrations on a machine, from a phone with the Mac closed: from the catalog the Mac
// leaves there, one added with its keys (or the keys it has), one used on its site turned away,
// and one removed with everything that goes with it: its keys, what its server kept, its bots'
// own keys and folder settings, all on the machine itself.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-integrations-"));
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const keyFile = "{file:~/.kuvo-code/box/keys/KUVO_KEY_TODOIST_API_KEY}";
const catalog = { integrations: [
  { id: "todoist", title: "Todoist", summary: "Tasks", kind: "Code and Work", symbol: "checklist", site: "https://todoist.com", how: "Open source · your key", way: "package",
    keys: [{ name: "API_KEY", label: "API token", prompt: "From Todoist" }], variables: { API_KEY: "KUVO_KEY_TODOIST_API_KEY" },
    settings: { type: "local", command: ["kuvo-npx", "@doist/todoist-mcp@1.0.0"], environment: { API_KEY: keyFile }, codemode: false } },
  { id: "linkedin", title: "LinkedIn", summary: "Posts", kind: "Social", symbol: "person", site: "https://linkedin.com", how: "In the browser", way: "browser" },
] };
fs.mkdirSync(path.join(home, "bin"), { recursive: true });
fs.writeFileSync(path.join(home, "bin", "integrations.json"), JSON.stringify(catalog));
fs.mkdirSync(path.join(home, "box"), { recursive: true });
fs.writeFileSync(path.join(home, "box", "opencode.json"), JSON.stringify({ mcp: { servers: {} } }));
const settings = () => JSON.parse(fs.readFileSync(path.join(home, "box", "opencode.json"), "utf8"));
const ask = (method, route, body) => link.answerIntegrations(method, route, body, null, undefined);

test("listed from the Mac's catalog, added with its keys or the ones it has, never one used on its site", async () => {
  const listed = await ask("GET", "kuvo/integrations");
  assert.deepEqual(listed.value.integrations.map(each => [each.id, each.added, each.keysSaved]), [["todoist", false, false], ["linkedin", false, undefined]]);
  assert.equal(listed.value.integrations[0].settings, undefined, "its settings stay the machine's");

  const missing = await ask("POST", "kuvo/integrations/todoist", {});
  assert.equal(missing.status, 400);
  assert.match(missing.value.message, /API token/);
  const added = await ask("POST", "kuvo/integrations/todoist", { keys: { API_KEY: " tok_123 " } });
  assert.equal(added.status, 200);
  assert.equal(added.value.integration.added, true);
  assert.equal(fs.readFileSync(path.join(home, "box", "keys", "KUVO_KEY_TODOIST_API_KEY"), "utf8"), "tok_123");
  // Where this box keeps its keys (here, the test's own folder), whatever folder the catalog names.
  assert.deepEqual(settings().mcp.servers.todoist.environment, { API_KEY: `{file:${home}/box/keys/KUVO_KEY_TODOIST_API_KEY}` });
  // Again, without keys: the ones it has do.
  assert.equal((await ask("POST", "kuvo/integrations/todoist", {})).status, 200);

  assert.equal((await ask("POST", "kuvo/integrations/linkedin", {})).status, 409);
  assert.equal((await ask("POST", "kuvo/integrations/nothing", {})).status, 404);
});

test("removed with its keys, what its server kept, and its bots' own keys and folder settings", async () => {
  fs.mkdirSync(path.join(home, "integrations", "todoist"), { recursive: true });
  fs.mkdirSync(path.join(home, "box", "bot-keys"), { recursive: true });
  fs.writeFileSync(path.join(home, "box", "bot-keys", "KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT"), "theirs");
  fs.writeFileSync(path.join(home, "box", "bot-keys", "KUVO_KEY_OTHER_API_KEY__BOT_SCOUT"), "stays");
  const own = path.join(home, "bots", "bot_scout", "workspace", ".opencode");
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(path.join(own, "opencode.json"), JSON.stringify({ mcp: { servers: { todoist: { type: "local", environment: { API_KEY: "{file:~/.kuvo-code/box/bot-keys/KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT}" } } } } }));
  // Another bot's, written by hand without keys of its own: it stays, as the Mac leaves it.
  const theirs = path.join(home, "bots", "bot_atlas", "workspace", ".opencode");
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, "opencode.json"), JSON.stringify({ mcp: { servers: { todoist: { type: "remote", url: "https://example.com/mcp" } } } }));

  assert.equal((await ask("DELETE", "kuvo/integrations/todoist")).status, 200);
  assert.equal(settings().mcp?.servers?.todoist, undefined);
  assert.equal(fs.existsSync(path.join(home, "box", "keys", "KUVO_KEY_TODOIST_API_KEY")), false);
  assert.equal(fs.existsSync(path.join(home, "integrations", "todoist")), false);
  assert.equal(fs.existsSync(path.join(home, "box", "bot-keys", "KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT")), false);
  assert.equal(fs.readFileSync(path.join(home, "box", "bot-keys", "KUVO_KEY_OTHER_API_KEY__BOT_SCOUT"), "utf8"), "stays");
  assert.equal(fs.existsSync(own), false, "a bot's settings naming only it go, with their folder");
  assert.equal(JSON.parse(fs.readFileSync(path.join(theirs, "opencode.json"), "utf8")).mcp.servers.todoist.type, "remote");
  assert.equal(fs.existsSync(path.join(home, "box", "integrations-removed.json")), false, "nothing for a Mac to see to: the machine has done it all");
  assert.equal((await ask("DELETE", "kuvo/integrations/todoist")).status, 404);
});

test("new keys: its server connects again a moment later, as Settings has it", async () => {
  const asked = [];
  const http = await import("node:http");
  const server = http.createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  after(() => { server.closeAllConnections(); server.close(); });
  const engine = { port: server.address().port, password: "pw" };
  // What waits a moment, run when the test says.
  const waiting = [];
  const later = (run, ms) => waiting.push({ run, ms });
  const added = await link.answerIntegrations("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_789" } }, engine, undefined, undefined, later);
  assert.equal(added.status, 200);
  assert.ok(!asked.some(each => each.includes("/connect")), "not before the engine has read them");
  assert.deepEqual(waiting.map(each => each.ms), [2_000]);
  await waiting[0].run();
  assert.ok(asked.includes("POST /api/experimental/mcp/todoist/connect"));
  // Without new keys, nothing to connect again for.
  waiting.length = 0;
  await link.answerIntegrations("POST", "kuvo/integrations/todoist", {}, engine, undefined, undefined, later);
  assert.equal(waiting.length, 0);
});
