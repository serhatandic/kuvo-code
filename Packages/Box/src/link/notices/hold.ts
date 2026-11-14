// Notices held while you're at a computer (PROTOCOL.md, "kuvo/attention")
// A client in use (the Mac app, while you're at the Mac) tells the box so, for a short lease it
// renews. While one is, each notice waits a little before it goes to your phones, and doesn't go
// if it was answered meanwhile (a permission, a question, an ask) or seen: its conversation came
// on that client's screen, or the client showed it in a notification of its own. When the last
// lease ends (it ran out, or the client said it's not in use), what waits goes at once; with none,
// notices go at once. So a client that vanishes (a Mac's lid closed) holds nothing back for longer
// than a hold.

import path from "node:path";
import { NOTICE_CATCHUP_MS } from "../../agents/usage/notices";
import { finishUsage, usageDelivered } from "./usage-delivery";
import { isObject } from "../../shared/json";
import { RUN } from "../home";
import type { Notice, NoticeCategory } from "./notice";

/** A notification a client showed: of a conversation's news or what it asks (`ask`), or of one request. */
export interface ShownNotice {
  session: string;
  ask: boolean;
  request?: string;
}

/** What a client said of its use (`attentionGiven`): its lease, the conversations on its screen, its notifications. */
export interface Attention {
  seconds: number;
  sessions: string[];
  shown: ShownNotice[];
}

/** A notice held: when it came (`at` by the clock, `wall` by the date), when its hold ends, whether
 * it was seen, and when it's tried again after it couldn't go. */
export interface HeldNotice {
  notice: Notice;
  at: number;
  wall: number;
  due: number;
  seen: boolean;
  retry?: number;
}

/** What's kept of a held notice for a bridge that starts again (`run/held-notices.json`): when it
 * came, by the date, and whether it was held for a client in use (`attended`; one kept before
 * bridge 0.9.61 doesn't say). */
export interface KeptNotice {
  notice: Notice;
  at: number;
  seen: boolean;
  attended?: boolean;
}

/** A timer of the hold's clock. */
type Timer = ReturnType<typeof setTimeout>;

/** What a NoticeHold is made with (each said in its constructor's comment). */
export interface NoticeHoldOptions {
  send: (notice: Notice) => boolean;
  now?: () => number;
  wall?: () => number;
  setTimer?: (then: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  save?: (entries: KeptNotice[]) => void;
  /** What a bridge before kept, as read from its file: checked here. */
  held?: KeptNotice[];
}

// How long a notice waits while you're at a computer: what's asked of you less than news.
export const ASK_HOLD = 30_000;
export const NEWS_HOLD = 60_000;
// The longest lease a client gets: one it doesn't renew is over by then.
export const LONGEST_LEASE = 60_000;
// A client's notification of a notice's news and the notice itself come apart (each box hears the
// engine on its own): one shown this long before the notice still counts.
export const SHOWN_WITHIN = 10_000;
// Where a running bridge keeps what's held.
export const HELD_FILE = path.join(RUN, "held-notices.json");
// What a bridge before held waits this long for its clients to say they're still in use (a Mac
// renews every 15 seconds), as they were when it stopped: then it goes, unless they're back.
export const RESTORED_WAIT = 20_000;
// A notice that couldn't go (no relay just now) is tried again this often, for this long.
const RETRY_EVERY = 5_000;
const TRY_FOR = 10 * 60_000;
// Requests answered lately: one answered before its notice was made (the engine is asked who's
// asking first) never goes.
const MOST_ANSWERED = 200;
const ASKED = new Set(["permission", "question", "ask"]);
export const holdFor = (category: NoticeCategory): number => ASKED.has(category) ? ASK_HOLD : NEWS_HOLD;

// What a notice is about (its conversation, or group chat), and what answering takes it back.
const shownIn = (notice: Notice): string | undefined => notice?.data?.session ?? notice?.data?.group ?? notice?.thread;
const answeredBy = (notice: Notice): string | undefined => notice?.data?.request ?? notice?.data?.ask;
// Whether a client's notification (`{session, ask, request?}`) is of this notice: the request or
// ask it's about, when it names one; else its conversation, and asked of you or news alike.
const showsNotice = (shown: ShownNotice, notice: Notice): boolean => shown.request !== undefined
  ? shown.request === answeredBy(notice)
  : shown.session === shownIn(notice) && shown.ask === ASKED.has(notice.category);

// What a client said (`POST kuvo/attention`'s body, or a Mac's mail): `{seconds, sessions,
// shown}`, its lease cut to the longest; null for what isn't that.
export function attentionGiven(given: unknown): Attention | null {
  if (!isObject(given) || typeof given.for !== "number" || !Number.isFinite(given.for) || given.for < 0) return null;
  if (given.sessions !== undefined && (!Array.isArray(given.sessions) || !given.sessions.every(each => typeof each === "string"))) return null;
  if (given.shown !== undefined && (!Array.isArray(given.shown)
    || !given.shown.every(each => isObject(each) && typeof each.session === "string" && (each.ask === undefined || typeof each.ask === "boolean")
      && (each.request === undefined || typeof each.request === "string")))) return null;
  return {
    seconds: Math.min(given.for, LONGEST_LEASE / 1000),
    sessions: (given.sessions ?? []).slice(0, 50),
    shown: (given.shown ?? []).slice(0, 50).map(each => ({ session: each.session, ask: each.ask === true, ...(each.request !== undefined ? { request: each.request } : {}) })),
  };
}

// A clock for time gone by that a change of the date or time can't move.
const monotonic = () => performance.now();

export class NoticeHold {
  declare send: NoticeHoldOptions["send"];
  declare now: () => number;
  declare wall: () => number;
  declare setTimer: NonNullable<NoticeHoldOptions["setTimer"]>;
  declare clearTimer: NonNullable<NoticeHoldOptions["clearTimer"]>;
  declare save: NonNullable<NoticeHoldOptions["save"]>;
  /** Until when each client is in use, by the clock. */
  declare leases: Map<string, number>;
  declare heard: Map<string, number>;
  declare shown: (ShownNotice & { at: number })[];
  declare answered: string[];
  declare timer: Timer | null;
  declare held: HeldNotice[];
  /** What was last kept (`NoticeHold.kept`). */
  declare saved: string;

  // `send(notice)`: to your phones; false when it can't go now. `now`, `setTimer` and `clearTimer`:
  // the clock (a test's own), `now` for time gone by; `wall`, the date, for what's kept. `save(entries)`:
  // what's held, kept for a bridge that starts again, which gives them back as `held`: what was held
  // for a client in use with the rest of its hold, and what was seen kept seen, while its clients
  // have a moment to say they're still there (`RESTORED_WAIT`); what was only waiting for the relay,
  // at once.
  constructor({ send, now = monotonic, wall = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, save = () => {}, held = [] }: NoticeHoldOptions) {
    Object.assign(this, { send, now, wall, setTimer, clearTimer, save });
    this.leases = new Map();
    // When each client last spoke (its word's `at`): an older word, come late, is let go.
    this.heard = new Map();
    // Notifications clients showed lately, for notices that come after them.
    this.shown = [];
    this.answered = [];
    this.timer = null;
    const start = this.now(), today = this.wall();
    const restored = (Array.isArray(held) ? held : []).filter(entry => isObject(entry?.notice) && typeof entry.at === "number");
    this.held = restored.map(entry => {
      const age = Math.min(Math.max(today - entry.at, 0), TRY_FOR);
      // One held for a client keeps the rest of its hold; one only waiting for the relay goes now.
      // (One kept before bridge 0.9.61 doesn't say: taken as held for a client, that once.)
      const due = entry.attended !== false ? start - age + holdFor(entry.notice.category) : start - age;
      return { notice: entry.notice, wall: entry.at, at: start - age, due: Math.max(due, start - age), seen: entry.seen === true };
    });
    if (restored.some(entry => entry.attended !== false)) this.leases.set("restored", start + RESTORED_WAIT);
    this.saved = NoticeHold.kept(this.held);
    this.settle();
  }

  // What's kept of what's held, as JSON: when each was made, by the date.
  static kept(entries: HeldNotice[]): string {
    // `attended`: held because a client was in use, not only waiting for the relay.
    return JSON.stringify(entries.map(({ notice, wall, seen, at, due }) => ({ notice, at: wall, seen, attended: due > at })));
  }

  // Whether a client is in use now, and how many notices wait.
  get inUse(): boolean {
    const now = this.now();
    return [...this.leases.values()].some(until => until > now);
  }
  get count(): number { return this.held.length; }

  // `client` is in use for `seconds` more, with `sessions` on its screen and `shown` in its own
  // notifications just now; 0: it isn't any more. `at`: when it said so, by its own clock, for words
  // that can come out of order (mail).
  attend(client: string, { seconds, sessions = [], shown = [] }: { seconds: number; sessions?: string[]; shown?: ShownNotice[] }, at?: number): void {
    if (typeof at === "number") {
      if (at < (this.heard.get(client) ?? -Infinity)) return;
      this.heard.set(client, at);
    }
    if (seconds > 0) {
      const now = this.now();
      this.leases.set(client, now + seconds * 1000);
      const onScreen = new Set<string | undefined>(sessions);
      for (const entry of this.held) if (onScreen.has(shownIn(entry.notice))) entry.seen = true;
      // Each notification stands for one notice: the oldest held of it, or the next to come.
      this.shown = this.shown.filter(each => now - each.at < SHOWN_WITHIN);
      for (const each of shown) {
        const entry = this.held.find(entry => !entry.seen && showsNotice(each, entry.notice));
        if (entry) entry.seen = true;
        else this.shown.push({ ...each, at: now });
      }
      this.shown = this.shown.slice(-200);
    } else {
      this.leases.delete(client);
    }
    this.settle();
  }

  // A notice for your phones: it goes now, or once its hold ends. True: it's taken.
  tell(notice: Notice): boolean {
    if (notice.category === "usage" && notice.data?.notice) {
      if (usageDelivered(notice)) return true;
      // Catch-up can hear a fact again while its earlier attempt waits for a client or relay.
      if (this.held.some(entry => entry.notice.category === "usage" && entry.notice.data?.notice === notice.data?.notice)) return false;
    }
    const answer = answeredBy(notice);
    if (answer !== undefined && this.answered.includes(answer)) return true;
    const now = this.now();
    const inUse = this.inUse;
    // Shown by a client in use just before it came: that notification is spent.
    const mark = inUse ? this.shown.findIndex(each => now - each.at < SHOWN_WITHIN && showsNotice(each, notice)) : -1;
    const seen = mark >= 0;
    if (seen) this.shown.splice(mark, 1);
    this.held.push({ notice, at: now, wall: this.wall(), due: inUse ? now + holdFor(notice.category) : now, seen });
    this.settle();
    return notice.category !== "usage" || usageDelivered(notice);
  }

  /** Cancel a queued usage copy when the bridge's agreed forwarder is another computer. */
  reconcileUsage(eligible: string[], known: string[]): void {
    const allowed = new Set(eligible), told = new Set(known);
    this.held = this.held.filter(entry => entry.notice.category !== "usage"
      || !told.has(entry.notice.data?.notice ?? "") || allowed.has(entry.notice.data?.notice ?? ""));
    this.settle();
  }

  // A request or an ask answered (or gone): its notice, waiting, never goes.
  resolve(id: unknown): void {
    if (typeof id !== "string" || !id) return;
    this.answered.push(id);
    if (this.answered.length > MOST_ANSWERED) this.answered.shift();
    this.held = this.held.filter(entry => answeredBy(entry.notice) !== id);
    this.settle();
  }

  // Sends what's due, and wakes again when the next is (or a lease ends with something waiting).
  settle(): void {
    const now = this.now();
    for (const [client, until] of this.leases) if (until <= now) this.leases.delete(client);
    const waiting = this.leases.size > 0;
    // When an entry may go: its hold's end while a client's in use, else now; one that couldn't
    // go waits for its next try.
    const when = (entry: HeldNotice) => Math.max(waiting ? entry.due : -Infinity, entry.retry ?? -Infinity);
    const kept: HeldNotice[] = [];
    for (const entry of this.held) {
      if (entry.notice.category === "usage") {
        const expires = Number(entry.notice.data?.expires ?? Infinity);
        const made = Number(entry.notice.data?.at ?? entry.wall);
        if (this.wall() >= expires || this.wall() - made >= NOTICE_CATCHUP_MS) continue;
      }
      if (when(entry) > now) {
        kept.push(entry);
        continue;
      }
      // Seen: news needs telling no more; what's asked of you waits until it's answered, and goes
      // once no one's at a client (you saw it, and left it unanswered).
      if (entry.seen && !ASKED.has(entry.notice.category)) {
        finishUsage(entry.notice);
        continue;
      }
      if (entry.seen && waiting) {
        kept.push({ ...entry, due: Infinity });
        continue;
      }
      if (this.send(entry.notice)) {
        finishUsage(entry.notice);
        continue;
      }
      if (now - entry.at < TRY_FOR) kept.push({ ...entry, retry: now + RETRY_EVERY });
    }
    this.held = kept;
    const text = NoticeHold.kept(kept);
    if (text !== this.saved) {
      this.saved = text;
      this.save(JSON.parse(text));
    }
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const next = Math.min(...kept.map(when), ...(kept.length ? this.leases.values() : []));
    if (Number.isFinite(next)) this.timer = this.setTimer(() => this.settle(), Math.max(0, next - now));
  }
}