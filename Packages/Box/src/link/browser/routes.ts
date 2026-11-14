// The browser's data, as every box answers it (PROTOCOL.md, "The browser's data"; feature
// `browser.data`): `kuvo/browser/history` and `…/icons/:host`, `…/sites`, `…/settings`. On this
// Mac's box, what its app's panel kept is taken in the first time any of them is asked.

import { parsed } from "../../shared/json";
import { IS_MAC } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";
import { takeInAppBrowserData, thisMacsAppFolder } from "./from-app";
import { BROWSER_FOLDER, forgetHistory, iconOf, readHistory } from "./history";
import { changeBrowserSettings, readBrowserSettings } from "./settings";
import { browserSites, removeSiteData } from "./sites";

/** The routes this file answers: the history (a site's in it), a site's icon, the sites with data
 * (one of them), the settings. */
export const BROWSER_DATA_ROUTE = /^kuvo\/browser\/(?:(history|sites)(?:\/([^/]+))?|(icons)\/([^/]+)|(settings))$/;

/** A path's part as it was sent (`%3A` in `localhost%3A3000`), or null when it won't decode. */
function part(text: string): string | null {
  try { return decodeURIComponent(text); } catch { return null; }
}

export async function* browserDataRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  const method = request.method.toUpperCase();
  if (IS_MAC) takeInAppBrowserData(thisMacsAppFolder(), BROWSER_FOLDER);
  const [, list, one, icons, iconHost, settings] = match;
  if (icons) {
    if (method !== "GET") return yield* json(405, {});
    const host = part(iconHost!);
    const icon = host ? iconOf(host) : null;
    if (!icon) return yield* json(404, { message: "There's no icon for that site here." });
    yield { head: { status: 200, headers: { "content-type": icon.type, "content-length": String(icon.bytes.length) } } };
    return yield { body: icon.bytes };
  }
  if (settings) {
    if (method === "GET") return yield* json(200, readBrowserSettings());
    if (method !== "PATCH") return yield* json(405, {});
    const problem = changeBrowserSettings(parsed(request.body));
    return yield* problem ? json(400, { message: problem }) : json(200, readBrowserSettings());
  }
  const which = one === undefined ? null : part(one);
  if (one !== undefined && !which) return yield* json(400, { message: "Name the site as its address has it." });
  if (list === "history") {
    if (method === "GET" && which === null) return yield* json(200, readHistory());
    if (method !== "DELETE") return yield* json(405, {});
    forgetHistory(which);
    return yield* json(200, readHistory());
  }
  if (method === "GET" && which === null) return yield* json(200, await browserSites());
  if (method !== "DELETE") return yield* json(405, {});
  await removeSiteData(which === null ? "all" : [which.toLowerCase()]);
  return yield* json(200, await browserSites());
}
