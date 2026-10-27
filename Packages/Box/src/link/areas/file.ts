// A file on this box that an agent's reply or tool names (PROTOCOL.md, `kuvo/file`): its bytes, by its
// `file://` address, for a client to show, a machine's with the Mac closed too.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AnswerPiece, RouteContext } from "../server/context";

// The biggest file `kuvo/file` sends.
export const FILE_LIMIT = 25 * 1024 * 1024;

const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  svg: "image/svg+xml", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg",
  wav: "audio/wav", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", css: "text/css", js: "text/javascript",
};

// `kuvo/file?uri=<file:// URI>[&max=<bytes>]`: a file on this machine, as an agent's reply or tool
// names it: its bytes with its type; 404 with a message for one that isn't there (or isn't a
// file), 413 over FILE_LIMIT, or over `max` (all a client would show of it).
export async function* fileAt(requestPath: string, json: RouteContext["json"]): AsyncGenerator<AnswerPiece> {
  const query = requestPath.includes("?") ? requestPath.slice(requestPath.indexOf("?") + 1) : "";
  const asked = new URLSearchParams(query);
  const uri = asked.get("uri");
  const max = Number(asked.get("max") ?? FILE_LIMIT);
  let file;
  try {
    file = uri ? fileURLToPath(uri) : undefined;
  } catch {}
  if (!file) return yield* json(400, { message: "That isn’t a file:// address." });
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {}
  if (!stat?.isFile()) return yield* json(404, { message: "That file isn’t there anymore." });
  if (stat.size > FILE_LIMIT) return yield* json(413, { message: "That file is too big to open here." });
  if (Number.isFinite(max) && stat.size > max) return yield* json(413, { message: "That file is too big to show here." });
  const type = TYPES[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";
  // Opened before it's answered: one that can't be read says so, with no path in it.
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch (error) {
    const refused = (["EACCES", "EPERM"] as (string | undefined)[]).includes((error as NodeJS.ErrnoException)?.code);
    return yield* json(refused ? 403 : 404, { message: refused ? "That file can’t be opened here." : "That file isn’t there anymore." });
  }
  yield { head: { status: 200, headers: { "content-type": type, "content-length": String(stat.size) } } };
  // In pieces, as the engine's bodies go.
  try {
    for await (const piece of handle.createReadStream({ highWaterMark: 32 * 1024 })) yield { body: piece };
  } finally {
    await handle.close().catch(() => {});
  }
}