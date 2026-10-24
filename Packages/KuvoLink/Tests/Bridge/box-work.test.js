// A machine tells your phones what happens in its own sessions and what its agents ask for as
// they browse, whether a Mac is connected to it or not: a Mac never tells them a machine's news,
// so each notice comes once, from the machine. Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The bridge keeps its state in KUVO_HOME: a folder of this test's own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-box-work-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const run = path.join(home, "run");
fs.mkdirSync(run, { recursive: true });

// What a connected Mac of an earlier version leaves on the machine each minute: notes that it's
// there (`run/present`, `run/connected`), just now.
function macJustConnected() {
  for (const folder of ["present", "connected"]) {
    fs.mkdirSync(path.join(run, folder), { recursive: true });
    fs.writeFileSync(path.join(run, folder, "mac_1"), "");
  }
}

// An engine with sessions, whose events a test sends to whoever follows them.
async function engineWith(sessions) {
  const followers = [];
  let followed;
  const following = new Promise(resolve => { followed = resolve; });
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      followed();
      return;
    }
    if (url.pathname.endsWith("/message")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ data: [] }));
    }
    const session = sessions[decodeURIComponent(url.pathname.split("/").pop())];
    response.writeHead(session ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: session ?? null }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    read: () => ({ port: server.address().port, password: "pw" }),
    following,
    send: event => { for (const follower of followers) follower.write(`data: ${JSON.stringify(event)}\n\n`); },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

// What goes to your phones, as it goes: `next()` is the next notice.
function phones() {
  const told = [];
  let read = 0, waiting = null;
  return {
    told,
    tell: notice => {
      told.push(notice);
      if (waiting) {
        read += 1;
        waiting(notice);
        waiting = null;
      }
      return true;
    },
    next: () => read < told.length ? Promise.resolve(told[read++]) : new Promise(resolve => { waiting = resolve; }),
  };
}

test("with a Mac connected, a permission asked in a session here still reaches your phones, once, from the machine", async () => {
  macJustConnected();
  const engine = await engineWith({
    ses_main: { id: "ses_main", title: "Fix the tests", location: { directory: "/home/me/shop" } },
  });
  const stop = new AbortController();
  const { told, tell, next } = phones();
  try {
    link.watchEvents(engine.read, tell, stop.signal);
    await engine.following;
    engine.send({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_main", action: "shell", resources: ["npm test"] } });
    assert.deepEqual(await next(), {
      title: "Fix the tests", subtitle: "shop", body: "Wants to run a command: npm test", category: "permission", thread: "ses_main",
      data: { session: "ses_main", request: "per_1" },
    });
    // What comes after it is told after it: the permission went once.
    engine.send({ type: "session.execution.failed", data: { sessionID: "ses_main" } });
    assert.equal((await next()).category, "failed");
    assert.deepEqual(told.map(notice => notice.category), ["permission", "failed"]);
  } finally {
    stop.abort();
    engine.close();
  }
});

test("a group chat's seat says nothing of its own: its chat tells your phones what matters", async () => {
  const sessions = {
    ses_seat: { id: "ses_seat", title: "Scout", metadata: { kuvo: { seat: { group: "grp_1", bot: "bot_1" } } }, location: { directory: "/home/me/.kuvo-code/bots/bot_1/workspace" } },
  };
  const get = async route => ({ data: route.endsWith("/message?limit=6&order=desc") ? [] : sessions[decodeURIComponent(route.split("/").pop())] });
  assert.equal(await link.noticeFor({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_seat", action: "shell", resources: ["ls"] } }, get), null);
  assert.equal(await link.noticeFor({ type: "session.execution.succeeded", data: { sessionID: "ses_seat" } }, get), null);
});

test("with a Mac connected, what an agent asks for as it browses here still reaches your phones, from the machine", async () => {
  macJustConnected();
  fs.writeFileSync(path.join(run, "browser-asks.json"), JSON.stringify({ asks: [{ id: "ask-1", kind: "code", host: "github.com", prompt: "The code GitHub sent" }] }));
  const stop = new AbortController();
  const { tell, next } = phones();
  try {
    // The browser runs.
    link.watchAsks(tell, { signal: stop.signal, every: 0, read: () => link.readAsks(() => true) });
    assert.deepEqual(await next(), { title: "Code for github.com", subtitle: undefined, body: "The code GitHub sent", category: "ask", thread: "ask-1", data: { ask: "ask-1" } });
  } finally {
    stop.abort();
    fs.rmSync(path.join(run, "browser-asks.json"), { force: true });
  }
});

test("a sign-in a Mac answers at once, with your saved password, never reaches your phones", async () => {
  const signIn = { id: "ask-2", kind: "signIn", host: "github.com", username: true, password: true };
  // Asked at one look, answered by the next; a third shows the watch went on.
  const looks = [[signIn], [], []];
  let looked = 0, lookedThrice;
  const thrice = new Promise(resolve => { lookedThrice = resolve; });
  const stop = new AbortController();
  const { told, tell } = phones();
  try {
    link.watchAsks(tell, {
      signal: stop.signal, every: 0,
      read: () => {
        looked += 1;
        if (looked === 3) lookedThrice();
        return looks[Math.min(looked, looks.length) - 1];
      },
    });
    await thrice;
    assert.deepEqual(told, []);
  } finally {
    stop.abort();
  }
});
