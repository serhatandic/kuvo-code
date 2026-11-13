// What names the old place, rewritten as the box moves (#333 §3.4, piece 2b): the box's own files,
// the engine's database and the folders it keeps by a path, worktrees' git links, and the coding
// agents' history kept by a folder's path. One path map (old prefix → new) applied by one rewriter;
// a move back is the same map turned around. Then it's checked: nothing left where it rewrites, the
// counts as they were, and the engine started on the rewritten data answers with the same sessions.

import fs from "node:fs";
import path from "node:path";
import { enginesIn } from "../../shared/engines";
import { checkWithEngine } from "./engine-check";
import { databaseCounts, databaseFolders, databaseLeftovers, databasesIn, rewriteDataFolders, rewriteDatabase, schemaRefusal } from "./database";
import { homeSide, namedElsewhere, ownFiles, ownFolders, ownLeftovers, renameKeptByPath, rewriteOwnFile } from "./own";
import { claudeAccounts, clearClaudeSignIns, clearGrokIndex, copyClaudeSignIns, ownAgentHomes, renameClaudeHistory, renameGrokSessions, repairWorktrees, rewriteAgents, setAsideGrokIndex } from "./outside";
import { mapped, type PathMap } from "./paths";
import type { Act, Placement } from "./state";

export { mapped, pathMap, type PathMap } from "./paths";

/** A move as the rewriter sees it: which way, the box's home and its app's folder, what moves where
 * (`placements`, staged first), the path map, and a folder of the move's own for its work. */
export interface MoveContext {
  way: "move" | "back";
  home: string;
  appFolder: string;
  placements: readonly Placement[];
  map: PathMap;
  work: string;
}

/** What a rewriter does at each of the move's steps. Each may throw: before the move clears the
 * old place, that goes back. */
export interface Rewriter {
  /** Why the move can't go ahead (an engine database of a schema it doesn't know), or null. Asked
   * as the move's planned, before anything changes. */
  refuses(move: MoveContext): string | null;
  /** The staged copy rewritten (`staged` in each placement), before it's checked. */
  rewrite(move: MoveContext): void;
  /** The staged copy checked: throws with what's wrong; else what still names the old place where
   * it isn't the box's to change (said for support, never a failure). */
  check(move: MoveContext): Promise<string[]>;
  /** What's outside the box that names its folders, fixed once it's in place, each change
   * journaled through `journal` first, so going back puts it back. */
  outside(move: MoveContext, journal: (act: Act) => void): void;
  /** What's owed once the old place is cleared (the originals of the sign-ins copied, deleted). */
  cleared(move: MoveContext): void;
}

/** The rewriter that moves nothing's paths: for a test of the move's own steps alone. */
export const NO_REWRITE: Rewriter = {
  refuses: () => null,
  rewrite: () => {},
  check: async () => [],
  outside: () => {},
  cleared: () => {},
};

/** The placement whose place in the box's home is `name` (`data`, `agents`, `engine`…). */
function placementOf(move: MoveContext, name: string): Placement | undefined {
  return move.placements.find(each => !each.installed && path.relative(move.home, homeSide(each, move.way)) === name);
}

/** Where `file` (named as it will be) is staged now, or null where it isn't moving. */
function stagedOf(move: MoveContext, file: string): string | null {
  const placement = move.placements
    .filter(each => file === each.to || file.startsWith(each.to + "/"))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return placement ? path.join(placement.staged, path.relative(placement.to, file)) : null;
}

const reversed = (map: PathMap): PathMap => map.map(({ from, to }) => ({ from: to, to: from })).sort((a, b) => b.from.length - a.from.length);
const exists = (file: string): boolean => { try { fs.statSync(file); return true; } catch { return false; } };
const listOf = (folder: string): string[] => { try { return fs.readdirSync(folder); } catch { return []; } };

/** The folders the box's sessions and agents worked in, as they were (the move's own record of them,
 * `folders.json`, written as it rewrites). */
const foldersFile = (move: MoveContext) => path.join(move.work, "folders.json");
const countsFile = (move: MoveContext) => path.join(move.work, "counts.json");
function readFolders(move: MoveContext): string[] {
  try {
    const kept = JSON.parse(fs.readFileSync(foldersFile(move), "utf8"));
    return Array.isArray(kept) ? kept.filter((each: unknown): each is string => typeof each === "string") : [];
  } catch {
    return [];
  }
}

/** The engine the staged box starts: the version its keeper names (`V=` in `bin/kuvo-start`), else
 * the newest there. */
function stagedEngine(move: MoveContext): string | null {
  const engines = placementOf(move, "engine");
  if (!engines || !exists(engines.staged)) return null;
  const versions = enginesIn(engines.staged);
  let named: string | undefined;
  const keeper = move.placements.find(each => each.installed)?.staged;
  for (const file of [keeper && path.join(keeper, "kuvo-start"), path.join(move.home, "bin", "kuvo-start")]) {
    if (!file) continue;
    try { named = /^V=([0-9][0-9A-Za-z.+-]*)$/m.exec(fs.readFileSync(file, "utf8"))?.[1]; } catch {}
    if (named) break;
  }
  const version = named && versions.includes(named) ? named : versions.at(-1);
  return version ? path.join(engines.staged, version, "opencode") : null;
}

/** What placing will rename as it merges a folder into one that's there (a sent file of the app's
 * named as one of the box's: `<name> 2`), worked out as `place` does it, in its order, before
 * anything's placed: each to its new name, for what names it to follow it. Only a move's: going
 * back, what's put there keeps its name. */
export function mergeClashes(move: MoveContext): PathMap {
  if (move.way !== "move") return [];
  const clashes: PathMap = [];
  const kindOf = (file: string): "file" | "dir" | null => { try { return fs.lstatSync(file).isDirectory() ? "dir" : "file"; } catch { return null; } };
  const byPlace = new Map<string, Placement[]>();
  for (const placement of move.placements) byPlace.set(placement.to, [...(byPlace.get(placement.to) ?? []), placement]);
  for (const [to, group] of byPlace) {
    // What's there, as it will be: what's in its place already, then each placed in turn.
    const taken = new Map<string, "file" | "dir">();
    const add = (file: string, relative: string) => {
      const kind = kindOf(file);
      if (!kind) return;
      taken.set(relative, kind);
      if (kind === "dir") for (const name of listOf(file)) add(path.join(file, name), path.join(relative, name));
    };
    if (kindOf(to)) add(to, "");
    const free = (relative: string) => {
      const extension = path.extname(relative), base = relative.slice(0, relative.length - extension.length);
      for (let n = 2; ; n++) if (!taken.has(`${base} ${n}${extension}`)) return `${base} ${n}${extension}`;
    };
    for (const placement of group) {
      const put = (file: string, relative: string) => {
        const kind = kindOf(file);
        if (!kind) return;
        if (taken.get(relative) === "dir" && kind === "dir") {
          for (const name of listOf(file).sort()) put(path.join(file, name), path.join(relative, name));
        } else if (!taken.has(relative)) {
          add(file, relative);
        } else {
          const named = free(relative);
          clashes.push({ from: path.join(placement.from, relative), to: path.join(to, named) });
          add(file, named);
        }
      };
      put(placement.staged, "");
    }
  }
  return clashes;
}

/** The map the rewrite goes by: the move's, and what merging renames. */
const withClashes = (move: MoveContext): PathMap => [...mergeClashes(move), ...move.map].sort((a, b) => b.from.length - a.from.length);

/** The rewriter (#333 §3.4). */
export const PATH_REWRITER: Rewriter = {
  refuses(move) {
    const data = placementOf(move, "data");
    const folder = data ? path.join(data.from, "opencode") : null;
    if (!folder || !databasesIn(folder).length) return null;
    if (!process.versions.bun) return "This Mac's box moves only when run by its engine's Bun.";
    return schemaRefusal(folder);
  },

  rewrite(move) {
    const { placements, way, home } = move;
    const map = withClashes(move);
    fs.mkdirSync(move.work, { recursive: true, mode: 0o700 });
    const data = placementOf(move, "data");
    const engineData = data ? path.join(data.staged, "opencode") : null;
    // The folders worked in, as they were (before the database is rewritten).
    const folders = new Set<string>(ownFolders(placements, way, home, map));
    if (engineData) for (const database of databasesIn(engineData)) for (const folder of databaseFolders(database)) folders.add(folder);
    for (const name of ["chats", "bots"]) {
      const placement = placementOf(move, name);
      for (const each of placement ? listOf(placement.from) : []) folders.add(name === "bots" ? path.join(placement!.from, each, "workspace") : path.join(placement!.from, each));
    }
    const list = [...folders].filter(folder => path.isAbsolute(folder)).sort();
    fs.writeFileSync(foldersFile(move), JSON.stringify(list), { mode: 0o600 });
    // The engine's (what each held counted first, from the copy, to hold the rewrite to).
    if (engineData) {
      const counts: Record<string, ReturnType<typeof databaseCounts>> = {};
      for (const database of databasesIn(engineData)) counts[path.basename(database)] = databaseCounts(database);
      fs.writeFileSync(countsFile(move), JSON.stringify(counts), { mode: 0o600 });
      for (const database of databasesIn(engineData)) {
        const { projects } = rewriteDatabase(database, map);
        rewriteDataFolders(engineData, database, projects, map);
      }
    }
    // The box's own, and what it keeps by a path's hash.
    for (const file of ownFiles(placements, way, home)) rewriteOwnFile(file, map);
    renameKeptByPath(placements, way, home, list, map);
    // The coding agents' own, in the bridge's folder: added accounts' history, Cursor's records.
    const agents = placementOf(move, "agents");
    if (agents && exists(agents.staged)) rewriteAgents(agents.staged, list, map);
  },

  async check(move) {
    const { map, placements, way, home } = move;
    // Nothing left where it rewrites.
    const left = ownLeftovers(placements, way, home, map);
    if (left.length) throw new Error(`The box's files still name where it was: ${left.slice(0, 5).join(", ")}${left.length > 5 ? "…" : ""}`);
    const notes: string[] = [];
    const data = placementOf(move, "data");
    const engineData = data ? path.join(data.staged, "opencode") : null;
    for (const database of engineData ? databasesIn(engineData) : []) {
      const { rewritten, elsewhere } = databaseLeftovers(database, map);
      if (rewritten.length) throw new Error(`The engine's database still names where the box was: ${rewritten.join(", ")}`);
      notes.push(...elsewhere.map(each => `${path.basename(database)}: ${each}`));
      // The same sessions and projects as before.
      const before = (JSON.parse(fs.readFileSync(countsFile(move), "utf8")) as Record<string, ReturnType<typeof databaseCounts>>)[path.basename(database)];
      if (!before) throw new Error(`The engine's database ${path.basename(database)} wasn't counted before it was rewritten.`);
      const after = databaseCounts(database);
      if (before.sessions !== after.sessions || before.projects !== after.projects) {
        throw new Error(`The engine's database lost what it held as it was rewritten (${after.sessions} of ${before.sessions} sessions, ${after.projects} of ${before.projects} projects).`);
      }
    }
    notes.push(...namedElsewhere(placements, way, home, map));
    // The engine started on what's staged answers with the same sessions, each in its new folder.
    const main = engineData ? path.join(engineData, "opencode.db") : null;
    if (main && exists(main) && databaseCounts(main).sessions) {
      const engine = stagedEngine(move);
      if (!engine) throw new Error("There's no engine to check the moved sessions with.");
      const back = reversed(map);
      await checkWithEngine({
        engine,
        data: data!.staged,
        scratch: path.join(move.work, "check"),
        lost: folder => {
          const was = mapped(folder, back);
          if (was === folder || !exists(was)) return false;
          const staged = stagedOf(move, folder);
          return staged !== null && !exists(staged);
        },
      });
    }
    return notes;
  },

  outside(move, journal) {
    const { map, placements } = move;
    const rename = (from: string, to: string) => {
      journal({ act: "rename", from, to });
      fs.renameSync(from, to);
    };
    // Worktrees' links, from each repository's place now.
    repairWorktrees(placements.filter(each => !each.installed).map(each => each.to), map, journal);
    // Your own Claude Code's and Grok's history of each folder that moved.
    const folders = readFolders(move);
    const own = ownAgentHomes();
    renameClaudeHistory(own.claude, folders, map, rename);
    if (renameGrokSessions(own.grok, map, rename)) setAsideGrokIndex(own.grok, rename);
    // Each added Claude Code account's sign-in, under its folder's new name.
    const agents = placementOf(move, "agents");
    if (agents) copyClaudeSignIns(claudeAccounts(agents.from), map, journal);
  },

  cleared(move) {
    clearGrokIndex(ownAgentHomes().grok);
    const agents = placementOf(move, "agents");
    if (!agents) return;
    // (The accounts as they were: where they are now, named as they were.)
    const back = reversed(move.map);
    clearClaudeSignIns(claudeAccounts(agents.to).map(folder => mapped(folder, back)), move.map);
  },
};
