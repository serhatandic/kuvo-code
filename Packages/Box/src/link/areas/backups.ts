// `kuvo/git/backups`: a repository's branch backups, which the box takes as agents' turns start and
// end (`../work/backups.ts`; PROTOCOL.md, "Branch backups"). A client lists a folder's (what
// taking each back would bring back now) and takes one back, which never moves a branch you have.

import fs from "node:fs";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import { listBackups, restoreBackup, RestoreError } from "../work/backups";
import type { AnswerPiece, RouteContext } from "../server/context";

// A folder that's there (its `.git` may not be).
function folderAt(value: unknown): string | null {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    return fs.statSync(value).isDirectory() ? value : null;
  } catch {
    return null;
  }
}

export async function* backupsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, json } = context;
  const method = request.method.toUpperCase();
  if (route === "kuvo/git/backups") {
    if (method !== "GET") return yield* json(405, { message: "Read them with GET." });
    const folder = folderAt(new URLSearchParams(request.path.split("?")[1] ?? "").get("folder"));
    if (!folder) return yield* json(400, { message: "Name a folder that's there (folder)." });
    return yield* json(200, await listBackups(folder));
  }
  if (method !== "POST") return yield* json(405, { message: "Take one back with POST." });
  const body = parsed(request.body);
  const given = isObject(body) ? body : {};
  const folder = folderAt(given.folder);
  if (!folder || typeof given.id !== "string" || !given.id) return yield* json(400, { message: "Name a folder that's there (folder) and the backup (id)." });
  try {
    return yield* json(200, await restoreBackup(folder, given.id));
  } catch (error) {
    if (error instanceof RestoreError) return yield* json(error.status, { message: error.message });
    throw error;
  }
}
