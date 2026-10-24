// A box's projects (PROTOCOL.md, "Projects"): its own list, kept on the box, which every client
// reads and changes; Remove Project archives every session of one, its worktrees' too, page after
// page. Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-projects-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-work-")));
after(() => fs.rmSync(work, { recursive: true, force: true }));
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
// their metadata changed (`refusing` ones it won't change).
async function engineWith(sessions, refusing = new Set()) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const url = new URL(request.url, "http://x");
      const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET" && url.pathname === "/api/session") {
        const cursor = url.searchParams.get("cursor");
        const { directory, start } = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString()) : { directory: url.searchParams.get("directory"), start: 0 };
        const inFolder = sessions.filter(each => each.location.directory === directory);
        const limit = Number(url.searchParams.get("limit"));
        const page = inFolder.slice(start, start + limit);
        return send(200, { data: page, cursor: { next: Buffer.from(JSON.stringify({ directory, start: start + limit })).toString("base64url") } });
      }
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const session = sessions.find(each => each.id === id);
      if (request.method === "PATCH" && session && !refusing.has(id)) {
        session.metadata = JSON.parse(body).metadata;
        return send(200, { data: session });
      }
      send(500, { message: "busy" });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, password: "p", close: () => { server.closeAllConnections(); server.close(); } };
}

const session = (id, directory, metadata = {}) => ({ id, location: { directory }, time: { created: 1, updated: 1 }, metadata });

test("a project added from any client is kept on the box as it's named, and changed there", async () => {
  const handle = link.engineHandler(() => { throw new Error("no engine"); }, { name: "box" }, () => null);
  assert.deepEqual((await ask(handle, "GET", "kuvo/projects")).json, { projects: [] });

  // A link stays a link: its sessions run there, by that name.
  const linked = path.join(work, "shop-link");
  fs.symlinkSync(shop, linked);
  const added = await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(linked)}`, { name: "  Shop  ", folders: [blog, linked], run: "npm run dev", terminal: " " });
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

test("Remove Project archives every session of it, its worktree's and older ones too, and keeps its settings for when one comes back", async t => {
  // More than a page of them, one archived already, and another project's.
  const sessions = [
    ...Array.from({ length: 102 }, (_, i) => session(`ses_shop${i}`, shop)),
    session("ses_tree", tree),
    session("ses_old", shop, { "kuvo.archived": true, "kuvo.pinned": true }),
    session("ses_blog", blog, { "kuvo.pinned": true }),
  ];
  const engine = await engineWith(sessions);
  t.after(engine.close);
  const handle = link.engineHandler(() => engine, { name: "box" }, () => null);
  await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { name: "Shop", folders: [blog] });

  const removed = await ask(handle, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.deepEqual(removed.json, { archived: 103 });
  assert.ok(sessions.filter(each => each.id !== "ses_blog").every(each => each.metadata["kuvo.archived"] === true));
  assert.deepEqual(sessions.find(each => each.id === "ses_blog").metadata, { "kuvo.pinned": true }, "another project's stay");
  assert.deepEqual(sessions.find(each => each.id === "ses_old").metadata, { "kuvo.archived": true, "kuvo.pinned": true });
  assert.deepEqual((await ask(handle, "GET", "kuvo/projects")).json.projects, [{ directory: shop, name: "Shop", folders: [blog], removed: true }]);

  // Added again: as it was.
  const back = await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, {});
  assert.deepEqual(back.json.project, { directory: shop, name: "Shop", folders: [blog] });
});

test("a session the engine doesn't archive keeps its project, which says so", async t => {
  const sessions = [session("ses_a", shop), session("ses_b", shop)];
  const engine = await engineWith(sessions, new Set(["ses_b"]));
  t.after(engine.close);
  const handle = link.engineHandler(() => engine, { name: "box" }, () => null);
  await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(shop)}`, { name: "Shop" });

  const kept = await ask(handle, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`);
  assert.equal(kept.status, 409);
  assert.equal(kept.json.kept, 1);
  assert.match(kept.json.message, /One of its sessions couldn’t be archived/);
  assert.equal((await ask(handle, "GET", "kuvo/projects")).json.projects[0].removed, undefined);

  // Without its engine, nothing can be archived: it says so.
  const down = link.engineHandler(() => { throw new Error("down"); }, { name: "box" }, () => null);
  assert.equal((await ask(down, "DELETE", `kuvo/projects?directory=${encodeURIComponent(shop)}`)).status, 503);
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
