// Edits to a bot whose computer is away, held by the box that was asked (PROTOCOL.md, `kuvo/bots`,
// "Held for another computer"): a client asks any box to change or delete a bot that lives on
// another of your computers, and that box takes it at once, keeps it for that computer, and hands
// it on by mail when that computer answers. So no client keeps an outbox of its own.
//
// One a bot, in `run/bots-held/<bot id>.json`: each field the last you gave it, and a delete over
// all of it. Sealed with this box's own secret, as a route left it: what anything else on this
// computer leaves there never goes out as you (this Mac's box keeps its keys in your Keychain).
// Kept on disk, as a machine's routes from a Mac over SSH are answered by a process of their own
// (`box route`) with no relay connection: its link sends what's held, each round.
//
// The computer that keeps the bot does it as Edit Bot or Delete Bot… would there, once for each
// edit, and answers; what it refuses is let go, and said, in plain words, to every client that
// follows this box's bots.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { LOOKS } from "../../shared/routes/bots";
import { listOf, locked, textOf, writePrivate } from "../files";
import { RUN } from "../home";
import { readPeerAgents } from "../peers/directory";
import { computerName } from "../peers/computer-name";
import { mailFor, peersOf } from "../peers/known";
import { readTold } from "../work-queue/told";
import { ownName } from "../letters/start";
import { readLink } from "../state";
import { botHere, isModel, noteBotsChanged } from "./here";
import { givenJob } from "./jobs";
import { fitsLook } from "./make";
import type { BotChange } from "./edit";
import type { HeldEdit, RefusedEdit } from "../../shared/routes/bots";
import type { MailSender, Peer } from "../peers/known";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";

/** What a box's agents' mail says (`kuvo/info`'s `features` too) when it holds edits for your other
 * computers and takes those held for it. */
export const HELD_FEATURE = "bots.held";

export const HELD = path.join(RUN, "bots-held");
const LOCK = path.join(RUN, ".bots-held.lock");
const REFUSED_FILE = path.join(HELD, "refused.json");
// What this box did with edits held for it elsewhere, by asker and id: each done once.
const TAKEN_FILE = path.join(RUN, "bots-held-taken.json");
const BOT_ID = /^bot_[A-Za-z0-9]{1,60}$/;
const EDIT_ID = /^bte_[A-Za-z0-9_-]{16,40}$/;
const FIELDS = ["name", "look", "personality", "job", "model", "work"] as const;

/** How often what's held goes again to a computer that answers (the relay keeps nothing), and how
 * long a refusal shows. */
const AGAIN_AFTER = 60_000;
const REFUSAL_SHOWS = 86_400_000;
const MOST_REFUSALS = 50;
/** How long a keeper remembers what it did with each held edit (one sent again comes within
 * minutes; a few days covers a holder that was itself off meanwhile), and how many at most. */
const TAKEN_MEMORY = 7 * 86_400_000;
const MOST_TAKEN = 1_000;

/** An edit held here: the bot's computer by its key (empty while this box doesn't know it: one you
 * removed, named by the client in `on`), the change (`PATCH kuvo/bots/<id>`'s fields) or a delete,
 * since when it's held and when it last changed, this version's id, and its seal. */
interface Held {
  id: string;
  bot: string;
  to: string;
  on?: string;
  change?: BotChange;
  delete?: true;
  since: number;
  at: number;
  seal?: string;
}

/** How what's held goes at once, where this process sends it (this Mac's box, a machine's link). */
export const heldSoon: { send: () => void } = { send: () => {} };

const fileOf = (bot: string) => path.join(HELD, `${bot}.json`);

// The seal: an HMAC of the record with a key from this box's secret, which only it has (this Mac's
// box from your Keychain, in memory).
function sealOf(held: Omit<Held, "seal">, link: LinkState | null): string | null {
  if (!link?.secret) return null;
  const key = crypto.createHmac("sha256", Buffer.from(link.secret, "base64url")).update("kuvo bot edits held").digest();
  const { id, bot, to, on, change, since, at } = held;
  return crypto.createHmac("sha256", key).update(JSON.stringify([id, bot, to, on ?? null, change ?? null, held.delete === true, since, at])).digest("base64url");
}

function readHeld(bot: string, link: LinkState | null = readLink()): Held | null {
  let kept: unknown;
  try { kept = JSON.parse(textOf(fileOf(bot)) ?? ""); } catch { return null; }
  if (!isObject(kept) || kept.bot !== bot || typeof kept.id !== "string" || !EDIT_ID.test(kept.id) || typeof kept.to !== "string") return null;
  if (kept.on !== undefined && typeof kept.on !== "string") return null;
  if (typeof kept.since !== "number" || typeof kept.at !== "number" || typeof kept.seal !== "string") return null;
  if (kept.delete !== true && !isObject(kept.change)) return null;
  const held = kept as unknown as Held;
  const seal = sealOf(held, link);
  if (!seal || held.seal!.length !== seal.length || !crypto.timingSafeEqual(Buffer.from(seal), Buffer.from(held.seal!))) return null;
  return held;
}

function writeHeld(held: Omit<Held, "seal">, link: LinkState | null): boolean {
  const seal = sealOf(held, link);
  if (!seal) return false;
  writePrivate(fileOf(held.bot), JSON.stringify({ ...held, seal }));
  return true;
}

/** Every edit held here, as kept (unsealed ones left out). */
function allHeld(link: LinkState | null = readLink()): Held[] {
  return listOf(HELD).map(name => /^(bot_[A-Za-z0-9]{1,60})\.json$/.exec(name)?.[1]).filter((bot): bot is string => Boolean(bot))
    .map(bot => readHeld(bot, link)).filter((held): held is Held => Boolean(held)).sort((a, b) => a.since - b.since);
}

/** The computer that keeps `bot`, as its box last told this one (its agents), or else as the client
 * named it (`on`: its key, or its id on its Mac): one of this box's peers, never this box. */
export function keeperOf(bot: string, on: string | null | undefined, link: LinkState | null = readLink()): Peer | null {
  const peers = peersOf(link);
  const told = readPeerAgents();
  const listing = peers.find(peer => told[peer.key]?.list?.some(agent => agent.kind === "bot" && agent.id === bot));
  if (listing) return listing;
  if (!on) return null;
  return peers.find(peer => peer.key === on || (peer.kind === "machine" && peer.id === on)) ?? null;
}

const nameOf = (held: Pick<Held, "to" | "on">, link: LinkState | null): string => {
  const peer = held.to ? peersOf(link).find(each => each.key === held.to) : null;
  return peer ? computerName(peer) : held.on || "another computer";
};

const viewOf = (held: Held, link: LinkState | null): HeldEdit => ({
  bot: held.bot,
  box: held.to,
  computer: nameOf(held, link),
  ...(held.delete ? { delete: true } : { change: held.change as Record<string, unknown> }),
  since: held.since,
});

/** What's held here for your other computers, and what they refused lately, as `kuvo/bots` lists
 * them for clients to show. */
export function heldLists(link: LinkState | null = readLink(), now = Date.now()): { held: HeldEdit[]; refused: RefusedEdit[] } {
  return { held: allHeld(link).map(each => viewOf(each, link)), refused: readRefused(now) };
}

// A change as Edit Bot gives it, checked as far as this box can without the bot (its computer
// checks the rest as it takes it): only the fields a change has, each of the right kind.
function checkedChange(given: unknown): { change: BotChange } | { error: string } {
  if (!isObject(given)) return { error: "That isn’t a change to a bot." };
  const change: Record<string, unknown> = {};
  for (const field of FIELDS) if (field in given) change[field] = given[field];
  if (!Object.keys(change).length) return { error: "That isn’t a change to a bot." };
  if ("name" in change) {
    change.name = plainName(change.name);
    if (!change.name) return { error: "A bot needs a name." };
  }
  if ("look" in change && !fitsLook({ colors: [...LOOKS.colors], shapes: [...LOOKS.shapes], faces: [...LOOKS.faces] }, change.look)) return { error: "That isn’t a look a bot can have." };
  if ("personality" in change && change.personality !== null && typeof change.personality !== "string") return { error: "That isn’t a personality." };
  if ("job" in change) {
    const checked = givenJob(change.job);
    if (checked.error) return { error: checked.error };
  }
  if ("model" in change && !isModel(change.model)) return { error: "That isn’t a model." };
  if ("work" in change && change.work !== null && !isObject(change.work)) return { error: "That isn’t a bot’s work settings." };
  return { change: change as BotChange };
}

// `later` on top of `earlier`, field by field: a work's settings each by its own.
function merged(earlier: BotChange | undefined, later: BotChange): BotChange {
  const next: Record<string, unknown> = { ...(earlier ?? {}) };
  for (const [field, value] of Object.entries(later)) {
    next[field] = field === "work" && isObject(value) && isObject(next.work) ? { ...next.work, ...value } : value;
  }
  return next as BotChange;
}

/** What `holdEdit` answers: held (202), or why not. */
export type HoldAnswer = { status: 202; value: { held: HeldEdit } } | { status: 400 | 404 | 503; value: { message: string } };

/** A change to `bot` (or its delete), which lives on another of your computers, held here for it:
 * on top of what's held already, a field at a time, a delete over all of it. `on`: the computer as
 * the client names it, for one this box hasn't heard of the bot from. */
export function holdEdit(bot: string, given: { change: unknown } | { delete: true }, on: string | null | undefined, now = Date.now()): HoldAnswer {
  const no = (status: 400 | 404 | 503, message: string): HoldAnswer => ({ status, value: { message } });
  if (!BOT_ID.test(bot)) return no(404, "That bot isn’t there any more.");
  const link = readLink();
  const keeper = keeperOf(bot, on, link);
  // (A computer this box doesn't know now, named by the client: one you removed. It goes there if
  // you add it again.)
  const named = on ? plainName(on).slice(0, 200) : "";
  if (!keeper && !named) return no(404, "That bot isn’t there any more.");
  const checked = "change" in given ? checkedChange(given.change) : null;
  if (checked && "error" in checked) return no(400, checked.error);
  let answer: HoldAnswer | null = null;
  try {
    fs.mkdirSync(HELD, { recursive: true, mode: 0o700 });
    locked(LOCK, () => {
      const before = readHeld(bot, link);
      if (before?.delete && checked) {
        answer = no(404, `That bot is deleted: it goes from ${keeper ? computerName(keeper) : named} once it’s back.`);
        return;
      }
      const held: Held = {
        id: `bte_${crypto.randomBytes(16).toString("base64url")}`,
        bot,
        to: keeper?.key ?? "",
        ...(keeper ? {} : { on: named }),
        ...(checked ? { change: merged(before?.change, checked.change) } : { delete: true as const }),
        since: before?.since ?? now,
        at: now,
      };
      if (!writeHeld(held, link)) {
        answer = no(503, `${ownName()} can’t keep it now. Try again in a moment.`);
        return;
      }
      sent.delete(bot);
      dropRefusal(bot);
      answer = { status: 202, value: { held: viewOf(held, link) } };
    });
  } catch {
    return no(503, `${ownName()} can’t keep it now. Try again in a moment.`);
  }
  noteBotsChanged();
  heldSoon.send();
  return answer!;
}

/** For a client: whether `bot` lives here (its route changes it) or is held for another computer. */
export const livesHere = (bot: string): boolean => Boolean(botHere(bot));

// When each held edit last went, in this process, by bot.
const sent = new Map<string, { id: string; at: number }>();

/** `key` answers again: what's held for it goes now, not at its next minute. */
export function heldBack(key: string): void {
  let any = false;
  for (const held of allHeld()) {
    if (held.to !== key) continue;
    sent.delete(held.bot);
    any = true;
  }
  if (any) heldSoon.send();
}

/** What's held here, sent by this process's relay connection to each computer it's for (each
 * round, and as it's held): again each minute until it answers, and at once when it's back. One
 * whose bot another of your computers lists now goes there instead (it moved). Only to a computer
 * that takes it (`HELD_FEATURE`); one that doesn't yet waits until it's updated. */
export function sendHeld(host: Pick<LinkHost, "send" | "welcomed"> | null | undefined, link: LinkState | null = readLink(), now = Date.now()): void {
  if (!host?.welcomed || !link) return;
  const told = readPeerAgents();
  for (let held of allHeld(link)) {
    const keeper = keeperOf(held.bot, held.on, link);
    if (keeper && keeper.key !== held.to) {
      const moved = locked(LOCK, () => {
        const now = readHeld(held.bot, link);
        if (now?.id !== held.id) return null;
        const { on: _, ...rest } = held;
        const next = { ...rest, to: keeper.key };
        return writeHeld(next, link) ? next : null;
      });
      if (!moved) continue;
      held = moved;
      sent.delete(held.bot);
      noteBotsChanged();
    }
    const last = sent.get(held.bot);
    if (last?.id === held.id && now - last.at < AGAIN_AFTER) continue;
    const peer = peersOf(link).find(each => each.key === held.to);
    if (!peer || !(told[peer.key]?.features ?? []).includes(HELD_FEATURE)) continue;
    const bytes = mailFor(peer, { botEdit: { id: held.id, bot: held.bot, ...(held.delete ? { delete: true } : { change: held.change }), at: held.at }, at: now }, link);
    if (!bytes) continue;
    try {
      host.send(bytes);
      sent.set(held.bot, { id: held.id, at: now });
    } catch {}
  }
}

// What the computers held edits went to refused lately, the newest first.
function readRefused(now = Date.now()): RefusedEdit[] {
  try {
    const kept: unknown = JSON.parse(textOf(REFUSED_FILE) ?? "");
    if (!isObject(kept) || !Array.isArray(kept.refused)) return [];
    return kept.refused.filter((each): each is RefusedEdit => isObject(each) && typeof each.bot === "string" && typeof each.box === "string" && typeof each.computer === "string"
      && typeof each.message === "string" && typeof each.at === "number" && now - each.at < REFUSAL_SHOWS);
  } catch {
    return [];
  }
}

function writeRefused(refused: RefusedEdit[]): void {
  if (!refused.length) return void fs.rmSync(REFUSED_FILE, { force: true });
  writePrivate(REFUSED_FILE, JSON.stringify({ refused: refused.slice(0, MOST_REFUSALS) }));
}

// (Under LOCK.)
function dropRefusal(bot: string): void {
  const refused = readRefused();
  if (refused.some(each => each.bot === bot)) writeRefused(refused.filter(each => each.bot !== bot));
}

/** The answer from the computer a held edit went to, from that computer only: done, it's let go;
 * refused for good, it's let go and said; one it can't take now (the bot moving, its engine
 * starting) goes again. A bot that's no longer there: a delete is done; a change goes to the
 * computer that lists it now, or is refused. */
export function takeBotEdited(sender: MailSender, given: unknown, now = Date.now()): void {
  if (!isObject(given) || typeof given.id !== "string" || !EDIT_ID.test(given.id) || typeof given.bot !== "string" || !BOT_ID.test(given.bot)) return;
  const status = given.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) return;
  const link = readLink();
  const bot = given.bot;
  let changed = false;
  try {
    locked(LOCK, () => {
      const held = readHeld(bot, link);
      if (!held || held.id !== given.id || held.to !== sender.key) return;
      if (status === 409 || status >= 500) {
        sent.set(bot, { id: held.id, at: now });
        return;
      }
      if (status === 404 && !held.delete) {
        const keeper = keeperOf(bot, null, link);
        if (keeper && keeper.key !== held.to) {
          // (Moved meanwhile: it goes where the bot is now.)
          changed = writeHeld({ ...held, to: keeper.key }, link);
          sent.delete(bot);
          return;
        }
      }
      fs.rmSync(fileOf(bot), { force: true });
      sent.delete(bot);
      changed = true;
      if (status < 300 || (status === 404 && held.delete)) return;
      const computer = nameOf(held, link);
      const why = isObject(given) && typeof given.message === "string" ? plainName(given.message).slice(0, 500) : "";
      const message = held.delete
        ? `${computer} didn’t delete the bot as you asked while it was away.${why ? ` ${why}` : ""}`
        : `${computer} didn’t take the changes you made while it was away.${why ? ` ${why}` : ""}`;
      writeRefused([{ bot, box: held.to, computer, message, at: now }, ...readRefused(now).filter(each => each.bot !== bot)]);
    });
  } catch {}
  if (changed) {
    noteBotsChanged();
    if (status === 404) heldSoon.send();
  }
}

// What this box did with each held edit sent to it, by asker and id.
interface Taken { until: number; status: number; message?: string }

function readTaken(now: number): Record<string, Taken> {
  try {
    const kept: unknown = JSON.parse(textOf(TAKEN_FILE) ?? "");
    if (!isObject(kept)) return {};
    return Object.fromEntries(Object.entries(kept).filter(([, each]) => isObject(each) && typeof each.until === "number" && each.until > now && typeof each.status === "number")) as Record<string, Taken>;
  } catch {
    return {};
  }
}

function keepTaken(key: string, taken: Taken, now: number): void {
  try {
    const kept = readTaken(now);
    delete kept[key];
    kept[key] = taken;
    const entries = Object.entries(kept);
    writePrivate(TAKEN_FILE, JSON.stringify(Object.fromEntries(entries.slice(Math.max(0, entries.length - MOST_TAKEN)))));
  } catch {}
}

// Those under way in this process, by asker and id (one sent again meanwhile isn't done twice).
const taking = new Set<string>();

/** What this box does with a held edit: as Edit Bot changes a bot, or Delete Bot… deletes it. */
export interface EditSteps {
  change: (bot: string, change: BotChange) => Promise<{ status: number; value: unknown }>;
  delete: (bot: string) => Promise<{ status: number; value: unknown }>;
}

/** An edit another of your computers held for this one, done here as a client's would be, once for
 * each id, and answered (`reply`); one sent again is answered as it went. One this box can't do
 * now (the bot moving, its engine starting) isn't remembered: it's done when it comes again. */
export async function takeBotEdit(sender: MailSender, given: unknown, reply: (payload: Record<string, unknown>) => void, steps: EditSteps, now = Date.now()): Promise<void> {
  if (!isObject(given) || typeof given.id !== "string" || !EDIT_ID.test(given.id) || typeof given.bot !== "string" || !BOT_ID.test(given.bot)) return;
  if (given.delete !== true && !isObject(given.change)) return;
  const link = readLink();
  // (Only from one of your computers that's still a peer.)
  const peer = peersOf(link).find(each => each.key === sender.key);
  if (!peer) return;
  const { id, bot } = given;
  const answer = (status: number, message?: string) => reply({ botEdited: { id, bot, status, ...(message ? { message } : {}) } });
  const key = `${sender.key} ${id}`;
  if (taking.has(key)) return;
  const kept = readTaken(now)[key];
  if (kept) return answer(kept.status, kept.message);
  // (From a machine Macs share outside one setup: another person may use it.)
  if (readTold(sender.key)?.shared) return answer(403, `${ownName()} doesn’t take changes to its bots from ${computerName(peer)}, a machine shared with other Macs.`);
  taking.add(key);
  try {
    let done: { status: number; value: unknown };
    try {
      done = given.delete === true ? await steps.delete(bot) : await steps.change(bot, given.change as BotChange);
    } catch {
      done = { status: 503, value: { message: `Something went wrong on ${ownName()}.` } };
    }
    const message = isObject(done.value) && typeof done.value.message === "string" ? done.value.message : undefined;
    if (done.status !== 409 && done.status < 500) keepTaken(key, { until: now + TAKEN_MEMORY, status: done.status, ...(message ? { message } : {}) }, now);
    answer(done.status, message);
  } finally {
    taking.delete(key);
  }
}

/** All this process remembers forgotten (a test's: what's on disk stays, as for a box that started
 * again). */
export function forgetHeldSends(): void {
  sent.clear();
  taking.clear();
}
