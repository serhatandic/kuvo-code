// The Work Queue's issues and pull requests on GitHub (PROTOCOL.md, "The Work Queue", Issues and
// pull requests): an item that is one is named by it, and shows what GitHub says of it, its title
// and whether it's open, read with the box's own `gh` (`github/graphql.ts`). Read only for what a
// client is showing (a panel, a chip), and when an agent adds or links one; never written to.
//
// What was read is kept beside the queues (`run/work-queue/seen.json`), never in them: a read
// changes no queue file and no item's `updated`. A summary takes it in as it's made (`withSeen`):
// GitHub's title, its state (`seen`), and Done while it's closed or merged, the item's own category
// kept (`keptIn`) for when it's reopened.

import path from "node:path";
import fs from "node:fs";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { HERE } from "../home";
import { readKept, readOne, readThrough, register, type Read, type Reader, type Unread } from "../github/graphql";
import { WORK_QUEUE, type Source } from "./store";
import { issueAt, refText, sourceKey, type IssueAt } from "./sources";

export const SEEN_FILE = path.join(WORK_QUEUE, "seen.json");

/** Where an issue or a pull request stands on GitHub: an issue open, closed as completed, or as not
 * planned (a duplicate too); a pull request open, a draft, merged, or closed without merging. */
export type SeenState = "open" | "draft" | "completed" | "not_planned" | "merged" | "closed";
/** The states that make an item Done. */
export const DONE_STATES: ReadonlySet<string> = new Set(["completed", "not_planned", "merged", "closed"]);
/** Those of them that close it without its being done: not planned, or a pull request not merged. */
const STRUCK: ReadonlySet<string> = new Set(["not_planned", "closed"]);

/** What GitHub said of one. */
export interface IssueRead {
  kind: "github" | "github-pr";
  /** GitHub's own id for it, which stays as its repository is renamed. */
  id: string;
  number: number;
  title: string;
  url: string;
  state: SeenState;
  closedAt?: number;
}

const FRESH_OPEN = 60_000;
const FRESH_DONE = 30 * 60_000;
const FRESH_MISSING = 5 * 60_000;

const ISSUE_FIELDS = "id number title url state stateReason closedAt";
const PULL_FIELDS = "id number title url state isDraft merged closedAt";

/** An issue or a pull request to read: where it is, and GitHub's id for one found missing there
 * since (moved to another repository, or turned into a discussion), read by that instead; or the id
 * its item knows (`knownId`), to read it by if it isn't found where it was. */
export type IssueAsk = IssueAt & { id?: string; knownId?: string };

const fields = (body: boolean) => `__typename ... on Issue { ${ISSUE_FIELDS}${body ? " body" : ""} } ... on PullRequest { ${PULL_FIELDS}${body ? " body" : ""} }`;

// One issue or pull request in a query, under `alias` (with its description, `body`): by GitHub's
// id where that's given, else by its repository and number.
const nodeQuery = (ask: IssueAsk, alias: string, body = false): string => (ask.id
  ? `${alias}: node(id: ${JSON.stringify(ask.id)}) { ${fields(body)} }`
  : `${alias}: repository(owner: ${JSON.stringify(ask.owner)}, name: ${JSON.stringify(ask.repo)}) { issueOrPullRequest(number: ${ask.number}) { ${fields(body)} } }`);

/** One issue or pull request from GitHub's answer (a repository's, or a node by its id); null for
 * none. */
export function issueReadOf(found: unknown, byID = false): IssueRead | null {
  const node = byID ? found : isObject(found) ? found.issueOrPullRequest : null;
  if (!isObject(node) || typeof node.id !== "string" || typeof node.number !== "number" || typeof node.title !== "string" || typeof node.url !== "string") return null;
  if (!/^https:\/\/github\.com\//.test(node.url) || (node.__typename !== "Issue" && node.__typename !== "PullRequest")) return null;
  const pull = node.__typename === "PullRequest";
  const state: SeenState = pull
    ? (node.merged === true || node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : node.isDraft === true ? "draft" : "open")
    : node.state === "CLOSED" ? (node.stateReason === "NOT_PLANNED" || node.stateReason === "DUPLICATE" ? "not_planned" : "completed") : "open";
  const closedAt = typeof node.closedAt === "string" ? Date.parse(node.closedAt) : NaN;
  return {
    kind: pull ? "github-pr" : "github",
    id: node.id.slice(0, 200),
    number: node.number,
    title: plainName(node.title).slice(0, 200) || `#${node.number}`,
    url: node.url.slice(0, 2000),
    state,
    ...(Number.isFinite(closedAt) ? { closedAt } : {}),
  };
}

/** The Work Queue's reader of GitHub. */
export const ISSUES: Reader<IssueAsk, IssueRead> = register<IssueAsk, IssueRead>({
  name: "work-queue",
  file: SEEN_FILE,
  keyOf: sourceKey,
  hostOf: at => at.host,
  query: asks => `query { ${asks.map((at, index) => nodeQuery(at, `p${index}`)).join(" ")} }`,
  valueOf: (found, ask) => issueReadOf(found, Boolean(ask.id)),
  freshFor: value => (!value ? FRESH_MISSING : DONE_STATES.has(value.state) ? FRESH_DONE : FRESH_OPEN),
  keptFor: 30 * 86_400_000,
  keepsLast: true,
  // (Missing where it was: by GitHub's id for it, moved to another repository say.)
  again: (ask, before) => {
    const id = before?.value?.id ?? ask.knownId;
    return !ask.id && id ? { ...ask, id } : null;
  },
});

/** At most this many read at once, for one view or one ask of chips: those read longest ago first. */
const MOST_READ = 200;
/** How fresh what another computer told of one must be for this box not to read it itself: that
 * computer reads what it shows, and tells it. */
const TOLD_FRESH = 5 * 60_000;

/** What a summary says of its issue as last read, and when it was last asked (another computer's). */
export interface Seen { state: string; at: number; checked?: number; gone?: boolean }

/** What GitHub says of the issues and pull requests among `items`, read now where it's due:
 * waiting `wait` ms at most (a read that takes longer goes on, and a client following the view
 * hears of it when it's kept). Only for what a client is showing; not one another computer told of
 * lately, which reads it itself. */
export async function readSeen(items: { source?: Source; removed?: unknown; seen?: Seen }[], wait: number, now = Date.now()): Promise<void> {
  const { reads } = seenReads();
  const asks = new Map<string, IssueAsk>();
  for (const item of items) {
    const at = item.source && !item.removed ? issueAt(item.source.ref) : null;
    if (!at) continue;
    // (As another computer told it lately: that one reads it. Not one it found gone.)
    const told = item.seen && !item.seen.gone ? item.seen.checked ?? item.seen.at : undefined;
    if (told !== undefined && now - told < (DONE_STATES.has(item.seen!.state) ? FRESH_DONE : TOLD_FRESH)) continue;
    const key = sourceKey(at);
    // (One found missing where it was, or found elsewhere since: by GitHub's id, wherever it went.)
    // (Never read here, one handed or told from another computer: as its item says, its page there
    // and whether that one found it gone.)
    const kept = reads[key];
    const there = kept?.value ? issueAt(kept.value.url) : !kept && item.source!.url ? issueAt(item.source!.url) : null;
    const moved = Boolean(there && sourceKey(there) !== key);
    const knownId = kept?.value?.id ?? item.source!.id;
    const id = kept?.gone || moved || (!kept && item.seen?.gone) ? knownId : undefined;
    if (!asks.has(key)) asks.set(key, { ...at, ...(id ? { id } : knownId ? { knownId } : {}) });
  }
  const asked = (key: string) => reads[key]?.checked ?? reads[key]?.at ?? 0;
  const wanted = [...asks].sort(([a], [b]) => asked(a) - asked(b)).slice(0, MOST_READ).map(([, at]) => at);
  if (wanted.length) await readThrough(ISSUES, wanted, { wait });
}

// What's kept, read again only when the file changed.
let cache: { mark: string; reads: Record<string, Read<IssueRead>>; owners: Map<string, Set<string>> } | null = null;

/** Everything read and kept, by key. */
export function seenReads(): { reads: Record<string, Read<IssueRead>>; owners: Map<string, Set<string>> } {
  let mark = "-";
  try {
    const stat = fs.statSync(SEEN_FILE);
    mark = `${stat.mtimeMs} ${stat.size} ${stat.ino}`;
  } catch {}
  if (cache?.mark === mark) return cache;
  const reads = mark === "-" ? {} : readKept<IssueRead>(SEEN_FILE).reads;
  // (Which owners each repository name has, among those read: a name two share is said whole.)
  const owners = new Map<string, Set<string>>();
  for (const key of Object.keys(reads)) {
    const found = key.match(/^[^/]+\/([^/]+)\/([^#]+)#/);
    if (found) owners.set(found[2]!, (owners.get(found[2]!) ?? new Set()).add(found[1]!));
  }
  cache = { mark, reads, owners };
  return cache;
}

/** What an item's source was last read as, here; none where it never was. */
export function seenOf(source: Source | undefined): Read<IssueRead> | undefined {
  const at = source ? issueAt(source.ref) : null;
  return at ? seenReads().reads[sourceKey(at)] : undefined;
}

/** Whether GitHub said it's closed or merged, as last read (here, or as its computer told it). */
export const doneOnGitHub = (state: string | undefined): boolean => state !== undefined && DONE_STATES.has(state);

/** Whether what was read here makes it Done: closed or merged, or gone from GitHub since (deleted,
 * or no longer visible to `gh` here: GitHub says the same of both). */
export const doneByRead = (read: Read<IssueRead> | undefined): boolean => Boolean(read?.value && (read.gone || doneOnGitHub(read.value.state)));

/** What a client shows in place of its category while GitHub makes it Done. */
const doneWords = (seen: Seen): string => (seen.gone ? "Gone from GitHub" : seen.state === "merged" ? "Merged on GitHub" : "Closed on GitHub");

/** The name a client shows: `kuvo-ai#12`, or `owner/kuvo-ai#12` where another owner's repository
 * read here has the same name. */
export function shownName(at: IssueAt): string {
  const others = seenReads().owners.get(at.repo.toLowerCase());
  return `${others && [...others].some(owner => owner !== at.owner.toLowerCase()) ? `${at.owner}/` : ""}${at.repo}#${at.number}`;
}

/** What a summary of an item needs for this. */
interface Shown {
  title: string;
  category: string;
  inProgress: boolean;
  source?: Source;
  seen?: Seen;
  keptIn?: string;
  doneAt?: number;
  struck?: boolean;
  closesOn?: string;
  doneAs?: string;
}

/** A summary with what GitHub says of its issue or pull request taken in: the newer of what was
 * read here and what its computer told (`seen`). Done while it's closed or merged, or gone (never
 * in progress then), its own category kept in `keptIn`, and said in words (`doneAs`); GitHub's
 * title; the name a client shows. */
export function withSeen<S extends Shown>(summary: S): S {
  if (!summary.source) return summary;
  const at = issueAt(summary.source.ref);
  if (!at) return summary;
  let read = seenReads().reads[sourceKey(at)];
  const keptIn = summary.keptIn ?? summary.category;
  let { title } = summary;
  let seen = summary.seen;
  let source: Source = { ...summary.source, name: shownName(at) };
  let closedAt: number | undefined;
  // (The newer word, by when each was last asked of GitHub; this box's on a tie; one found gone
  // only when the other was too, or there's no other.)
  const toldWhen = seen ? seen.checked ?? seen.at : -Infinity;
  const localWhen = read ? read.checked ?? read.at : -Infinity;
  const local = Boolean(read?.value) && (!seen || (read!.gone && !seen.gone ? false : !read!.gone && seen.gone ? true : localWhen >= toldWhen));
  if (local) {
    read = read!;
    title = read.value!.title;
    seen = { state: read.value!.state, at: read.at, ...(read.gone ? { gone: true } : {}) };
    source = { ...source, kind: read.value!.kind, url: read.value!.url, id: read.value!.id };
    closedAt = read.value!.closedAt;
  }
  const done = Boolean(seen && (seen.gone || doneOnGitHub(seen.state)));
  const { keptIn: _, doneAt, struck: __, doneAs: ___, ...rest } = summary;
  // (A Done one's time: when GitHub closed it; one Done only by what was told keeps the time told.)
  const doneSince = closedAt ?? (summary.keptIn !== undefined ? doneAt : undefined) ?? seen?.at;
  return {
    ...rest,
    title,
    source,
    ...(seen ? { seen } : {}),
    category: done ? "done" : keptIn,
    inProgress: done ? false : summary.inProgress,
    // (What a client draws: its title struck through when it was closed without being done, or is
    // gone.)
    ...(seen && (seen.gone || STRUCK.has(seen.state)) ? { struck: true } : {}),
    closesOn: "github",
    ...(done ? { keptIn, doneAt: doneSince, doneAs: doneWords(seen!) } : doneAt !== undefined && summary.keptIn === undefined ? { doneAt } : {}),
  } as S;
}

/** Why `gh` read nothing, in words for an agent. */
export const unreadWords = (unread: Unread): string =>
  unread === "missing" ? `GitHub's gh isn't on ${HERE}: the Work Queue reads GitHub with it (cli.github.com), signed in with gh auth login.`
    : unread === "signed-out" ? `gh isn't signed in to GitHub on ${HERE}: gh auth login signs it in.`
      : "gh couldn't reach GitHub just now: try again in a moment.";

/** An issue or a pull request read now, with its description, for an agent adding or linking it;
 * kept as last read. Or why not, in words. */
export async function readIssue(at: IssueAt): Promise<{ read: IssueRead; body: string } | { refused: string }> {
  // (Under the reader's lock and back-off, as every read of GitHub here.)
  const answer = await readOne(ISSUES, at, `query { ${nodeQuery(at, "p0", true)} }`, data => issueReadOf(data.p0));
  if ("unread" in answer) return { refused: unreadWords(answer.unread) };
  // (Not that it isn't there: GitHub wouldn't say, as an organization's SAML sign-on or IP allow
  // list keeps it from gh's sign-in.)
  if (answer.held?.size) return { refused: `GitHub wouldn't answer for ${refText(at)} to gh on ${HERE}${answer.said ? `: ${answer.said}` : "."}` };
  const read = issueReadOf(answer.data.p0);
  if (!read) return { refused: `GitHub has no issue or pull request ${refText(at)} that gh on ${HERE} may see (gh auth status says which account it uses).` };
  const node = isObject(answer.data.p0) && isObject(answer.data.p0.issueOrPullRequest) ? answer.data.p0.issueOrPullRequest : {};
  return { read, body: typeof node.body === "string" ? node.body : "" };
}

/** Where GitHub says it is: its owner's and repository's names as GitHub writes them, after a
 * rename or a transfer too (from its page); else as it was named. */
export const canonicalOf = (at: IssueAt, read: IssueRead): IssueAt => issueAt(read.url) ?? at;

/** An item's source as it's kept: the stored ref (GitHub's own names), its page, and GitHub's id
 * and kind. */
export const sourceOf = (at: IssueAt, read: IssueRead): Source => ({ kind: read.kind, ref: refText(canonicalOf(at, read)), url: read.url, host: at.host, id: read.id });
