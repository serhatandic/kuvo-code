// A new box's first message works, on the real engine: started as the box starts it (`engine-config`,
// the settings layer for providers' quirks on top), with no account of any kind, its default model is
// one that can answer, and a conversation that leaves the model to the engine gets a reply. (Naming
// GitHub Copilot in that layer with no Copilot account made Copilot's newest model the engine's
// default, and every first message failed: "missing required Authorization header".) The real box
// code and a real engine on a free model, in folders of the test's own; skipped unless
// OPENCODE_TEST_BINARY names the engine.
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

test("a new box's engine, started with the box's settings layer and no accounts, answers a first message on its default model", { skip: !binary && "OPENCODE_TEST_BINARY isn't set", timeout: 300_000 }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-compatibility-live-")));
  removeAtEnd(root);
  for (const folder of ["home", "tmp", "work", "box/run", "xdg/config", "xdg/data", "xdg/state", "xdg/cache"]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  process.env.KUVO_HOME = `${root}/box`;
  const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

  const env = {
    PATH: process.env.PATH, HOME: `${root}/home`, TMPDIR: `${root}/tmp/`, XDG_CONFIG_HOME: `${root}/xdg/config`, XDG_DATA_HOME: `${root}/xdg/data`,
    XDG_STATE_HOME: `${root}/xdg/state`, XDG_CACHE_HOME: `${root}/xdg/cache`, OPENCODE_PASSWORD: "pw",
    OPENCODE_CONFIG_CONTENT: link.engineConfigContent(undefined),
  };
  const engine = spawn(binary, ["serve", "--stdio", "--port", "0"], { env, cwd: `${root}/work`, stdio: ["pipe", "pipe", "pipe"] });
  atEnd(() => { engine.stdin.end(); engine.kill(); });
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    engine.stdout.on("data", look);
    engine.stderr.on("data", look);
    engine.on("exit", code => reject(new Error(`The engine ended (${code}): ${said}`)));
  });
  const target = { port, password: "pw", pid: engine.pid };
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(`${root}/work`) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const waitFor = async (wanted, what) => {
    const end = Date.now() + 240_000;
    for (;;) {
      const found = await wanted();
      if (found) return found;
      assert.ok(Date.now() < end, `Waited too long for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  };

  // The engine answers 503 while it boots.
  const chosen = await waitFor(async () => { const answer = await api("GET", "api/model/default"); return answer.status === 200 && answer.json; }, "the engine to start");
  assert.equal(chosen.data?.providerID, "opencode", `The engine's default is ${chosen.data?.providerID}/${chosen.data?.id}, which has no account here`);

  const session = (await api("POST", "api/session", { location: { directory: `${root}/work` } })).json.data;
  await api("POST", `api/session/${session.id}/prompt`, { id: "msg_compatibilitylive0001", text: "Say hi in three words.", delivery: "steer" });
  const messages = await waitFor(async () => {
    const page = (await api("GET", `api/session/${session.id}/message?limit=20`)).json?.data ?? [];
    return page.some(message => message.type === "idle") && page;
  }, "the first reply");
  const failed = messages.find(message => message.type === "assistant" && message.error);
  assert.equal(failed, undefined, `The first message failed on ${failed?.model?.providerID}/${failed?.model?.id}: ${failed?.error?.message} (${failed?.error?.response?.body ?? ""})`);
  assert.equal(messages.find(message => message.type === "idle").outcome, "succeeded");

  // The box learns from its engine as it finds it: with no Copilot account, nothing of Copilot's for
  // its next start either.
  await link.learnCompatibility(target);
  assert.equal(JSON.parse(link.engineConfigContent(undefined)).providers?.["github-copilot"], undefined);
});
