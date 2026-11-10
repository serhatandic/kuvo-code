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
import { askGitHub, keepRead, readKept, readThrough, type Read, type Reader, type Unread } from "../github/graphql";
import { WORK_QUEUE, type Source } from "./store";
import { issueAt, refText, sourceKey, type IssueAt } from "./sources";

export const SEEN_FILE = path.join(WORK_QUEUE, "seen.json");

/** Where an issue or a pull request stands on GitHub: an issue open, closed as completed, or as not
 * planned (a duplicate too); a pull request open, a draft, merged, or closed without merging. */
export type SeenState = "open" | "draft" | "completed" | "not_planned" | "merged" | "closed";
/** The states that make an item Done. */
export const DONE_STATES: ReadonlySet<string> = new Set(["completed", "not_planned", "merged", "closed"]);

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

// One issue or pull request in a query, under `alias` (with its description, `body`).
const nodeQuery = (at: IssueAt, alias: string, body = false): string =>
  `${alias}: repository(owner: ${JSON.stringify(at.owner)}, name: ${JSON.stringify(at.repo)}) { issueOrPullRequest(number: ${at.number}) { __typename ... on Issue { ${ISSUE_FIELDS}${body ? " body" : ""} } ... on PullRequest { ${PULL_FIELDS}${body ? " body" : ""} } } }`;

/** One issue or pull request from GitHub's answer (a repository's); null for none. */
export function issueReadOf(found: unknown): IssueRead | null {
  const node = isObject(found) ? found.issueOrPullRequest : null;
  if (!isObject(node) || typeof node.id !== "string" || typeof node.number !== "number" || typeof node.title !== "string" || typeof node.url !== "string") return null;
  if (!/^https:\/\/github\.com\//.test(node.url)) return null;
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
export const ISSUES: Reader<IssueAt, IssueRead> = {
  file: SEEN_FILE,
  keyOf: sourceKey,
  hostOf: at => at.host,
  query: asks => `query { ${asks.map((at, index) => nodeQuery(at, `p${index}`)).join(" ")} }`,
  valueOf: found => issueReadOf(found),
  freshFor: value => (!value ? FRESH_MISSING : DONE_STATES.has(value.state) ? FRESH_DONE : FRESH_OPEN),
  keptFor: 30 * 86_400_000,
  keepsLast: true,
};

/** At most this many read at once, for one view or one ask of chips. */
const MOST_READ = 200;

/** What GitHub says of the issues and pull requests among `items`, read now where it's due:
 * waiting `wait` ms at most (a read that takes longer goes on, and a client following the view
 * hears of it when it's kept). Only for what a client is showing. */
export async function readSeen(items: { source?: Source; removed?: unknown }[], wait: number): Promise<void> {
  const asks = items.flatMap(item => (item.source && !item.removed ? [issueAt(item.source.ref)] : [])).filter((at): at is IssueAt => at !== null).slice(0, MOST_READ);
  if (asks.length) await readThrough(ISSUES, asks, { wait });
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
  seen?: { state: string; at: number };
  keptIn?: string;
  doneAt?: number;
}

/** A summary with what GitHub says of its issue or pull request taken in: the newer of what was
 * read here and what its computer told (`seen`). Done while it's closed or merged (never in
 * progress then), its own category kept in `keptIn`; GitHub's title; the name a client shows. */
export function withSeen<S extends Shown>(summary: S): S {
  if (!summary.source) return summary;
  const at = issueAt(summary.source.ref);
  if (!at) return summary;
  const read = seenReads().reads[sourceKey(at)];
  const keptIn = summary.keptIn ?? summary.category;
  let { title } = summary;
  let seen = summary.seen;
  let source: Source = { ...summary.source, name: shownName(at) };
  let closedAt: number | undefined;
  if (read?.value && !(seen && seen.at >= read.at)) {
    title = read.value.title;
    seen = { state: read.value.state, at: read.at };
    source = { ...source, kind: read.value.kind, url: read.value.url, id: read.value.id };
    closedAt = read.value.closedAt;
  }
  const done = doneOnGitHub(seen?.state);
  const { keptIn: _, doneAt, ...rest } = summary;
  // (A Done one's time: when GitHub closed it; one Done only by what was told keeps the time told.)
  const doneSince = closedAt ?? (summary.keptIn !== undefined ? doneAt : undefined) ?? seen?.at;
  return {
    ...rest,
    title,
    source,
    ...(seen ? { seen } : {}),
    category: done ? "done" : keptIn,
    inProgress: done ? false : summary.inProgress,
    ...(done ? { keptIn, doneAt: doneSince } : doneAt !== undefined && summary.keptIn === undefined ? { doneAt } : {}),
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
  const answer = await askGitHub(at.host, `query { ${nodeQuery(at, "p0", true)} }`);
  if ("unread" in answer) return { refused: unreadWords(answer.unread) };
  const read = issueReadOf(answer.data.p0);
  if (!read) return { refused: `GitHub has no issue or pull request ${refText(at)} that gh on ${HERE} may see (gh auth status says which account it uses).` };
  keepRead(ISSUES, at, read);
  const node = isObject(answer.data.p0) && isObject(answer.data.p0.issueOrPullRequest) ? answer.data.p0.issueOrPullRequest : {};
  return { read, body: typeof node.body === "string" ? node.body : "" };
}

/** An item's source as it's kept: the stored ref, its page, and GitHub's id and kind. */
export const sourceOf = (at: IssueAt, read: IssueRead): Source => ({ kind: read.kind, ref: refText(at), url: read.url, host: at.host, id: read.id });
