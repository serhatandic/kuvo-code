// Already in a setup? (PROTOCOL.md, "Your setup", "Already in a setup?"): what's on a computer,
// judged into one verdict, by the box, for a client to draw. Each box found there says what it is by
// its card (`card.ts`), or, an older box with none, by a few fields of its link.json: the Macs that
// set it up, when each was last heard from, their names, and whether it has phones. Found by a Mac
// adding that computer over SSH (the probe's lines, `POST kuvo/setup/judge`), or by Kuvo Code as it
// opens on its own Mac (`kuvo-link.js here`). What's found is only a hint, never trusted: a lie
// changes a warning at most. A main computer unheard of for long is still a main computer: never
// `free`, as silence alone never hands a setup over.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { processRuns } from "../../shared/platform";
import { plainName } from "../../shared/text";
import { homeFolder } from "../home";
import { KEY, macsOf, ownKey, peersOf } from "../peers/known";
import { moveUnderWay } from "../rehome/state";
import { followedSetup } from "./record";
import { setupView } from "./view";
import type { HERE, JUDGED } from "../../shared/routes/box";
import type { Infer } from "../../shared/shape";
import type { LinkState } from "../state";

export type Judged = Infer<typeof JUDGED>;
export type Verdict = Judged["verdict"];
type JudgedBox = Judged["boxes"][number];

/** A box's card as it was found, cleaned (`card.ts` writes it). `macs` is left out by a card from
 * before it said them. */
export interface FoundCard {
  setup: string | null;
  role: "primary" | "member" | null;
  primary: { key: string; name: string; heard: number | null } | null;
  self: { key: string | null; name: string; kind: "mac" | "machine" | null };
  app: boolean;
  /** How many computers its setup has and how many work items are here: null where the card
   * doesn't say (an older or broken one), which is never taken for none. */
  computers: number | null;
  items: number | null;
  macs?: { key: string; name: string }[];
}

/** What an older box's link.json says, for want of a card: the Macs that set it up (the last, `mac`, first),
 * when each was last heard from, their names, and whether it has phones. */
export interface FoundLink {
  macs: string[];
  seen: Record<string, number>;
  names: Record<string, string>;
  phones: boolean;
}

/** A box found on a computer: its folder (from the home folder), whether it's Kuvo Code's own on a
 * Mac (`app`, in its app's folder) or a machine's (`~/.kuvo-code`), its card, and what its link.json
 * says. */
export interface FoundBox {
  folder: string;
  app: boolean;
  card?: FoundCard;
  link?: FoundLink;
}

/** Who's ours, as the box judging says it: its own key, its setup, and every computer of it (in its
 * setup, or set up by it). */
export interface Ours {
  key: string | null;
  setup: string | null;
  keys: Set<string>;
}

const MOST_BOXES = 8;
const words = (value: unknown, most = 100) => plainName(value).slice(0, most);
const key = (value: unknown): string | null => (typeof value === "string" && KEY.test(value) ? value : null);
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
const SETUP_ID = /^set_[A-Za-z0-9_-]{22}$/;

/** A card as it came, cleaned; undefined for what isn't one. */
export function cardOf(given: unknown): FoundCard | undefined {
  if (!isObject(given) || !isObject(given.self)) return undefined;
  const primary = isObject(given.primary) && key(given.primary.key) ? { key: key(given.primary.key)!, name: words(given.primary.name), heard: time(given.primary.heard) } : null;
  const kind = given.self.kind === "mac" || given.self.kind === "machine" ? given.self.kind : null;
  return {
    setup: typeof given.setup === "string" && SETUP_ID.test(given.setup) ? given.setup : null,
    role: given.role === "primary" || given.role === "member" ? given.role : null,
    primary,
    self: { key: key(given.self.key), name: words(given.self.name), kind },
    app: given.app === true,
    computers: count(given.computers),
    items: count(given.items),
    ...(Array.isArray(given.macs) ? { macs: given.macs.filter(each => isObject(each) && key(each.key)).slice(0, 16).map(each => ({ key: each.key as string, name: words(each.name) })) } : {}),
  };
}

/** What an older box's link.json says, read from it (`here`, on this computer): the few fields a
 * probe prints, nothing else. */
export function linkOf(given: unknown): FoundLink | undefined {
  if (!isObject(given)) return undefined;
  const macs = [...new Set([given.mac, ...(Array.isArray(given.macs) ? given.macs : [])].map(key).filter((each): each is string => each !== null))].slice(0, 16);
  const pick = <T>(map: unknown, clean: (value: unknown) => T | null): Record<string, T> => (isObject(map)
    ? Object.fromEntries(Object.entries(map).filter(([each]) => key(each)).slice(0, 16).map(([each, value]) => [each, clean(value)]).filter(([, value]) => value !== null)) : {});
  return { macs, seen: pick(given.macSeen, time), names: pick(given.macNames, value => words(value) || null), phones: Array.isArray(given.phones) && given.phones.length > 0 };
}

/** The boxes a probe found on a computer, from the lines it printed (`RemoteEngineInstaller`'s
 * probe, OpenCodeKit): `box machine|app <folder>`, then that box's `card <json>`, and for an older
 * box `link mac|macs <key>`, `link seen <key> <ms>`, `link name <key> <json string>`, `link phones
 * none|some`. Other lines are left alone. */
export function foundOf(lines: readonly string[]): FoundBox[] {
  const found: FoundBox[] = [];
  const links = new Map<FoundBox, FoundLink>();
  for (const line of lines.slice(0, 2000)) {
    const box = /^box (machine|app) (.{1,500})$/.exec(line);
    if (box) {
      if (found.length >= MOST_BOXES) break;
      found.push({ folder: box[2], app: box[1] === "app" });
      continue;
    }
    const current = found[found.length - 1];
    if (!current) continue;
    if (line.startsWith("card ")) {
      try { current.card ??= cardOf(JSON.parse(line.slice(5))); } catch {}
      continue;
    }
    const field = /^link (mac|macs|seen|name|phones) (\S+)(?: (.+))?$/.exec(line);
    if (!field) continue;
    const kept = links.get(current) ?? { macs: [], seen: {}, names: {}, phones: false };
    links.set(current, kept);
    current.link = kept;
    const [, name, first, rest] = field;
    if (name === "phones") kept.phones = first === "some";
    else if (!key(first)) continue;
    // (The last Mac to set it up first, wherever its line comes.)
    else if (name === "mac") kept.macs = [first, ...kept.macs.filter(each => each !== first)].slice(0, 16);
    else if (name === "macs") { if (!kept.macs.includes(first) && kept.macs.length < 16) kept.macs.push(first); }
    else if (name === "seen" && time(Number(rest)) !== null) kept.seen[first] = Number(rest);
    else if (name === "name" && rest) try { const said = JSON.parse(rest); if (typeof said === "string" && words(said)) kept.names[first] = words(said); } catch {}
  }
  return found;
}

/** Who's ours, as this box says it: itself, its setup, and every computer in it or that it set up. */
export function oursNow(link: LinkState | null | undefined): Ours {
  const own = link ? ownKey(link) : null;
  const view = setupView(link);
  const keys = new Set<string>([...(own ? [own] : []), ...view.computers.map(each => each.key), ...peersOf(link).map(peer => peer.key), ...macsOf(link)]);
  return { key: own, setup: followedSetup(link)?.id ?? null, keys };
}

/** One box found on a computer, judged: `self` (this very box), `ours` (in our setup, or set up by
 * one of ours), `elsewhere` (a member of another setup, or a machine other Macs set up), `main` (the
 * main computer of another setup, or a Mac whose own app runs it), `older` (another Mac set it up,
 * and its box can't say its setup yet), or `free` (no one's: nothing there, or no Mac set it up and
 * it leads nothing). How long ago its main computer was heard from changes nothing. */
export function judgeBox(found: FoundBox, ours: Ours): Exclude<Verdict, "two"> {
  const card = found.card;
  if (card) {
    if (ours.key && card.self.key === ours.key) return "self";
    const macs = card.macs?.map(each => each.key) ?? found.link?.macs ?? [];
    if (card.setup && card.setup === ours.setup) return "ours";
    // A setup this box leads, by its key, that it made anew since (the same keys): the machine
    // hasn't taken the new one yet.
    if (card.setup && ours.key && card.primary?.key === ours.key) return "ours";
    // In another setup now, whoever set it up before (a machine of ours that forgot us, say).
    if (card.setup && card.role === "member") return "elsewhere";
    if (card.setup && card.role === "primary") return "main";
    if ((card.self.key && ours.keys.has(card.self.key)) || macs.some(each => ours.keys.has(each))) return "ours";
    // In no setup now: set aside (a machine Macs share), held back, or one its Mac let go.
    if (macs.length) return "elsewhere";
    if (card.app) return "main";
    // (A card from before cards named Macs, with no link.json fields beside it: as an older box.)
    if (!card.macs && !found.link) return "older";
    return "free";
  }
  const link = found.link;
  if (!link) return found.app ? "older" : "free";
  if (link.macs.some(each => ours.keys.has(each))) return "ours";
  // (Kuvo Code's own box on a Mac, from before cards: it runs Kuvo Code, and can't say its setup yet.)
  return link.macs.length || link.phones || found.app ? "older" : "free";
}

/** A found box as a client reads it, with its verdict. */
function judgedOf(found: FoundBox, verdict: JudgedBox["verdict"]): JudgedBox {
  const card = found.card;
  const link = found.link;
  // (Its Macs, the last to set it up first, by name where its link.json names them.)
  const macs = card?.macs ?? (link ? link.macs.map(each => ({ key: each, name: link.names[each] ?? "" })) : []);
  const last = link?.macs[0];
  const primary = card?.primary ?? (verdict === "older" && last ? { key: last, name: link!.names[last] ?? "", heard: link!.seen[last] ?? null } : null);
  return {
    folder: found.folder,
    app: found.app,
    verdict,
    key: card?.self.key ?? null,
    name: card?.self.name ?? "",
    kind: card?.self.kind ?? null,
    setup: card?.setup ?? null,
    role: card?.role ?? null,
    primary,
    macs,
    computers: card ? card.computers : null,
    items: card ? card.items : null,
  };
}

/** What's on a computer, judged as one verdict (`judgeComputer(found, ours, apps)`): `self` where this
 * very box is among them; `free` with nothing anyone's; the one verdict of the one box that's
 * someone's; `ours` when each box there is; `two` for boxes of more than one setup on one computer
 * (an app's, and a `~/.kuvo-code` another Mac set up). It `joins` with nothing to ask only when it's
 * another setup's main computer with no Kuvo Code app on it (none runs its box, none attached to it,
 * and no app's folder found there: `apps`, a Mac's app would open as a window from then on, which
 * you choose) whose setup is empty: its card says no other computer is in it and no work is there
 * (one that doesn't say is asked; a lie there skips a question at most, as the join brings what's
 * there in all the same). */
export function judgeComputer(found: readonly FoundBox[], ours: Ours, apps = 0): Judged {
  const boxes = found.slice(0, MOST_BOXES).map(each => judgedOf(each, judgeBox(each, ours)));
  const someones = boxes.filter(each => each.verdict !== "free");
  const verdict: Verdict = boxes.some(each => each.verdict === "self") ? "self"
    : !someones.length ? "free"
    : someones.length === 1 ? someones[0].verdict
    : someones.every(each => each.verdict === "ours") ? "ours"
    : "two";
  const main = someones[0];
  const empty = main?.computers != null && main.computers <= 1 && main.items === 0;
  const joins = verdict === "main" && !apps && !found.some(each => each.app || each.card?.app) && empty;
  return { verdict, joins, boxes };
}

/** How many Kuvo Code apps' folders a probe found on a computer (`app <folder>` lines): an app that
 * ran there, whether or not a box of its own did. */
export function appsOf(lines: readonly string[]): number {
  return lines.slice(0, 2000).filter(line => /^app .{1,500}$/.test(line)).length;
}

/** A box's folder as `here` finds it: its card and link.json's few fields, or null with neither. */
export function foundAt(folder: string, app: boolean, home = homeFolder()): FoundBox | null {
  const read = (file: string): unknown => {
    try { return JSON.parse(fs.readFileSync(path.join(folder, "run", file), "utf8")); } catch { return undefined; }
  };
  const card = cardOf(read("setup-card.json"));
  const link = linkOf(read("link.json"));
  if (!card && !link) return null;
  return { folder: shownFolder(folder, home), app, ...(card ? { card } : {}), ...(link ? { link } : {}) };
}

const shownFolder = (folder: string, home: string) => (folder.startsWith(`${home}/`) ? folder.slice(home.length + 1) : folder);

/** What `kuvo-link.js here` says as Kuvo Code opens on a Mac, before it starts a box: whether it
 * uses its own box (`own`: its app's folder, as always; or none there yet and nothing else here) or
 * attaches to the one already on this Mac, in place (`attach`: a `~/.kuvo-code` another Mac set up,
 * or one of its own: one box per computer, never a second), with that box's verdict, as a Mac adding
 * this computer would judge it, and what it says of its setup. */
export type Here = Infer<typeof HERE>;

/** Whether the box in `~/<root>` can run (`machine`, its folder): `gone` where the Mac that set it up
 * removed it (its `kuvo-start off` leaves `run/off`, which only a Mac's start there takes away, and
 * then its way to start, `bin/kuvo-start`, goes with its keys, leaving its link.json and card: a
 * keeper still ending is gone too; that file is only ever replaced whole, never missing while it's
 * updated); else `running` (its keeper, `run/box.pid`, runs now) or `stopped`. */
export function runsAt(machine: string): "running" | "stopped" | "gone" {
  if (!fs.existsSync(path.join(machine, "bin", "kuvo-start")) || fs.existsSync(path.join(machine, "run", "off"))) return "gone";
  let keeper: number | null = null;
  try { keeper = Number(fs.readFileSync(path.join(machine, "run", "box.pid"), "utf8")); } catch {}
  return keeper && processRuns(keeper, "kuvo-start") ? "running" : "stopped";
}

/** `here` worked out from the app's own box (`own`, in its folder: null while it has none) and the
 * box in this Mac's `~/.kuvo-code` (`machine`, null for none; `runs`, as `runsAt` says it: one
 * that's `gone`, its Mac having removed it, is no box, whatever its card still says). An app that
 * has a box of its own keeps it (it works now, and goes on working: two boxes on one computer are
 * settled by a join or a move, `two`); one that has none attaches to the box that's here. It opens as a `window` where the box it uses is a member of a setup (an old main
 * computer after a handover, a Mac that joined, a Mac mini another Mac set up, or one that can't say
 * yet: never its main computer by itself), else as its setup's `main` computer (a box no one else
 * set up leads its own setup). */
export function judgeHere(own: FoundBox | null, there: FoundBox | null, runs: "running" | "stopped" | "gone" | null = there ? "running" : null): Here {
  const machine = runs === "gone" ? null : there;
  const ownCard = own?.card;
  const ours: Ours = { key: ownCard?.self.key ?? null, setup: ownCard?.setup ?? null, keys: new Set(ownCard?.self.key ? [ownCard.self.key] : []) };
  const judgedOwn = own ? judgedOf(own, "self") : null;
  const ownOpens = ownCard?.role === "member" ? "window" : "main";
  if (!machine) return { verdict: "free", use: "own", opens: ownOpens, runs, box: null, own: judgedOwn };
  const verdict = judgeBox(machine, ours);
  const box = judgedOf(machine, verdict);
  if (own) return { verdict: verdict === "ours" || verdict === "free" ? verdict : "two", use: "own", opens: ownOpens, runs, box, own: judgedOwn };
  const member = box.role === "member" || verdict === "elsewhere" || verdict === "older";
  return { verdict, use: "attach", opens: member ? "window" : "main", runs, box, own: null };
}

/** What says a box of the app's own ran in its folder: what the box writes itself (its card, its
 * link.json), or what the app writes only as it starts one (`serve.json`) or its keeper does
 * (`keeper.json`). Never the folder alone: the app writes in it with no box (its machines' list,
 * the integrations' catalog), so it's there on a Mac whose app attached to the box in place too. */
export const OWN_BOX_RAN = ["setup-card.json", "link.json", "serve.json", "keeper.json"];

/** Whether the app's own engine kept your sessions in its data folder (`KUVO_ENGINE_DATA`, as the
 * app gives its box: its database, `opencode*.db`). A version from before its box had a folder, or
 * one that quit cleanly, leaves nothing else to say so. Never a default folder: the machines' is
 * another box's. */
function engineKept(engineData: string | undefined): boolean {
  if (!engineData) return false;
  try { return fs.readdirSync(engineData).some(file => /^opencode.*\.db$/.test(file)); } catch { return false; }
}

/** `here` on this Mac now: the app's own box in its folder (`appBox`, this process's `KUVO_HOME`),
 * once a box ran there or its own engine kept your sessions (`engineData`, `KUVO_ENGINE_DATA`), and
 * the box in `~/<root>` (`.kuvo-code`, or a test's or a demo copy's own folder). Both box folders
 * must be said: guessed, a copy could attach to the wrong one. */
export function hereNow(root: string, appBox: string | undefined = process.env.KUVO_HOME, home = homeFolder(), engineData = process.env.KUVO_ENGINE_DATA): Here {
  const machine = path.join(home, root || "");
  if (!root || !appBox || path.resolve(appBox) === path.resolve(machine)) throw new Error("kuvo-link.js here needs KUVO_HOME, the app's own box's folder, and the machines' folder's name: here <root>.");
  // A move of this Mac's box into that home, under way (or stopped part way): no box starts until
  // it's finished, back or forward (`rehome --resume`), whatever its folders say meanwhile.
  if (moveUnderWay(machine)) return { verdict: "moving", use: "wait", opens: "main", runs: null, box: null, own: null };
  const ownRan = engineKept(engineData) || OWN_BOX_RAN.some(file => fs.existsSync(path.join(appBox, "run", file)));
  const own = ownRan ? foundAt(appBox, true, home) ?? { folder: shownFolder(appBox, home), app: true } : null;
  const there = foundAt(machine, false, home);
  return judgeHere(own, there, there ? runsAt(machine) : null);
}

/** Where a box records that Kuvo Code on its Mac attached to it in place (`POST kuvo/setup/attached`):
 * its card says the app is there from then on (`card.ts`), so a Mac adding this computer never has
 * it join another setup without asking. */
export const ATTACHED_FILE = "app-attached.json";
