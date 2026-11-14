// A conversation on Autopilot, on the real engine with a real model: what it asks marking a choice
// goes ahead on it, keeping the call under the step that asked; changed, its agent hears and goes
// that way; what's left unmarked comes back declined, and its turn goes on to the end with nobody
// told and nothing chosen; what an MCP server asks is declined too; and off, even a marked one waits.
// The real box script and a real engine on a free model, in folders of the test's own. Skipped
// unless OPENCODE_TEST_BINARY names the engine.
//
// Run with `OPENCODE_TEST_BINARY=<opencode> node --test box/bridge-tests/autopilot-live.test.js`,
// with `KUVO_TEST_MODEL=<id>` for another of OpenCode's free models than the engine's default. For a
// provider's model with a sign-in of its own, also `KUVO_TEST_PROVIDER=<its id>` and
// `KUVO_TEST_CREDENTIAL=<a file of what POST api/credential takes>`, which only this test's own engine gets.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const binary = process.env.OPENCODE_TEST_BINARY;

test("Autopilot on a real engine: a marked question goes ahead and can be changed; an unmarked one holds nothing and its turn goes on; off, a marked one waits", { skip: !binary && "OPENCODE_TEST_BINARY isn't set" }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-autopilot-live-")));
  removeAtEnd(home);
  for (const folder of ["tmp", "work", "xdg/config", "xdg/data", "xdg/state", "xdg/cache", "bin", "run"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  process.env.KUVO_HOME = home;
  const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
  const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
  const waitFor = async (wanted, what) => {
    const end = Date.now() + 240_000;
    for (;;) {
      const found = await wanted();
      if (found) return found;
      assert.ok(Date.now() < end, `Waited too long for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };

  // An MCP server with a tool that asks you something (an elicitation), and says what it heard.
  const probe = path.join(home, "probe.mjs");
  fs.writeFileSync(probe, `
    import readline from "node:readline";
    const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    let calling;
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const message = JSON.parse(line);
      if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } } });
      if (message.method === "tools/list") return send({ id: message.id, result: { tools: [{ name: "pick_repository", description: "Picks the repository to work on.", inputSchema: { type: "object", properties: {} } }] } });
      if (message.method === "tools/call") {
        calling = message.id;
        return send({ id: "ask", method: "elicitation/create", params: { message: "Which repository?", requestedSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } } });
      }
      if (message.id === "ask") return send({ id: calling, result: { content: [{ type: "text", text: "probe heard: " + (message.result?.action ?? "an error") }] } });
      if (message.id !== undefined && message.method) send({ id: message.id, result: {} });
    });
  `);

  // The engine, as the box starts it, with no accounts: its default model is a free one.
  const workspace = path.join(home, "work");
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: `${home}/tmp/`, XDG_CONFIG_HOME: `${home}/xdg/config`, XDG_DATA_HOME: `${home}/xdg/data`,
    XDG_STATE_HOME: `${home}/xdg/state`, XDG_CACHE_HOME: `${home}/xdg/cache`, OPENCODE_PASSWORD: "pw",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...JSON.parse(link.engineConfigContent(undefined)), mcp: { servers: { probe: { type: "local", command: [process.execPath, probe] } } } }),
  };
  const child = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  atEnd(() => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); }));
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const target = { port, password: "pw" };
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(workspace) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const engineUp = await waitFor(async () => (await api("GET", "api/model/default").catch(() => ({ status: 0 }))).status === 200, "the engine to start");
  assert.ok(engineUp);
  if (process.env.KUVO_TEST_CREDENTIAL) {
    const stored = await api("POST", "api/credential", JSON.parse(fs.readFileSync(process.env.KUVO_TEST_CREDENTIAL, "utf8")));
    assert.ok(stored.status < 300, `The engine didn't take the sign-in (${stored.status})`);
  }
  const model = process.env.KUVO_TEST_MODEL ? { model: { providerID: process.env.KUVO_TEST_PROVIDER ?? "opencode", id: process.env.KUVO_TEST_MODEL } } : {};
  const session = (await api("POST", "api/session", { title: "Menu page", location: { directory: workspace }, ...model })).json.data.id;
  fs.writeFileSync(path.join(home, "run", "engine.json"), JSON.stringify({ port, password: "pw", version: "0.0.0" }));
  fs.copyFileSync(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), path.join(home, "bin", "bot-words.json"));

  // A client's request, as the box answers one: a process of its own.
  const route = (method, pathname, body) => new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home, HOME: home, TMPDIR: `${home}/tmp` }, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    process_.stdout.on("data", chunk => { out += chunk; });
    process_.on("error", reject);
    process_.on("close", () => {
      const said = JSON.parse(out.trim().split("\n").pop());
      resolve({ status: said.status, body: JSON.parse(said.body) });
    });
    process_.stdin.end(JSON.stringify({ method, path: pathname, body }));
  });
  const calls = async () => (await route("GET", `kuvo/sessions/${session}/autopilot`)).body.decided ?? [];
  const page = async () => (await api("GET", `api/session/${session}/message?limit=50`)).json?.data ?? [];
  const forms = async () => (await api("GET", `api/session/${session}/form`)).json?.data ?? [];

  // Its turn on what it's sent over, with what it said: the model's limit fails here, by name.
  const turnAfter = async (id, what) => waitFor(async () => {
    const messages = await page();
    const ended = messages.findIndex(each => each.type === "idle");
    const asked = messages.findIndex(each => each.id === id);
    if (ended < 0 || asked < 0 || ended > asked) return null;
    assert.notEqual(messages[ended].outcome, "failed", `Its turn failed: ${messages[ended].error?.message}`);
    return messages.slice(0, asked);
  }, what);
  const send = (id, text) => api("POST", `api/session/${session}/prompt`, { id, delivery: "steer", text });

  // The box's watch over the engine's events, as it runs: what it tells your phones.
  const told = [];
  const stop = new AbortController();
  atEnd(() => stop.abort());
  link.watchEvents(() => target, notice => { told.push(notice); return true; }, stop.signal, () => {}, { work: "engine" });
  const toldOf = form => waitFor(async () => told.some(each => each.data?.request === form), `your phone to be told of ${form}`);

  // On Autopilot, from a client.
  const on = await route("PUT", `kuvo/sessions/${session}/autopilot`, { autopilot: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.autopilot, true);

  // A question it marks goes ahead at once, with nobody answering: kept as the step's call.
  await send("msg_autopilotlive00001", "Use your question tool now to ask me one question, \"Which roast for the house blend?\", with the choices Light, Warm and Dark. You recommend Warm: it suits the pastries. When you have your answer, reply with only the name of the roast you're going with.");
  const [call] = await waitFor(async () => {
    const made = await calls();
    if (made.length) return made;
    // (The model's limit, by name, rather than a long wait.)
    const failed = (await page()).find(each => each.type === "idle" && each.outcome === "failed");
    assert.equal(failed, undefined, `Its turn failed: ${failed?.error?.message}`);
    return null;
  }, "the question to go ahead");
  assert.equal(call.choice, "Warm");
  assert.match(call.text, /roast/i);
  assert.deepEqual([...call.options].sort(), ["Dark", "Light", "Warm"], "in whatever order the model lists them");
  assert.ok(call.call, "it names the step that asked");
  const said = await turnAfter("msg_autopilotlive00001", "its turn to end");
  assert.ok(JSON.stringify(await page()).includes(call.call), "that step is in the conversation");
  assert.match(JSON.stringify(said), /Warm/, "its agent had its answer");
  assert.deepEqual(told.filter(each => each.data?.request === call.id), [], "nobody is told of what went ahead");
  const says = async form => (await route("POST", `kuvo/sessions/${session}/autopilot/asked`, { form })).body.waiting;
  assert.equal(await says(call.id), false, "its box says it isn't waiting on you");

  // Changed: its agent hears, and goes that way.
  const changed = await route("POST", `kuvo/sessions/${session}/autopilot`, { decided: call.id, choice: "Dark" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.decided[0].yours.choice, "Dark");
  await waitFor(async () => {
    const messages = await page();
    const heard = messages.findIndex(each => JSON.stringify(each).includes("[Decision changed]"));
    const ended = messages.findIndex(each => each.type === "idle");
    return heard >= 0 && ended >= 0 && ended < heard && /Dark/.test(JSON.stringify(messages.slice(0, heard)));
  }, "its agent to go with your choice");

  // Asked with no mark: declined by its box. Its turn goes on to the end, what it asked is told to
  // nobody and no call is kept, and it says what it left.
  const before = told.length;
  await send("msg_autopilotlive00002", "Use your question tool now to ask me one question, \"Which day should it ship?\", with the choices \"Monday\" and \"Friday\", no choice marked. Then, whatever comes back, reply with one short line saying which day you settled on and why.");
  const left = await turnAfter("msg_autopilotlive00002", "its turn to end, with nobody answering");
  const asking = (await page()).flatMap(each => each.content ?? []).filter(block => block.type === "tool" && /question/i.test(block.name ?? ""));
  assert.ok(asking.length >= 2, `it asked with its question tool: ${JSON.stringify(asking.map(each => each.state?.status))}`);
  assert.deepEqual(await forms(), [], "nothing's left asked");
  assert.equal((await calls()).length, 1, "it made no call on it");
  assert.deepEqual(told.slice(before).filter(each => each.data?.request), [], "nobody's told");
  assert.ok(asking.some(each => each.state?.status === "error" && /This is on Autopilot:/.test(JSON.stringify(each.state.error))), `its step shows it was set aside, as both apps read it: ${JSON.stringify(asking.map(each => each.state))}`);
  assert.match(JSON.stringify(left), /monday|friday/i, "it says what it settled on");

  // What an MCP server asks, filed under no session: its box declines it, the tool hears, and nobody's told.
  const beforeServer = told.length;
  await send("msg_autopilotlive00004", "Call your tool probe_pick_repository now, once. Then reply with one short line saying what it returned.");
  await turnAfter("msg_autopilotlive00004", "its turn to end, with the server's form declined");
  // (Its step may be its own, or Code Mode's, which calls the tool for it.)
  const steps = (await page()).flatMap(each => each.content ?? []).filter(block => block.type === "tool");
  assert.match(JSON.stringify(steps), /probe heard: (decline|cancel)/, `the server heard no: ${JSON.stringify(steps.slice(0, 2).concat(steps.filter(each => !/question/.test(each.name ?? ""))).map(each => [each.name, each.state?.status, each.state?.error, JSON.stringify(each.state?.content ?? "").slice(0, 300)]))}`);
  assert.deepEqual((await api("GET", "api/session/global/form")).json?.data ?? [], [], "nothing's left asked");
  assert.deepEqual(told.slice(beforeServer).filter(each => each.data?.request), [], "nobody's told");

  // Off: a marked question waits like any other. (Only its label says so: what Autopilot told it
  // is gone, so this says it itself.)
  assert.equal((await route("PUT", `kuvo/sessions/${session}/autopilot`, { autopilot: false })).body.autopilot, false);
  await send("msg_autopilotlive00003", "Use your question tool now to ask me one question, \"Which cup size?\", with the choices \"Small\" and \"Large (Recommended)\", labelled exactly so. Write nothing else.");
  const [cup] = await waitFor(async () => { const asked = await forms(); return asked.length ? asked : null; }, "the question off Autopilot");
  await toldOf(cup.id);
  assert.equal(await says(cup.id), true, "off Autopilot, its box says so of a marked one too");
  assert.equal((await calls()).length, 1, "it made no call on it");
  assert.equal((await forms()).length, 1);
});

// No model in this one, and so no box: the server asks as soon as the engine connects to it, and this
// is the engine's part of what the box does (for an engine update to catch).
test("a real engine takes the way the box turns down what an MCP server asks, filed under no session: that server hears no", { skip: !binary && "OPENCODE_TEST_BINARY isn't set" }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-autopilot-live-")));
  removeAtEnd(home);
  for (const folder of ["tmp", "work", "xdg/config", "xdg/data", "xdg/state", "xdg/cache"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  const heard = path.join(home, "heard.json");
  const probe = path.join(home, "probe.mjs");
  fs.writeFileSync(probe, `
    import fs from "node:fs";
    import readline from "node:readline";
    const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const message = JSON.parse(line);
      if (message.method === "initialize") return send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1.0.0" } } });
      if (message.method === "tools/list") return send({ id: message.id, result: { tools: [] } });
      if (message.method === "notifications/initialized") return send({ id: "ask", method: "elicitation/create", params: { message: "Which repository?", requestedSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] } } });
      if (message.id === "ask") return fs.writeFileSync(${JSON.stringify(heard)}, JSON.stringify(message));
      if (message.id !== undefined && message.method) send({ id: message.id, result: {} });
    });
  `);
  const workspace = path.join(home, "work");
  const child = spawn(binary, ["serve", "--stdio", "--port", "0"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: `${home}/tmp/`, XDG_CONFIG_HOME: `${home}/xdg/config`, XDG_DATA_HOME: `${home}/xdg/data`,
      XDG_STATE_HOME: `${home}/xdg/state`, XDG_CACHE_HOME: `${home}/xdg/cache`, OPENCODE_PASSWORD: "pw",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { servers: { probe: { type: "local", command: [process.execPath, probe] } } } }),
    },
  });
  atEnd(() => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); }));
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const headers = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "x-opencode-directory": encodeURIComponent(workspace) };
  const get = async route => (await fetch(`http://127.0.0.1:${port}/${route}`, { headers })).json();
  const waitFor = async (wanted, what) => {
    const end = Date.now() + 60_000;
    for (;;) {
      const found = await wanted().catch(() => null);
      if (found) return found;
      assert.ok(Date.now() < end, `Waited too long for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };

  // The engine connects to its servers as a folder's first read of them asks it to.
  const [form] = await waitFor(async () => {
    await get("api/mcp");
    const { data } = await get("api/session/global/form");
    return data?.length ? data : null;
  }, "the server's form");
  assert.equal(form.metadata?.kind, "mcp-elicitation");
  assert.equal(form.sessionID, "global");

  const declined = await fetch(`http://127.0.0.1:${port}/api/session/global/form/${form.id}?message=${encodeURIComponent("Left undone on Autopilot.")}`, { method: "DELETE", headers });
  assert.equal(declined.ok, true, `The engine said ${declined.status}`);

  const said = await waitFor(async () => (fs.existsSync(heard) ? JSON.parse(fs.readFileSync(heard, "utf8")) : null), "the server to hear");
  assert.match(said.result?.action ?? "", /^(decline|cancel)$/, "it hears no, with nothing filled in");
  assert.equal(said.result?.content, undefined);
  assert.deepEqual((await get("api/session/global/form")).data, []);
});
