// The engine's own data, rewritten for the box's new place (#333 §3.4, piece 0's trial 4): its
// database (opencode's, unmodified), with the engine stopped and in one transaction, only in the
// columns that are paths and only for a schema this was tried with; the projects outside git, whose
// IDs are made from their folders' paths, with what refers to them; and the folders it keeps by a
// path (`snapshot/<project>/<sha1(path)>`, `shell/<project>`), with the snapshots' own links.
//
// Never what a person or an agent wrote (messages' text, shell output, titles, the instructions'
// blobs): those are listed by the search for what's left, and stay as they were.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { folderProjectID, mapLines, mapped, mappedURL, mappedValue, mapJSON, moves, namesOld, snapshotName, type PathMap } from "./paths";

/** The schemas the rewrite was tried with: the engine's migrations, counted and the last
 * (`SELECT count(*), max(id) FROM migration`), as its pinned version made them. The weekly upstream
 * check adds a new engine's once it's checked that its migrations touch no path column or ID rule. */
export const KNOWN_SCHEMAS: readonly string[] = ["59 20261030054400_job"];

/** The columns that are a path, whole. */
const PATH_COLUMNS: readonly [string, string][] = [
  ["project", "worktree"], ["session_v2", "directory"], ["worktree", "directory"], ["project_directory", "directory"],
];
/** The columns of JSON whose every value that's a path is one (no one's words in them). */
const JSON_COLUMNS: readonly [string, string][] = [
  ["project", "sandboxes"], ["session_v2", "revert"], ["session_v2", "summary_diffs"], ["session_v2", "permission"], ["session_v2", "metadata"], ["workspace", "binding"],
];
/** The columns of JSON a person's words are in too: only the files sent with them (`files[*]`'s URL). */
const FILES_COLUMNS: readonly [string, string][] = [["session_message", "data"], ["session_inbox", "payload"]];
/** The columns a project's ID is in. */
const PROJECT_ID_COLUMNS: readonly [string, string][] = [
  ["session_v2", "project_id"], ["permission", "project_id"], ["worktree", "project_id"], ["project_directory", "project_id"],
  ["event_sequence", "aggregate_id"], ["event", "aggregate_id"],
];

interface Statement { all(...values: unknown[]): any[]; iterate(...values: unknown[]): IterableIterator<any>; get(...values: unknown[]): any; run(...values: unknown[]): unknown }
interface Database { query(sql: string): Statement; exec(sql: string): void; close(): void }

/** SQLite, as the engine's Bun has it (`bun:sqlite`): the box's command runs with that Bun. */
function open(file: string, readonly = false): Database {
  let sqlite: { Database: new (file: string, options?: object) => Database };
  try {
    sqlite = createRequire(import.meta.url)(["bun", "sqlite"].join(":"));
  } catch {
    throw new Error("The engine's database can only be rewritten by the box run with the engine's Bun.");
  }
  return new sqlite.Database(file, readonly ? { readonly: true } : { readwrite: true });
}

/** Every channel's database in an engine's data folder (`opencode*.db`). */
export function databasesIn(folder: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(folder); } catch {}
  return names.filter(name => name.startsWith("opencode") && name.endsWith(".db")).sort().map(name => path.join(folder, name));
}

/** A column's text naming an old prefix somewhere (plainly or URL-encoded), as SQL: what's then
 * looked at row by row, never the whole table. */
function naming(column: string, map: PathMap): { where: string; values: string[] } {
  // (By the folder every old prefix is in, where there's one: one look a row, not one a prefix.)
  const parts = map.map(({ from }) => from.split("/"));
  const common = parts.length ? parts[0].slice(0, parts.reduce((most, each) => {
    let n = 0;
    while (n < most && each[n] === parts[0][n]) n++;
    return n;
  }, parts[0].length)).join("/") : "";
  const prefixes = common.split("/").length > 2 ? [common] : map.map(({ from }) => from);
  const forms = [...new Set(prefixes.flatMap(from => [from, pathToFileURL(from).href.slice("file://".length)]))];
  return { where: `typeof("${column}") = 'text' AND (${forms.map(() => `instr("${column}", ?) > 0`).join(" OR ") || "0"})`, values: forms };
}

const tables = (db: Database): Set<string> => new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name as string));

/** The schema's mark (`<count> <last migration>`), or null for a database with no tables at all
 * (made, never used). */
export function schemaMark(file: string): string | null {
  const db = open(file, true);
  try {
    const there = tables(db);
    if (!there.size) return null;
    if (!there.has("migration")) return "unknown";
    const row = db.query("SELECT count(*) AS n, max(id) AS last FROM migration").get();
    return `${row.n} ${row.last}`;
  } finally {
    db.close();
  }
}

/** Why the databases in `folder` can't be rewritten (a schema it doesn't know), or null. */
export function schemaRefusal(folder: string): string | null {
  for (const file of databasesIn(folder)) {
    let mark: string | null;
    try { mark = schemaMark(file); } catch (error) {
      return `The engine's database (${path.basename(file)}) can't be read: ${(error as Error).message}`;
    }
    if (mark !== null && !KNOWN_SCHEMAS.includes(mark)) {
      return `The engine's database (${path.basename(file)}) is of a version this box can't move yet (${mark}): it moves once the box updates.`;
    }
  }
  return null;
}

/** A project whose ID changes with its folder (one outside git). */
export interface ProjectMove { from: string; to: string; folder: string }

/** What a database's rewrite did. */
export interface DatabaseRewrite {
  projects: ProjectMove[];
  changed: number;
}

/** The files sent with a message (`files[*]`, its `source.uri` or `uri`) written anew; how many. */
function mapFiles(value: unknown, map: PathMap): number {
  if (!value || typeof value !== "object" || !Array.isArray((value as { files?: unknown }).files)) return 0;
  let changed = 0;
  for (const file of (value as { files: unknown[] }).files) {
    if (!file || typeof file !== "object") continue;
    const each = file as { uri?: unknown; source?: { uri?: unknown } };
    if (typeof each.uri === "string") {
      const to = mappedURL(each.uri, map);
      if (to !== null) { each.uri = to; changed++; }
    }
    if (each.source && typeof each.source === "object" && typeof each.source.uri === "string") {
      const to = mappedURL(each.source.uri, map);
      if (to !== null) { each.source.uri = to; changed++; }
    }
  }
  return changed;
}

/** A database rewritten by the map, in one transaction, its foreign keys checked before it's kept. */
export function rewriteDatabase(file: string, map: PathMap): DatabaseRewrite {
  const db = open(file);
  try {
    const there = tables(db);
    const has = (table: string) => there.has(table);
    let changed = 0;
    const projects: ProjectMove[] = [];
    // (Links broken before it's rewritten, by an engine's own migration, aren't the rewrite's.)
    const brokenLink = (row: any) => `${row.table} ${row.rowid} ${row.parent} ${row.fkid}`;
    const brokenBefore = new Set(db.query("PRAGMA foreign_key_check").all().map(brokenLink));
    db.exec("BEGIN IMMEDIATE");
    try {
      // Projects outside git: their IDs are their folders', so they change with them.
      if (has("project")) {
        for (const row of db.query("SELECT id, worktree FROM project").all()) {
          if (typeof row.worktree !== "string" || !moves(row.worktree, map) || row.id !== folderProjectID(row.worktree)) continue;
          projects.push({ from: row.id, to: folderProjectID(mapped(row.worktree, map)), folder: row.worktree });
        }
        for (const { from, to } of projects) {
          if (db.query("SELECT 1 FROM project WHERE id = ?").get(to)) throw new Error(`The engine's database has a project at ${to} already.`);
          db.query("UPDATE project SET id = ? WHERE id = ?").run(to, from);
          for (const [table, column] of PROJECT_ID_COLUMNS) {
            if (has(table)) db.query(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`).run(to, from);
          }
          changed++;
        }
      }
      for (const [table, column] of PATH_COLUMNS) {
        if (!has(table)) continue;
        const { where, values } = naming(column, map);
        for (const row of db.query(`SELECT rowid AS r, "${column}" AS v FROM "${table}" WHERE ${where}`).all(...values)) {
          if (typeof row.v !== "string" || !moves(row.v, map)) continue;
          db.query(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`).run(mapped(row.v, map), row.r);
          changed++;
        }
      }
      // A rule's folder, where one's named: its glob from the old folder on.
      if (has("permission")) {
        const { where, values } = naming("resource", map);
        for (const row of db.query(`SELECT rowid AS r, resource AS v FROM permission WHERE ${where}`).all(...values)) {
          if (typeof row.v !== "string" || !moves(row.v, map)) continue;
          db.query("UPDATE permission SET resource = ? WHERE rowid = ?").run(mapped(row.v, map), row.r);
          changed++;
        }
      }
      const rewriteJSON = (table: string, column: string, how: (value: unknown) => number) => {
        if (!has(table)) return;
        const { where, values } = naming(column, map);
        for (const row of db.query(`SELECT rowid AS r, "${column}" AS v FROM "${table}" WHERE ${where}`).all(...values)) {
          if (typeof row.v !== "string" || !namesOld(row.v, map)) continue;
          let value: unknown;
          try { value = JSON.parse(row.v); } catch { continue; }
          const holder = { value };
          const count = how(holder);
          if (!count) continue;
          db.query(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`).run(JSON.stringify(holder.value), row.r);
          changed += count;
        }
      };
      for (const [table, column] of JSON_COLUMNS) {
        rewriteJSON(table, column, holder => {
          const { value, changed: count } = mapJSON((holder as { value: unknown }).value, map);
          (holder as { value: unknown }).value = value;
          return count;
        });
      }
      for (const [table, column] of FILES_COLUMNS) rewriteJSON(table, column, holder => mapFiles((holder as { value: unknown }).value, map));
      const broken = db.query("PRAGMA foreign_key_check").all().filter(row => !brokenBefore.has(brokenLink(row)));
      if (broken.length) throw new Error(`The engine's database didn't hold together once rewritten (${broken.length} broken links, ${broken[0].table}).`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // (Written into the database itself, nothing left in its log for another to apply.)
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { projects, changed };
  } finally {
    db.close();
  }
}

/** The folders an engine's data folder keeps by a project's ID or a worktree's path, renamed as the
 * rewrite changed them (`shell/<project>`, `snapshot/<project>/<sha1(worktree)>`), and each
 * snapshot's own links (its worktree, the repository whose objects it borrows) written anew. */
export function rewriteDataFolders(data: string, database: string, projects: readonly ProjectMove[], map: PathMap): void {
  const renamed = new Map(projects.map(each => [each.from, each.to]));
  const idOf = (id: string) => renamed.get(id) ?? id;
  // Every folder a project was used in, by its ID as it was (the rewrite changed both).
  const folders = new Map<string, Set<string>>();
  const note = (id: unknown, folder: unknown) => {
    if (typeof id !== "string" || typeof folder !== "string") return;
    const was = [...renamed.entries()].find(([, to]) => to === id)?.[0] ?? id;
    folders.set(was, (folders.get(was) ?? new Set()).add(folder));
  };
  const db = open(database, true);
  try {
    const there = tables(db);
    const reverse = map.map(({ from, to }) => ({ from: to, to: from })).sort((a, b) => b.from.length - a.from.length);
    const old = (folder: string) => mapped(folder, reverse);
    if (there.has("project")) for (const row of db.query("SELECT id, worktree FROM project").all()) note(row.id, row.worktree);
    for (const table of ["worktree", "project_directory", "session_v2"]) {
      if (!there.has(table)) continue;
      for (const row of db.query(`SELECT project_id AS id, directory AS folder FROM "${table}"`).all()) note(row.id, row.folder);
    }
    const snapshots = path.join(data, "snapshot");
    for (const [was, now] of folders) {
      for (const folder of now) {
        const from = path.join(snapshots, was, snapshotName(old(folder)));
        const to = path.join(snapshots, idOf(was), snapshotName(folder));
        if (from === to || !fs.existsSync(from)) continue;
        if (fs.existsSync(to)) throw new Error(`The engine's snapshots of ${folder} are there twice.`);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
      }
    }
  } finally {
    db.close();
  }
  for (const [from, to] of renamed) {
    for (const kind of ["shell", "snapshot"]) {
      const was = path.join(data, kind, from), now = path.join(data, kind, to);
      if (!fs.existsSync(was)) continue;
      if (!fs.existsSync(now)) { fs.renameSync(was, now); continue; }
      // (Its snapshots moved over one by one above; what's left joins them.)
      for (const name of fs.readdirSync(was)) {
        if (fs.existsSync(path.join(now, name))) throw new Error(`The engine's ${kind} of ${to} is there twice.`);
        fs.renameSync(path.join(was, name), path.join(now, name));
      }
      fs.rmdirSync(was);
    }
  }
  // Each snapshot's settings (its worktree) and the repository it borrows objects from.
  for (const project of listOf(path.join(data, "snapshot"))) {
    for (const repository of listOf(path.join(data, "snapshot", project))) {
      for (const name of ["config", "opencode.gitconfig", path.join("objects", "info", "alternates")]) {
        const file = path.join(data, "snapshot", project, repository, name);
        let text: string;
        try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
        const next = mapLines(text, map);
        if (next !== text) fs.writeFileSync(file, next);
      }
    }
  }
}

const listOf = (folder: string): string[] => { try { return fs.readdirSync(folder); } catch { return []; } };

/** Whether a JSON value still holds, whole, a path the map moves (a value or a key): what the
 * rewrite would have rewritten. A path among other words (a diff's text) isn't. */
function holdsOldPath(value: unknown, map: PathMap): boolean {
  if (typeof value === "string") return mappedValue(value, map) !== null;
  if (Array.isArray(value)) return value.some(each => holdsOldPath(each, map));
  if (value && typeof value === "object") return Object.entries(value).some(([key, inner]) => mappedValue(key, map) !== null || holdsOldPath(inner, map));
  return false;
}

/** What a database still says of the old place: where the rewrite would have rewritten it (a path
 * column's path, a path whole in its JSON, a file sent), which fails the move; and elsewhere
 * (people's and agents' words, a diff's text, a command in a rule, the instructions' blobs: noted,
 * never a failure). */
export function databaseLeftovers(file: string, map: PathMap): { rewritten: string[]; elsewhere: string[] } {
  const db = open(file, true);
  const rewritten: string[] = [], elsewhere: string[] = [];
  const is = (list: readonly (readonly [string, string])[], table: string, column: string) => list.some(([t, c]) => t === table && c === column);
  try {
    const there = tables(db);
    for (const table of there) {
      for (const { name: column } of db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]) {
        let missed = 0, said = 0;
        const { where, values } = naming(column, map);
        for (const row of db.query(`SELECT "${column}" AS v FROM "${table}" WHERE ${where}`).iterate(...values)) {
          if (typeof row.v !== "string" || !namesOld(row.v, map)) continue;
          let left = false;
          if (is(PATH_COLUMNS, table, column) || (table === "permission" && column === "resource")) left = moves(row.v, map);
          else if (is(JSON_COLUMNS, table, column)) {
            try { left = holdsOldPath(JSON.parse(row.v), map); } catch {}
          } else if (is(FILES_COLUMNS, table, column)) {
            let value: any = null;
            try { value = JSON.parse(row.v); } catch {}
            left = Array.isArray(value?.files) && value.files.some((each: any) => [each?.uri, each?.source?.uri].some(uri => typeof uri === "string" && mappedURL(uri, map) !== null));
          }
          if (left) missed++;
          else said++;
        }
        if (missed) rewritten.push(`${table}.${column} (${missed})`);
        if (said) elsewhere.push(`${table}.${column} (${said})`);
      }
    }
  } finally {
    db.close();
  }
  return { rewritten, elsewhere };
}

/** How many sessions and projects a database holds. */
export function databaseCounts(file: string): { sessions: number; projects: number } {
  const db = open(file, true);
  try {
    const there = tables(db);
    const count = (table: string) => (there.has(table) ? Number(db.query(`SELECT count(*) AS n FROM "${table}"`).get().n) : 0);
    return { sessions: count("session_v2"), projects: count("project") };
  } finally {
    db.close();
  }
}

/** Every folder a database names: its projects', worktrees' and sessions'. */
export function databaseFolders(file: string): string[] {
  const db = open(file, true);
  try {
    const there = tables(db);
    const folders = new Set<string>();
    for (const [table, column] of PATH_COLUMNS) {
      if (!there.has(table)) continue;
      for (const row of db.query(`SELECT DISTINCT "${column}" AS v FROM "${table}"`).all()) if (typeof row.v === "string") folders.add(row.v);
    }
    return [...folders];
  } finally {
    db.close();
  }
}

/** A sample of sessions (newest first): their IDs and folders. */
export function sessionSample(file: string, most: number): { id: string; directory: string }[] {
  const db = open(file, true);
  try {
    if (!tables(db).has("session_v2")) return [];
    return db.query("SELECT id, directory FROM session_v2 ORDER BY time_updated DESC LIMIT ?").all(most) as { id: string; directory: string }[];
  } finally {
    db.close();
  }
}

/** A copy of a database to start an engine on for a check, with nothing it could act on: no
 * schedules or jobs, no accounts or keys, nothing said to be busy. */
export function quietCopy(file: string, to: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, to + suffix, fs.constants.COPYFILE_FICLONE);
  }
  const db = open(to);
  try {
    const there = tables(db);
    for (const table of ["schedule", "job", "credential", "account", "account_state", "control_account", "session_inbox"]) {
      if (there.has(table)) db.exec(`DELETE FROM "${table}"`);
    }
    if (there.has("session_v2")) {
      const columns = new Set(db.query(`PRAGMA table_info("session_v2")`).all().map(row => row.name as string));
      const quiet = ["time_busy", "time_compacting", "time_suspended"].filter(column => columns.has(column));
      if (quiet.length) db.exec(`UPDATE session_v2 SET ${quiet.map(column => `"${column}" = NULL`).join(", ")}`);
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
