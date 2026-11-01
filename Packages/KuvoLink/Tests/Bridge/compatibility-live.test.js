// A box's first message works, on the real engine: started as the box starts it (`engine-config`, the
// settings layer for providers' quirks on top), with no account of any kind, its default model is one
// that can answer, and a conversation that leaves the model to the engine gets a reply. (Naming
// GitHub Copilot in that layer with no Copilot account made Copilot's newest model the engine's
// default, and every first message failed: "missing required Authorization header".) A box an older
// Kuvo Code left that layer on unlearns it from its engine, for its next start. The real box code and
// a real engine on a free model, in folders of the test's own; skipped unless OPENCODE_TEST_BINARY
// names the engine.
//
// Run with `OPENCODE_TEST_BINARY=<opencode> node --test Packages/KuvoLink/Tests/Bridge/compatibility-live.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const binary = process.env.OPENCODE_TEST_BINARY;

test("with no accounts, a box's engine answers a first message on its default model, and one an older Kuvo Code left Copilot's settings on does from its next start", { skip: !binary && "OPENCODE_TEST_BINARY isn't set", timeout: 600_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-compatibility-live-")));
  removeAtEnd(root);
  for (const folder of ["home", "tmp", "work", "box/run", "xdg/config", "xdg/data", "xdg/state", "xdg/cache"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  process.env.KUVO_HOME = `${root}/box`;
  const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
  const work = `${root}/work`;

  const waitFor = async (wanted, what) => {
    const end = Date.now() + 240_000;
    for (;;) {
      const found = await wanted().catch(() => null);
      if (found) return found;
      assert.ok(Date.now() < end, `Waited too long for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };
  // The engine, started as the box starts it: with what `engine-config` gives it now.
  const startEngine = async () => {
    const env = {
      PATH: process.env.PATH, HOME: `${root}/home`, TMPDIR: `${root}/tmp/`, XDG_CONFIG_HOME: `${root}/xdg/config`, XDG_DATA_HOME: `${root}/xdg/data`,
      XDG_STATE_HOME: `${root}/xdg/state`, XDG_CACHE_HOME: `${root}/xdg/cache`, OPENCODE_PASSWORD: "pw",
      OPENCODE_CONFIG_CONTENT: link.engineConfigContent(undefined),
    };
    const child = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
    const stop = () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); });
    atEnd(stop);
    const port = await new Promise((resolve, reject) => {
      let said = "";
      const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
      child.stdout.on("data", look);
      child.stderr.on("data", look);
      child.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
    });
    const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(work) };
    const api = async (method, route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : null };
    };
    // It answers 503 while it boots.
    const chosen = await waitFor(async () => { const answer = await api("GET", "api/model/default"); return answer.status === 200 && answer.json.data; }, "the engine to start");
    return { target: { port, password: "pw", pid: child.pid }, api, chosen, stop };
  };

  // A box an older Kuvo Code left Copilot's Claude models on, learned from what that layer itself
  // put in the engine's list: its engine's default is Copilot's, with no account to run it.
  const setting = { compatibility: { supportsThinkingBlockBinding: false } };
  fs.writeFileSync(`${root}/box/run/compatibility.json`, JSON.stringify({ providers: { "github-copilot": { models: { "claude-opus-5.5": setting, "claude-sonnet-5.5": setting } } } }));
  const before = await startEngine();
  assert.equal(before.chosen.providerID, "github-copilot", "The engine no longer makes Copilot its default when its settings name it: the layer may not need its account check");
  // The box learns from it (it may not say what accounts it has for a moment after it starts).
  await waitFor(async () => { await link.learnCompatibility(before.target); return true; }, "the box to learn from its engine");
  assert.equal(JSON.parse(link.engineConfigContent(undefined)).providers?.["github-copilot"], undefined);
  await before.stop();

  // Its next start, as a new box's first: the default is one that answers.
  const after = await startEngine();
  assert.equal(after.chosen.providerID, "opencode", `The engine's default is ${after.chosen.providerID}/${after.chosen.id}, which has no account here`);
  const session = (await after.api("POST", "api/session", { location: { directory: work } })).json.data;
  await after.api("POST", `api/session/${session.id}/prompt`, { id: "msg_compatibilitylive0001", text: "Say hi in three words.", delivery: "steer" });
  const messages = await waitFor(async () => {
    const page = (await after.api("GET", `api/session/${session.id}/message?limit=20`)).json?.data ?? [];
    return page.some(message => message.type === "idle") && page;
  }, "the first reply");
  const failed = messages.find(message => message.type === "assistant" && message.error);
  assert.equal(failed, undefined, `The first message failed on ${failed?.model?.providerID}/${failed?.model?.id}: ${failed?.error?.message} (${failed?.error?.response?.body ?? ""})`);
  assert.equal(messages.find(message => message.type === "idle").outcome, "succeeded");
});
