// A Mac's machines for a phone (PROTOCOL.md, "Machines"), with its app open or closed.
//
// The app connects to them over SSH, so how a connection stands and what's done with one are the
// app's to say. The list isn't: it's in `machines.json` in this box's folder, which the app alone
// writes and this box only reads, so there's one list, and this box answers from it while the app
// isn't there. It says what it can tell of each by itself (its box was heard from lately), and what
// needs the app says so.

import fs from "node:fs";
import path from "node:path";
import { K } from "../home";
import { readPeerAgents } from "../peers/directory";
import { peersOf } from "../peers/known";
import { macLink, readLink } from "../state";
import { appAnswer, passedOn } from "./app-route";
import type { Hosts, MacMachines } from "../../shared/routes/mac";
import type { AnswerPiece, Asker, LinkRequest } from "../server/context";

const LIST_FILE = path.join(K, "machines.json");
// What the app keeps of your machines' bridges, beside this box's folder.
const PHONE_LINK_FILE = path.join(path.dirname(K), "phone-link.json");

/** How long since a machine's box said its agents (every ten minutes, while it's on the relay) it
 * still counts as heard from. */
const HEARD_LATELY = 30 * 60_000;

/** How long the app may take to start answering before this box answers in its place (an app that's
 * stuck is no better than one that's closed), and how often a stream looks for the app again. */
export interface AppTiming {
  wait: number;
  look: number;
}
const TIMING: AppTiming = { wait: 5000, look: 10_000 };

const macName = () => macLink.config?.name || "this Mac";
const notOpen = () => `Kuvo Code isn’t open on ${macName()}`;
const UNREADABLE = "This Mac’s list of machines can’t be read right now.";

interface KeptHost {
  name?: unknown;
  address?: unknown;
  key?: unknown;
  anotherMac?: unknown;
}

// What the app keeps of your machines' bridges: undefined without the file, null when it won't read.
function keptHosts(): Record<string, KeptHost> | null | undefined {
  try {
    return JSON.parse(fs.readFileSync(PHONE_LINK_FILE, "utf8")).machines ?? {};
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

// Its machines as the app keeps them, or null when that can't be told, which isn't the same as none:
// a list that won't read, or no list while the app keeps bridges for machines. (Removing the last one
// leaves an empty list; no list then means it couldn't be written, and it's in the app's settings.)
function savedMachines(kept = keptHosts()): { destination: string; otherAddresses?: string[] }[] | null {
  let text: string;
  try {
    text = fs.readFileSync(LIST_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    return kept === undefined || (kept && !Object.keys(kept).length) ? [] : null;
  }
  try {
    const saved = JSON.parse(text);
    return Array.isArray(saved) && saved.every(machine => typeof machine?.destination === "string") ? saved : null;
  } catch {
    return null;
  }
}

/** Whether this Mac has machines its link meets, as its list says (the app's word for it, read by
 * the box itself): one that can't be read counts, as the app counts it. */
export function anyMachines(): boolean {
  const saved = savedMachines();
  return saved === null || saved.length > 0;
}

/** `kuvo/machines` as this box says it without the app: null when its list can't be read. */
export function machinesWithoutApp(now = Date.now()): MacMachines | null {
  const saved = savedMachines();
  if (!saved) return null;
  const peers = peersOf(readLink());
  const told = readPeerAgents();
  return {
    machines: saved.map(({ destination, otherAddresses }) => {
      const peer = peers.find(each => each.id === destination);
      const last = peer ? told[peer.key] : undefined;
      // (By this Mac's clock: `heard`. A list kept before there was one has only the sender's.)
      const heard = !peer ? "" : now - (last?.heard ?? last?.at ?? 0) < HEARD_LATELY ? "Running · " : "Not heard from lately · ";
      return { id: destination, name: destination, otherAddresses: Array.isArray(otherAddresses) ? otherAddresses : [], connection: "notConnected", status: heard + notOpen() };
    }),
    // What Add a Machine suggests, for what only the app can do.
    hosts: [],
  };
}

/** `kuvo/hosts` as this box says it without the app, from what the app keeps: null when that can't
 * be told or there's no relay yet to name, since a phone takes this list for all your machines and
 * forgets the rest. */
function hostsWithoutApp(): Hosts | null {
  const kept = keptHosts();
  const saved = savedMachines(kept);
  const relay = macLink.config?.relay;
  if (!saved || !relay || kept === null || (kept === undefined && saved.length)) return null;
  const hosts = Object.entries(kept ?? {}).flatMap(([machine, { name, address, key, anotherMac }]) => (typeof name === "string" && typeof address === "string" && typeof key === "string"
    ? [{ kind: "machine" as const, name, address, key, relay, machine, anotherMac: anotherMac === true, removed: !saved.some(each => each.destination === machine) }]
    : []));
  return { hosts: hosts.sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0)) };
}

const answer = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];

// The app's answer, once it's started answering, within `wait`.
async function appWithin(request: LinkRequest, phone: Asker | undefined, signal: AbortSignal | undefined, wait: number): Promise<Response | null> {
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), wait);
  const response = await appAnswer(request, phone, signal ? AbortSignal.any([signal, late.signal]) : late.signal);
  clearTimeout(timer);
  return response;
}

const pause = (ms: number, signal: AbortSignal | undefined) => new Promise<void>(done => {
  const finish = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", finish);
    done();
  };
  const timer = setTimeout(finish, ms);
  signal?.addEventListener("abort", finish, { once: true });
});

// `kuvo/machines/events`: the app's lines while it's there, this box's while it isn't, one stream
// over both, for as long as the phone follows. Where the list can't be read that's said as a read
// would: at once as it starts, and later the stream ends, for a phone's next try to hear it, since the
// last line may be the app's, saying it's connected.
async function* machinesFollowed(request: LinkRequest, phone: Asker | undefined, signal: AbortSignal | undefined, timing: AppTiming): AsyncGenerator<AnswerPiece> {
  const head: AnswerPiece = { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  let started = false;
  let last = "";
  while (!signal?.aborted) {
    const response = await appWithin(request, phone, signal, timing.wait);
    if (response?.status === 200 && response.body) {
      if (!started) yield head;
      started = true;
      let ended = true;
      try {
        for await (const chunk of response.body) {
          if (signal?.aborted) return;
          yield { body: Buffer.from(chunk) };
          ended = chunk[chunk.length - 1] === 0x0a;
        }
      } catch {}
      // (Gone halfway through a line: what comes next is a line of its own.)
      if (!ended) yield { body: Buffer.from("\n") };
      last = "";
    } else {
      await response?.body?.cancel().catch(() => {});
    }
    if (signal?.aborted) return;
    const own = machinesWithoutApp();
    if (!own) return started ? undefined : yield* answer(503, { message: UNREADABLE });
    if (!started) yield head;
    started = true;
    const line = JSON.stringify(own);
    if (line !== last) {
      yield { body: Buffer.from(line + "\n") };
      last = line;
    }
    await pause(timing.look, signal);
  }
}

// What this box can say itself of what's read.
const OWN_ANSWERS: Record<string, () => MacMachines | Hosts | null> = { "kuvo/machines": machinesWithoutApp, "kuvo/hosts": hostsWithoutApp };

/** Whether `route` is one of those this file answers. */
export const isMachinesRoute = (route: string): boolean => /^kuvo\/(machines|hosts)(\/|$)/.test(route);

/** A phone asking about this Mac's machines: the app says, and while it isn't there this box says
 * what it can, and that the rest needs the app. */
export async function* machinesRoute(request: LinkRequest, phone: Asker | undefined, signal: AbortSignal | undefined, route: string, timing: AppTiming = TIMING): AsyncGenerator<AnswerPiece> {
  const read = request.method.toUpperCase() === "GET";
  if (read && route === "kuvo/machines/events") return yield* machinesFollowed(request, phone, signal, timing);
  // Only what's read has this box to fall back on. What changes something may take as long as it
  // takes (adding a machine checks it over SSH first), and can't be said not to have happened.
  const response = read ? await appWithin(request, phone, signal, timing.wait) : await appAnswer(request, phone, signal);
  const own = read ? OWN_ANSWERS[route] : undefined;
  // (An app that won't say, whose list wouldn't read as it started, isn't the last word on it.)
  if (response && (!own || response.status === 200)) return yield* passedOn(response, signal);
  await response?.body?.cancel().catch(() => {});
  if (signal?.aborted) return;
  if (own) {
    const said = own();
    return yield* answer(said ? 200 : 503, said ?? { message: UNREADABLE });
  }
  yield* answer(503, { message: `${notOpen()}. Open it there, then try again.` });
}
