// Programs (PROTOCOL.md, `kuvo/programs`): whether this box has the program an MCP server's command
// names, for Settings › MCP Servers to say so before the engine fails to start it.

import fs from "node:fs";
import path from "node:path";
import type { ProgramFound } from "../../shared/routes/misc";
import type { AnswerPiece, JSONAnswer, RouteContext } from "../server/context";
import { homeFolder } from "../home";

/** `kuvo/programs?name=`: where this box runs a program from, as an MCP server's command names it
 * (`npx`, `uvx`, `docker`, or a path), found the way its engine finds one, on its PATH:
 * `{name, path}`, `path` null for one it doesn't have; `unknown` for one it can't tell from here
 * (`./server`, from the server's working folder; `$HOME/x`). */
export function findProgram(requestPath: string, PATH: string = process.env.PATH ?? ""): JSONAnswer<ProgramFound, { message: string }> {
  const name = (new URLSearchParams(requestPath.split("?")[1] ?? "").get("name") ?? "").trim();
  if (!name) return { status: 400, value: { message: "Name the program (name)." } };
  const runnable = (file: string) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  // Found from the server's working folder, or named with a shell's variable or another user's
  // home: not known from here.
  if (/^\.\.?\//.test(name) || name.includes("$") || /^~[^/]/.test(name)) return { status: 200, value: { name, path: null, unknown: true } };
  if (name.includes("/")) {
    const file = name.startsWith("~/") ? path.join(homeFolder(), name.slice(2)) : name;
    return { status: 200, value: { name, path: path.isAbsolute(file) && runnable(file) ? file : null } };
  }
  const found = PATH.split(path.delimiter).filter(Boolean).map(folder => path.join(folder, name)).find(runnable);
  return { status: 200, value: { name, path: found ?? null } };
}

// Whether this box has an MCP server's program (PROTOCOL.md, `kuvo/programs`).
export async function* programsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const { status, value } = findProgram(request.path);
  return yield* json(status, value);
}
