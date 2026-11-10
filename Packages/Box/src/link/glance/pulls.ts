// Which session made which pull request (`pull` in `kuvo/sessions/glance`), kept in
// `box/pulls.json`: the one Create Pull Request made from a session (`kuvo/git/pull-request` with
// `session`), and one a session's own `gh pr create` printed, caught as its call ends. A session in
// a worktree also has its branch's (glance.ts); one with neither has none, so two sessions in one
// folder never show each other's.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { lockedWhile, writePrivate } from "../files";
import { K } from "../home";
import { call } from "../engine/client";
import type { Target } from "../../shared/records";

export const PULLS_FILE = path.join(K, "box", "pulls.json");
/** How many sessions' pull requests are kept, the latest. */
const KEPT = 500;

/** A pull request a session made: its page, and when it was linked (ms). */
export interface PullLink {
  url: string;
  at: number;
}

/** A pull request's page on GitHub, its parts: `https://github.com/me/app/pull/7`. */
export function pullAt(url: string): { host: string; owner: string; repo: string; number: number; url: string } | null {
  const found = url.match(/^https:\/\/([A-Za-z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\b/);
  if (!found || !found[1]!.includes("github")) return null;
  const [, host, owner, repo, number] = found as unknown as [string, string, string, string, string];
  return { host, owner, repo, number: Number(number), url: `https://${host}/${owner}/${repo}/pull/${number}` };
}

/** Every session's pull request, by session. */
export function readPullLinks(): Record<string, PullLink> {
  try {
    const kept = JSON.parse(fs.readFileSync(PULLS_FILE, "utf8")).sessions;
    if (!isObject(kept)) return {};
    return Object.fromEntries(Object.entries(kept).filter(([, link]) => isObject(link) && typeof link.url === "string" && typeof link.at === "number")) as Record<string, PullLink>;
  } catch {
    return {};
  }
}

/** Told as a session's pull request is linked. */
export const pullFollowers = new Set<() => void>();

/** `session` made the pull request at `url` (GitHub's; any other is left out): kept as its own. */
export async function linkPull(session: string, url: string, now = Date.now()): Promise<boolean> {
  const pull = pullAt(url);
  if (!pull || !/^ses/.test(session)) return false;
  await lockedWhile(PULLS_FILE + ".lock", async () => {
    const kept = readPullLinks();
    kept[session] = { url: pull.url, at: now };
    const latest = Object.entries(kept).sort(([, a], [, b]) => b.at - a.at).slice(0, KEPT);
    writePrivate(PULLS_FILE, JSON.stringify({ sessions: Object.fromEntries(latest) }, null, 1) + "\n");
  });
  for (const told of pullFollowers) try { told(); } catch {}
  return true;
}

/** A tool call's event, as `pullCatcher` reads it. */
export interface ToolEvent {
  type: string;
  data?: { sessionID?: unknown; id?: unknown; input?: unknown; content?: unknown; metadata?: unknown };
}

/** The words a call printed: its output's text parts, and what it said it printed. */
function printed(data: NonNullable<ToolEvent["data"]>): string {
  const parts = Array.isArray(data.content) ? data.content.map(part => (isObject(part) && typeof part.text === "string" ? part.text : "")) : [];
  const metadata = isObject(data.metadata) ? data.metadata : {};
  return [...parts, typeof metadata.output === "string" ? metadata.output : ""].join("\n");
}

/** The conversation `session` is part of on `target` (a subagent's, the one it works for). */
async function conversationOf(target: Target, session: string): Promise<string> {
  let at = session;
  for (let step = 0; step < 10; step++) {
    const found = await call(target, "GET", `/api/session/${encodeURIComponent(at)}`).catch(() => null);
    const parent = isObject(found) && typeof found.parentID === "string" ? found.parentID : null;
    if (!parent) return at;
    at = parent;
  }
  return at;
}

/** Follows a place's tool calls (the engine's, or the coding agents' bridge's) for a `gh pr create`
 * a session ran itself: the pull request its output names (made, or one already open for the
 * branch) is linked to its conversation as the call ends. */
export function pullCatcher(target: () => Target | null): (event: ToolEvent) => void {
  const creating = new Map<string, string>();
  return event => {
    const data = event.data;
    if (!data || typeof data.id !== "string" || typeof data.sessionID !== "string") return;
    if (event.type === "session.tool.called") {
      const command = isObject(data.input) ? data.input.command ?? data.input.cmd : undefined;
      if (typeof command === "string" && /\bgh\s+pr\s+create\b/.test(command)) creating.set(data.id, data.sessionID);
      return;
    }
    if (event.type !== "session.tool.success" && event.type !== "session.tool.failed") return;
    const session = creating.get(data.id);
    if (!session) return;
    creating.delete(data.id);
    const url = printed(data).match(/https:\/\/[^\s"'<>]+\/pull\/\d+/)?.[0];
    const place = target();
    if (!url || !place) return;
    conversationOf(place, session).then(conversation => linkPull(conversation, url)).catch(() => {});
  };
}
