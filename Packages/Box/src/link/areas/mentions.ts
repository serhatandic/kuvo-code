// What "@" and "&" suggest as you type in a conversation (PROTOCOL.md, "Mentions"): its folders'
// files, and the agents "&" can name, ranked as the Mac's composer ranked them, so every client
// shows the same list and only draws it.

import path from "node:path";
import { targetsOf } from "../letters/tools";
import { foldersOf } from "./projects";
import { listTree } from "./folders";
import { namedNow } from "./named";
import { sessionHere, Unreached } from "./glance";
import type { Mention } from "../../shared/routes/sessions";
import type { Named } from "../../shared/routes/box";
import type { EngineSession } from "../engine/sessions";
import type { AnswerPiece, RouteContext } from "../server/context";

export const MENTIONS_ROUTE = /^kuvo\/sessions\/([^/]+)\/mentions$/;

/** How many it suggests, unless asked for fewer or more, and at most. */
export const MENTIONS_SHOWN = 8;
export const MENTIONS_MOST = 20;

/** A file "@" can point at (the Mac's ProjectFiles.File): its path as listed (with several folders,
 * after its folder's name), which folder it's in (0, the conversation's own), how the message names
 * it, its name, when it last changed, and whether it's one of the folders itself. */
export interface MentionableFile {
  path: string;
  folder: number;
  mention: string;
  name: string;
  modified: number | null;
  isFolder: boolean;
}

/** Characters as Swift counts them (what people see as one). */
const length = (text: string) => [...new Intl.Segmenter().segment(text)].length;

/** The files of `roots` (the conversation's folder first, then its project's others), as the Mac's
 * `ProjectFiles.mentionable` lists them: with several, each folder first, then every file, newest
 * first (`dated`: when they last changed is read). A folder that can't be read lists nothing. */
export async function mentionableFiles(roots: string[], dated: boolean, signal?: AbortSignal): Promise<MentionableFile[]> {
  const several = roots.length > 1;
  const folders: MentionableFile[] = several ? roots.map((root, folder) => ({ path: `${path.basename(root)}/`, folder, mention: `${path.basename(root)}/`, name: path.basename(root), modified: null, isFolder: true })) : [];
  const files: MentionableFile[] = [];
  for (const [folder, root] of roots.entries()) {
    const listed = await listTree(`kuvo/folders/tree?path=${encodeURIComponent(root)}${dated ? "&dated=1" : ""}`, undefined, signal);
    if (listed.status !== 200 || !("files" in listed.value)) continue;
    const { files: names, modified } = listed.value;
    const prefix = several ? `${path.basename(root)}/` : "";
    names.forEach((name, at) => files.push({ path: prefix + name, folder, mention: folder === 0 ? name : prefix + name, name: path.basename(name), modified: modified?.[at] ?? null, isFolder: false }));
  }
  // (Newest first; Array.sort keeps the rest in their order.)
  if (dated) files.sort((a, b) => (b.modified ?? -Infinity) - (a.modified ?? -Infinity));
  return [...folders, ...files];
}

/** The Mac's `Mentions.matches`: the name itself, then names starting with what's typed, then names
 * containing it, then anywhere in the path; among equals, the conversation's folder's and shorter
 * paths first. Nothing typed: the folders, then the first files (newest first). */
export function rankFiles(query: string, files: MentionableFile[], limit: number): MentionableFile[] {
  const typed = query.toLowerCase();
  if (!typed) return [...files.filter(file => file.isFolder), ...files.filter(file => !file.isFolder).slice(0, limit)].slice(0, limit);
  const rank = (file: MentionableFile): number | null => {
    const name = file.name.toLowerCase();
    if (name === typed) return 0;
    if (name.startsWith(typed)) return 1;
    if (name.includes(typed)) return 2;
    if (file.path.toLowerCase().includes(typed)) return 3;
    return null;
  };
  return files.flatMap(file => { const at = rank(file); return at === null ? [] : [{ file, at, size: length(file.path) }]; })
    .sort((a, b) => a.at - b.at || a.file.folder - b.file.folder || a.size - b.size || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0))
    .slice(0, limit)
    .map(each => each.file);
}

/** A name as "&" matches it: case and accents aside. */
const folded = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The Mac's `AgentReferences.matches`: the name itself, then names starting with what's typed, then
 * a word in the name starting with it, then names or projects containing it; past a space, only names
 * that go on that way. Equals keep the list's order. Nothing typed: the list's first. */
export function rankAgents(query: string, agents: Named["agents"], limit: number): Named["agents"] {
  const typed = folded(query);
  if (!typed) return agents.slice(0, limit);
  const words = /\s/u.test(typed);
  const rank = (agent: Named["agents"][number]): number | null => {
    const name = folded(agent.name);
    if (name === typed) return 0;
    if (name.startsWith(typed)) return 1;
    if (words) return name.includes(typed) ? 3 : null;
    if (name.split(/[^\p{L}\p{N}]+/u).some(word => word && word.startsWith(typed))) return 2;
    if (name.includes(typed)) return 3;
    if (agent.project !== null && folded(agent.project).includes(typed)) return 4;
    return null;
  };
  return agents.flatMap((agent, index) => { const at = rank(agent); return at === null ? [] : [{ agent, at, index }]; })
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .slice(0, limit)
    .map(each => each.agent);
}

/** What "&"'s list says beside an agent, as the Mac's (AgentReferenceList): a bot's job (else
 * "Bot"), a session's project (a chat's "Chat", else "Session"), and the computer it's on. */
export function agentDetail(agent: Named["agents"][number]): string {
  const what = agent.kind === "bot" ? (agent.about || "Bot") : agent.project === "Chats" ? "Chat" : agent.project ?? "Session";
  return what + (agent.machine ? ` · on ${agent.machine}` : "");
}

// The files listed for "@" a moment ago (or being listed), by folders and whether dated: what's
// typed next ranks the same list rather than read every folder again for each letter. A dated list
// serves what's typed too (its order is the ranking's then).
const listed = new Map<string, { at: number; files: Promise<MentionableFile[]> }>();
const LISTED_FOR = 5_000;

function filesFor(roots: string[], dated: boolean, signal?: AbortSignal): Promise<MentionableFile[]> {
  const key = (withDates: boolean) => JSON.stringify([roots, withDates]);
  const fresh = (withDates: boolean) => { const kept = listed.get(key(withDates)); return kept && Date.now() - kept.at < LISTED_FOR ? kept.files : null; };
  const kept = fresh(dated) ?? (dated ? null : fresh(true));
  if (kept) return kept;
  const files = mentionableFiles(roots, dated, signal);
  listed.set(key(dated), { at: Date.now(), files });
  // (One that failed, or was stopped, isn't kept.)
  files.catch(() => listed.delete(key(dated)));
  if (signal) signal.addEventListener("abort", () => listed.delete(key(dated)), { once: true });
  if (listed.size > 20) listed.delete(listed.keys().next().value!);
  return files;
}

// `GET kuvo/sessions/<id>/mentions?for=files|agents&q=<typed>[&limit=<n>]`.
export async function* mentionsRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const query = new URLSearchParams(request.path.split("?")[1] ?? "");
  const kind = query.get("for");
  if (kind !== "files" && kind !== "agents") return yield* json(400, { message: "Say what's suggested: for=files (\"@\") or for=agents (\"&\")." });
  const typed = query.get("q") ?? "";
  const asked = Number.parseInt(query.get("limit") ?? "", 10);
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MENTIONS_MOST) : MENTIONS_SHOWN;
  const session = decodeURIComponent(match[1]!);
  const targets = targetsOf({ readEngine, bridge });
  if (!targets.length) return yield* json(503, { message: "The engine isn't running." });
  let here: Awaited<ReturnType<typeof sessionHere>>;
  try {
    here = await sessionHere(targets, session, signal ?? undefined);
  } catch (error) {
    if (error instanceof Unreached) return yield* json(503, { message: error.message });
    throw error;
  }
  if (!here) return yield* json(404, { message: "There's no such conversation here." });
  if (kind === "agents") {
    const agents = (await namedNow(readEngine)).filter(agent => agent.session !== session);
    const mentions: Mention[] = rankAgents(typed, agents, limit).map(agent => ({ text: `&${agent.name}`, title: agent.name, detail: agentDetail(agent), kind: agent.kind, session: agent.session }));
    return yield* json(200, { mentions });
  }
  const data: EngineSession = here.data;
  const folder = data.location?.directory ?? data.directory;
  if (!folder) return yield* json(200, { mentions: [] });
  const roots = [folder, ...(foldersOf(data, folder) ?? []).filter(each => each !== folder)];
  // (When each changed only matters before anything's typed.)
  const files = await filesFor(roots, !typed, signal ?? undefined);
  const mentions: Mention[] = rankFiles(typed, files, limit).map(file => {
    const inside = path.posix.dirname(file.path.replace(/\/$/, ""));
    return { text: `@${file.mention}`, title: file.name, detail: file.isFolder || inside === "." ? null : inside, kind: file.isFolder ? "folder" : "file", session: null };
  });
  return yield* json(200, { mentions });
}
