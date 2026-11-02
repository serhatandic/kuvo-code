// What the vault's tests wait on, as it happens: a file the box makes, what the vault asks you.
// Never a count of tries or a pause: a busy machine is slow, never wrong, and a wait whose thing
// never comes fails at the test's own time limit.

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { before as nodeBefore, test as nodeTest } from "node:test";
import { atEnd } from "./at-end.js";

const LIMIT = 60_000;
// What ends the test or setup a wait is part of: each wait ends with it, so a test that times out
// still stops its box in its `finally` (also when it reaches a wait only after its time ran out).
const ending = new AsyncLocalStorage();
export const test = (name, run) => nodeTest(name, { timeout: LIMIT }, t => ending.run(t.signal, () => run(t)));
export const before = run => nodeBefore(t => ending.run(t.signal, () => run(t)), { timeout: LIMIT });

const inode = where => { try { return fs.statSync(where).ino; } catch { return null; } };

/** What `found()` gives, once it gives something: looked at again as anything changes in `folder`.
 * Watched with the folder above it, each on its own (never recursively, which Linux only imitates),
 * so a folder the box clears and makes again, or makes only later, is followed to the new one. */
export function appears(folder, found) {
  return new Promise((resolve, reject) => {
    const signal = ending.getStore();
    const watched = new Map();
    let done = false;
    // (Closed once the file's tests are done, if a test failed before this was seen: never what
    // keeps its process going.)
    atEnd(() => finish(() => resolve(undefined)));
    const ended = () => finish(() => reject(new Error(`The test ended before this came, in ${folder}.`)));
    if (signal?.aborted) return ended();
    signal?.addEventListener("abort", ended, { once: true });
    function finish(then) {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", ended);
      for (const { watcher } of watched.values()) watcher.close();
      then();
    }
    function arm() {
      let above = path.dirname(folder);
      while (inode(above) === null) above = path.dirname(above);
      const wanted = new Map([[above, inode(above)]]);
      if (inode(folder) !== null) wanted.set(folder, inode(folder));
      for (const [where, { watcher, ino }] of watched) {
        if (wanted.get(where) === ino) continue;
        watcher.close();
        watched.delete(where);
      }
      for (const [where, ino] of wanted) {
        if (watched.has(where)) continue;
        try {
          watched.set(where, { watcher: fs.watch(where, changed), ino });
        } catch {
          // (Gone again since: the folder above it says so.)
        }
      }
    }
    function changed() {
      if (done) return;
      arm();
      look();
    }
    function look() {
      if (done) return;
      let value;
      try { value = found(); } catch (error) { return finish(() => reject(error)); }
      if (value) finish(() => resolve(value));
    }
    // (Once it watches, so nothing made in between is missed.)
    changed();
  });
}

/** What the vault asks you that isn't in `seen` (ids), once it does: from its asks' stream at
 * `url` (`…/kuvo/vault/asks/events` on the box's own process), as this Mac's app follows them. */
export async function asked(url, password, seen = new Set()) {
  const stop = new AbortController();
  const signal = ending.getStore() ? AbortSignal.any([stop.signal, ending.getStore()]) : stop.signal;
  const response = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-kuvo-from": "app" }, signal });
  let buffer = "";
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const { asks } = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (asks?.some(each => !seen.has(each.id))) {
        stop.abort();
        return asks.filter(each => !seen.has(each.id));
      }
    }
  }
  throw new Error("The box stopped telling its asks.");
}
