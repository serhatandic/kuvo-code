// What a session's row and its card show beyond the session itself (PROTOCOL.md, "A session at a
// glance"): `GET kuvo/sessions/glance?sessions=<id>,<id>…`, and `…/events`, the same now and again as
// it changes, each minute at most for its pull requests, while a client follows it (the rows on its
// screen). Worked out here, so every client shows the same: the branch a session has of its own, its
// pull request and checks, the account it runs on, and since when it's waited on you.

import fs from "node:fs";
import { isObject } from "../../shared/json";
import { call } from "../engine/client";
import { targetsOf } from "../letters/tools";
import { workAccounts } from "../work/accounts";
import { askChanges, askedSince, askFollowers } from "../glance/asked";
import { FRESH, keyOf, readPulls, type PullAsk } from "../glance/github";
import { pullAt, pullChanges, pullFollowers, readPullLinks } from "../glance/pulls";
import { countIn, originOf, webPage, worktreeOf } from "./changes";
import type { Glance, GlancePull } from "../../shared/routes/sessions";
import type { Target } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";
import type { AnswerPiece, RouteContext } from "../server/context";

export const GLANCE_ROUTE = /^kuvo\/sessions\/glance(\/events)?$/;
/** At most this many sessions in one ask. */
export const GLANCE_MOST = 200;

/** A worktree's repository on GitHub, by its folder: origin's, as git last said (a few minutes). */
const repositories = new Map<string, { at: number; repository: { host: string; owner: string; repo: string } | null }>();

async function repositoryOf(root: string, now: number): Promise<{ host: string; owner: string; repo: string } | null> {
  const kept = repositories.get(root);
  if (kept && now - kept.at < 5 * 60_000) return kept.repository;
  const remote = await originOf(root);
  const page = remote ? webPage(remote) : null;
  const parts = page?.pathname.replace(/^\/|\/$/g, "").split("/") ?? [];
  const repository = page && page.hostname.includes("github") && parts.length === 2 ? { host: page.hostname, owner: parts[0]!, repo: parts[1]! } : null;
  repositories.set(root, { at: now, repository });
  return repository;
}

/** The places here couldn't say whether they have a session (one wasn't answering): not the same as
 * not having it, so nothing is said of any rather than say they're gone. */
export class Unreached extends Error {}

/** A session here, and where it runs (the engine, or the coding agents' bridge); null for one no
 * place has. Throws `Unreached` when one that might have it didn't answer. */
export async function sessionHere(targets: Target[], id: string, signal?: AbortSignal): Promise<{ target: Target; data: EngineSession } | null> {
  let unreached = false;
  for (const target of targets) {
    const wait = AbortSignal.timeout(5_000);
    try {
      const found = await call(target, "GET", `/api/session/${encodeURIComponent(id)}`, undefined, signal ? AbortSignal.any([signal, wait]) : wait);
      if (isObject(found) && found.id === id) return { target, data: found as unknown as EngineSession };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) unreached = true;
    }
  }
  if (unreached) throw new Unreached("The engine isn't answering.");
  return null;
}

/** The lines a worktree's branch changed, by its folder, as git last said (half a minute). */
const counts = new Map<string, { at: number; counted: Awaited<ReturnType<typeof countIn>> }>();

async function linesIn(directory: string, base: string | undefined): Promise<Awaited<ReturnType<typeof countIn>>> {
  const kept = counts.get(directory);
  if (kept && Date.now() - kept.at < 30_000) return kept.counted;
  const counted = await countIn(directory, "branch", base).catch(() => null);
  counts.set(directory, { at: Date.now(), counted });
  if (counts.size > 500) counts.delete(counts.keys().next().value!);
  return counted;
}

/** When a worktree's folder was made (ms), so a pull request from before it is an earlier branch's
 * of the same name; none where the system can't say. */
function madeAt(root: string): number | undefined {
  try {
    const stat = fs.statSync(root);
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/** What each of `ids` shows at a glance, by session; one this box doesn't have is left out. Throws
 * `Unreached` while a place that might have one isn't answering. */
export async function glances(ids: string[], targets: Target[], signal?: AbortSignal, now: () => number = Date.now): Promise<Record<string, Glance>> {
  const found = (await Promise.all(ids.map(id => sessionHere(targets, id, signal)))).filter(each => each !== null);
  const links = readPullLinks();
  // The pull request each one shows: the one it made, else its worktree branch's latest.
  const wanted = new Map<string, { ask: PullAsk; url?: string; number?: number }>();
  const trees = new Map<string, NonNullable<ReturnType<typeof worktreeOf>>>();
  for (const { data } of found) {
    const directory = data.location?.directory ?? data.directory;
    const tree = directory ? worktreeOf(directory) : undefined;
    if (tree) trees.set(data.id, tree);
    const made = links[data.id] ? pullAt(links[data.id]!.url) : null;
    if (made) wanted.set(data.id, { ask: { host: made.host, owner: made.owner, repo: made.repo, number: made.number }, url: made.url, number: made.number });
    else if (tree) {
      const repository = await repositoryOf(tree.root, now());
      const since = madeAt(tree.root);
      if (repository) wanted.set(data.id, { ask: { ...repository, branch: tree.branch, ...(since ? { since: since - 60_000 } : {}) } });
    }
  }
  const [pulls, accounts, asked] = await Promise.all([
    readPulls([...wanted.values()].map(each => each.ask), now),
    workAccounts(found.map(({ target, data }) => ({ id: data.id, target, provider: data.model?.providerID })), signal),
    askedSince(found.map(({ data }) => data.id), targets, signal),
  ]);
  const answer: Record<string, Glance> = {};
  for (const { data } of found) {
    const glance: { -readonly [K in keyof Glance]: Glance[K] } = {};
    const tree = trees.get(data.id);
    const want = wanted.get(data.id);
    const read = want ? pulls.get(keyOf(want.ask)) : undefined;
    let pull: GlancePull | undefined;
    if (read) pull = { number: read.number, url: read.url, state: read.state, additions: read.additions, deletions: read.deletions, ...(read.checks ? { checks: read.checks } : {}) };
    // One it made that GitHub hasn't said anything of yet: its number and page.
    else if (want?.number && want.url) pull = { number: want.number, url: want.url };
    const branch = tree?.branch ?? (read?.branch || undefined);
    if (branch) glance.branch = branch;
    if (pull) glance.pull = pull;
    else if (tree) {
      // Without a pull request, the lines the branch changed since it left its base, as they are now.
      const directory = data.location?.directory ?? data.directory ?? tree.root;
      const counted = await linesIn(directory, tree.base);
      if (counted?.repository) Object.assign(glance, { additions: counted.additions, deletions: counted.deletions });
    }
    const account = accounts.get(data.id);
    if (account) glance.account = account;
    const since = asked.get(data.id);
    if (since !== undefined) glance.asked = since;
    answer[data.id] = glance;
  }
  return answer;
}

/** The sessions a request names (`sessions=a,b`), or null for none or too many. */
export function sessionsAsked(requestPath: string): string[] | null {
  const given = new URLSearchParams(requestPath.split("?")[1] ?? "").get("sessions") ?? "";
  const ids = [...new Set(given.split(",").map(each => each.trim()).filter(each => /^ses[A-Za-z0-9_-]+$/.test(each)))];
  return ids.length && ids.length <= GLANCE_MOST ? ids : null;
}

/** What's changed in this process since: asks come or go, pull requests linked. */
const changes = () => askChanges + pullChanges;

/** Waits `ms`, or until an ask or a session's pull request changes (and a moment after, so a few
 * at once are one), or `signal` stops it; at once if one changed since `seen`. */
function changeOrPause(ms: number, seen: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      clearTimeout(settle);
      askFollowers.delete(changed);
      pullFollowers.delete(changed);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const changed = () => {
      if (!settle) settle = setTimeout(done, 1_500);
    };
    const timer = setTimeout(done, ms);
    askFollowers.add(changed);
    pullFollowers.add(changed);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
    else if (changes() !== seen) changed();
  });
}

export async function* glanceRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const ids = sessionsAsked(request.path);
  if (!ids) return yield* json(400, { message: `Name the sessions: sessions=<id>,<id>… (${GLANCE_MOST} at most).` });
  const targets = targetsOf({ readEngine, bridge });
  if (!targets.length) return yield* json(503, { message: "The engine isn't running." });
  if (!match[1]) {
    try {
      return yield* json(200, { sessions: await glances(ids, targets, signal ?? undefined) });
    } catch (error) {
      if (error instanceof Unreached) return yield* json(503, { message: error.message });
      throw error;
    }
  }
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  let last = "";
  while (!signal?.aborted) {
    const seen = changes();
    let line: string | null = null;
    try {
      line = JSON.stringify({ sessions: await glances(ids, targetsOf({ readEngine, bridge }), signal ?? undefined) });
    } catch (error) {
      // A place not answering: what was said last stands, until it can be asked again.
      if (!(error instanceof Unreached)) throw error;
    }
    if (signal?.aborted) return;
    if (line !== null && line !== last) {
      yield { body: Buffer.from(line + "\n") };
      last = line;
    }
    await changeOrPause(FRESH, seen, signal ?? undefined);
  }
}
