// A server of this box that has hung while running (its coding agents' bridge watches its engine;
// its link watches the bridge): ended, so whoever keeps it starts it again as after any crash (this
// Mac's keeper, a machine's `kuvo-start`).
//
// Ending a server loses what it has under way, so only this counts, all of it, at every look, for
// ten minutes without a break:
//
// - it takes connections but says nothing (not one that refuses them, or answers anything at all,
//   an error too: the question needs only its event loop, none of its work);
// - this box's own connections work, so it isn't the computer that's stuck;
// - all its threads are asleep, none running, on a disk or paused, and it used next to no CPU since
//   the last look: one at long work uses CPU, however deaf it is meanwhile;
// - nothing it started is working either (a long command under it);
// - macOS isn't asking you something (`run/.system-asking`, as this Mac's box says): a server that
//   reads a folder waits on your answer, asleep;
// - and this watch itself looked on time: a sleeping Mac, a paused machine or a starved one misses
//   its looks, and then what it saw before doesn't count.
//
// From outside, nothing tells a server stuck for good in a call that sleeps from one that call will
// still return to, so a call taking over ten minutes (a network folder that stalled) counts as hung.
// A server spinning at full CPU is never ended by this: from outside, that's long work. Neither is
// one whose event loop runs but whose work is stuck: it answers.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { processUse, type ProcessUse } from "./platform";

/** How often it looks, and how long a server has to answer each time (ms). */
export const LOOK_EVERY = 30_000;
export const ANSWER_WITHIN = 20_000;
/** How long all of that must hold without a break (ms). */
export const HUNG_AFTER = 600_000;
/** How much of one CPU, since the last look, says a server is working, and what it started. */
const OWN_WORK = 0.02;
const WORK_BELOW = 0.05;
/** Told to stop, how long it has before it's made to (ms). */
const TIME_TO_GO = 10_000;
/** How many it may end in a while, should a server keep hanging, or this be wrong about it. */
export const MOST_ENDED = 3;
const ENDED_WHILE = 6 * 3_600_000;

export interface HangWatchOptions {
  /** What it's called, in what's said and kept (`run/hung-<name>.json`). */
  name: "engine" | "bridge";
  /** The box's `run` folder. */
  run: string;
  /** Its record there, with where it is. */
  record: string;
  /** Whether a command line is this server's: never whatever took its number. */
  isIt: (command: string) => boolean;
  /** For a test: */
  every?: number;
  answerWithin?: number;
  hungAfter?: number;
  timeToGo?: number;
  now?: () => number;
  use?: (pid: number) => Promise<ProcessUse | null>;
}

/** What a question to a server came to: it answered something, nothing would connect, or silence. */
type Answer = "answered" | "refused" | "silent";

/** Asks what's on `port` on this computer, and whether it says anything at all. */
function ask(port: number, within: number): Promise<Answer> {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (answer: Answer) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done("silent"), within);
    socket.once("connect", () => socket.write("GET /api/info HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    socket.once("data", () => done("answered"));
    socket.once("error", () => done("refused"));
    socket.once("close", () => done("refused"));
  });
}

/** Whether connections on this computer work now, this process's event loop with them. */
function connectionsWork(): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer(socket => socket.end("x"));
    const done = (works: boolean) => {
      server.close();
      resolve(works);
    };
    server.once("error", () => done(false));
    server.listen(0, "127.0.0.1", () => {
      ask((server.address() as net.AddressInfo).port, ANSWER_WITHIN).then(answer => done(answer === "answered"));
    });
  });
}

export class HangWatch {
  private readonly every: number;
  private readonly answerWithin: number;
  private readonly hungAfter: number;
  private readonly timeToGo: number;
  private readonly now: () => number;
  private readonly use: (pid: number) => Promise<ProcessUse | null>;
  private looking = false;
  /** What's been seen of it without a break. */
  private seen: { pid: number; port: number; since: number; at: number; use: ProcessUse } | null = null;

  constructor(private readonly options: HangWatchOptions) {
    // (A test's real server, loaded with test/quick-hang.ts: never one of a real box's.)
    const test = (globalThis as { kuvoQuickHangWatch?: number }).kuvoQuickHangWatch ?? 0;
    this.every = options.every ?? (test || LOOK_EVERY);
    this.answerWithin = options.answerWithin ?? (test ? test / 2 : ANSWER_WITHIN);
    this.hungAfter = options.hungAfter ?? (test ? test * 3 : HUNG_AFTER);
    this.timeToGo = options.timeToGo ?? (test || TIME_TO_GO);
    this.now = options.now ?? Date.now;
    this.use = options.use ?? processUse;
  }

  /** One look. */
  async look(): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      await this.lookOnce();
    } finally {
      this.looking = false;
    }
  }

  private async lookOnce(): Promise<void> {
    const server = this.server();
    if (!server || this.stoppedOnPurpose()) {
      this.seen = null;
      return;
    }
    if ((await ask(server.port, this.answerWithin)) !== "silent" || !(await connectionsWork())) {
      this.seen = null;
      return;
    }
    const use = await this.use(server.pid);
    const at = this.now();
    // (Started over meanwhile: another server.)
    const now = this.server();
    if (!use?.waiting || !this.options.isIt(use.command) || use.below.running || now?.pid !== server.pid || now.port !== server.port) {
      this.seen = null;
      return;
    }
    // Late since the last look, or the clock went back: the computer slept (between looks or in
    // this one), or this was held up. What it saw before says nothing of now.
    const onTime = this.seen && at >= this.seen.at && at - this.seen.at <= this.every * 2;
    const seen = onTime && this.seen?.pid === server.pid && this.seen.port === server.port ? this.seen : null;
    // (From when this look ended: the computer may have slept since it began.)
    if (!seen) {
      this.seen = { ...server, since: at, at, use };
      return;
    }
    const seconds = (at - seen.at) / 1000;
    if (use.seconds - seen.use.seconds >= seconds * OWN_WORK || use.below.seconds - seen.use.below.seconds >= seconds * WORK_BELOW) {
      this.seen = { ...server, since: at, at, use };
      return;
    }
    this.seen = { ...seen, at, use };
    if (at - seen.since >= this.hungAfter) await this.end(server.pid, seen.since);
  }

  /** Where it is, as its record says, while one says so. */
  private server(): { pid: number; port: number } | null {
    try {
      const { pid, port } = JSON.parse(fs.readFileSync(this.options.record, "utf8"));
      return Number.isInteger(pid) && pid > 1 && Number.isInteger(port) && port > 0 ? { pid, port } : null;
    } catch {
      return null;
    }
  }

  /** You stopped it, it's being started, stopped or updated, or macOS is asking you something: nothing here to judge. */
  private stoppedOnPurpose(): boolean {
    return ["stopped", ".launching", ".updating", ".system-asking"].some(name => fs.existsSync(path.join(this.options.run, name)));
  }

  /** The times this ended one lately, read and kept beside its records; null when there's no telling. */
  private endedLately(): number[] | null {
    const file = path.join(this.options.run, `hung-${this.options.name}.json`);
    if (!fs.existsSync(file)) return [];
    try {
      const times = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(times) ? times.filter(time => typeof time === "number" && this.now() - time < ENDED_WHILE && time <= this.now()) : null;
    } catch {
      return null;
    }
  }

  private end(pid: number, since: number): void {
    this.seen = null;
    const minutes = Math.round((this.now() - since) / 60_000);
    const lately = this.endedLately();
    if (!lately || lately.length >= MOST_ENDED) {
      console.error(`The ${this.options.name} has said nothing for ${minutes} minutes, and it's been ended too often lately, or there's no telling how often: it's left as it is, for you to restart.`);
      return;
    }
    // Counted first: what can't be counted isn't ended, so the limit always holds.
    const file = path.join(this.options.run, `hung-${this.options.name}.json`);
    try {
      fs.writeFileSync(`${file}.new`, JSON.stringify([...lately, this.now()]), { mode: 0o600 });
      fs.renameSync(`${file}.new`, file);
    } catch {
      console.error(`The ${this.options.name} has said nothing for ${minutes} minutes, but that can't be noted in ${file}: it's left as it is, for you to restart.`);
      return;
    }
    console.error(`The ${this.options.name} (process ${pid}) has said nothing for ${minutes} minutes, with nothing at work: ending it, so it starts again.`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
    // Hung, it may not hear that. Only if it's still this one.
    setTimeout(async () => {
      const still = await this.use(pid);
      if (!still || !this.options.isIt(still.command)) return;
      try { process.kill(pid, "SIGKILL"); } catch {}
    }, this.timeToGo).unref?.();
  }

  /** Looks from now on, as long as this process runs. */
  start(): void {
    setInterval(() => void this.look().catch(() => {}), this.every).unref?.();
  }
}

/** The engine beside this bridge: `opencode serve`. */
export const isEngine = (command: string): boolean => /\bserve\b/.test(command) && !command.includes("kuvo-link");
/** The coding agents' bridge. */
export const isBridge = (command: string): boolean => command.includes("kuvo-agents");
