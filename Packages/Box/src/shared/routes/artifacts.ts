// What a box's agents made (PROTOCOL.md, `kuvo/artifacts`): a place's list and Timeline, one thing
// with its versions, a version's bytes and what it changed, pinning, putting a version back, and
// what the copies take. The coding agents' bridge keeps the record and answers
// (src/agents/artifacts/routes.ts), and the box passes its answers on as they are: these are the
// shapes it answers in. Times are seconds since 1970.

import { bool, BYTES, list, nullable, number, object, oneOf, type RouteShape, string, words } from "../shape";

const KIND = words("memory", "skill", "image", "page", "document", "download", "code", "file");

/** One version: what one turn (or you, or something outside a turn) made of it. */
export const VERSION = object({
  n: number,
  at: nullable(number),
  by: object({ kind: words("agent", "you", "outside"), "session?": string, "bot?": string, "agent?": string }),
  "turn?": object({ session: string, "message?": string }),
  "group?": object({ id: string, "message?": string }),
  "trigger?": words("you", "wake", "group", "agent"),
  via: list(string),
  status: words("added", "modified", "deleted"),
  edits: number,
  "lines?": object({ added: number, removed: number }),
  size: number,
  hash: nullable(string),
  kept: bool,
  "reason?": words("secret", "ignored", "git", "too-big", "low-disk", "cleared"),
  "patch?": string,
  "restored?": number,
  "before?": bool,
  "handoff?": object({ from: string }),
});

const HEADER = {
  id: string,
  path: string,
  name: string,
  kind: KIND,
  type: string,
  where: object({ bots: list(string), "project?": string, sessions: list(string), groups: list(string) }),
  pinned: nullable(object({ by: words("bot", "you"), at: nullable(number), "note?": string })),
  gone: nullable(number),
  "shown?": nullable(number),
  "living?": bool,
  "git?": bool,
  restorable: bool,
  updated: nullable(number),
} as const;

/** One thing with every version, oldest first. */
export const ARTIFACT = object({ ...HEADER, versions: list(VERSION) });

/** A place's things, pinned first, then the latest changed, each with its newest version. */
export const ARTIFACT_LIST = object({ artifacts: list(object({ ...HEADER, versions: number, latest: VERSION })), next: nullable(string) });

/** Every version made in a place, newest first, each with its thing. */
export const ARTIFACT_TIMELINE = object({ entries: list(object({ artifact: object(HEADER), version: VERSION })), next: nullable(string) });

/** What the copies take, in bytes: all of them, older versions', the budget, the disk's free space
 * and the floor kept free; `low` while it's under the floor. */
export const ARTIFACT_STORAGE = object({ copies: number, older: number, budget: number, free: number, floor: number, low: bool });

/** What a version changed since the one before: words in prose, lines in code, or the two to show
 * side by side (a picture, a PDF). */
export const ARTIFACT_CHANGES = oneOf(
  object({ style: words("words"), lines: list(object({ kind: string, "text?": string, "runs?": list(object({ t: string, text: string })), "lines?": number })), added: number, removed: number, from: nullable(number), to: number }),
  object({ style: words("lines"), patch: string, added: number, removed: number, from: nullable(number), to: number }),
  object({ style: words("pair", "none"), from: nullable(number), to: number }),
);

export const ARTIFACT_ROUTES: RouteShape[] = [
  { route: "GET kuvo/artifacts", answers: { 200: ARTIFACT_LIST } },
  { route: "GET kuvo/artifacts/timeline", answers: { 200: ARTIFACT_TIMELINE } },
  { route: "GET kuvo/artifacts/storage", answers: { 200: ARTIFACT_STORAGE } },
  { route: "POST kuvo/artifacts/storage", answers: { 200: ARTIFACT_STORAGE } },
  { route: "POST kuvo/artifacts/storage/clear", answers: { 200: object({ cleared: number, copies: number, older: number, budget: number, free: number, floor: number, low: bool }) } },
  { route: "GET kuvo/artifacts/:id", answers: { 200: ARTIFACT } },
  { route: "POST kuvo/artifacts/:id/pin", answers: { 200: ARTIFACT } },
  { route: "POST kuvo/artifacts/:id/restore", answers: { 200: ARTIFACT } },
  { route: "GET kuvo/artifacts/:id/versions/:n", answers: { 200: BYTES } },
  { route: "GET kuvo/artifacts/:id/versions/:n/changes", answers: { 200: ARTIFACT_CHANGES } },
];
