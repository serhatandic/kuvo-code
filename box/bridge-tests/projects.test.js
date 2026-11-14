// A box's projects (PROTOCOL.md, "Projects"): its own list, kept on the box, which every client
// reads and changes; Remove Project archives every session of one, its worktrees' too, page after
// page. Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { removeAtEnd } from "./at-end.js";
import { runningAs } from "./running-as.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-projects-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-work-")));
removeAtEnd(work);
const shop = path.join(work, "shop");
const blog = path.join(work, "blog");
const tree = path.join(work, "trees", "brave-otter");
for (const folder of [shop, blog, tree]) fs.mkdirSync(folder, { recursive: true });

beforeEach(() => {
  fs.rmSync(path.join(home, "box"), { recursive: true, force: true });
  // A worktree of the shop this box keeps, where its session runs.
  fs.mkdirSync(path.join(home, "box"), { recursive: true });
  fs.writeFileSync(path.join(home, "box", "worktrees.json"), JSON.stringify({ worktrees: [{ project: shop, root: tree, folder: tree, branch: "kuvo/brave-otter" }] }));
});

async function ask(handle, method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}

// The engine's sessions, as it keeps them: listed by folder newest first, a page at a time, and
// their metadata changed (`refusing` ones it won't change). The `waiting` ones wait on a
// permission; what's stopped is noted, and how many changes it was asked for at once, at most.
async function engineWith(sessions, refusing = new Set(), waiting = new Set(), active = null) {
  const stopped = [], looked = new Set();
  let changing = 0, most = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const [, asked, what] = /^\/api\/session\/([^/]+)\/(permission|form|inbox|interrupt)$/.exec(url.pathname) ?? [];
      // At work: those `active` names (its list can't be read without them).
      if (url.pathname === "/api/session/active" && active) return send(200, { data: Object.fromEntries([...active].map(id => [id, { type: "running" }])) });
      if (what === "permission") looked.add(asked);
      if (what === "permission") return send(200, { data: waiting.has(asked) ? [{ id: `per_${asked}`, sessionID: asked, action: "shell", resources: ["git push"] }] : [] });
      if (what === "form" || what === "inbox") return send(200, { data: [] });
      if (what === "interrupt") {
        stopped.push(asked);
        return send(200, { data: true });
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        const cursor = url.searchParams.get("cursor");
        const { directory, start } = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) : { directory: url.searchParams.get("directory"), start: 0 };
        // (Without a folder, every one.)
        const inFolder = sessions.filter(each => directory === null || each.location.directory === directory);
        const limit = Number(url.searchParams.get("limit"));
        const page = inFolder.slice(start, start + limit);
        return send(200, { data: page, cursor: { next: Buffer.from(JSON.stringify({ directory, start: start + limit })).toString("base64url") } });
      }
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const session = sessions.find(each => each.id === id);
      // One read as it is now, before its metadata is written (#581).
      if (request.method === "GET" && session) return send(200, { data: session });
      if (request.method === "PATCH" && session && !refusing.has(id)) {
        session.metadata = JSON.parse(body).metadata;
        // Answered once the others asked meanwhile have come in.
        most = Math.max(most, ++changing);
        return setImmediate(() => {
          changing -= 1;
          send(200, { data: session });
        });
      }
      send(500, { message: "busy" });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, password: "p", stopped, looked, most: () => most, close: () => { server.closeAllConnections(); server.close(); } };
}

const session = (id, directory, metadata = {}) => ({ id, location: { directory }, time: { created: 1, updated: 1 }, metadata });

test("a project added from any client is kept on the box as it's named, and changed there", async () => {
  const handle = link.engineHandler(() => { throw new Error("no engine"); }, { name: "box" }, () => null);
  // None yet; its worktree's sessions are said to be the shop's.
  assert.deepEqual((await ask(handle, "GET", "kuvo/projects")).json, { projects: [], worktrees: { [tree]: shop } });

  // A link stays a link: its sessions run there, by that name.
  const linked = path.join(work, "shop-link");
  fs.symlinkSync(shop, linked);
  const added = await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(linked)}`, { name: "  Shop  ", folders: [blog, linked], run: "npm run dev", terminal: "claude --continue" });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.project, { directory: linked, name: "Shop", folders: [blog], run: "npm run dev" });

  // Its folder's own name is no name of its own; what's not given stays.
  const renamed = await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(linked)}`, { name: "shop-link" });
  assert.deepEqual(renamed.json.project, { directory: linked, folders: [blog], run: "npm run dev" });
  assert.deepEqual((await ask(handle, "GET", "kuvo/projects")).json.projects, [renamed.json.project]);
  // Only you can read it.
  assert.equal(fs.statSync(path.join(home, "box", "projects.json")).mode & 0o777, 0o600);

  // One on a drive that isn't there now stays, and a client's copy of a removed one comes as removed.
  const away = path.join(work, "on-a-drive");
  assert.equal((await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(away)}`, { name: "Drive", removed: true })).status, 200);
  assert.deepEqual((await ask(handle, "GET", "kuvo/projects")).json.projects[0], { directory: away, name: "Drive", folders: [], removed: true });

  assert.equal((await ask(handle, "PUT", "kuvo/projects", {})).status, 400);
  assert.equal((await ask(handle, "PUT", "kuvo/projects?directory=relative/path", {})).status, 400);
  assert.equal((await ask(handle, "POST", `kuvo/projects?directory=${encodeURIComponent(shop)}`, {})).status, 405);
});

test("a saved terminal project is returned as an ordinary project and cleaned on its next edit", async () => {
  const file = path.join(home, "box", "projects.json");
  const project = { directory: shop, name: "Shop", folders: [blog], run: "bun dev", removed: true };
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [{ ...project, terminal: "opencode" }] }));
  const handle = link.engineHandler(() => { throw new Error("no engine"); }, { name: "box" }, () => null);
  const answer = await ask(handle, "GET", "kuvo/projects");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json.projects, [project]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, projects: [{ ...project, terminal: "opencode" }] });
  const edited = { ...project, name: "Shop renamed" };
  const saved = await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { name: edited.name, removed: true });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.project, edited);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, projects: [edited] });
});

test("Remove Project archives every session of it, its worktree's, its other folders', those filed under it from a subfolder and older ones too, and keeps its settings for when one comes back", async t => {
  // More than a page of them, one archived already, one in its other folder, one an agent started
  // in a subfolder of it (#311), and another project's, and one filed under it before it moved there.
  const sub = path.join(shop, "Packages"), notes = path.join(work, "notes");
  const sessions = [
    ...Array.from({ length: 102 }, (_, i) => session(`ses_shop${i}`, shop)),
    session("ses_tree", tree),
    session("ses_old", shop, { "kuvo.archived": true, "kuvo.pinned": true }),
    session("ses_blog", blog, { "kuvo.pinned": true }),
    session("ses_sub", sub, { kuvo: { filed: { folder: sub, project: shop } } }),
    session("ses_notes", notes, { "kuvo.pinned": true }),
    session("ses_moved", notes, { kuvo: { filed: { folder: sub, project: shop } } }),
  ];
  const engine = await engineWith(sessions);
  t.after(engine.close);
  const handle = link.engineHandler(() => engine, { name: "box" }, () => null);
  await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { name: "Shop", folders: [blog] });

  const removed = await ask(handle, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(removed.json.archived, 105);
  // Which, so each client's lists hide them at once.
  assert.deepEqual([...removed.json.sessions].sort(), sessions.filter(each => each.metadata["kuvo.archived"] === true && each.id !== "ses_old").map(each => each.id).sort());
  assert.ok(sessions.filter(each => !["ses_notes", "ses_moved"].includes(each.id)).every(each => each.metadata["kuvo.archived"] === true));
  assert.deepEqual(sessions.find(each => each.id === "ses_notes").metadata, { "kuvo.pinned": true }, "another project's stay");
  assert.equal(sessions.find(each => each.id === "ses_moved").metadata["kuvo.archived"], undefined, "one moved out of it since stays");
  assert.deepEqual(sessions.find(each => each.id === "ses_old").metadata, { "kuvo.archived": true, "kuvo.pinned": true });
  assert.deepEqual((await ask(handle, "GET", "kuvo/projects")).json.projects, [{ directory: shop, name: "Shop", folders: [blog], removed: true }]);

  // Added again: as it was.
  const back = await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, {});
  assert.deepEqual(back.json.project, { directory: shop, name: "Shop", folders: [blog] });
});

// Each of a big project's sessions archived, and those that wait on you stopped: looked at only
// where they're at work (an ask holds its turn), every one when that can't be read.
for (const [name, readable] of [["", true], [", its sessions at work unknown", false]]) {
  test(`Remove Project on a project of many sessions archives them all, several at once, and stops those that wait on you${name}`, async t => {
    const sessions = [
      ...Array.from({ length: 240 }, (_, i) => session(`ses_big${i}`, shop)),
      ...Array.from({ length: 30 }, (_, i) => session(`ses_bigtree${i}`, tree)),
    ];
    const waiting = new Set(["ses_big3", "ses_big150", "ses_bigtree7"]);
    // At work: those that wait on you, and one that's just working.
    const working = new Set([...waiting, "ses_big9"]);
    const engine = await engineWith(sessions, new Set(), waiting, readable ? working : null);
    t.after(engine.close);
    const handle = link.engineHandler(() => engine, { name: "box" }, () => null);
    await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { name: "Shop" });

    const removed = await ask(handle, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.json));
    assert.equal(removed.json.archived, 270);
    assert.deepEqual([...removed.json.sessions].sort(), sessions.map(each => each.id).sort());
    assert.ok(sessions.every(each => each.metadata["kuvo.archived"] === true));
    assert.deepEqual([...engine.stopped].sort(), [...waiting].sort(), "only those that wait on you, each once");
    assert.deepEqual([...engine.looked].sort(), readable ? [...working].sort() : sessions.map(each => each.id).sort(), "what each asks is read only where it may ask");
    assert.ok(engine.most() > 1, "not one after another: a big project would take minutes");
    assert.equal((await ask(handle, "GET", "kuvo/projects")).json.projects[0].removed, true);
  });
}

test("a session the engine doesn't archive keeps its project, which says so", async t => {
  const sessions = [session("ses_a", shop), session("ses_b", shop)];
  const engine = await engineWith(sessions, new Set(["ses_b"]));
  t.after(engine.close);
  const handle = link.engineHandler(() => engine, { name: "box" }, () => null);
  await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { name: "Shop" });

  const kept = await ask(handle, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`);
  assert.equal(kept.status, 409);
  assert.equal(kept.json.kept, 1);
  assert.deepEqual(kept.json.sessions, ["ses_a"], "those archived all the same");
  assert.match(kept.json.message, /One of its sessions couldn’t be archived/);
  assert.equal((await ask(handle, "GET", "kuvo/projects")).json.projects[0].removed, undefined);

  // Without its engine, nothing can be archived: it says so.
  const down = link.engineHandler(() => { throw new Error("down"); }, { name: "box" }, () => null);
  assert.equal((await ask(down, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`)).status, 503);
});

test("with its engine down and the coding agents' bridge up, Remove Project says it can't, and the project stays: its engine's sessions would come back", async t => {
  const bridge = await engineWith([]);
  t.after(bridge.close);
  const pid = await runningAs("kuvo-agents", t);
  const handle = link.engineHandler(() => { throw new Error("down"); }, { name: "box" }, () => ({ port: bridge.port, password: bridge.password, pid }));
  await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { name: "Shop" });
  const removed = await ask(handle, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`);
  assert.equal(removed.status, 503, JSON.stringify(removed.json));
  assert.equal((await ask(handle, "GET", "kuvo/projects")).json.projects[0].removed, undefined);

  // Its record left by one that ended without a word: the same, and the bridge's sessions are left as they were.
  const bridgeSessions = [session("ses_agent", shop)];
  const agents = await engineWith(bridgeSessions);
  t.after(agents.close);
  const gone = await engineWith([]);
  gone.close();
  const stale = link.engineHandler(() => ({ port: gone.port, password: "p" }), { name: "box" }, () => ({ port: agents.port, password: agents.password, pid }));
  const again = await ask(stale, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`);
  assert.equal(again.status, 503, JSON.stringify(again.json));
  assert.deepEqual(bridgeSessions[0].metadata, {});
});

test("Remove Project archives the sessions of a worktree of it that was removed since, which the sidebar still shows under it", async t => {
  const gone = path.join(work, "trees", "quiet-heron");
  fs.writeFileSync(path.join(home, "box", "worktrees.json"), JSON.stringify({ worktrees: [], removed: { [gone]: shop, [path.join(work, "trees", "elsewhere")]: blog } }));
  const sessions = [session("ses_shop", shop), session("ses_gone", gone), session("ses_else", path.join(work, "trees", "elsewhere"))];
  const engine = await engineWith(sessions);
  t.after(engine.close);
  const handle = link.engineHandler(() => engine, { name: "box" }, () => null);
  const removed = await ask(handle, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`);
  assert.deepEqual(removed.json.archived, 2);
  assert.deepEqual([...removed.json.sessions].sort(), ["ses_gone", "ses_shop"], "named, so each client hides them at once");
  assert.equal(sessions.find(each => each.id === "ses_gone").metadata["kuvo.archived"], true);
  assert.deepEqual(sessions.find(each => each.id === "ses_else").metadata, {}, "another project's");
});

test("Remove Project archives the sessions of folders the client shows under it that the box doesn't know (worktrees removed before it kept them)", async t => {
  const old = path.join(work, "trees", "long-gone");
  const sessions = [session("ses_shop", shop), session("ses_old_tree", old)];
  const engine = await engineWith(sessions);
  t.after(engine.close);
  const handle = link.engineHandler(() => engine, { name: "box" }, () => null);
  const removed = await ask(handle, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { folders: [old, "relative/one"] });
  assert.deepEqual(removed.json.archived, 2);
  assert.deepEqual([...removed.json.sessions].sort(), ["ses_old_tree", "ses_shop"]);
  assert.equal(sessions.find(each => each.id === "ses_old_tree").metadata["kuvo.archived"], true);
});

test("the list followed: a line now, and another when it changes", async () => {
  const handle = link.engineHandler(() => { throw new Error("no engine"); }, { name: "box" }, () => null);
  const abort = new AbortController();
  const lines = [];
  for await (const part of handle({ method: "GET", path: "kuvo/projects/events", headers: {}, body: Buffer.alloc(0) }, {}, abort.signal)) {
    if (part.head) assert.equal(part.head.headers["content-type"], "application/x-ndjson");
    if (!part.body) continue;
    lines.push(JSON.parse(part.body.toString()));
    if (lines.length === 1) await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(blog)}`, {});
    if (lines.length === 2) abort.abort();
  }
  assert.deepEqual(lines.map(line => line.projects.map(each => each.directory)), [[], [blog]]);
});
