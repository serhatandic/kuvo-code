// The browser's data, as every box answers it (PROTOCOL.md, "The browser's data"; feature
// `browser.data`): `kuvo/browser/history` and `…/icons/:host`, `…/sites`, `…/settings`.

import { parsed } from "../../shared/json";
import type { AnswerPiece, RouteContext } from "../server/context";
import { forgetHistory, iconOf, readHistory } from "./history";
import { changeBrowserSettings, readBrowserSettings } from "./settings";
import { browserSites, removeSiteData, siteOf } from "./sites";

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
  // A site as the list names it (`example.com`, `localhost`, an address), never a part of one (`com`).
  const site = which?.toLowerCase() ?? null;
  if (site !== null && (siteOf(site) !== site || !(site.includes(".") || site === "localhost"))) return yield* json(400, { message: "Name a site as the list of sites names it." });
  if (!(await removeSiteData(site === null ? "all" : [site]))) return yield* json(503, { message: "The browser is busy starting. Try again in a moment." });
  // (What Chrome still clears of it, a moment later, isn't listed.)
  const { sites } = await browserSites();
  return yield* json(200, { sites: site === null ? [] : sites.filter(each => each.site !== site) });
}
