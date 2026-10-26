// This box's own settings, its MCP catalog and its integrations' keys (PROTOCOL.md, "Settings per
// box").

import { parsed } from "../../shared/json";
import type { Config } from "../../shared/routes/settings";
import type { AnswerPiece, RouteContext } from "../server/context";
import { applySettings } from "./apply";
import { answerKeys } from "./box-keys";
import { changeSettings, ownsSettings, readSettings } from "./config";
import type { Settings } from "./config";
import { addFromCatalog, mcpCatalog } from "./mcp-catalog";

// Its own settings, and its integrations' keys (PROTOCOL.md, "Settings per box").
export async function* settingsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, json } = context;
  // Its own, once Kuvo Code has made them so; until then, as the Mac that started it has them.
  if (!ownsSettings()) return yield* json(409, { message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." });
  const method = request.method.toUpperCase();
  // A file that can't be used says why twice: in words to show (`message`), and the file's
  // problem alone (`problem`), for a page that names the file already.
  const answered = ({ status, settings, message, problem }: { status: number; settings?: Settings; message?: string; problem?: string }): AnswerPiece[] =>
    json(status, message ? (problem ? { message, problem } : { message }) : (settings ?? {}) satisfies Config);
  if (route === "kuvo/config") {
    if (method === "GET") {
      const { settings, problem } = readSettings();
      return yield* (problem ? json(409, { message: `The engine's settings file can't be changed from here: ${problem}`, problem }) : json(200, settings! satisfies Config));
    }
    if (method === "PATCH") return yield* answered(changeSettings(parsed(request.body)?.changes));
    return yield* json(405, {});
  }
  if (route === "kuvo/config/apply") {
    if (method !== "POST") return yield* json(405, {});
    const { status, ...answer } = applySettings(parsed(request.body));
    return yield* json(status, answer);
  }
  if (route === "kuvo/mcp/catalog") {
    if (method !== "GET") return yield* json(405, {});
    return yield* json(200, mcpCatalog(readSettings().settings ?? {}));
  }
  const adding = route.match(/^kuvo\/mcp\/catalog\/([^/]+)$/);
  if (adding && method === "POST") return yield* answered(addFromCatalog(decodeURIComponent(adding[1])));
  // Its integrations' keys, where it keeps them (a machine's files, this Mac's Keychain through
  // its app): a bot's own aren't among them.
  if (route === "kuvo/keys" || route.startsWith("kuvo/keys/")) {
    const { status, value } = await answerKeys(method, route, parsed(request.body));
    return yield* json(status, value);
  }
  return yield* json(404, {});
}
