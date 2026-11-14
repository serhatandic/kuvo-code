// What the vault's tests wait on, as it happens: a file the box makes, what the vault asks you.
// Never a count of tries or a pause: a busy machine is slow, never wrong, and a wait whose thing
// never comes fails at the test's own time limit. Filesystem watches are a hint,
// with a periodic look too: macOS may lose or coalesce a notification.

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { before as nodeBefore, test as nodeTest } from "node:test";
import { atEnd } from "./at-end.js";

const LIMIT = 60_000;
// What ends the test or setup a wait is part of: each wait ends with it, so a test that times out
// still stops its box in its `finally` (also when it reaches a wait only after its time ran out). A
// setup's own signal never ends at its time limit, so its waits end at that limit themselves.
const ending = new AsyncLocalStorage();
export const test = (name, run) => nodeTest(name, { timeout: LIMIT }, t => ending.run(t.signal, () => run(t)));
export const before = run => nodeBefore(async () => {
  const limit = new AbortController();
  const at = setTimeout(() => limit.abort(), LIMIT);
  try { return await ending.run(limit.signal, run); } finally { clearTimeout(at); }
}, { timeout: LIMIT });

// Waits still open once the file's tests are done (a test failed before they came): each fails, and
// none keeps its process going.
const open = new Set();
atEnd(() => { for (const end of [...open]) end(); });

/** What `found()` gives, once it gives something: looked at again as anything changes in `folder`.
 * Watched with the folder above it, each on its own (never recursively, which Linux only imitates),
 * and watched anew as either changes, so a folder the box clears and makes again (which Linux may
 * give the same inode), or makes only later, is followed to the new one. */
export function appears(folder, found) {
  return new Promise((resolve, reject) => {
    const signal = ending.getStore();
    const watchers = [];
    let done = false;
    let fallback;
    const ended = () => finish(() => reject(new Error(`The test ended before this came, in ${folder}.`)));
    if (signal?.aborted) return ended();
    signal?.addEventListener("abort", ended, { once: true });
    open.add(ended);
    function finish(then) {
      if (done) return;
      done = true;
      clearInterval(fallback);
      open.delete(ended);
      signal?.removeEventListener("abort", ended);
      for (const watcher of watchers.splice(0)) watcher.close();
      then();
    }
    function arm() {
      for (const watcher of watchers.splice(0)) watcher.close();
      let above = path.dirname(folder);
      while (!fs.existsSync(above)) above = path.dirname(above);
      for (const where of fs.existsSync(folder) ? [above, folder] : [above]) {
        try {
          watchers.push(fs.watch(where, changed));
        } catch {
          // (Gone again since: the folder above it says so.)
        }
      }
      // On macOS a folder's watch starts a moment after fs.watch returns, and what changes in that
      // moment is never told; nor, to any watch, what changes as another starts or stops (the
      // process's watches share one stream, made anew then). One opened and closed here has these
      // watching before the first look, more often than not; the look every 100 ms finds the rest.
      // (On Linux, as fs.watch returns.)
      try { fs.watch(above).close(); } catch {}
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
    if (!done) fallback = setInterval(look, 100);
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
