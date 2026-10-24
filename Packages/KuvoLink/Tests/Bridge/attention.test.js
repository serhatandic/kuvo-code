// A machine's notices while you're at a computer (PROTOCOL.md, "kuvo/attention"): a client in use
// (a Mac you're at) has each wait a little, and one answered or seen on its screen meanwhile never
// reaches your phones; once no client is in use (its lease ran out, or it said so), what waits goes
// at once, and with none, notices go at once. The clock is the test's own: nothing waits for real
// time. Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The bridge keeps its state in KUVO_HOME: a folder of this test's own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-attention-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// A clock that moves only when the test moves it, and the timers it runs.
function clock() {
  let now = 1_800_000_000_000;
  let timers = [];
  let next = 1;
  return {
    now: () => now,
    setTimer: (fire, ms) => {
      const id = next++;
      timers.push({ id, at: now + ms, fire });
      return id;
    },
    clearTimer: id => { timers = timers.filter(timer => timer.id !== id); },
    // Moves on by `ms`, running each timer as its time comes.
    pass(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter(timer => timer !== due);
        now = due.at;
        due.fire();
      }
      now = end;
    },
  };
}

// A box's hold on this clock, and what reached your phones (`up`: whether the relay is there).
function box({ up = true, ...options } = {}) {
  const time = clock();
  const phones = [];
  const relay = { up };
  const hold = new link.NoticeHold({ ...time, send: notice => relay.up && Boolean(phones.push(notice)), ...options });
  return { time, phones, relay, hold };
}

const finished = { title: "Fix the tests", subtitle: "shop", body: "All green.", category: "finished", thread: "ses_main", data: { session: "ses_main" } };
const permission = { title: "Fix the tests", subtitle: "shop", body: "Wants to run a command: npm test", category: "permission", thread: "ses_main", data: { session: "ses_main", request: "per_1" } };
const atTheMac = { seconds: 45, sessions: [] };

test("with a client in use, a run finished waits its hold, then goes", () => {
  const { time, phones, hold } = box();
  hold.attend("mac:a", atTheMac);
  hold.tell(finished);
  time.pass(15_000);
  // Still at the Mac: the lease renewed, another conversation on screen.
  hold.attend("mac:a", { seconds: 45, sessions: ["ses_other"] });
  time.pass(link.NEWS_HOLD - 15_000 - 1);
  assert.deepEqual(phones, []);
  time.pass(1);
  assert.deepEqual(phones, [finished]);
  time.pass(120_000);
  assert.equal(phones.length, 1);
});

test("a permission waits less than news", () => {
  assert.ok(link.ASK_HOLD < link.NEWS_HOLD);
  const { time, phones, hold } = box();
  hold.attend("mac:a", atTheMac);
  hold.tell(permission);
  time.pass(link.ASK_HOLD);
  assert.deepEqual(phones, [permission]);
});

test("a permission answered during its hold never reaches your phones", () => {
  const { time, phones, hold } = box();
  hold.attend("mac:a", atTheMac);
  hold.tell(permission);
  time.pass(5_000);
  hold.resolve("per_1");
  time.pass(120_000);
  assert.deepEqual(phones, []);
  assert.equal(hold.count, 0);
});

test("one answered before its notice is made (the engine asked who's asking first) never goes, lease or not", () => {
  const { phones, hold } = box();
  hold.resolve("per_1");
  hold.tell(permission);
  assert.deepEqual(phones, []);
});

test("one whose conversation comes on the client's screen during its hold never goes", () => {
  const { time, phones, hold } = box();
  hold.attend("mac:a", atTheMac);
  hold.tell(finished);
  time.pass(10_000);
  hold.attend("mac:a", { seconds: 45, sessions: ["ses_main"] });
  time.pass(link.NEWS_HOLD);
  assert.deepEqual(phones, []);
  // Seen, it isn't sent when the Mac goes either.
  hold.attend("mac:a", atTheMac);
  hold.tell({ ...finished, data: { session: "ses_two" }, thread: "ses_two" });
  hold.attend("mac:a", { seconds: 45, sessions: ["ses_two"] });
  hold.attend("mac:a", { seconds: 0 });
  assert.deepEqual(phones, []);
});

test("a permission seen but left unanswered waits on you, and goes once you leave", () => {
  const { time, phones, hold } = box();
  hold.attend("mac:a", atTheMac);
  hold.tell(permission);
  hold.attend("mac:a", { seconds: 45, sessions: ["ses_main"] });
  time.pass(link.ASK_HOLD);
  assert.deepEqual(phones, []);
  hold.attend("mac:a", { seconds: 0 });
  assert.deepEqual(phones, [permission]);
});

test("a Mac's older word, come late by mail, is let go", () => {
  const { phones, hold } = box();
  // It said it's not in use; its renewal from just before comes after.
  hold.attend("mac:a", { seconds: 0 }, 2);
  hold.attend("mac:a", atTheMac, 1);
  assert.equal(hold.inUse, false);
  hold.tell(finished);
  assert.deepEqual(phones, [finished]);
});

test("on screen before the notice came doesn't count: a lid closed then leaves nothing seen", () => {
  const { time, phones, hold } = box();
  hold.attend("mac:a", { seconds: 45, sessions: ["ses_main"] });
  hold.tell(finished);
  // No word from the Mac since: its lease runs out before the hold ends, and it goes then.
  time.pass(45_000);
  assert.deepEqual(phones, [finished]);
});

test("a lease that runs out sends what's held at once", () => {
  const { time, phones, hold } = box();
  hold.attend("mac:a", { seconds: 20, sessions: [] });
  hold.tell(finished);
  time.pass(19_999);
  assert.deepEqual(phones, []);
  time.pass(1);
  assert.deepEqual(phones, [finished]);
  assert.equal(hold.inUse, false);
});

test("a client saying it's not in use sends what's held at once", () => {
  const { phones, hold } = box();
  hold.attend("mac:a", atTheMac);
  hold.tell(finished);
  hold.tell(permission);
  hold.attend("mac:a", { seconds: 0 });
  assert.deepEqual(phones, [finished, permission]);
});

test("while another client is still in use, one leaving doesn't send what's held", () => {
  const { time, phones, hold } = box();
  hold.attend("mac:a", atTheMac);
  hold.attend("mac:b", atTheMac);
  hold.tell(finished);
  hold.attend("mac:a", { seconds: 0 });
  assert.deepEqual(phones, []);
  time.pass(link.NEWS_HOLD);
  assert.deepEqual(phones, [finished]);
});

test("with no client in use, a notice goes at once", () => {
  const { phones, hold } = box();
  hold.tell(finished);
  assert.deepEqual(phones, [finished]);
  assert.equal(hold.count, 0);
});

test("no lease lasts longer than the longest, however long a client asks for", () => {
  const { time, phones, hold } = box();
  hold.attend("mac:a", link.attentionGiven({ for: 86_400 }));
  hold.tell(finished);
  time.pass(link.LONGEST_LEASE);
  assert.deepEqual(phones, [finished]);
});

test("one that can't go (no relay just now) goes once it can, once", () => {
  const { time, phones, relay, hold } = box();
  relay.up = false;
  hold.tell(finished);
  time.pass(30_000);
  assert.deepEqual(phones, []);
  relay.up = true;
  time.pass(5_000);
  assert.deepEqual(phones, [finished]);
  time.pass(60_000);
  assert.equal(phones.length, 1);
});

test("what's held when the bridge stops goes from the next one, once", () => {
  let kept = [];
  const first = box({ save: entries => { kept = entries; } });
  first.hold.attend("mac:a", atTheMac);
  first.hold.tell(finished);
  assert.equal(kept.length, 1);
  // The next bridge, before the relay welcomes it, then after.
  const next = box({ up: false, held: JSON.parse(JSON.stringify(kept)), save: entries => { kept = entries; } });
  assert.deepEqual(next.phones, []);
  next.relay.up = true;
  next.time.pass(5_000);
  assert.deepEqual(next.phones, [finished]);
  assert.deepEqual(kept, []);
  assert.deepEqual(first.phones, []);
});

test("what a client says is read strictly: a lease in seconds, the conversations on its screen", () => {
  assert.deepEqual(link.attentionGiven({ for: 45, sessions: ["ses_1"] }), { seconds: 45, sessions: ["ses_1"] });
  assert.deepEqual(link.attentionGiven({ for: 0 }), { seconds: 0, sessions: [] });
  for (const wrong of [null, {}, { for: -1 }, { for: "45" }, { for: 45, sessions: "ses_1" }, { for: 45, sessions: [1] }, { for: Infinity }]) {
    assert.equal(link.attentionGiven(wrong), null, JSON.stringify(wrong));
  }
});

// ---- Through the bridge's own ways in ----

const k = key => key.toString("base64url");
const machineKey = link.newKey(), macKey = link.newKey(), strangerKey = link.newKey();
const mailFrom = (from, payload) => link.sealOneWay(Buffer.from(JSON.stringify(payload)), from, link.publicOf(machineKey)).message;

test("a Mac you're at says so by mail, and only a Mac that set this machine up is heard", () => {
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: k(machineKey), relay: "wss://relay.invalid", name: "lab", id: "lab.invalid", mac: k(link.publicOf(macKey)), macs: [k(link.publicOf(macKey))], phones: [] });
  const attended = [];
  const heard = (mac, given, at) => attended.push({ mac, given, at });
  link.receiveMail(mailFrom(strangerKey, { at: 1, attention: { for: 45 } }), undefined, () => {}, heard);
  link.receiveMail(mailFrom(macKey, { at: 2, attention: { for: 45, sessions: ["ses_main"] } }), undefined, () => {}, heard);
  link.receiveMail(mailFrom(macKey, { at: 3, attention: { for: "soon" } }), undefined, () => {}, heard);
  link.receiveMail(mailFrom(macKey, { attention: { for: 45 } }), undefined, () => {}, heard);
  assert.deepEqual(attended, [{ mac: k(link.publicOf(macKey)), given: { seconds: 45, sessions: ["ses_main"] }, at: 2 }]);
});

// An engine whose events a test sends to whoever follows them.
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

test("a permission answered in the engine during its hold never reaches your phones", async () => {
  const engine = await engineWith({ ses_main: { id: "ses_main", title: "Fix the tests", location: { directory: "/home/me/shop" } } });
  const { time, phones, hold } = box();
  const stop = new AbortController();
  let told, answered;
  const wasTold = new Promise(resolve => { told = resolve; });
  const wasAnswered = new Promise(resolve => { answered = resolve; });
  try {
    hold.attend("mac:a", atTheMac);
    link.watchEvents(engine.read, notice => { hold.tell(notice); told(); return true; }, stop.signal, id => { hold.resolve(id); answered(); });
    await engine.following;
    engine.send({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_main", action: "shell", resources: ["npm test"] } });
    await wasTold;
    assert.equal(hold.count, 1);
    engine.send({ type: "permission.replied", data: { sessionID: "ses_main", requestID: "per_1" } });
    await wasAnswered;
    time.pass(120_000);
    assert.deepEqual(phones, []);
  } finally {
    stop.abort();
    engine.close();
  }
});

test("an ask a Mac answers during its hold never reaches your phones", async () => {
  const ask = { id: "ask-1", kind: "code", host: "github.com", prompt: "The code GitHub sent" };
  // Asked at two looks (so it's told), then answered.
  const looks = [[ask], [ask], [], []];
  let looked = 0, done;
  const finishedLooking = new Promise(resolve => { done = resolve; });
  const { time, phones, hold } = box();
  hold.attend("mac:a", atTheMac);
  const stop = new AbortController();
  link.watchAsks(notice => hold.tell(notice), {
    signal: stop.signal, every: 0, answered: id => hold.resolve(id),
    read: () => {
      if (looked === looks.length - 1) { stop.abort(); done(); }
      return looks[Math.min(looked++, looks.length - 1)];
    },
  });
  await finishedLooking;
  time.pass(120_000);
  assert.deepEqual(phones, []);
});

test("kuvo/attention answers only in the running bridge, which holds its notices", async () => {
  const answer = async (handle, method, body) => {
    const parts = [];
    for await (const part of handle({ method, path: "kuvo/attention", headers: {}, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) }, {}, undefined)) parts.push(part);
    return { status: parts[0].head.status, json: JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString()) };
  };
  // `box route`, a command of its own, has nothing held to change.
  assert.equal((await answer(link.engineHandler(), "POST", { for: 45 })).status, 503);
  const { phones, hold } = box();
  const handle = link.engineHandler(undefined, {}, undefined, undefined, hold);
  assert.deepEqual(await answer(handle, "POST", { for: 45, sessions: [] }), { status: 200, json: { for: 45 } });
  hold.tell(finished);
  assert.deepEqual(await answer(handle, "GET"), { status: 200, json: { inUse: true, held: 1 } });
  assert.deepEqual(await answer(handle, "POST", { for: 0 }), { status: 200, json: { for: 0 } });
  assert.deepEqual(phones, [finished]);
});
