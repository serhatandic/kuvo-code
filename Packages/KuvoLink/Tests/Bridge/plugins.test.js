// Settings › Engine's plugins, as each box finds them on npm: the most used ones before you type,
// the ones a word finds, the package you name exactly first, and a name npm doesn't have said
// so. npm is a stand-in, as a box reaches it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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
    const found = text === "keywords:opencode-plugin" ? ["@tarquinen/opencode-dcp", "opencode-wakatime"] : text.startsWith("waka") ? ["opencode-wakatime"] : [];
    return send({ objects: found.map(name => ({ package: { name, version: packages[name]["dist-tags"].latest, description: packages[name].versions[packages[name]["dist-tags"].latest].description }, downloads: { weekly: 500 } })) });
  }
  const named = packages[decodeURIComponent(url.pathname.slice(1))];
  return named ? send(named) : send({ error: "Not found" }, 404);
});
await new Promise(resolve => npm.listen(0, "127.0.0.1", resolve));
process.env.KUVO_TEST_NPM = `http://127.0.0.1:${npm.address().port}`;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
after(() => {
  npm.close();
  fs.rmSync(home, { recursive: true, force: true });
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
  // Not a package's name exactly, but it finds one: nothing's missing to say.
  assert.equal(answer.missing, "waka");
});

test("a package named exactly comes first, a scoped one or one search doesn't find too, with the version asked for", async () => {
  const scoped = await link.searchPlugins("@tarquinen/opencode-dcp");
  assert.equal(scoped.packages[0].name, "@tarquinen/opencode-dcp");
  assert.equal(scoped.packages[0].description, "Prunes old tool output");
  const pinned = await link.searchPlugins("opencode-wakatime@1.3.0");
  assert.equal(pinned.packages[0].version, "1.3.0");
  assert.equal(pinned.missing, undefined);
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
