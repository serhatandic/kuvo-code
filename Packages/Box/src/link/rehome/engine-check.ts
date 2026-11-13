// The move's last check before anything's put in place (#333 §3.2, step 5): the engine started on
// the rewritten data, at a port of its own, answers with the same sessions, each in its new folder.
// It runs on a copy of the database with nothing it could act on (no schedules, jobs, accounts or
// keys, nothing busy), with settings of its own (no servers or plugins of yours), and stops when
// its stdin closes, as the box's engine does.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { databaseCounts, databasesIn, quietCopy, sessionSample } from "./database";

/** How long the engine may take to start, and to answer. */
const START_LIMIT = 120_000;
const ANSWER_LIMIT = 60_000;
/** How many sessions are looked at one by one. */
const SAMPLE = 25;

export interface EngineCheck {
  /** The engine to start (`engine/<version>/opencode`, staged). */
  engine: string;
  /** The rewritten data folder (the engine's `XDG_DATA_HOME`, with `opencode/` in it). */
  data: string;
  /** A folder of its own for the check, made and removed here. */
  scratch: string;
  /** Whether a session's folder, as rewritten, was there before and isn't now (its staged copy
   * missing): one you deleted long ago isn't lost by the move. */
  lost: (folder: string) => boolean;
}

/** The engine started on the rewritten data: throws with what didn't answer as it should. */
export async function checkWithEngine({ engine, data, scratch, lost }: EngineCheck): Promise<{ sessions: number }> {
  const database = path.join(data, "opencode", "opencode.db");
  if (!databasesIn(path.join(data, "opencode")).includes(database)) return { sessions: 0 };
  const expected = databaseCounts(database);
  if (!expected.sessions) return { sessions: 0 };
  fs.rmSync(scratch, { recursive: true, force: true });
  const folder = (name: string) => {
    const made = path.join(scratch, name);
    fs.mkdirSync(made, { recursive: true, mode: 0o700 });
    return made;
  };
  quietCopy(database, path.join(folder("data/opencode"), "opencode.db"));
  const password = crypto.randomBytes(24).toString("hex");
  const child = spawn(engine, ["serve", "--stdio", "--port", "0"], {
    cwd: folder("workspace"),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: folder("home"),
      TMPDIR: folder("tmp") + "/",
      XDG_DATA_HOME: path.join(scratch, "data"),
      XDG_CONFIG_HOME: folder("config"),
      XDG_STATE_HOME: folder("state"),
      XDG_CACHE_HOME: folder("cache"),
      OPENCODE_PASSWORD: password,
      OPENCODE_CLIENT: "desktop",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FREE_MODELS: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_FILEWATCHER: "1",
      // (Nowhere to reach: nothing it could start would get a model to answer.)
      HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
    },
  });
  // (Its stdin closing on one that's gone, or never started, is no failure of the move's.)
  child.stdin.on("error", () => {});
  let said = "", errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2000); });
  // (Gone once it's stopped, or once it couldn't be started at all.)
  const gone = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const limit = setTimeout(() => reject(new Error("The engine didn't start on the moved data in time.")), START_LIMIT);
      child.stdout.on("data", chunk => {
        said += chunk;
        const found = /"url"\s*:\s*"([^"]+)"/.exec(said);
        if (found) { clearTimeout(limit); resolve(found[1]); }
      });
      child.once("exit", status => { clearTimeout(limit); reject(new Error(`The engine stopped as it started on the moved data (${status}): ${errors.trim().slice(-300)}`)); });
      child.once("error", error => { clearTimeout(limit); reject(error); });
    });
    const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const ask = async (route: string): Promise<any> => {
      const answer = await fetch(url + route, { headers: { authorization }, signal: AbortSignal.timeout(ANSWER_LIMIT) });
      if (!answer.ok) throw new Error(`The engine on the moved data answered ${answer.status} to ${route.split("?")[0]}.`);
      return answer.json();
    };
    // Every session, by its list (and the archived ones'), page by page.
    const listed = new Set<string>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      for (let page = 0; page < 100_000; page++) {
        const answer: any = await ask(`/api/session?limit=200&order=desc${archived ? "&archived=true" : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const session of answer?.data ?? []) if (typeof session?.id === "string") listed.add(session.id);
        cursor = typeof answer?.cursor?.next === "string" && (answer?.data ?? []).length ? answer.cursor.next : null;
        if (!cursor) break;
      }
    }
    if (listed.size !== expected.sessions) throw new Error(`The engine on the moved data lists ${listed.size} sessions, not ${expected.sessions}.`);
    // A sample, each in its folder as rewritten, which is there.
    for (const { id, directory } of sessionSample(database, SAMPLE)) {
      const session: any = await ask(`/api/session/${encodeURIComponent(id)}`);
      const folder = session?.data?.location?.directory ?? session?.location?.directory;
      if (folder !== directory) throw new Error(`The engine on the moved data has ${id} in ${folder}, not ${directory}.`);
      if (lost(directory)) throw new Error(`${id}'s folder isn't there once moved (${directory}).`);
    }
    return { sessions: listed.size };
  } finally {
    child.stdin.end();
    // (It stops as its stdin closes; one that doesn't, stopped.)
    const stopped = await Promise.race([gone.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 10_000).unref())]);
    if (!stopped && child.pid) try { process.kill(child.pid, "SIGKILL"); } catch {}
    await gone;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
