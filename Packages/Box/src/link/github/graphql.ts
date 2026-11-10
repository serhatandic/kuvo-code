// Reading GitHub on a box, for whatever shows what GitHub says (the Work Queue's issues and pull
// requests; meant for a session's pull request at a glance too, #395): with GitHub's own `gh` and
// its sign-in on this box, so Kuvo Code keeps no key of GitHub's for it. Only reads: nothing here
// writes to GitHub.
//
// - One GraphQL query for everything asked at once on a host, `PER_QUERY` at most each.
// - Read only as a client asks (what's on its screen), and each thing again only as often as it can
//   change (the reader's own `freshFor`: a minute while it's open, half an hour once it's closed).
// - What was read is kept in the reader's file, so a route answered in a process of its own
//   (`box route`) reads it too, and only one process at a time asks GitHub (a lock beside it).
// - A host `gh` couldn't read (not there, signed out, no network) isn't asked again for a few
//   minutes.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject } from "../../shared/json";
import { writePrivate } from "../files";

/** How long a process asking GitHub holds the others off, at most: past it, its lock is taken as
 * left behind. Longer than the most it could take (four queries of 30 s). */
const HOLD = 3 * 60_000;
/** How long a host isn't asked again after `gh` couldn't read it. */
export const BACK_OFF = 5 * 60_000;
/** At most this many things in one query. */
const PER_QUERY = 50;

/** Why `gh` read nothing: it isn't on this computer, it isn't signed in, or it couldn't ask. */
export type Unread = "missing" | "signed-out" | "failed";

/** `gh api graphql` on `host`: what it answered (GitHub's `data`, with nulls for what it couldn't
 * find or may not see), or why it couldn't ask. */
export function askGitHub(host: string, query: string, timeout = 30_000): Promise<{ data: Record<string, unknown> } | { unread: Unread }> {
  return new Promise(resolve => {
    execFile("gh", ["api", "graphql", "--hostname", host, "-f", `query=${query}`], {
      // (Never in a repository: what a folder's own settings say has nothing to do with it.)
      cwd: os.tmpdir(), timeout, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      // Some not found (a repository gone, an issue it may not see) still answers the rest.
      try {
        const answer = JSON.parse(String(stdout));
        if (isObject(answer) && isObject(answer.data)) return resolve({ data: answer.data });
      } catch {}
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return resolve({ unread: "missing" });
      resolve({ unread: /auth login|not logged in|authentication|HTTP 401/i.test(String(stderr)) ? "signed-out" : "failed" });
    });
  });
}

/** A thing as last read: when, and what GitHub said (null: nothing there, or nothing this sign-in
 * may see). For a reader that `keepsLast`, one found missing since keeps what was read before, with
 * when it was asked again (`checked`) and that it was missing (`gone`). */
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
}

export function readKept<Value>(file: string): Kept<Value> {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    return { reads: isObject(kept.reads) ? kept.reads as Kept<Value>["reads"] : {}, hosts: isObject(kept.hosts) ? kept.hosts as Kept<Value>["hosts"] : {} };
  } catch {
    return { reads: {}, hosts: {} };
  }
}

/** Takes the lock on asking GitHub: false while another process holds it (it isn't left behind). */
function takeLock(lock: string, now: number): boolean {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(lock);
    return true;
  } catch {
    try {
      if (now - fs.statSync(lock).mtimeMs < HOLD) return false;
      fs.rmdirSync(lock);
      fs.mkdirSync(lock);
      return true;
    } catch {
      return false;
    }
  }
}

/** When a read was last asked. */
const askedAt = (read: Read<unknown>): number => read.checked ?? read.at;

/** Keeps what was read, and lets old reads and back-offs go. */
function keep<Value>(reader: Reader<unknown, Value>, kept: Kept<Value>, now: number): void {
  for (const [key, read] of Object.entries(kept.reads)) if (now - askedAt(read) > reader.keptFor) delete kept.reads[key];
  for (const [host, until] of Object.entries(kept.hosts)) if (until <= now) delete kept.hosts[host];
  writePrivate(reader.file, JSON.stringify(kept) + "\n");
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
  if (!takeLock(lock, Date.now())) return;
  try {
    // (Read again now it's held: another may have just read them.)
    const kept = readKept<Value>(reader.file);
    const byHost = new Map<string, Ask[]>();
    for (const ask of due(kept)) byHost.set(reader.hostOf(ask), [...(byHost.get(reader.hostOf(ask)) ?? []), ask]);
    for (const [host, each] of byHost) {
      for (let at = 0; at < each.length; at += PER_QUERY) {
        const part = each.slice(at, at + PER_QUERY);
        // (Still this process's: the others keep off.)
        try { fs.utimesSync(lock, new Date(), new Date()); } catch {}
        const answer = await askGitHub(host, reader.query(part));
        if ("unread" in answer) {
          kept.hosts[host] = now() + BACK_OFF;
          break;
        }
        part.forEach((ask, index) => {
          const key = reader.keyOf(ask);
          const value = reader.valueOf(answer.data[`p${index}`], ask);
          const before = kept.reads[key];
          kept.reads[key] = value === null && reader.keepsLast && before?.value ? { at: before.at, value: before.value, checked: now(), gone: true } : { at: now(), value };
        });
      }
    }
    keep(reader as Reader<unknown, Value>, kept, now());
  } finally {
    try { fs.rmdirSync(lock); } catch {}
  }
}

/** What GitHub says of `asks`, by key: read now where it's due (waiting `wait` ms at most for it;
 * a read that takes longer goes on, and is kept for the next ask), else as last read. One never
 * read isn't there. */
export async function readThrough<Ask, Value>(reader: Reader<Ask, Value>, asks: Ask[], { now = Date.now, wait = Infinity }: { now?: () => number; wait?: number } = {}): Promise<Map<string, Read<Value>>> {
  const unique = [...new Map(asks.map(ask => [reader.keyOf(ask), ask])).values()];
  const id = (ask: Ask) => `${reader.file}\n${reader.keyOf(ask)}`;
  const waiting = unique.filter(ask => !reading.has(id(ask)));
  if (waiting.length) {
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

/** A read made apart from `readThrough` (a fuller query, say), kept as one of the reader's. */
export function keepRead<Ask, Value>(reader: Reader<Ask, Value>, ask: Ask, value: Value | null, now = Date.now()): void {
  const kept = readKept<Value>(reader.file);
  kept.reads[reader.keyOf(ask)] = { at: now, value };
  keep(reader as Reader<unknown, Value>, kept, now);
}
