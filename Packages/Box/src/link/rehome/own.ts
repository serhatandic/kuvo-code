// The box's own files, rewritten in the staged copy (#333 §3.4): every path they keep that names the
// old place, in the shapes the box keeps them (JSON and its lines, a file holding one folder, a
// script's lines), and what the box and its bridge keep by a path's hash (an artifact's ID, the
// bridge's snapshots, branch backups, usage's place in each log), renamed to the new path's.
//
// Never what's yours or an agent's own (your chats' and bots' folders, sent files, the agents'
// settings folders, the trash), what's made anew as the box starts (the sandbox's files, the
// engine's plugins), or what's encrypted (the vault).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { claudeSlug, mapJSON, mapLines, mapped, mappedValue, moves, namesOld, type PathMap } from "./paths";
import type { Placement } from "./state";

/** How a file of the box's is rewritten. */
type Kind = "json" | "lines-json" | "path" | "lines";

/** What isn't the box's to rewrite, by its place in a box's home (a glob's `*` one name). */
const NOT_OURS = [
  "engine", "data", "state", "cache", "workspace", "attachments", "chats", "integrations", "trash", "browser", "apps", "t", "bin", "moved-*",
  "box/vault", "box/keys", "box/bot-keys", "box/branch-backups/*/store",
  // (Made anew as the box starts.)
  "run/fence",
  "bots/*/workspace", "bots/*/memory",
  "agents/claude", "agents/codex", "agents/cursor", "agents/grok", "agents/antigravity", "agents/runtime", "agents/cache", "agents/snapshots", "agents/skills",
  "config", "updates",
];
/** What's the box's inside what isn't. */
const OURS_INSIDE = ["bots/*/workspace/.opencode/opencode.json", "config/opencode/opencode.json", "updates/rollback/restore.sh"];

const glob = (pattern: string) => new RegExp("^" + pattern.split("/").map(part => (part === "*" ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\*", "[^/]*"))).join("/") + "(/|$)");
const NOT_OURS_RULES = NOT_OURS.map(glob);
const OURS_INSIDE_RULES = OURS_INSIDE.map(pattern => new RegExp(glob(pattern).source.replace(/\(\/\|\$\)$/, "$")));

function kindOf(relative: string): Kind | null {
  const name = path.basename(relative);
  if (OURS_INSIDE_RULES.some(rule => rule.test(relative))) return name.endsWith(".sh") ? "lines" : "json";
  if (NOT_OURS_RULES.some(rule => rule.test(relative))) return null;
  if (/^(wakes|bots)\/[^/]+\/directory$/.test(relative)) return "path";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".jsonl") || name.endsWith(".ndjson")) return "lines-json";
  return null;
}
/** Whether a folder may hold any of the box's files: one that isn't left out, or one on the way to
 * what's the box's inside what is. */
const mayHold = (relative: string) => !NOT_OURS_RULES.some(rule => rule.test(relative)) || OURS_INSIDE.some(pattern => leadsTo(pattern, relative));
const leadsTo = (pattern: string, relative: string) => {
  const parts = pattern.split("/"), mine = relative.split("/");
  return mine.length < parts.length && mine.every((part, at) => parts[at] === "*" || parts[at] === part);
};

/** One staged file of the box's, and its place in the box's home layout. */
export interface OwnFile { file: string; relative: string; kind: Kind }

/** Where each placement is in the box's home's layout (`run`, `box`, `data`…): where it goes on a
 * move, where it came from on a move back. */
export const homeSide = (placement: Placement, way: "move" | "back") => (way === "move" ? placement.to : placement.from);

/** Every file of the box's in the staged copy. */
export function ownFiles(placements: readonly Placement[], way: "move" | "back", home: string): OwnFile[] {
  const found: OwnFile[] = [];
  const walk = (file: string, relative: string, depth: number) => {
    let kind: fs.Stats;
    try { kind = fs.lstatSync(file); } catch { return; }
    if (kind.isFile()) {
      const how = kindOf(relative);
      if (how) found.push({ file, relative, kind: how });
      return;
    }
    if (!kind.isDirectory() || depth > 12 || !mayHold(relative)) return;
    let names: string[] = [];
    try { names = fs.readdirSync(file); } catch {}
    for (const name of names) walk(path.join(file, name), `${relative}/${name}`, depth + 1);
  };
  for (const placement of placements) {
    if (placement.installed || !fs.existsSync(placement.staged)) continue;
    const relative = path.relative(home, homeSide(placement, way));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    walk(placement.staged, relative, 0);
  }
  return found;
}

const artifactID = (file: string) => "art_" + createHash("sha256").update(file).digest("hex").slice(0, 24);

/** One line of the record of what agents made, its artifact's ID following its path (`art_` and
 * the path's hash). */
function mapArtifactLine(value: unknown, map: PathMap): unknown {
  const a = (value as { a?: { id?: unknown; path?: unknown } } | null)?.a;
  if (a && typeof a.path === "string" && typeof a.id === "string" && moves(a.path, map) && a.id === artifactID(a.path)) a.id = artifactID(mapped(a.path, map));
  return value;
}

/** A file of the box's rewritten where it names the old place; whether it changed. */
export function rewriteOwnFile({ file, relative, kind }: OwnFile, map: PathMap): boolean {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  if (!namesOld(text, map)) return false;
  let next = text;
  if (kind === "path") {
    const to = mappedValue(text.trim(), map);
    if (to !== null) next = text.replace(text.trim(), to);
  } else if (kind === "lines") {
    next = mapLines(text, map);
  } else if (kind === "json") {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return false; }
    const { value: rewritten, changed } = mapJSON(value, map);
    if (changed) next = JSON.stringify(rewritten, null, /\n {2}"/.test(text) ? 2 : /\n "/.test(text) ? 1 : /\n\t/.test(text) ? "\t" : undefined) + (text.endsWith("\n") ? "\n" : "");
  } else {
    const artifacts = relative.startsWith("artifacts/");
    next = text.split("\n").map(line => {
      if (!line.trim() || !namesOld(line, map)) return line;
      try {
        const parsed = JSON.parse(line);
        const { value, changed } = mapJSON(artifacts ? mapArtifactLine(parsed, map) : parsed, map);
        return changed ? JSON.stringify(value) : line;
      } catch {
        return line;
      }
    }).join("\n");
  }
  if (next === text) return false;
  const mode = fs.statSync(file).mode & 0o7777;
  const temporary = `${file}.rehome`;
  fs.writeFileSync(temporary, next, { mode });
  fs.renameSync(temporary, file);
  return true;
}

/** What the box and its bridge keep by a path's hash, renamed for each folder that moved: the
 * bridge's snapshots and the box's branch backups (`<sha1(top)[:20]>`), and usage's place in each
 * log (`<sha256(log)[:32]>.json`, its `path` rewritten already). */
export function renameKeptByPath(placements: readonly Placement[], way: "move" | "back", home: string, folders: Iterable<string>, map: PathMap): void {
  const stagedAt = (relative: string): string | null => {
    for (const placement of placements) {
      const side = path.relative(home, homeSide(placement, way));
      if (relative === side || relative.startsWith(side + "/")) return path.join(placement.staged, path.relative(side, relative));
    }
    return null;
  };
  const short = (folder: string) => createHash("sha1").update(folder).digest("hex").slice(0, 20);
  const list = [...folders].filter(folder => moves(folder, map));
  for (const relative of ["agents/snapshots", "box/branch-backups"]) {
    const root = stagedAt(relative);
    if (!root || !fs.existsSync(root)) continue;
    for (const folder of list) {
      const from = path.join(root, short(folder)), to = path.join(root, short(mapped(folder, map)));
      if (from !== to && fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    }
  }
  // (A Claude Code log's in its folder's history, which is renamed for the folder's new place too.)
  const slugs = new Map(list.map(folder => [claudeSlug(folder), claudeSlug(mapped(folder, map))]));
  const usage = stagedAt("agents/usage");
  for (const kind of usage ? listOf(usage) : []) {
    if (!kind.endsWith("-files")) continue;
    for (const name of listOf(path.join(usage!, kind))) {
      const file = path.join(usage!, kind, name);
      let kept: any;
      try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      if (typeof kept?.path !== "string") continue;
      const history = /^(.*\/projects\/)([^/]+)(\/.*)$/.exec(kept.path);
      if (history && slugs.has(history[2]) && slugs.get(history[2]) !== history[2]) {
        kept.path = history[1] + slugs.get(history[2]) + history[3];
        fs.writeFileSync(file, JSON.stringify(kept), { mode: fs.statSync(file).mode & 0o7777 });
      }
      const named = createHash("sha256").update(kept.path).digest("hex").slice(0, 32) + ".json";
      if (named !== name && !fs.existsSync(path.join(usage!, kind, named))) fs.renameSync(file, path.join(usage!, kind, named));
    }
  }
}

const listOf = (folder: string): string[] => { try { return fs.readdirSync(folder); } catch { return []; } };

/** The folders the box's files name that move (its sessions', projects', worktrees', bots', wake-ups'
 * folders, and every other path it records whole): what's kept by a folder's path, in the agents'
 * history and the bridge's stores, is renamed for these. Over-naming costs only a look. */
export function ownFolders(placements: readonly Placement[], way: "move" | "back", home: string, map: PathMap): string[] {
  const folders = new Set<string>();
  const note = (value: unknown) => {
    if (typeof value === "string" && path.isAbsolute(value) && !value.includes("\n") && moves(value, map)) folders.add(value.replace(/\/+$/, ""));
  };
  const walk = (value: unknown): void => {
    if (typeof value === "string") note(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) { note(key); walk(inner); }
  };
  for (const { file, kind } of ownFiles(placements, way, home)) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (!namesOld(text, map)) continue;
    if (kind === "path") note(text.trim());
    else if (kind === "json") { try { walk(JSON.parse(text)); } catch {} }
    else if (kind === "lines-json") for (const line of text.split("\n")) { if (line.trim()) try { walk(JSON.parse(line)); } catch {} }
  }
  return [...folders];
}

/** The box's own files that still name the old place, once rewritten. */
export function ownLeftovers(placements: readonly Placement[], way: "move" | "back", home: string, map: PathMap): string[] {
  const left: string[] = [];
  for (const each of ownFiles(placements, way, home)) {
    let text = "";
    try { text = fs.readFileSync(each.file, "utf8"); } catch { continue; }
    if (!namesOld(text, map)) continue;
    // (In what's ours, a path among other words, a person's or an agent's, isn't ours to change.)
    if (each.kind === "json" || each.kind === "lines-json") {
      let exact = false;
      const look = (value: unknown): void => {
        if (exact) return;
        if (typeof value === "string") { if (mappedValue(value, map) !== null) exact = true; return; }
        if (Array.isArray(value)) { value.forEach(look); return; }
        if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) { if (mappedValue(key, map) !== null) exact = true; look(inner); }
      };
      try {
        if (each.kind === "json") look(JSON.parse(text));
        else for (const line of text.split("\n")) if (line.trim()) try { look(JSON.parse(line)); } catch {}
      } catch { continue; }
      if (!exact) continue;
    }
    left.push(each.relative);
  }
  return left;
}

/** Where else in what moved the old place is still named, for support (never a failure): text files
 * of what moved but what's yours (chats, sent files) and what's made anew. At most `most`. */
export function namedElsewhere(placements: readonly Placement[], way: "move" | "back", home: string, map: PathMap, most = 50): string[] {
  const ours = new Set(ownFiles(placements, way, home).map(each => each.file));
  const skip = /^(engine|attachments|chats|cache|state|workspace|browser|apps|t|bin|trash|data\/opencode\/(worktree|snapshot|repos|log|bin))(\/|$)|\/(node_modules|\.git)(\/|$)/;
  const found: string[] = [];
  // (A search for support, not a check: as far as 20,000 files, said where it stopped.)
  let looked = 0;
  const walk = (file: string, relative: string, depth: number) => {
    if (found.length >= most || looked > 20_000 || skip.test(relative)) return;
    let kind: fs.Stats;
    try { kind = fs.lstatSync(file); } catch { return; }
    if (kind.isDirectory()) {
      if (depth > 10) return;
      for (const name of listOf(file)) walk(path.join(file, name), `${relative}/${name}`, depth + 1);
      return;
    }
    if (!kind.isFile() || kind.size > 8_000_000 || ours.has(file) || /\.db(-wal|-shm)?$/.test(file)) return;
    if (++looked > 20_000) { found.push("(the search stopped after 20,000 files)"); return; }
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    if (namesOld(text, map)) found.push(relative);
  };
  for (const placement of placements) {
    if (placement.installed || !fs.existsSync(placement.staged)) continue;
    const relative = path.relative(home, homeSide(placement, way));
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    walk(placement.staged, relative, 0);
  }
  return found;
}
