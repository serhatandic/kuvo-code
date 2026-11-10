// Reading pull requests from GitHub for sessions' rows and cards (`pull` in `kuvo/sessions/glance`):
// with GitHub's own `gh` and its sign-in on this box (Kuvo Code keeps no key of GitHub's for it),
// one GraphQL query for every pull request asked for at once, each read at most once a minute and
// only while a client asks (its row or card on screen). What was read is kept in
// `run/glance/github.json`, so a route answered in a process of its own (`box route`) reads it too.
// A box without `gh`, or with it signed out, reads nothing, and tries again a few minutes later.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject } from "../../shared/json";
import { lockedWhile, writePrivate } from "../files";
import { RUN } from "../home";
import type { GlanceChecks } from "../../shared/routes/sessions";

export const GITHUB_FILE = path.join(RUN, "glance", "github.json");
/** How long a read stands before it's read again (ms). */
export const FRESH = 60_000;
/** How long a read is kept at all, for a row that comes back into view. */
const KEPT = 30 * 60_000;
/** How long a host isn't asked again after `gh` couldn't read it (not there, signed out). */
const BACK_OFF = 5 * 60_000;
/** At most this many pull requests in one query. */
const PER_QUERY = 50;

/** A pull request to read: by its number, or the latest for a branch. */
export interface PullAsk {
  host: string;
  owner: string;
  repo: string;
  number?: number;
  branch?: string;
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

interface Kept {
  reads: Record<string, { at: number; pull: PullRead | null }>;
  /** A host `gh` couldn't read, until when it isn't asked again. */
  hosts: Record<string, number>;
}

export const keyOf = (ask: PullAsk) => `${ask.host}/${ask.owner}/${ask.repo}` + (ask.number ? `#${ask.number}` : `@${ask.branch ?? ""}`);

function readKept(): Kept {
  try {
    const kept = JSON.parse(fs.readFileSync(GITHUB_FILE, "utf8"));
    return { reads: isObject(kept.reads) ? kept.reads : {}, hosts: isObject(kept.hosts) ? kept.hosts : {} };
  } catch {
    return { reads: {}, hosts: {} };
  }
}

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

const FIELDS = "number url state isDraft additions deletions headRefName commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }";

/** One query for all of `asks` (on one host): each by its number, or a branch's latest. */
export function queryFor(asks: PullAsk[]): string {
  const parts = asks.map((ask, at) => {
    const repository = `repository(owner: ${JSON.stringify(ask.owner)}, name: ${JSON.stringify(ask.repo)})`;
    return ask.number
      ? `p${at}: ${repository} { pullRequest(number: ${ask.number}) { ...P } }`
      : `p${at}: ${repository} { pullRequests(headRefName: ${JSON.stringify(ask.branch ?? "")}, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...P } } }`;
  });
  return `query { ${parts.join(" ")} } fragment P on PullRequest { ${FIELDS} }`;
}

/** `gh api graphql` on `host`: what it answered (GitHub's `data`, with nulls for what it couldn't
 * find), or null when `gh` couldn't ask (not there, signed out, no network). */
function askGitHub(host: string, query: string): Promise<Record<string, unknown> | null> {
  return new Promise(resolve => {
    execFile("gh", ["api", "graphql", "--hostname", host, "-f", `query=${query}`], {
      // (Never in a repository: what a folder's own settings say has nothing to do with it.)
      cwd: os.tmpdir(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    }, (_error, stdout) => {
      // Some not found (a repository gone) still answers the rest.
      try {
        const answer = JSON.parse(String(stdout));
        resolve(isObject(answer) && isObject(answer.data) ? answer.data : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Reads now are this process's, under way, by key. */
const reading = new Map<string, Promise<void>>();

/** Reads `asks` that weren't read in the last minute (one query per host), and keeps what came. */
async function readStale(asks: PullAsk[], now: () => number): Promise<void> {
  await lockedWhile(GITHUB_FILE + ".lock", async () => {
    const kept = readKept();
    const stale = asks.filter(ask => !(now() - (kept.reads[keyOf(ask)]?.at ?? 0) < FRESH) && !((kept.hosts[ask.host] ?? 0) > now()));
    if (!stale.length) return;
    const byHost = new Map<string, PullAsk[]>();
    for (const ask of stale) byHost.set(ask.host, [...(byHost.get(ask.host) ?? []), ask]);
    for (const [host, each] of byHost) {
      for (let at = 0; at < each.length; at += PER_QUERY) {
        const part = each.slice(at, at + PER_QUERY);
        const data = await askGitHub(host, queryFor(part));
        if (!data) {
          kept.hosts[host] = now() + BACK_OFF;
          break;
        }
        part.forEach((ask, index) => {
          const found = data[`p${index}`];
          const node = isObject(found) ? (ask.number ? found.pullRequest : isObject(found.pullRequests) && Array.isArray(found.pullRequests.nodes) ? found.pullRequests.nodes[0] : null) : null;
          kept.reads[keyOf(ask)] = { at: now(), pull: pullOf(node) };
        });
      }
    }
    for (const [key, read] of Object.entries(kept.reads)) if (now() - read.at > KEPT) delete kept.reads[key];
    for (const [host, until] of Object.entries(kept.hosts)) if (until <= now()) delete kept.hosts[host];
    writePrivate(GITHUB_FILE, JSON.stringify(kept) + "\n");
  }, { stale: 60_000, wait: 35_000 });
}

/** The pull requests asked for, by key: as GitHub said within the last minute (read now where it
 * wasn't), or as last read; none for one never read, or that GitHub doesn't have. */
export async function readPulls(asks: PullAsk[], now: () => number = Date.now): Promise<Map<string, PullRead>> {
  const unique = [...new Map(asks.map(ask => [keyOf(ask), ask])).values()];
  const waiting = unique.filter(ask => !reading.has(keyOf(ask)));
  if (waiting.length) {
    const read = readStale(waiting, now).catch(() => {}).finally(() => { for (const ask of waiting) reading.delete(keyOf(ask)); });
    for (const ask of waiting) reading.set(keyOf(ask), read);
  }
  await Promise.all(unique.map(ask => reading.get(keyOf(ask))));
  const kept = readKept();
  const found = new Map<string, PullRead>();
  for (const ask of unique) {
    const pull = kept.reads[keyOf(ask)]?.pull;
    if (pull) found.set(keyOf(ask), pull);
  }
  return found;
}
