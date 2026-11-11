// What a bot's keys of its own do on a box, whichever way it keeps them: run by bot-keys.test.js
// (a machine's files) and bot-keys-host.test.js (this Mac's app, through its host interface). Also
// the stand-in for that app, and this Mac's box started as the app starts it.
import { ownPath } from "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atEnd } from "./at-end.js";

export const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
/** Where a box (its folder `KUVO_HOME`) keeps its conversations' SSH agents (vault/ssh.ts): on a Mac
 * with a home too long for a socket's path, outside it, so a test clears it itself (a box it stops
 * with SIGTERM can't); in a home short enough for the socket, as the box keeps them there. The same
 * choice `SSH_AGENTS` makes in Packages/Box/src/link/home.ts: this Mac's box (`macBox`, KUVO_BOX=mac),
 * or over 68 bytes to the agents' folder. (GitHub's macOS runners' home is `/Users/runner`: 63-64
 * bytes there, so the box keeps its agents in the home; looking in `/private/tmp` on every Mac waited
 * 60 s for an agent never there, #410.) */
export const sshAgentsOf = (home, macBox = false) => {
  const agents = path.join(home, "run", "ssh-agents");
  if (process.platform !== "darwin" || (!macBox && Buffer.byteLength(agents) <= 68)) return agents;
  return ownPath(path.join("/private/tmp", `kuvo-ssh-${process.getuid()}`, `agents-${crypto.createHash("sha256").update(home).digest("hex").slice(0, 8)}`));
};
export const own = "KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT";

const catalog = (version = "1.0.0") => ({ integrations: [
  { id: "todoist", title: "Todoist", summary: "Tasks", kind: "Code and Work", symbol: "checklist", site: "https://todoist.com", how: "Open source · your key", way: "package",
    keys: [{ name: "API_KEY", label: "API token", prompt: "From Todoist" }], variables: { API_KEY: "KUVO_KEY_TODOIST_API_KEY" },
    settings: { type: "local", command: ["kuvo-npx", `@doist/todoist-mcp@${version}`], environment: { API_KEY: "{file:~/.kuvo-code/box/keys/KUVO_KEY_TODOIST_API_KEY}" }, codemode: false } },
  { id: "linear", title: "Linear", summary: "Issues", kind: "Code and Work", symbol: "list.bullet", site: "https://linear.app", how: "Official · sign in", way: "official",
    settings: { type: "remote", url: "https://mcp.linear.app/mcp" } },
  // A key not named as Kuvo Code names them: never asked for, so never offered.
  { id: "odd", title: "Odd", summary: "", kind: "Code and Work", symbol: "questionmark", site: "https://example.com", how: "Open source · your key", way: "token",
    keys: [{ name: "TOKEN", label: "Token" }], variables: { TOKEN: "HOME" }, settings: { type: "local", command: ["odd"], environment: { TOKEN: "{file:~/.kuvo-code/box/keys/HOME}" } } },
] });

/** The box's catalog, its bots and their folders' settings, in `home`. */
export function fixtures(home) {
  const writeCatalog = version => {
    fs.mkdirSync(path.join(home, "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, "bin", "integrations.json"), JSON.stringify(catalog(version)));
  };
  const bot = (id, name, project = null) => {
    const folder = path.join(home, "bots", id);
    fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id, name, job: "", look: {}, project, created: 0, updated: 0 }));
    fs.writeFileSync(path.join(folder, "session"), `ses_${id.slice(4)}`);
  };
  const folderSettings = path.join(home, "bots", "bot_scout", "workspace", ".opencode", "opencode.json");
  const settings = () => JSON.parse(fs.readFileSync(folderSettings, "utf8"));
  return { writeCatalog, bot, folderSettings, settings };
}

/** A route as a client reaches it over SSH (`box route`), in a process of its own. */
export async function boxRoute(request, env) {
  const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify(request));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  return { status: answer.status, value: JSON.parse(answer.body || "{}") };
}

/** The stand-in for this Mac's app: its host interface's keys, kept in memory as the Keychain would.
 * `asked`: each call it took ({call, name?, prefix?, suffix?}); `turnedAway`: those without its password. */
export async function standInHost(password) {
  const host = { keys: new Map(), asked: [], turnedAway: 0, down: false, onNames: null };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const answer = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    // That it's the app, as the app proves it: the box's nonce signed with the password, asked
    // without it (and answered while its Keychain is locked too).
    if (request.method === "POST" && request.url === "/hello") {
      host.hellos = (host.hellos ?? 0) + 1;
      const { nonce, vault } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const at = host.url.replace("http://", "");
      return answer(200, {
        proof: crypto.createHmac("sha256", password).update(`kuvo-host-hello\0${nonce}\0${at}`).digest("hex"),
        // For the vault's calls, with the secret the app gave its box alone.
        ...(vault && host.vaultSecret ? { vaultProof: crypto.createHmac("sha256", host.vaultSecret).update(`kuvo-host-vault\0${nonce}\0${at}`).digest("hex") } : {}),
      });
    }
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${password}` || request.headers["content-type"] !== "application/json") {
      host.turnedAway++;
      return answer(401, {});
    }
    const given = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const { value: _, values: __, ...asked } = given;
    host.asked.push({ call: request.url, ...asked });
    if (host.down || host.failing?.has(request.url)) return answer(500, { message: "The Keychain is locked." });
    switch (request.url) {
      case "/keys/names": {
        const names = [...host.keys.keys()].filter(name => name.startsWith(given.prefix ?? "") && name.endsWith(given.suffix ?? ""));
        // Held, as read now, until the test lets it go (`hold`): what the box asked meanwhile is seen.
        if (host.hold) {
          const hold = host.hold;
          host.hold = null;
          host.held?.();
          await hold;
        }
        answer(200, { names });
        return host.onNames?.();
      }
      case "/keys/get":
        return host.keys.has(given.name) ? answer(200, { value: host.keys.get(given.name) }) : answer(404, {});
      case "/keys/set":
        host.keys.set(given.name, given.value);
        // What happens elsewhere while a key is saved (a prompt waiting for the Keychain, say).
        host.onSet?.();
        return answer(200, {});
      case "/keys/delete":
        host.keys.delete(given.name);
        // What happens elsewhere while the box waits for its answer.
        await host.onDelete?.();
        return answer(200, {});
      // The vault's values, kept by id as the Keychain would (vault-host.test.js): only to the box,
      // with the secret the app started it with (`vaultSecret`), never to what read its folder.
      case "/vault/get":
      case "/vault/set":
      case "/vault/delete":
      case "/vault/generations":
        // Each with its own proof: an HMAC with the secret of the call, its body and when.
        if (host.vaultSecret && request.headers["x-kuvo-vault-auth"] !== crypto.createHmac("sha256", host.vaultSecret).update(`kuvo-host-vault-call\0${request.url.slice(1)}\0${crypto.createHash("sha256").update(Buffer.concat(chunks)).digest("hex")}\0${request.headers["x-kuvo-vault-at"]}`).digest("hex")) {
          host.turnedAway++;
          return answer(403, {});
        }
        break;
    }
    switch (request.url) {
      // The vault files' newest generations, as the app keeps them in the Keychain.
      case "/vault/generations":
        // (`unreadable`: its Keychain locked; `adopt`: kept by an app from before the generations were.)
        if (host.unreadable) return answer(503, { message: "This Mac's Keychain can't be read now, so its vault waits." });
        host.generations ??= {};
        if (typeof given.file === "string") {
          host.adopt = false;
          if (given.generation > (host.generations[given.file] ?? 0)) host.generations[given.file] = given.generation;
        }
        return answer(200, { generations: host.generations, ...(host.adopt ? { adopt: true } : {}) });
      case "/vault/get":
        return host.vault?.has(given.id) ? answer(200, { values: host.vault.get(given.id) }) : answer(404, {});
      case "/vault/set":
        (host.vault ??= new Map()).set(given.id, given.values);
        return answer(200, {});
      case "/vault/delete":
        host.vault?.delete(given.id);
        return answer(200, {});
      // Whether its browser is signed in to the sites the agent uses there, as the test sets it.
      case "/sites/signed-in":
        return host.sites ? answer(200, { sites: host.sites }) : answer(503, { message: "It can't tell now." });
      default:
        return answer(404, {});
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  host.url = `http://127.0.0.1:${server.address().port}`;
  return host;
}

/** This Mac's box, started as the app starts it: its routes, and `stop`, which gives back all it printed. */
export async function served(env) {
  const child = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { err += chunk; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const url = await new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]).url);
    });
    exited.then(code => reject(new Error(`serve exited ${code}: ${err}`)));
  });
  const route = async (method, path, body) => {
    const response = await fetch(`${url}/${path}`, { method, headers: { authorization: `Basic ${Buffer.from("opencode:box-pw").toString("base64")}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  const stop = async () => {
    child.stdin.end();
    await exited;
    return out + err;
  };
  return { route, stop };
}

/**
 * The scenarios, on `link` (the box's module, its home `home`) keeping keys in `store`:
 * `{env, folder, kept(name), keep(name, value), botNames(), files}`: the environment a process of
 * the box's own needs for it, the folder its settings name a bot's keys in, a key as it's kept
 * (null for none), one kept there by hand, the bots' own kept, and whether they're the machine's files.
 */
export function botKeyScenarios({ link, home, store }) {
  const { writeCatalog, bot, folderSettings, settings } = fixtures(home);
  // What waits a moment (its server connecting again), run when the test says.
  const waiting = [];
  const later = (run, ms) => waiting.push({ run, ms });
  const ask = (method, route, body, engine = null) => link.answerBotKeys(method, route, body, engine, undefined, later);
  writeCatalog();
  bot("bot_scout", "Scout");
  bot("bot_atlas", "Atlas", "/srv/app");

  test("given a key of its own: kept, its folder's settings naming its server with it, and its server connected again in its folder", async t => {
    const asked = [];
    const engine = http.createServer((request, response) => {
      asked.push({ method: request.method, url: request.url, folder: decodeURIComponent(request.headers["x-opencode-directory"] ?? "") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
    t.after(() => { engine.closeAllConnections(); engine.close(); });

    assert.deepEqual((await ask("GET", "kuvo/bots/bot_scout/keys")).value, { keys: [{ integration: "todoist", own: false, shared: false,
      title: "Todoist", symbol: "checklist", keys: [{ name: "API_KEY", label: "API token", prompt: "From Todoist" }] }] }, "only those you bring a key for, as Edit Bot shows them");
    store.keep("KUVO_KEY_TODOIST_API_KEY", "shared");
    assert.equal((await ask("GET", "kuvo/bots/bot_scout/keys")).value.keys[0].shared, true, "the box's shared key");

    const missing = await ask("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: {} });
    assert.equal(missing.status, 400);
    assert.match(missing.value.message, /API token/);
    // What you wrote in its folder's settings by hand stays.
    fs.mkdirSync(path.dirname(folderSettings), { recursive: true });
    fs.writeFileSync(folderSettings, JSON.stringify({ instructions: ["notes.md"], mcp: { servers: { notes: { type: "local", command: ["notes"] } } } }));

    const engineAt = { port: engine.address().port, password: "pw" };
    const given = await ask("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: " tok_scout " } }, engineAt);
    assert.equal(given.status, 200);
    assert.deepEqual(given.value, { integration: "todoist", own: true, shared: true });
    assert.equal(store.kept(own), "tok_scout");
    if (store.files) assert.equal((fs.statSync(path.join(home, "box", "bot-keys", own)).mode & 0o777).toString(8), "600", "only you can read it");
    assert.deepEqual(settings().mcp.servers.todoist.environment, { API_KEY: `{file:${store.folder}/KUVO_KEY_TODOIST_API_KEY__BOT_SCOUT}` });
    assert.deepEqual(settings().mcp.servers.notes, { type: "local", command: ["notes"] });
    assert.deepEqual(settings().instructions, ["notes.md"]);
    assert.deepEqual(waiting.map(each => each.ms), [2_000], "once the engine has read it");
    await waiting.shift().run();
    assert.deepEqual(asked, [{ method: "POST", url: "/api/experimental/mcp/todoist/connect", folder: path.join(home, "bots", "bot_scout", "workspace") }]);

    assert.deepEqual((await ask("GET", "kuvo/bots/bot_scout/keys/todoist")).value, { keys: { API_KEY: "tok_scout" } });
    assert.equal((await ask("GET", "kuvo/bots/bot_scout/keys")).value.keys[0].own, true);
  });

  test("its servers follow the box's integrations (a newer version, through the refresh route), and taken away, its server goes and what you wrote stays", async () => {
    writeCatalog("1.1.0");
    assert.deepEqual(await boxRoute({ method: "POST", path: "kuvo/bots/keys/refresh" }, store.env), { status: 200, value: {} });
    assert.deepEqual(settings().mcp.servers.todoist.command, ["kuvo-npx", "@doist/todoist-mcp@1.1.0"]);
    assert.equal((await boxRoute({ method: "GET", path: "kuvo/bots/keys/refresh" }, store.env)).status, 405);

    waiting.length = 0;
    assert.equal((await ask("DELETE", "kuvo/bots/bot_scout/keys/todoist")).status, 200);
    // Settings naming keys it no longer has (moved here from another computer, which named its
    // own there): tidied as the box refreshes.
    const moved = settings();
    moved.mcp.servers.github = { type: "remote", headers: { Authorization: "Bearer {file:/Users/me/keys/KUVO_KEY_GITHUB_TOKEN__BOT_SCOUT}" } };
    fs.writeFileSync(folderSettings, JSON.stringify(moved));
    await link.refreshBotsKeys();
    assert.equal(settings().mcp.servers.github, undefined);
    assert.equal(store.kept(own), null);
    assert.equal(store.kept("KUVO_KEY_TODOIST_API_KEY"), "shared", "the shared one stays");
    assert.equal(settings().mcp.servers.todoist, undefined);
    assert.deepEqual(settings().mcp.servers.notes, { type: "local", command: ["notes"] });
    assert.equal((await ask("DELETE", "kuvo/bots/bot_scout/keys/todoist")).status, 404);
  });

  test("all of them, as it leaves the box: gone, and with nothing else in its folder's settings, the file too", async () => {
    fs.writeFileSync(folderSettings, "{}");
    await ask("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: "tok_again" } });
    store.keep("KUVO_KEY_GONE_TOKEN__BOT_SCOUT", "from an integration no longer here");
    store.keep("KUVO_KEY_TODOIST_API_KEY__BOT_SCOUTER", "another bot's");
    assert.equal((await ask("DELETE", "kuvo/bots/bot_scout/keys")).status, 200);
    assert.deepEqual(store.botNames(), ["KUVO_KEY_TODOIST_API_KEY__BOT_SCOUTER"], "its own, every one; never another bot's");
    assert.equal(fs.existsSync(path.dirname(folderSettings)), false);
  });

  test("a bot in a project, one that isn't here, an integration it can't have a key for, and settings that aren't plain JSON: turned away, nothing written", async () => {
    assert.equal((await ask("GET", "kuvo/bots/bot_atlas/keys")).status, 409);
    assert.equal((await ask("GET", "kuvo/bots/bot_nobody/keys")).status, 404);
    assert.equal((await ask("PUT", "kuvo/bots/bot_scout/keys/linear", { keys: {} })).status, 404);
    assert.equal((await ask("PUT", "kuvo/bots/bot_scout/keys/odd", { keys: { TOKEN: "tok" } })).status, 404);
    fs.mkdirSync(path.dirname(folderSettings), { recursive: true });
    fs.writeFileSync(folderSettings, "// mine\n{}");
    assert.equal((await ask("PUT", "kuvo/bots/bot_scout/keys/todoist", { keys: { API_KEY: "tok" } })).status, 409);
    assert.equal(store.kept(own), null);
    // One it has stays while its settings can't say it's gone.
    store.keep(own, "tok_kept");
    assert.equal((await ask("DELETE", "kuvo/bots/bot_scout/keys/todoist")).status, 409);
    assert.equal(store.kept(own), "tok_kept");
    fs.rmSync(path.dirname(folderSettings), { recursive: true });
  });

  test("from a Mac, over SSH, the same routes: `box route`", async () => {
    const answer = await boxRoute({ method: "PUT", path: "kuvo/bots/bot_scout/keys/todoist", body: { keys: { API_KEY: "tok_from_mac" } } }, store.env);
    assert.equal(answer.status, 200);
    assert.equal(answer.value.own, true);
    assert.equal(store.kept(own), "tok_from_mac");
  });

  test("deleted, its keys of its own go with it, and no other bot's", async () => {
    bot("bot_gone", "Gone");
    store.keep("KUVO_KEY_TODOIST_API_KEY__BOT_GONE", "tok_gone");
    assert.equal((await link.deleteBot("bot_gone", () => { throw new Error("no engine"); }, () => { throw new Error("no bridge"); })).status, 200);
    assert.equal(store.kept("KUVO_KEY_TODOIST_API_KEY__BOT_GONE"), null);
    assert.equal(store.kept(own), "tok_from_mac");
  });

  return { writeCatalog, bot, folderSettings, settings };
}
