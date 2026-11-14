// A conversation on Autopilot in the Codex lane, on a real Codex with a real model: the coding agents'
// bridge runs `codex app-server` and the box watches the bridge, as on a box. What Codex asks marking a
// choice goes ahead on it, kept as a call; what it asks with no choice marked comes back declined with
// the words, and its turn goes on to the end with nobody told; what an MCP server asks mid-tool is
// declined, and the server hears no.
//
// The real bridge (swift/KuvoCode/Resources/kuvo-agents.js, on Bun), the real box script and the real `codex`,
// in folders of the test's own. It signs in with a COPY of a Codex sign-in in a CODEX_HOME of its own,
// which is deleted afterwards: the real Codex home is never read but for that one file, and never
// changed. A copy must not refresh: that could rotate the token and sign the original out, so a sign-in
// with under a day left on its access token fails the test rather than risk it.
//
// Skipped unless KUVO_TEST_CODEX_AUTH (the sign-in file to copy) and KUVO_TEST_CODEX_MODEL (the model
// of the Codex lane to use, such as gpt-6-luna) are set, Bun and Codex are there, and the lane lists
// that model. Run with
// `KUVO_TEST_CODEX_AUTH=~/.codex/auth.json KUVO_TEST_CODEX_MODEL=<id> node --test box/bridge-tests/autopilot-codex-live.test.js`.
import { allowRealAgents, REAL_PATH } from "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";

const authFile = process.env.KUVO_TEST_CODEX_AUTH;
const modelID = process.env.KUVO_TEST_CODEX_MODEL;
const bun = testBun();
// (The agents' programs aren't on a test's PATH: REAL_PATH has them.)
const codex = process.env.KUVO_TEST_CODEX || spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf8", env: { ...process.env, PATH: REAL_PATH } }).stdout.trim();
const agentsJS = fileURLToPath(new URL("../../swift/KuvoCode/Resources/kuvo-agents.js", import.meta.url));
const skip = !authFile ? "KUVO_TEST_CODEX_AUTH isn't set" : !modelID ? "KUVO_TEST_CODEX_MODEL isn't set" : !bun ? NO_BUN : !codex ? "Codex isn't installed" : false;

/** How long the sign-in's access token has left, and how long ago Codex refreshed it, in milliseconds. */
function ageOf(file) {
  const auth = JSON.parse(fs.readFileSync(file, "utf8"));
  const token = auth.tokens?.access_token;
  assert.equal(typeof token, "string", "that isn't a ChatGPT sign-in of Codex's (no access token in it)");
  const { exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  assert.equal(typeof exp, "number", "the access token doesn't say when it expires");
  return { left: exp * 1000 - Date.now(), refreshed: Date.now() - Date.parse(auth.last_refresh) };
}

test("Autopilot in the Codex lane on a real Codex", { skip, timeout: 900_000 }, async t => {
  // The sign-in you named (your own Codex's, maybe) is read to copy it, and your Codex runs: as you asked.
  allowRealAgents();
  // A copy must never refresh, which would rotate the token and sign the original out: Codex does so
  // when the access token is near its end, and by itself once it was last refreshed some 8 days ago.
  const { left, refreshed } = ageOf(authFile);
  assert.ok(left > 24 * 3600_000, "That Codex sign-in has under a day left: a copy of it could refresh, and signing the original out. Use a fresher one.");
  assert.ok(refreshed < 6 * 24 * 3600_000, "That Codex sign-in was last refreshed 6 or more days ago (or doesn't say): Codex refreshes one by itself at about 8, and a copy of it would sign the original out. Use a fresher one.");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-autopilot-codex-")));
  removeAtEnd(home);
  const codexHome = path.join(home, "codex-home");
  for (const folder of ["tmp", "work", "agents", "run", "bin", "codex-home"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  process.env.KUVO_HOME = home;
  const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
  const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
  // (`describe` says where it stood, for a wait that ran out.)
  let describe = async () => "";
  const waitFor = async (wanted, what) => {
    const end = Date.now() + 240_000;
    for (;;) {
      const found = await wanted();
      if (found) return found;
      assert.ok(Date.now() < end, `Waited too long for ${what}: ${await describe().catch(error => String(error))}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };

  // The sign-in, copied.
  fs.writeFileSync(path.join(codexHome, "auth.json"), fs.readFileSync(authFile), { mode: 0o600 });

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
  // (Codex told to keep its sign-in in a file, not the Keychain, which would ask.)
  fs.writeFileSync(path.join(codexHome, "config.toml"), `cli_auth_credentials_store = "file"\n\n[mcp_servers.probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(probe)}]\n`);

  // The agents' bridge, as the app starts it, with everything of its own in the test's folders.
  const workspace = path.join(home, "work");
  const only = path.join(home, "codex-bin");
  fs.mkdirSync(only);
  fs.symlinkSync(codex, path.join(only, "codex"));
  const child = spawn(bun, [agentsJS], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    // (Only Codex on its PATH: not the other agents installed beside it, nor Claude Code's sign-in.)
    env: { PATH: `${only}:${process.env.PATH}`, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "claude"), TMPDIR: `${home}/tmp`, KUVO_AGENTS_HOME: path.join(home, "agents"), OPENCODE_PASSWORD: "pw", CODEX_HOME: codexHome, BUN_BE_BUN: "1" },
  });
  atEnd(() => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); }));
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The agents' bridge ended (${code}): ${said}`)));
  });
  const target = { port, password: "pw" };
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(workspace) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const listed = ((await api("GET", "api/model")).json?.data ?? []).some(each => each.providerID === "codex-cli" && each.id === modelID);
  if (!listed) return t.skip(`Codex doesn't list ${modelID} for this sign-in`);
  fs.writeFileSync(path.join(home, "run", "bridge.json"), JSON.stringify({ port, password: "pw", pid: child.pid }));
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
  const sessions = [];
  const make = async title => {
    const made = await api("POST", "api/session", { title, location: { directory: workspace }, model: { providerID: "codex-cli", id: modelID } });
    assert.equal(made.status, 200, `The bridge didn't make the session: ${JSON.stringify(made.json)}`);
    sessions.push(made.json.data.id);
    return made.json.data.id;
  };
  const calls = async session => (await route("GET", `kuvo/sessions/${session}/autopilot`)).body.decided ?? [];
  const page = async session => (await api("GET", `api/session/${session}/message?limit=100`)).json?.data ?? [];
  const forms = async session => (await api("GET", `api/session/${session}/form`)).json?.data ?? [];
  const busy = async session => Object.keys((await api("GET", "api/session/active")).json?.data ?? {}).includes(session);
  const send = async (session, id, text) => {
    const sent = await api("POST", `api/session/${session}/prompt`, { id, delivery: "steer", text });
    assert.equal(sent.status, 200, `The bridge didn't take the message: ${JSON.stringify(sent.json)}`);
  };
  const assistants = messages => messages.filter(each => each.type === "assistant");
  const textOf = message => (message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
  const failure = messages => messages.find(each => each.type === "idle" && each.outcome === "failed");

  // The box's watch over the bridge's events, as it runs: what it tells your phones.
  const told = [];
  const stop = new AbortController();
  atEnd(() => stop.abort());
  link.watchEvents(() => target, notice => { told.push(notice); return true; }, stop.signal, () => {}, { work: "bridge" });

  // The bridge's own events, to see a question reach the box and be settled there: kept as they come.
  const events = [];
  const listen = new AbortController();
  atEnd(() => listen.abort());
  fetch(`http://127.0.0.1:${port}/api/event`, { headers: { authorization: auth.authorization, accept: "text/event-stream" }, signal: listen.signal }).then(async response => {
    let rest = "";
    for await (const chunk of response.body) {
      rest += Buffer.from(chunk).toString();
      for (let end = rest.indexOf("\n\n"); end >= 0; end = rest.indexOf("\n\n")) {
        for (const line of rest.slice(0, end).split("\n")) if (line.startsWith("data:")) try { events.push(JSON.parse(line.slice(5))); } catch {}
        rest = rest.slice(end + 2);
      }
    }
  }).catch(() => {});
  await waitFor(async () => events.length > 0, "the event feed to open");
  /** The question `session` asked of its box, and how it was settled there (`replied` or `cancelled`, by its box). */
  const questionOf = (session, kind) => {
    const asked = events.find(each => each.type === "form.created" && each.data?.form?.sessionID === session && (kind ? each.data.form.metadata?.kind === kind : true));
    const settled = asked && events.find(each => ["form.replied", "form.cancelled"].includes(each.type) && each.data?.id === asked.data.form.id);
    return { asked: asked?.data.form, settled: settled?.type.slice("form.".length) };
  };

  // This bridge has no engine to read the app's rules from, so it asks before running any tool, which
  // a conversation's approval answers in the app. Here nothing is let run but what `allow` names (the
  // probe's tool): the rest is refused, so no question in this file waits on one.
  const settlePermissions = async (session, allow = /^$/) => {
    for (const each of (await api("GET", `api/session/${session}/permission`)).json?.data ?? []) {
      await api("POST", `api/session/${session}/permission/${each.id}/reply`, { decision: allow.test(each.action) ? "once" : "reject" });
    }
  };

  // Its turns done: nothing at work, nothing asked, and the newest entry the end of a turn, with
  // some assistant message there that `wanted` likes. A turn that failed (the model's limit, say)
  // fails here, by name.
  const turnsDone = (session, what, wanted = () => true, allow) => waitFor(async () => {
    await settlePermissions(session, allow);
    const messages = await page(session);
    assert.equal(failure(messages), undefined, `Its turn failed: ${JSON.stringify(failure(messages))}`);
    if (messages[0]?.type !== "idle" || await busy(session) || (await forms(session)).length) return null;
    return assistants(messages).length && wanted(messages) ? messages : null;
  }, what);

  describe = async () => {
    const lines = [];
    for (const session of sessions) {
      const messages = await page(session);
      lines.push(`${session}: busy ${await busy(session)}, forms ${JSON.stringify((await forms(session)).map(each => [each.metadata?.kind, each.fields?.map(field => field.description)]))}, calls ${(await calls(session)).length}`);
      lines.push(`  (its box was asked ${events.filter(each => each.type === "form.created" && each.data?.form?.sessionID === session).length} time(s), and told ${told.filter(each => each.thread === session).length})`);
      for (const message of [...messages].reverse()) lines.push(`  ${message.type} ${message.outcome ?? ""} ${(message.content ?? []).map(block => `${block.type}:${block.name ?? ""}:${block.state?.status ?? ""}:${JSON.stringify(block.text ?? block.state?.input ?? "").slice(0, 120)}`).join(" | ")}`);
    }
    return lines.join("\n");
  };

  // A conversation on Autopilot, turned on from a client.
  const onAutopilot = async title => {
    const session = await make(title);
    const on = await route("PUT", `kuvo/sessions/${session}/autopilot`, { autopilot: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.autopilot, true);
    return session;
  };

  // A question it marks goes ahead at once, with nobody answering: kept as a call it made, and Codex
  // goes on with the choice.
  await t.test("a marked question goes ahead on its choice, and the turn goes on to the end", async () => {
    const session = await onAutopilot("Roast");
    await send(session, "msg_autopilotcodex0001", "Use your question tool now to ask me one question, \"Which roast for the house blend?\", with the choices Light, Warm and Dark. You recommend Warm: it suits the pastries. When you have my answer, reply with only the name of the roast you're going with.");
    // (Its turn ending with nothing asked of its box, and staying so, is the question lost: said at once rather than after the wait.)
    let lost = 0;
    const [call] = await waitFor(async () => {
      await settlePermissions(session);
      const made = await calls(session);
      if (made.length) return made;
      const messages = await page(session);
      assert.equal(failure(messages), undefined, `Its turn failed: ${JSON.stringify(failure(messages))}`);
      lost = messages[0]?.type === "idle" && !await busy(session) && !(await forms(session)).length ? lost + 1 : 0;
      assert.ok(lost < 15, `Its turn ended and the question never reached its box, which has nothing to go ahead on: ${await describe()}`);
      return null;
    }, "the question to go ahead");
    assert.match(call.choice, /^Warm/);
    assert.match(call.text, /roast/i);
    for (const option of ["Light", "Warm", "Dark"]) assert.ok(call.options.some(each => each.startsWith(option)), `${option} is among its choices: ${JSON.stringify(call.options)}`);
    // (What came after the message that asked: the answer may be in already.)
    const wentOn = messages => {
      const mine = assistants(messages);
      const asking = mine.findIndex(each => /house blend/i.test(textOf(each)));
      return asking < 0 ? [] : mine.slice(0, asking);
    };
    const messages = await turnsDone(session, "its turn to go on with the choice and end", all => wentOn(all).some(each => /warm/i.test(textOf(each))));
    // It reached the model, and went on after the choice (the reply is newer than the message that asked).
    const reply = wentOn(messages).find(each => textOf(each));
    assert.equal(reply.model?.providerID, "codex-cli");
    assert.equal(reply.model?.id, modelID);
    assert.ok(reply.tokens?.output > 0, `the model answered: ${JSON.stringify(reply.tokens)}`);
    assert.equal(questionOf(session).asked?.id, call.id, "the question reached its box");
    assert.equal(questionOf(session).settled, "replied", "and it was answered there, not by anyone else");
    assert.deepEqual(told.filter(each => each.data?.request === call.id), [], "nobody is told of what went ahead");
    assert.equal((await route("POST", `kuvo/sessions/${session}/autopilot/asked`, { form: call.id })).body.waiting, false, "its box says it isn't waiting on you");
  });

  // Asked with no mark: declined by its box, and Codex hears the words. Its turn goes on to the end,
  // nobody is told and no call is kept.
  await t.test("an unmarked question comes back declined with the words, and the turn goes on to the end", async () => {
    const session = await onAutopilot("Day");
    const before = told.length;
    await send(session, "msg_autopilotcodex0002", "Ask me one question now with your user-input question tool (request_user_input_async), \"Which day should it ship?\", with the choices \"Monday\" and \"Friday\". Mark no choice as recommended, even though you were told to elsewhere: this checks a question with none marked. Then, whatever comes back, reply with one short line saying which day you settled on and why.");
    // (What came after the message that asked: its turn went on, with nothing put to anyone.)
    const wentOn = messages => {
      const mine = assistants(messages);
      // (Newest first, so the oldest that names both choices: the model words the question its own way.)
      const asking = mine.findLastIndex(each => /monday/i.test(textOf(each)) && /friday/i.test(textOf(each)));
      return asking < 0 ? [] : mine.slice(0, asking);
    };
    const messages = await turnsDone(session, "its turn to go on after the question and end, with nobody answering", all => wentOn(all).some(each => /monday|friday/i.test(textOf(each))));
    assert.ok(wentOn(messages).some(each => each.tokens?.output > 0), "the model answered after the question was set aside");
    // The question reached its box and was turned down there (a question that never got that far, the
    // drop the first test shows, leaves everything else here looking right).
    const question = questionOf(session);
    assert.ok(question.asked, `the question reached its box: ${await describe()}`);
    assert.match(JSON.stringify(question.asked.fields), /monday/i, "and it was the one this test asked");
    assert.equal(question.settled, "cancelled", `and it was declined there (it asked with the choices ${JSON.stringify(question.asked.fields?.map(field => field.options?.map(option => option.label)))}: one marked means the model marked it anyway)`);
    assert.deepEqual(await forms(session), [], "nothing's left asked");
    assert.deepEqual(await calls(session), [], `it made no call on it (the model marked a choice anyway? ${JSON.stringify(question.asked?.fields?.map(field => field.options?.map(option => option.label)))})`);
    assert.deepEqual(told.slice(before).filter(each => each.data?.request), [], "nobody's told");
  });

  // A model that sleeps for an hour on its question, as Codex tells it it may: the question goes ahead,
  // and the sleep doesn't hold the turn, whichever comes first.
  await t.test("a model asleep for an hour on its question doesn't hold its turn", async () => {
    const session = await onAutopilot("Grind");
    const started = Date.now();
    await send(session, "msg_autopilotcodex0004", "Ask me one question now with your user-input question tool (request_user_input_async), \"Which grind for the house blend?\", with the choices Fine (Recommended) and Coarse. Straight after asking, wait for my answer with clock.sleep for 3600 seconds. When my answer comes, reply with only the name of the grind and how many seconds you slept.");
    const wentOn = messages => {
      const mine = assistants(messages);
      const asking = mine.findIndex(each => /house blend/i.test(textOf(each)));
      return asking < 0 ? [] : mine.slice(0, asking);
    };
    const messages = await turnsDone(session, "its turn to go on with the choice and end, not after an hour", all => wentOn(all).some(each => /fine/i.test(textOf(each))));
    assert.ok(Date.now() - started < 240_000, "it didn't sleep the hour");
    assert.equal(questionOf(session).settled, "replied", "the question reached its box and went ahead there");
    const slept = assistants(messages).flatMap(each => each.content ?? []).filter(block => block.type === "tool" && block.name === "sleep");
    console.log(`The model slept ${slept.length} time(s) on its question.`);
    assert.ok(slept.every(each => each.state?.status === "completed"), "no sleep is left going");
  });

  // Not on Autopilot: whatever the model does while it waits, the question stays up for you, nothing
  // answers it for you, and your answer reaches the model.
  await t.test("in an Interactive conversation the question waits for you, and your answer reaches the model", async () => {
    const session = await make("Cup");
    await send(session, "msg_autopilotcodex0005", "Use your question tool now to ask me one question, \"Which cup size for the takeaway?\", with the choices Small and Large. When you have my answer, reply with only the size I chose.");
    const [form] = await waitFor(async () => {
      await settlePermissions(session);
      const open = await forms(session);
      return open.length ? open : null;
    }, "its question to show");
    // (The model words the question its own way, so only what it's about is asked of it here.)
    assert.match(JSON.stringify(form.fields), /cup/i);
    // (A while for the model to go on from it, as it does: reasoning, a step or a sleep.)
    await new Promise(resolve => setTimeout(resolve, 15_000));
    assert.deepEqual((await forms(session)).map(each => each.id), [form.id], "it's still up, with nobody having answered it");
    const key = form.fields[0].key;
    assert.equal((await api("POST", `api/session/${session}/form/${form.id}/reply`, { answer: { [key]: "Large" } })).status, 200);
    const messages = await turnsDone(session, "its turn to go on with your answer and end", all => assistants(all).flatMap(each => each.content ?? []).some(block => block.type === "text" && /large/i.test(block.text) && !/small|\?/i.test(block.text)));
    assert.equal(failure(messages), undefined);
    assert.deepEqual(await calls(session), [], "it's no call Autopilot made");
  });

  // What an MCP server asks mid-tool: its box declines it and the server hears no.
  await t.test("what an MCP server asks is declined, and the server hears no", async () => {
    const session = await onAutopilot("Probe");
    const before = told.length;
    await send(session, "msg_autopilotcodex0003", "Call the pick_repository tool of your probe MCP server now, once. Then reply with one short line saying exactly what it returned.");
    const messages = await turnsDone(session, "its turn to end, with the server's form declined", undefined, /probe/);
    const steps = assistants(messages).flatMap(each => each.content ?? []).filter(block => block.type === "tool");
    assert.match(JSON.stringify(steps), /probe heard: decline/, `the server heard no: ${JSON.stringify(steps.map(each => [each.name, each.state?.status, JSON.stringify(each.state?.content ?? each.state?.error ?? "").slice(0, 300)]))}`);
    const question = questionOf(session, "mcp-elicitation");
    assert.ok(question.asked, "the server's question reached its box");
    assert.equal(question.settled, "cancelled", "and it was declined there, not by the bridge's own fallback");
    assert.deepEqual(await forms(session), [], "nothing's left asked");
    assert.deepEqual(told.slice(before).filter(each => each.data?.request && each.category !== "permission"), [], "nobody's told of the server's question (only of the tool's permission, which the conversation's approval answers)");
  });
});
