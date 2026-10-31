// What Settings › Integrations does on a box, whichever way it keeps its keys: run by
// integrations.test.js (a machine's, in its files, with the Mac closed) and
// integrations-host.test.js (this Mac's, in its Keychain, through its app's host interface).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { atEnd } from "./at-end.js";

const shared = "KUVO_KEY_TODOIST_API_KEY";
const theirs = `${shared}__BOT_SCOUT`;

/** The catalog a Mac leaves in a box's `bin` (`MachineBox.integrationsJSON`), shortened. */
const catalog = { integrations: [
  { id: "apple-calendar", title: "Apple Calendar and Reminders", summary: "Events", kind: "Mail and Calendar", symbol: "calendar", site: "https://www.icloud.com/calendar", how: "On this Mac", way: "package", by: "mcp-server-apple-events", macOnly: true,
    settings: { type: "local", command: ["kuvo-npx", "mcp-server-apple-events@1.0.0"], environment: {}, codemode: false } },
  { id: "microsoft-365", title: "Outlook and Microsoft 365", summary: "Mail", kind: "Mail and Calendar", symbol: "envelope", site: "https://outlook.live.com", how: "Open source", way: "package", by: "ms-365-mcp-server",
    signInFile: "token-cache.json", settings: { type: "local", command: ["kuvo-npx", "@softeria/ms-365-mcp-server@1.0.0"], environment: {}, codemode: false } },
  { id: "todoist", title: "Todoist", summary: "Tasks", kind: "Code and Work", symbol: "checklist", site: "https://todoist.com", how: "Open source · your key", way: "package",
    keys: [{ name: "API_KEY", label: "API token", prompt: "From Todoist" }], variables: { API_KEY: shared },
    settings: { type: "local", command: ["kuvo-npx", "@doist/todoist-mcp@1.0.0"], environment: { API_KEY: `{file:~/.kuvo-code/box/keys/${shared}}` }, codemode: false } },
  { id: "caldav", title: "CalDAV", summary: "Calendars", kind: "Mail and Calendar", symbol: "calendar", site: "https://caldav.example", how: "Open source · your key", way: "package",
    keys: [{ name: "CALDAV_USERNAME", label: "user name", prompt: "Yours" }, { name: "CALDAV_PASSWORD", label: "password", prompt: "An app password" }],
    variables: { CALDAV_USERNAME: "KUVO_KEY_CALDAV_CALDAV_USERNAME", CALDAV_PASSWORD: "KUVO_KEY_CALDAV_CALDAV_PASSWORD" },
    settings: { type: "local", command: ["kuvo-npx", "caldav-mcp@1.0.0"], environment: { CALDAV_USERNAME: "{file:~/.kuvo-code/box/keys/KUVO_KEY_CALDAV_CALDAV_USERNAME}", CALDAV_PASSWORD: "{file:~/.kuvo-code/box/keys/KUVO_KEY_CALDAV_CALDAV_PASSWORD}" }, codemode: false } },
  { id: "notion", title: "Notion", summary: "Pages", kind: "Code and Work", symbol: "doc.text", site: "https://notion.so", how: "Official", way: "official",
    settings: { type: "remote", url: "https://mcp.notion.com/mcp", codemode: false } },
  { id: "linkedin", title: "LinkedIn", summary: "Posts", kind: "Social", symbol: "person", site: "https://linkedin.com", how: "In the browser", way: "browser" },
] };

/** An engine that lists its MCP servers as `servers()` says and its sign-ins as `credentials()`
 * (one that throws: it can't say), with `folders` open, and notes what it's asked (and for which
 * folder). */
export async function standInEngine(servers, folders = [], credentials = () => []) {
  const asked = [];
  const server = http.createServer((request, response) => {
    const folder = request.headers["x-opencode-directory"];
    asked.push(`${request.method} ${request.url}${folder ? ` in ${decodeURIComponent(folder)}` : ""}`);
    asked.onAsked?.();
    // A list it can't give (one that throws): answered as an engine too busy to say.
    let data;
    try {
      data = request.url === "/api/debug/location" ? folders.map(directory => ({ directory })) : { data: request.url === "/api/mcp" ? servers() : request.url === "/api/credential" ? credentials() : [] };
    } catch (error) {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: error.message }));
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { engine: { port: server.address().port, password: "pw" }, asked };
}

/** One route, answered as the box answers any client. */
async function route(link, method, requestPath, body) {
  const handle = link.engineHandler(() => { throw new Error("no engine"); });
  let status = 0;
  const chunks = [];
  for await (const part of handle({ method, path: requestPath, headers: {}, body: Buffer.from(body ? JSON.stringify(body) : ""), fromApp: true }, {}, undefined)) {
    if (part.head) status = part.head.status;
    if (part.body) chunks.push(Buffer.from(part.body));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return { status, value: text ? JSON.parse(text) : {} };
}

/**
 * The scenarios, on `link` (the box's module, its home `home`), for a box that `mac` or not, with
 * its keys in `store`: `{settingsFile, named, data, kept(name), keep(name, value)}`: its settings
 * file, the folder its settings name its keys in, where its servers keep what they keep, a key as
 * it's kept (null for none), and one kept there by hand.
 */
export function integrationScenarios({ link, home, mac, store }) {
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "integrations.json"), JSON.stringify(catalog));
  fs.mkdirSync(path.dirname(store.settingsFile), { recursive: true });
  fs.writeFileSync(store.settingsFile, JSON.stringify({ mcp: { servers: {} } }));
  const settings = () => JSON.parse(fs.readFileSync(store.settingsFile, "utf8"));
  const write = value => fs.writeFileSync(store.settingsFile, JSON.stringify(value));
  const ask = (method, requestPath, body, engine = null, later) => link.answerIntegrations(method, requestPath, body, engine, undefined, undefined, later);
  const listed = async (engine = null) => (await ask("GET", "kuvo/integrations", undefined, engine)).value.integrations;

  test("listed from the catalog, added with its keys or the ones it has, never one used on its site", async () => {
    const all = await listed();
    const expected = [...(mac ? [["apple-calendar", false, undefined]] : []), ["microsoft-365", false, undefined], ["todoist", false, false], ["caldav", false, false], ["notion", false, undefined], ["linkedin", false, undefined]];
    assert.deepEqual(all.map(each => [each.id, each.added, each.keysSaved]), expected, mac ? "with those that use this Mac's own apps" : "without those that use a Mac's own apps");
    assert.ok(all.every(each => each.settings === undefined && each.variables === undefined && each.signInFile === undefined), "what it runs stays the box's");

    const missing = await ask("POST", "kuvo/integrations/todoist", {});
    assert.equal(missing.status, 400);
    assert.match(missing.value.message, /API token/);
    const added = await ask("POST", "kuvo/integrations/todoist", { keys: { API_KEY: " tok_123 " } });
    assert.equal(added.status, 200);
    assert.equal(added.value.integration.added, true);
    assert.equal(added.value.integration.keysSaved, true);
    assert.equal(store.kept(shared), "tok_123", "its key, kept where this box keeps them");
    // Named where this box's engine reads it, whatever folder the catalog names.
    assert.deepEqual(settings().mcp.servers.todoist.environment, { API_KEY: `{file:${store.named}/${shared}}` });
    // Again, without keys: the ones it has do.
    assert.equal((await ask("POST", "kuvo/integrations/todoist", {})).status, 200);

    assert.equal((await ask("POST", "kuvo/integrations/linkedin", {})).status, 409);
    assert.equal((await ask("POST", "kuvo/integrations/nothing", {})).status, 404);
    assert.equal((await ask("POST", "kuvo/integrations/apple-calendar", {})).status, mac ? 200 : 404);
    if (mac) assert.equal((await ask("DELETE", "kuvo/integrations/apple-calendar")).status, 200);
  });

  test("off in MCP Servers says so; just turned on, while the engine still says it's off, it's starting", async t => {
    const states = { todoist: "disabled" };
    const { engine } = await standInEngine(() => Object.entries(states).map(([name, status]) => ({ name, status: { status } })));
    const health = async () => (await listed(engine)).find(each => each.id === "todoist").health;
    const turn = off => {
      const written = settings();
      if (off) written.mcp.servers.todoist.disabled = true; else delete written.mcp.servers.todoist.disabled;
      write(written);
    };
    assert.equal((await ask("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_123" } })).status, 200);
    t.after(() => turn(false));
    turn(true);
    assert.equal(await health(), "disabled", "it won't start until it's turned on: nothing to wait for");
    turn(false);
    assert.equal(await health(), "starting", "Turn On: the engine hasn't read it yet");
    states.todoist = "connected";
    assert.equal(await health(), "connected");
    states.todoist = "failed";
    assert.equal(await health(), "failed");
    delete states.todoist;
    const down = (await ask("GET", "kuvo/integrations")).value;
    assert.equal(down.engineDown, true, "no engine to say how they're doing");
    assert.equal(down.integrations.find(each => each.id === "todoist").health, undefined, "not called starting");
    turn(true);
    assert.equal((await listed(null)).find(each => each.id === "todoist").health, "disabled", "one turned off is still off");
    turn(false);
    assert.equal((await ask("GET", "kuvo/integrations", undefined, engine)).value.engineDown, undefined);
  });

  test("one that signs in with a code the first time it's used waits for it until its sign-in is there", async t => {
    const { engine } = await standInEngine(() => [{ name: "microsoft-365", status: { status: "connected" } }]);
    assert.equal((await ask("POST", "kuvo/integrations/microsoft-365", {})).status, 200);
    t.after(async () => { await ask("DELETE", "kuvo/integrations/microsoft-365"); });
    const health = async () => (await listed(engine)).find(each => each.id === "microsoft-365").health;
    assert.equal(await health(), "waitsForCode");
    fs.mkdirSync(path.join(store.data, "microsoft-365"), { recursive: true });
    fs.writeFileSync(path.join(store.data, "microsoft-365", "token-cache.json"), "{}");
    assert.equal(await health(), "connected");
  });

  test("one you sign in to on its own page: Sign In before it ever had a sign-in, Sign In Again once the one it had ended", async t => {
    let status = "needs_auth";
    let credentials = [];
    const { engine } = await standInEngine(() => [{ name: "notion", status: { status }, integrationID: "mcp_notion" }], [], () => credentials);
    assert.equal((await ask("POST", "kuvo/integrations/notion", {})).status, 200);
    t.after(async () => { await ask("DELETE", "kuvo/integrations/notion"); });
    const shown = async () => (await listed(engine)).find(each => each.id === "notion");
    assert.deepEqual(await shown().then(each => [each.health, each.signIn, each.signInEnded]), ["needsSignIn", "mcp_notion", undefined], "never signed in");
    // Signed in once; the engine can't use that sign-in any more (it ran out, or was taken back).
    credentials = [{ id: "cred_1", integrationID: "mcp_notion", label: "you@example.com", active: true, value: { type: "oauth" } }];
    assert.deepEqual(await shown().then(each => [each.health, each.signInEnded]), ["needsSignIn", true]);
    // One set aside in Accounts is still one it had.
    status = "connected";
    credentials = [{ ...credentials[0], active: false }];
    assert.deepEqual(await shown().then(each => [each.health, each.signInEnded]), ["needsSignIn", true]);
    // Signed in again: nothing ended.
    credentials = [{ ...credentials[0], active: true }];
    assert.deepEqual(await shown().then(each => [each.health, each.signInEnded]), ["connected", undefined]);
  });

  // One whose sign-in list the engine didn't give (busy, or it timed out) isn't called signed out:
  // nothing is known of its sign-in, so it's as the engine says.
  test("its engine not saying who's signed in never turns a connected one into Sign In", async t => {
    let credentials = () => [{ id: "cred_1", integrationID: "mcp_notion", label: "you@example.com", active: true, value: { type: "oauth" } }];
    const { engine } = await standInEngine(() => [{ name: "notion", status: { status: "connected" }, integrationID: "mcp_notion" }], [], () => credentials());
    assert.equal((await ask("POST", "kuvo/integrations/notion", {})).status, 200);
    t.after(async () => { await ask("DELETE", "kuvo/integrations/notion"); });
    const shown = async () => (await listed(engine)).find(each => each.id === "notion");
    assert.equal((await shown()).health, "connected");
    credentials = () => { throw new Error("busy"); };
    assert.deepEqual(await shown().then(each => [each.health, each.signInEnded]), ["connected", undefined]);
  });

  // Change Key for one of its keys (the phone sends what you changed): saved, and the others kept.
  test("one of several keys changed alone is saved, the others kept; a first one without them all isn't added", async t => {
    const user = "KUVO_KEY_CALDAV_CALDAV_USERNAME", password = "KUVO_KEY_CALDAV_CALDAV_PASSWORD";
    t.after(async () => { await ask("DELETE", "kuvo/integrations/caldav"); });
    const half = await ask("POST", "kuvo/integrations/caldav", { keys: { CALDAV_PASSWORD: "pw_1" } });
    assert.equal(half.status, 400, "not added with half its keys");
    assert.match(half.value.message, /user name and password/);
    assert.equal(settings().mcp.servers.caldav, undefined);
    assert.equal(store.kept(password), null, "nor that half kept");
    assert.equal((await ask("POST", "kuvo/integrations/caldav", { keys: { CALDAV_USERNAME: "me", CALDAV_PASSWORD: "pw_1" } })).status, 200);
    const changed = await ask("POST", "kuvo/integrations/caldav", { keys: { CALDAV_PASSWORD: " pw_2 " } });
    assert.equal(changed.status, 200);
    assert.equal(store.kept(password), "pw_2", "the new one saved");
    assert.equal(store.kept(user), "me", "the other kept");
  });

  test("its keys through kuvo/keys: listed, read, set and removed, never a bot's own", async () => {
    store.keep(theirs, "bots");
    const names = await route(link, "GET", "kuvo/keys");
    assert.equal(names.status, 200);
    assert.ok(names.value.keys.includes(shared) && !names.value.keys.includes(theirs), JSON.stringify(names.value));
    assert.deepEqual((await route(link, "GET", `kuvo/keys/${shared}`)).value, { value: "tok_123" });
    assert.equal((await route(link, "PUT", `kuvo/keys/${shared}`, { value: "tok_456" })).status, 200);
    assert.equal(store.kept(shared), "tok_456");
    for (const name of [theirs, "HOME", "KUVO_KEY_", "kuvo_key_lower", "..%2Fopencode.json"]) {
      assert.equal((await route(link, "GET", `kuvo/keys/${name}`)).status, 400, name);
      assert.equal((await route(link, "PUT", `kuvo/keys/${name}`, { value: "x" })).status, 400, name);
    }
    assert.equal(store.kept(theirs), "bots", "a bot's own, untouched");
    assert.equal((await route(link, "PUT", `kuvo/keys/${shared}`, { value: "" })).status, 400);
    assert.equal((await route(link, "POST", "kuvo/keys")).status, 405);
    assert.equal((await route(link, "PUT", `kuvo/keys/${shared}`, { value: "tok_123" })).status, 200);
  });

  test("new keys: its server connects again a moment later, in every folder its engine has open", async () => {
    const { engine, asked } = await standInEngine(() => [], ["/work/app", "/work/site"]);
    // What waits a moment, run when the test says.
    const waiting = [];
    const later = (run, ms) => waiting.push({ run, ms });
    const added = await ask("POST", "kuvo/integrations/todoist", { keys: { API_KEY: "tok_789" } }, engine, later);
    assert.equal(added.status, 200);
    assert.ok(!asked.some(each => each.includes("/connect")), "not before the engine has read them");
    assert.deepEqual(waiting.map(each => each.ms), [2_000]);
    await waiting[0].run();
    for (const where of ["", " in /work/app", " in /work/site"]) assert.ok(asked.includes(`POST /api/experimental/mcp/todoist/connect${where}`), `${where}: ${asked}`);
    // Without new keys, nothing to connect again for.
    waiting.length = 0;
    await ask("POST", "kuvo/integrations/todoist", {}, engine, later);
    assert.equal(waiting.length, 0);
  });

  test("removed with its keys, what its server kept, and its bots' own keys and folder settings", async () => {
    fs.mkdirSync(path.join(store.data, "todoist"), { recursive: true });
    store.keep(theirs, "theirs");
    store.keep("KUVO_KEY_OTHER_API_KEY__BOT_SCOUT", "stays");
    const own = path.join(home, "bots", "bot_scout", "workspace", ".opencode");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "opencode.json"), JSON.stringify({ mcp: { servers: { todoist: { type: "local", environment: { API_KEY: `{file:${store.named}/${theirs}}` } } } } }));
    // Another bot's, written by hand without keys of its own: it stays.
    const handWritten = path.join(home, "bots", "bot_atlas", "workspace", ".opencode");
    fs.mkdirSync(handWritten, { recursive: true });
    fs.writeFileSync(path.join(handWritten, "opencode.json"), JSON.stringify({ mcp: { servers: { todoist: { type: "remote", url: "https://example.com/mcp" } } } }));

    assert.equal((await ask("DELETE", "kuvo/integrations/todoist")).status, 200);
    assert.equal(settings().mcp?.servers?.todoist, undefined);
    assert.equal(store.kept(shared), null);
    assert.equal(fs.existsSync(path.join(store.data, "todoist")), false);
    assert.equal(store.kept(theirs), null);
    assert.equal(store.kept("KUVO_KEY_OTHER_API_KEY__BOT_SCOUT"), "stays");
    assert.equal(fs.existsSync(own), false, "a bot's settings naming only it go, with their folder");
    assert.equal(JSON.parse(fs.readFileSync(path.join(handWritten, "opencode.json"), "utf8")).mcp.servers.todoist.type, "remote");
    assert.equal((await ask("DELETE", "kuvo/integrations/todoist")).status, 404, "nothing of it left");
    const after = (await listed()).find(each => each.id === "todoist");
    assert.deepEqual([after.added, after.keysSaved, after.health], [false, false, undefined]);
  });
}
