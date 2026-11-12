// Reading GitHub on a box, for whatever shows what GitHub says (the Work Queue's issues and pull
// requests, `work-queue/github.ts`; a session's pull request at a glance, `glance/github.ts`), each
// a `Reader` of its own: with GitHub's own `gh` and
// its sign-in on this box, so Kuvo Code keeps no key of GitHub's for it. Only reads: nothing here
// writes to GitHub.
//
// - One GraphQL query for everything asked at once on a host, `PER_QUERY` at most each.
// - Read only as a client asks (what's on its screen), and each thing again only as often as it can
//   change (the reader's own `freshFor`: about a minute while it's open, half an hour once closed).
// - What was read is kept in the reader's file, so a route answered in a process of its own
//   (`box route`) reads it too, and only one process at a time asks GitHub (a lock beside it).
// - A host `gh` couldn't read (not there, signed out, no network) isn't asked again for a few
//   minutes.
// - A process that answers once (`box route`) never waits on GitHub: a read that's due goes in a
//   process of its own (`box github-read`), and the next ask has it.

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject } from "../../shared/json";
import { writePrivate } from "../files";
import { K, OWN_RUNTIME, SCRIPT } from "../home";
import { answeringOnce } from "../once";

/** How long a process asking GitHub holds the others off, at most: past it, its lock is taken as
 * left behind. Longer than the most it could take (four queries of 30 s). */
const HOLD = 3 * 60_000;
/** How long a host isn't asked again after `gh` couldn't read it. */
export const BACK_OFF = 5 * 60_000;
/** At most this many things in one query. */
const PER_QUERY = 50;

/** Why `gh` read nothing: it isn't on this computer, it isn't signed in, or it couldn't ask. */
export type Unread = "missing" | "signed-out" | "failed";

/** What GitHub answered: its `data`, with nulls for what it couldn't find or may not see; and the
 * aliases it couldn't answer for another reason (`held`: an organization's SAML sign-on or IP
 * allow list, say), whose nulls say nothing of whether they're there. */
export interface Answered { data: Record<string, unknown>; held?: Set<string> }

/** The aliases GitHub's `errors` name for anything but not finding them. */
function heldOf(errors: unknown): Set<string> | undefined {
  const held = new Set<string>();
  for (const error of Array.isArray(errors) ? errors : []) {
    if (isObject(error) && error.type !== "NOT_FOUND" && Array.isArray(error.path) && typeof error.path[0] === "string") held.add(error.path[0]);
  }
  return held.size ? held : undefined;
}

/** `gh api graphql` on `host`: what it answered, or why it couldn't ask. */
export function askGitHub(host: string, query: string, timeout = 30_000): Promise<Answered | { unread: Unread }> {
  return new Promise(resolve => {
    execFile("gh", ["api", "graphql", "--hostname", host, "-f", `query=${query}`], {
      // (Never in a repository: what a folder's own settings say has nothing to do with it.)
      cwd: os.tmpdir(), timeout, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      // Some not found (a repository gone, an issue it may not see) still answers the rest.
      try {
        const answer = JSON.parse(String(stdout));
        if (isObject(answer) && isObject(answer.data)) {
          const held = heldOf(answer.errors);
          return resolve({ data: answer.data, ...(held ? { held } : {}) });
        }
      } catch {}
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return resolve({ unread: "missing" });
      resolve({ unread: /auth login|not logged in|authentication|HTTP 401/i.test(String(stderr)) ? "signed-out" : "failed" });
    });
  });
}

/** A thing as last read: what GitHub said (null: nothing there, or nothing this sign-in may see),
 * since when it has said so (`at`: a read that finds it the same leaves it, so what's shown of it
 * doesn't change with every read), and when it was last asked (`checked`, when that's later). For
 * a reader that `keepsLast`, one found missing since keeps what was read before, said `gone`. */
export interface Read<Value> {
  at: number;
  value: Value | null;
  checked?: number;
  gone?: boolean;
}

/** What a reader keeps: each thing read, and the hosts not to ask until when. */
export interface Kept<Value> {
  reads: Record<string, Read<Value>>;
  hosts: Record<string, number>;
}

/** What one reader reads, and how. */
export interface Reader<Ask, Value> {
  /** Its name, for a read in a process of its own (`box github-read <name>`). */
  name: string;
  /** Where its reads are kept. */
  file: string;
  keyOf(ask: Ask): string;
  hostOf(ask: Ask): string;
  /** One query for `asks` (on one host), each under the alias `p<index>`. */
  query(asks: Ask[]): string;
  /** What GitHub said of `ask`, from what it answered under its alias; null for nothing there. */
  valueOf(found: unknown, ask: Ask): Value | null;
  /** How long a read stands before it's read again (ms). */
  freshFor(value: Value | null): number;
  /** How long a read is kept at all, after it was last asked (ms). */
  keptFor: number;
  /** Keep what was read when it's found missing later (GitHub says the same of one gone and one
   * this sign-in may no longer see), rather than forget it. */
  keepsLast?: boolean;
  /** For one found missing where it was: how to ask for it again in the same read (by GitHub's id
   * for it, wherever it went), before it's taken as gone; null for no other way. */
  again?(ask: Ask, before: Read<Value> | undefined): Ask | null;
}

export function readKept<Value>(file: string): Kept<Value> {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    const reads: Kept<Value>["reads"] = {};
    for (const [key, read] of Object.entries(isObject(kept.reads) ? kept.reads : {})) {
      if (!isObject(read) || typeof read.at !== "number") continue;
      // (As the glance kept a pull request before one reader read GitHub for all, `{at, pull}`:
      // taken as what was read, and kept in this shape from the next write on. Kept 2 hours at
      // most, so this goes once no box from before #541 is about.)
      reads[key] = "value" in read ? read as unknown as Read<Value> : { at: read.at, value: (read.pull ?? null) as Value | null };
    }
    return { reads, hosts: isObject(kept.hosts) ? kept.hosts as Kept<Value>["hosts"] : {} };
  } catch {
    return { reads: {}, hosts: {} };
  }
}

/** Takes the lock on asking GitHub (a folder, with a token of this hold's in it): the token, or null
 * while another process holds it. One left behind (untouched for `HOLD`) is moved aside first, by a
 * rename only one process can make; one that turns out to be fresh (another just took it over) is
 * put back. */
function takeLock(lock: string, now: number): string | null {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(9).toString("base64url");
  const make = (): string | null => {
    try {
      fs.mkdirSync(lock);
    } catch {
      return null;
    }
    try { fs.writeFileSync(path.join(lock, token), ""); } catch {}
    return token;
  };
  const made = make();
  if (made) return made;
  // (What a takeover cut off midway left aside, once it's old.)
  try {
    for (const name of fs.readdirSync(path.dirname(lock))) {
      if (!name.startsWith(path.basename(lock) + ".")) continue;
      const aside = path.join(path.dirname(lock), name);
      if (now - fs.statSync(aside).mtimeMs > HOLD) fs.rmSync(aside, { recursive: true, force: true });
    }
  } catch {}
  try {
    if (now - fs.statSync(lock).mtimeMs < HOLD) return null;
    const aside = `${lock}.${token}`;
    fs.renameSync(lock, aside);
    if (Date.now() - fs.statSync(aside).mtimeMs < HOLD) {
      try { fs.renameSync(aside, lock); } catch {}
      return null;
    }
    fs.rmSync(aside, { recursive: true, force: true });
    return make();
  } catch {
    return null;
  }
}

/** The lock let go, only while this hold (`token`) still has it. */
function letGo(lock: string, token: string): void {
  try {
    if (!fs.existsSync(path.join(lock, token))) return;
    fs.rmSync(lock, { recursive: true, force: true });
  } catch {}
}

/** Keeps the lock this hold has (`token`) from being taken as left behind. */
function touch(lock: string): void {
  try { fs.utimesSync(lock, new Date(), new Date()); } catch {}
}

/** When a read was last asked. */
const askedAt = (read: Read<unknown>): number => read.checked ?? read.at;

/** Keeps what was read, and lets old reads and back-offs go. */
function keep<Value>(reader: Reader<unknown, Value>, kept: Kept<Value>, now: number): void {
  for (const [key, read] of Object.entries(kept.reads)) if (now - askedAt(read) > reader.keptFor) delete kept.reads[key];
  for (const [host, until] of Object.entries(kept.hosts)) if (until <= now) delete kept.hosts[host];
  writePrivate(reader.file, JSON.stringify(kept) + "\n");
}

/** What a read found of one thing, kept after what was read of it before. */
function readOf<Value>(before: Read<Value> | undefined, value: Value | null, keepsLast: boolean | undefined, now: number): Read<Value> {
  // (Found gone is a word of its own: since when, the first read that found it so.)
  if (value === null && keepsLast && before?.value) return { at: before.gone ? before.at : now, value: before.value, checked: now, gone: true };
  if (before && JSON.stringify(before.value) === JSON.stringify(value) && !before.gone) return { at: before.at, value, checked: now };
  return { at: now, value };
}

/** Reads now under way in this process, by reader and key. */
const reading = new Map<string, Promise<void>>();

/** Reads `asks` that are due (one query per host), and keeps what came; nothing while another
 * process is asking GitHub, whose answer is read from what it keeps. */
async function readDue<Ask, Value>(reader: Reader<Ask, Value>, asks: Ask[], now: () => number): Promise<void> {
  const due = (kept: Kept<Value>) => asks.filter(ask => {
    const read = kept.reads[reader.keyOf(ask)];
    return !(read && now() - askedAt(read) < reader.freshFor(read.gone ? null : read.value)) && !((kept.hosts[reader.hostOf(ask)] ?? 0) > now());
  });
  if (!due(readKept(reader.file)).length) return;
  const lock = reader.file + ".lock";
  const token = takeLock(lock, Date.now());
  if (!token) return;
  try {
    // (Read again now it's held: another may have just read them.)
    const kept = readKept<Value>(reader.file);
    const read = new Map<string, Read<Value>>();
    const held = new Map<string, number>();
    const byHost = new Map<string, Ask[]>();
    for (const ask of due(kept)) byHost.set(reader.hostOf(ask), [...(byHost.get(reader.hostOf(ask)) ?? []), ask]);
    for (const [host, each] of byHost) {
      for (let at = 0; at < each.length; at += PER_QUERY) {
        const part = each.slice(at, at + PER_QUERY);
        // (Still this process's: the others keep off.)
        touch(lock);
        const answer = await askGitHub(host, reader.query(part));
        if ("unread" in answer) {
          held.set(host, now() + BACK_OFF);
          break;
        }
        // (One GitHub wouldn't answer for, rather than didn't find, stays as it was, asked now.)
        const values = new Map<string, Value | null>();
        part.forEach((ask, index) => {
          const key = reader.keyOf(ask);
          const before = kept.reads[key];
          if (answer.held?.has(`p${index}`)) {
            if (before) read.set(key, { ...before, checked: now() });
            return;
          }
          values.set(key, reader.valueOf(answer.data[`p${index}`], ask));
        });
        // (Missing where it was: asked again another way, a moved issue by its id, before it's gone.)
        const again = part.flatMap(ask => {
          const key = reader.keyOf(ask);
          const other = values.has(key) && values.get(key) === null ? reader.again?.(ask, kept.reads[key]) : null;
          return other ? [other] : [];
        });
        if (again.length) {
          const second = await askGitHub(host, reader.query(again));
          if (!("unread" in second)) {
            again.forEach((ask, index) => {
              if (second.held?.has(`p${index}`)) return void values.delete(reader.keyOf(ask));
              const value = reader.valueOf(second.data[`p${index}`], ask);
              if (value !== null) values.set(reader.keyOf(ask), value);
            });
          }
        }
        for (const [key, value] of values) read.set(key, readOf(kept.reads[key], value, reader.keepsLast, now()));
      }
    }
    // (Into what's kept now: a read kept meanwhile apart from this one, `keepRead`, stays.)
    const latest = readKept<Value>(reader.file);
    for (const [key, each] of read) latest.reads[key] = each;
    for (const [host, until] of held) latest.hosts[host] = Math.max(latest.hosts[host] ?? 0, until);
    keep(reader as Reader<unknown, Value>, latest, now());
  } finally {
    letGo(lock, token);
  }
}

/** The asks among `asks` that are due to be read, by what's kept. */
function dueOf<Ask, Value>(reader: Reader<Ask, Value>, asks: Ask[], now: number): Ask[] {
  const kept = readKept<Value>(reader.file);
  return asks.filter(ask => {
    const read = kept.reads[reader.keyOf(ask)];
    return !(read && now - askedAt(read) < reader.freshFor(read.gone ? null : read.value)) && !((kept.hosts[reader.hostOf(ask)] ?? 0) > now);
  });
}

/** The readers, by name, for a read in a process of its own. */
const readers = new Map<string, Reader<unknown, unknown>>();

/** `reader` known by its name, for `box github-read`. */
export function register<Ask, Value>(reader: Reader<Ask, Value>): Reader<Ask, Value> {
  readers.set(reader.name, reader as Reader<unknown, unknown>);
  return reader;
}

/** `box github-read <reader>`, the asks as JSON on its input: a read that's due, made in a process
 * of its own for one that answers once; it ends once it's kept. */
export async function readApart(name: string | undefined, given: string | undefined): Promise<void> {
  const reader = name ? readers.get(name) : undefined;
  let asks: unknown;
  try { asks = JSON.parse(given ?? ""); } catch { return; }
  if (!reader || !Array.isArray(asks) || !asks.length || asks.length > 500) return;
  await readThrough(reader, asks);
}

/** What GitHub says of `asks`, by key: read now where it's due (waiting `wait` ms at most for it;
 * a read that takes longer goes on, and is kept for the next ask), else as last read. One never
 * read isn't there. */
export async function readThrough<Ask, Value>(reader: Reader<Ask, Value>, asks: Ask[], { now = Date.now, wait = Infinity }: { now?: () => number; wait?: number } = {}): Promise<Map<string, Read<Value>>> {
  const unique = [...new Map(asks.map(ask => [reader.keyOf(ask), ask])).values()];
  const id = (ask: Ask) => `${reader.file}\n${reader.keyOf(ask)}`;
  const waiting = unique.filter(ask => !reading.has(id(ask)));
  // (One that answers once never waits on GitHub, nor lives on after its answer for it.)
  if (answeringOnce()) {
    const due = dueOf(reader, waiting, now());
    // (Not while another process is reading, or one was started for it a moment ago: what it reads
    // is kept for the next ask. The asks go on its input, never where `ps` shows them.)
    const recent = (file: string, within: number) => { try { return Date.now() - fs.statSync(file).mtimeMs < within; } catch { return false; } };
    const started = reader.file + ".started";
    if (due.length && !recent(reader.file + ".lock", HOLD) && !recent(started, 10_000)) {
      try {
        writePrivate(started, "");
        const child = spawn(process.execPath, [...OWN_RUNTIME, SCRIPT, "box", "github-read", reader.name], { detached: true, stdio: ["pipe", "ignore", "ignore"], cwd: K, env: process.env });
        child.stdin?.end(JSON.stringify(due));
        child.unref();
      } catch {}
    }
  } else if (waiting.length) {
    const read = readDue(reader, waiting, now).catch(() => {}).finally(() => { for (const ask of waiting) reading.delete(id(ask)); });
    for (const ask of waiting) reading.set(id(ask), read);
  }
  const all = Promise.all(unique.map(ask => reading.get(id(ask))));
  if (wait === Infinity) await all;
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>(done => { timer = setTimeout(done, wait); })]);
    clearTimeout(timer);
  }
  const kept = readKept<Value>(reader.file);
  const found = new Map<string, Read<Value>>();
  for (const ask of unique) {
    const read = kept.reads[reader.keyOf(ask)];
    if (read) found.set(reader.keyOf(ask), read);
  }
  return found;
}

/** One thing read now, apart from `readThrough`, with a fuller query of its own (an agent waiting
 * on it): under the same lock (waiting for another process's read a few seconds at most); asked
 * whatever the back-off (someone asked for it: signed in again, say), and setting it, or lifting
 * it, as it goes; what `valueOf` makes of GitHub's answer kept as the reader's. GitHub's answer, or
 * why it wasn't read. */
export async function readOne<Ask, Value>(reader: Reader<Ask, Value>, ask: Ask, query: string, valueOf: (data: Record<string, unknown>) => Value | null, now = Date.now): Promise<Answered | { unread: Unread }> {
  const host = reader.hostOf(ask);
  const lock = reader.file + ".lock";
  let token = takeLock(lock, Date.now());
  for (let tries = 0; !token && tries < 50; tries++) {
    await new Promise(done => setTimeout(done, 200));
    token = takeLock(lock, Date.now());
  }
  try {
    const answer = await askGitHub(host, query);
    const kept = readKept<Value>(reader.file);
    if ("unread" in answer) kept.hosts[host] = Math.max(kept.hosts[host] ?? 0, now() + BACK_OFF);
    else {
      delete kept.hosts[host];
      // (Not one GitHub wouldn't answer for: as it was.)
      if (!answer.held?.size) kept.reads[reader.keyOf(ask)] = readOf(kept.reads[reader.keyOf(ask)], valueOf(answer.data), reader.keepsLast, now());
    }
    keep(reader as Reader<unknown, Value>, kept, now());
    return answer;
  } finally {
    if (token) letGo(lock, token);
  }
}
