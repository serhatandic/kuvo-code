// The browser's keeper on a machine (box/dist/kuvo-browser.js `host`), the real one, with
// Chrome as a stand-in that speaks its DevTools protocol over the keeper's pipe, as Chrome does: a
// test hears what the keeper asks Chrome, sends Chrome's events, and connects clients (the Mac's
// live view, or the agent's tools) on the keeper's socket. One keeper per test file.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { atEnd, removeAtEnd } from "./at-end.js";

const keeper = path.resolve(import.meta.dirname, "../dist/kuvo-browser.js");

/** Messages as they come, and a way to wait for one that fits. */
export class Heard {
  constructor() {
    this.all = [];
    this.waiters = new Set();
  }
  add(message) {
    this.all.push(message);
    for (const waiter of this.waiters) waiter();
  }
  until(fits) {
    return new Promise((resolve) => {
      const check = () => {
        const found = this.all.find(fits);
        if (!found) return;
        this.waiters.delete(check);
        resolve(found);
      };
      this.waiters.add(check);
      check();
    });
  }
}

/** Starts the keeper with its stand-in Chrome; `before(home, answer)` sets up what the keeper finds
 * as it starts (what a keeper before it left), and Chrome's answers from its start. */
export async function browserHost({ before } = {}) {
  // A short path: Unix sockets' are limited.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kbh-"));
  const home = path.join(root, "home");
  removeAtEnd(root);

  // Chrome: a program the keeper starts, which hands its pipe (fds 3 and 4) to this test.
  const build = path.join(home, "browser", "builds", "test");
  fs.mkdirSync(build, { recursive: true });
  fs.symlinkSync(build, path.join(home, "browser", "current"));
  fs.writeFileSync(path.join(build, "chrome.js"), `const fs = require("node:fs"), net = require("node:net");
const socket = net.createConnection(process.env.KUVO_TEST_CHROME);
fs.createReadStream(null, { fd: 3 }).pipe(socket);
socket.pipe(fs.createWriteStream(null, { fd: 4 }));
socket.on("close", () => process.exit(0));
`);
  // (Through a shell: the keeper starts it without BUN_BE_BUN, which the engine's Bun needs to be one.)
  fs.writeFileSync(path.join(build, "chrome"), `#!/bin/sh\nBUN_BE_BUN=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(build, "chrome.js"))}\n`, { mode: 0o755 });

  const chrome = new Heard();
  // What Chrome answers a call, by its method, where a test says (else nothing much).
  const answers = new Map();
  let toKeeper;
  const pipe = net.createServer((socket) => {
    toKeeper = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\0")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        chrome.add(message);
        // Every call answered, as Chrome does once it's done it.
        const result = answers.get(message.method)?.(message.params ?? {}) ?? (message.method === "Browser.getVersion" ? { product: "Chrome/155.0.0.0" } : {});
        if (message.id !== undefined) socket.write(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }) + "\0");
      }
    });
  });
  const pipePath = path.join(root, "chrome.sock");
  await new Promise((resolve) => pipe.listen(pipePath, resolve));
  const event = (method, params, sessionId) => toKeeper.write(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");

  // The box's socket key, as the box makes it before it starts the keeper.
  const socketKey = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.join(home, "run"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "run", "socket.key"), socketKey + "\n", { mode: 0o600 });

  before?.(home, (method, give) => answers.set(method, give));
  const host = spawn(process.execPath, [keeper, "host"], {
    env: { ...process.env, KUVO_HOME: home, KUVO_TEST_CHROME: pipePath },
    stdio: "ignore",
  });
  atEnd(() => {
    host.kill("SIGKILL");
    // (Chrome's end, which the keeper started, goes once it sees this one has.)
    toKeeper?.destroy();
    pipe.close();
  });

  /** A client of the keeper (the Mac's live view, or the agent's tools), on its socket. */
  async function client() {
    const socketPath = path.join(home, "run", "browser.sock");
    await chrome.until((message) => message.method === "Browser.getVersion");
    const heard = new Heard();
    const socket = await new Promise((resolve) => {
      const attempt = () => {
        const socket = net.createConnection(socketPath);
        socket.once("connect", () => resolve(socket));
        // Not listening yet (Chrome only just answered): again in a moment.
        socket.once("error", () => setTimeout(attempt, 20));
      };
      attempt();
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        heard.add(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    atEnd(() => socket.destroy());
    const send = (message) => socket.write(JSON.stringify(message) + "\n");
    // Kuvo Code's own, which knows the box's socket key: it gives it first.
    send({ method: "Kuvo.key", params: { key: socketKey } });
    return { heard, send };
  }

  /** Chrome's answer to each call of `method` from now on. */
  const answer = (method, give) => answers.set(method, give);

  return { home, chrome, event, client, answer };
}
