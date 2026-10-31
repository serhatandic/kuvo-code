// A test file's clean-up, once its tests are done: what it started stopped, the latest first, and
// its folders removed last. One hook for the whole file, so the order holds (a folder removed while
// a box it started still writes in it fails, ENOTEMPTY) and every step runs even when one fails:
// node:test skips a file's later `after` hooks once one throws, and what they'd have stopped keeps
// the file's process running, so the suite never finishes. Then nothing the file opened may still
// be open that would keep its process running for good (a server listening, a process never told
// to stop, a connection one of its socket servers took): it's named, closed, and fails the file,
// rather than holding up the whole run. (What ends on its own is closed without a word: its own
// connections out, kept alive for reuse, and an HTTP server's, which it lets go when idle. Timers
// aren't looked at: nothing says which end.)
//
// A file uses `atEnd` and `removeAtEnd` in place of `after`.
import { after } from "node:test";
import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const steps = [];
const folders = [];

/** `step` (stopping a server or a process), run once the file's tests are done: the latest first. */
export const atEnd = step => void steps.push(step);
/** `folder`, removed once every step has run and nothing is left open. */
export const removeAtEnd = folder => void folders.push(folder);

after(async () => {
  const failed = [];
  for (const step of steps.reverse()) {
    try {
      await step();
    } catch (error) {
      failed.push(error);
    }
  }
  const left = await leftOpen();
  for (const folder of folders) {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      failed.push(error);
    }
  }
  if (left.length) failed.push(new Error(`Still open once the file's tests were done, so its process would never end: ${left.join("; ")}.`));
  if (failed.length === 1) throw failed[0];
  if (failed.length) throw new AggregateError(failed, failed.map(error => error.message).join("\n"));
});

// What the file still has open: the runner's own stdio aside, and what's on its way out let go
// first (a process told to stop, until it has; its own connections out, closed; then what closes
// with them, a few turns of the loop: a server's side of them). Each named, then stopped.
async function leftOpen() {
  const own = new Set([process.stdin, process.stdout, process.stderr]);
  const open = () => process._getActiveHandles().filter(handle => !own.has(handle));
  // (A process's own pipes go with it.)
  const pipes = () => new Set(open().filter(handle => handle instanceof ChildProcess).flatMap(child => child.stdio));
  const stopping = child => child.killed || child.exitCode !== null || child.signalCode !== null || child.stdin?.writableEnded;
  await Promise.all(open().filter(handle => handle instanceof ChildProcess && stopping(handle)).map(closed));
  const piped = pipes();
  for (const handle of open()) if (handle instanceof net.Socket && !handle.server && !piped.has(handle)) handle.destroy();
  for (let turn = 0; turn < 10 && open().length; turn++) await new Promise(resolve => setImmediate(resolve));
  const children = open().filter(handle => handle instanceof ChildProcess);
  const theirs = pipes();
  const left = [];
  for (const child of children) {
    left.push(`a process never stopped (${child.spawnargs.join(" ").slice(0, 200)})`);
    child.kill("SIGKILL");
    await closed(child);
  }
  for (const handle of open()) {
    if (theirs.has(handle)) continue;
    if (handle instanceof net.Server) {
      const where = handle.address();
      left.push(`a server listening (${typeof where === "string" ? where : `port ${where?.port}`})`);
      handle.closeAllConnections?.();
      handle.close();
    } else if (handle instanceof net.Socket) {
      if (handle.server && !(handle.server instanceof http.Server)) left.push(`a connection to one of its socket servers (${handle.remoteAddress ? `from ${handle.remoteAddress}:${handle.remotePort}` : "a local socket"}), whose other end still runs`);
      handle.destroy();
    } else {
      left.push(`a ${handle.constructor?.name ?? "handle"}`);
    }
  }
  return left;
}

const closed = child => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : new Promise(resolve => child.once("close", resolve));
