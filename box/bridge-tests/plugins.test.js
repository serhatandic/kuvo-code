// Settings › Engine's plugins, as each box finds them on npm: the most used ones before you type,
// the ones a word finds, the package you name exactly first, and a name npm doesn't have said
// so. npm is a stand-in, as a box reaches it.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-plugins-")));
process.env.KUVO_HOME = path.join(home, ".kuvo-code");

// npm: its search and its packages.
const searched = [];
const packages = {
  "opencode-wakatime": { name: "opencode-wakatime", "dist-tags": { latest: "1.4.0" }, versions: { "1.3.0": {}, "1.4.0": { description: "WakaTime for OpenCode" } } },
  "@tarquinen/opencode-dcp": { name: "@tarquinen/opencode-dcp", "dist-tags": { latest: "3.2.0" }, versions: { "3.2.0": { description: "Prunes old tool output" } } },
};
let down = false;
const npm = http.createServer((request, response) => {
  const url = new URL(request.url, "http://x");
  const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (down) return send({}, 503);
  if (url.pathname === "/-/v1/search") {
    const text = url.searchParams.get("text");
    searched.push(text);
    const found = text === "keywords:opencode-plugin" ? ["@tarquinen/opencode-dcp", "opencode-wakatime"] : text.startsWith("waka") ? ["opencode-wakatime"] : text.includes("dcp") ? ["@tarquinen/opencode-dcp"] : [];
    return send({ objects: found.map(name => ({ package: { name, version: packages[name]["dist-tags"].latest, description: packages[name].versions[packages[name]["dist-tags"].latest].description }, downloads: { weekly: 500 } })) });
  }
  // Only its versions and tags, as npm installs from it: never a package's whole history.
  if (request.headers.accept !== "application/vnd.npm.install-v1+json") return send({ error: "Asked for the whole record" }, 406);
  const named = packages[decodeURIComponent(url.pathname.slice(1))];
  return named ? send(named) : send({ error: "Not found" }, 404);
});
await new Promise(resolve => npm.listen(0, "127.0.0.1", resolve));
process.env.KUVO_TEST_NPM = `http://127.0.0.1:${npm.address().port}`;
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
removeAtEnd(home);
atEnd(() => {
  npm.close();
});

test("before you type, the most used plugins", async () => {
  const answer = await link.searchPlugins("");
  assert.deepEqual(answer.packages.map(each => each.name), ["@tarquinen/opencode-dcp", "opencode-wakatime"]);
  assert.equal(answer.missing, undefined);
});

test("a word finds opencode's packages with it", async () => {
  const answer = await link.searchPlugins("waka");
  assert.equal(searched.at(-1), "waka keywords:opencode");
  assert.deepEqual(answer.packages, [{ name: "opencode-wakatime", version: "1.4.0", description: "WakaTime for OpenCode", weekly: 500 }]);
  // A name npm doesn't have, said for Return to add it, while the search finds the one meant.
  assert.equal(answer.missing, "waka");
});

test("a package named exactly comes first, a scoped one or one search doesn't find too, with the version asked for", async () => {
  const scoped = await link.searchPlugins("@tarquinen/opencode-dcp");
  assert.equal(scoped.packages[0].name, "@tarquinen/opencode-dcp");
  assert.equal(scoped.packages[0].description, "Prunes old tool output");
  const pinned = await link.searchPlugins("opencode-wakatime@1.3.0");
  assert.equal(pinned.packages[0].version, "1.3.0");
  assert.equal(pinned.missing, undefined);
  // A range or a tag it has isn't missing.
  assert.equal((await link.searchPlugins("opencode-wakatime@^1.0.0")).missing, undefined);
  assert.equal((await link.searchPlugins("opencode-wakatime@latest")).packages[0].version, "1.4.0");
});

test("a name or a version npm doesn't have is said to be missing", async () => {
  assert.equal((await link.searchPlugins("opencode-wakatme")).missing, "opencode-wakatme");
  assert.equal((await link.searchPlugins("opencode-wakatime@9.9.9")).missing, "opencode-wakatime@9.9.9");
});

test("npm not answering is an error to show, not a missing package", async () => {
  down = true;
  await assert.rejects(link.searchPlugins("opencode-wakatime"));
  down = false;
});

// A provider of your own: a local server that lists its models, one that wants its key first,
// and one that answers with something else.
test("a provider of your own's models, as its service lists them to this box", async () => {
  const seen = [];
  const service = http.createServer((request, response) => {
    seen.push(request.headers);
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.url === "/v1/models") return send({ object: "list", data: [{ id: "qwen3:8b" }, { id: "llama3.2" }, { id: "qwen3:8b" }] });
    if (request.url.startsWith("/keyed/models")) return send({ error: "no key" }, 401);
    if (request.url === "/ollama/models") return send({ models: [{ name: "gemma3" }] });
    if (request.url === "/gateway/models?team=a") return send({ data: [{ id: "gpt-x" }] });
    if (request.url === "/moved/models") { response.writeHead(302, { location: "https://elsewhere.example/models" }); return response.end(); }
    if (request.url === "/anthropic/models?limit=1000") return send({ data: [{ id: "claude-a" }], has_more: false });
    send("<html>", 200);
  });
  await new Promise(resolve => service.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${service.address().port}`;
  try {
    assert.deepEqual((await link.providerModels({ url: `${at}/v1/`, headers: { "X-Team": "a", Authorization: "Bearer {env:KEY}" } })).value, { reached: true, models: ["llama3.2", "qwen3:8b"] });
    // Headers written out go along; one naming an environment variable doesn't.
    assert.equal(seen.at(-1)["x-team"], "a");
    assert.equal(seen.at(-1).authorization, undefined);
    assert.deepEqual((await link.providerModels({ url: `${at}/keyed`, api: "anthropic" })).value, { reached: true, needsKey: true });
    assert.equal(seen.at(-1)["anthropic-version"], "2023-06-01");
    assert.deepEqual((await link.providerModels({ url: `${at}/ollama` })).value.models, ["gemma3"]);
    // Its query kept after the path; an Anthropic list asked for whole.
    assert.deepEqual((await link.providerModels({ url: `${at}/gateway?team=a` })).value.models, ["gpt-x"]);
    assert.deepEqual((await link.providerModels({ url: `${at}/anthropic`, api: "anthropic" })).value.models, ["claude-a"]);
    // Sent somewhere else: not followed, so its headers never go there.
    const moved = (await link.providerModels({ url: `${at}/moved`, headers: { "X-Team": "a" } })).value;
    assert.equal(moved.reached, false);
    assert.match(moved.message, /elsewhere\.example/);
    const other = (await link.providerModels({ url: `${at}/page` })).value;
    assert.equal(other.reached, false);
    assert.match(other.message, /\/v1/);
  } finally {
    service.close();
  }
  // Nothing there.
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  assert.deepEqual((await link.providerModels({ url: `http://127.0.0.1:${port}/v1` })).value, { reached: false, message: "Nothing answers at this address." });
  assert.equal((await link.providerModels({ url: "ftp://x" })).status, 400);
});

test("this Mac's real box asks npm itself, whatever its environment names instead (only a test's own box takes a stand-in)", async () => {
  const { spawn } = await import("node:child_process");
  const app = path.join(home, "run.kuvo.code");
  fs.mkdirSync(path.join(app, "box"), { recursive: true });
  const before = searched.length;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const link = await import(${JSON.stringify(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url).href)});
    await link.searchPlugins("waka").catch(() => {});
    process.exit(0);
  `], { env: { ...process.env, KUVO_HOME: path.join(app, "box"), KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: path.join(app, "config") }, stdio: "ignore" });
  await new Promise(resolve => child.once("exit", resolve));
  assert.equal(searched.length, before, "the stand-in was asked");
});
