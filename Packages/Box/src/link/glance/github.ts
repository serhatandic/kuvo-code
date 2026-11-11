// Reading pull requests from GitHub for sessions' rows and cards (`pull` in `kuvo/sessions/glance`):
// with GitHub's own `gh` and its sign-in on this box (Kuvo Code keeps no key of GitHub's for it),
// through the box's one reader of GitHub (`github/graphql.ts`, the Work Queue's too): one GraphQL
// query for every pull request asked for at once, and only while a client asks (its row
// or card on screen); each read again only as often as it can change (`freshFor`): once a minute
// while its checks run, every few minutes while it's open or not made yet, and every half hour once
// it's merged or closed. What was read is kept in `run/glance/github.json`, so a route answered in a
// process of its own (`box route`) reads it too, and one process at a time asks GitHub. A box without
// `gh`, or with it signed out, reads nothing, and tries again a few minutes later.

import path from "node:path";
import { isObject } from "../../shared/json";
import { RUN } from "../home";
import { readThrough, type Reader } from "../github/graphql";
import type { GlanceChecks } from "../../shared/routes/sessions";

export const GITHUB_FILE = path.join(RUN, "glance", "github.json");
/** How long a read stands before it's read again at most (ms): while its checks run. */
export const FRESH = 60_000;
/** While it's open with nothing under way, or there's none for a branch yet. */
const FRESH_OPEN = 5 * 60_000;
/** Once it's merged or closed, which it rarely stops being. */
const FRESH_DONE = 30 * 60_000;
/** How long a read is kept at all, for a row that comes back into view. */
const KEPT = 2 * 60 * 60_000;

/** A pull request to read: by its number, or the latest for a branch. */
export interface PullAsk {
  host: string;
  owner: string;
  repo: string;
  number?: number;
  branch?: string;
  /** For a branch's: made no earlier than this (ms), the worktree's own; one before is an earlier
   * branch's of the same name. */
  since?: number;
}

/** A pull request as GitHub says it is. */
export interface PullRead {
  number: number;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  additions: number;
  deletions: number;
  /** Its head branch. */
  branch: string;
  checks?: GlanceChecks;
}

export const keyOf = (ask: PullAsk) => `${ask.host}/${ask.owner}/${ask.repo}` + (ask.number ? `#${ask.number}` : `@${ask.branch ?? ""}`);

// Checks by GitHub's states: skipped and neutral count as passed; cancelled, timed out, stale and
// the like as failed, so nothing is left waiting for good; the rest are under way.
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "COMPLETED"]);
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);

/** A pull request's checks from GitHub's counts by state; none where it has none. */
export function checksOf(rollup: unknown): GlanceChecks | undefined {
  const contexts = isObject(rollup) && isObject(rollup.contexts) ? rollup.contexts : null;
  if (!contexts) return undefined;
  const checks = { passed: 0, failed: 0, pending: 0 };
  for (const list of [contexts.checkRunCountsByState, contexts.statusContextCountsByState]) {
    for (const each of Array.isArray(list) ? list : []) {
      if (!isObject(each) || typeof each.state !== "string" || typeof each.count !== "number") continue;
      const side = PASSED.has(each.state) ? "passed" : FAILED.has(each.state) ? "failed" : "pending";
      checks[side] += each.count;
    }
  }
  return checks.passed + checks.failed + checks.pending > 0 ? checks : undefined;
}

/** A pull request from GitHub's answer; null for none. */
export function pullOf(node: unknown): PullRead | null {
  if (!isObject(node) || typeof node.number !== "number" || typeof node.url !== "string") return null;
  const state = node.state === "MERGED" ? "merged" : node.state === "CLOSED" ? "closed" : node.isDraft === true ? "draft" : "open";
  const commits = isObject(node.commits) && Array.isArray(node.commits.nodes) ? node.commits.nodes : [];
  const last = commits.at(-1);
  const checks = checksOf(isObject(last) && isObject(last.commit) ? last.commit.statusCheckRollup : null);
  return {
    number: node.number, url: node.url, state,
    additions: typeof node.additions === "number" ? node.additions : 0,
    deletions: typeof node.deletions === "number" ? node.deletions : 0,
    branch: typeof node.headRefName === "string" ? node.headRefName : "",
    ...(checks ? { checks } : {}),
  };
}

const FIELDS = "number url state isDraft additions deletions headRefName createdAt headRepositoryOwner { login } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }";

/** One query for all of `asks` (on one host): each by its number, or a branch's latest. */
export function queryFor(asks: PullAsk[]): string {
  const parts = asks.map((ask, at) => {
    const repository = `repository(owner: ${JSON.stringify(ask.owner)}, name: ${JSON.stringify(ask.repo)})`;
    return ask.number
      ? `p${at}: ${repository} { pullRequest(number: ${ask.number}) { ...P } }`
      : `p${at}: ${repository} { pullRequests(headRefName: ${JSON.stringify(ask.branch ?? "")}, first: 5, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...P } } }`;
  });
  return `query { ${parts.join(" ")} } fragment P on PullRequest { ${FIELDS} }`;
}

/** A branch's own pull request among those GitHub has for its name, the latest first: from origin's
 * repository itself (not a fork's of the same name), and made since the branch was (not an earlier
 * branch's of the same name). */
export function branchPull(nodes: unknown[], ask: PullAsk): unknown {
  return nodes.find(node => {
    if (!isObject(node)) return false;
    const owner = isObject(node.headRepositoryOwner) && typeof node.headRepositoryOwner.login === "string" ? node.headRepositoryOwner.login : "";
    const made = typeof node.createdAt === "string" ? Date.parse(node.createdAt) : NaN;
    return owner.toLowerCase() === ask.owner.toLowerCase() && (!ask.since || !(made < ask.since));
  }) ?? null;
}

/** How long what was read of a pull request stands. */
export function freshFor(pull: PullRead | null): number {
  if (!pull) return FRESH_OPEN;
  if (pull.state === "merged" || pull.state === "closed") return FRESH_DONE;
  return (pull.checks?.pending ?? 0) > 0 ? FRESH : FRESH_OPEN;
}

/** Sessions' pull requests, as the shared reader of GitHub reads them (`github/graphql.ts`, the
 * Work Queue's too): each by its number, or a branch's latest. */
export const PULLS: Reader<PullAsk, PullRead> = {
  file: GITHUB_FILE,
  keyOf,
  hostOf: ask => ask.host,
  query: queryFor,
  valueOf: (found, ask) => pullOf(!isObject(found) ? null : ask.number ? found.pullRequest
    : isObject(found.pullRequests) && Array.isArray(found.pullRequests.nodes) ? branchPull(found.pullRequests.nodes, ask) : null),
  freshFor,
  keptFor: KEPT,
};

/** The pull requests asked for, by key: as GitHub said lately (read now where it's due), or as last
 * read; none for one never read, or that GitHub doesn't have. */
export async function readPulls(asks: PullAsk[], now: () => number = Date.now): Promise<Map<string, PullRead>> {
  const found = new Map<string, PullRead>();
  for (const [key, read] of await readThrough(PULLS, asks, { now })) if (read.value) found.set(key, read.value);
  return found;
}
