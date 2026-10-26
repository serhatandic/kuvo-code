// Plugins (PROTOCOL.md, `kuvo/plugins/search`): npm's packages its engine can load, found from this box.

import { IN_TEST_FOLDER } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";

// npm's registry, or a test's stand-in for it, in a test's folder only (never a machine's own).
const testNpm = IN_TEST_FOLDER ? process.env.KUVO_TEST_NPM : undefined;
const NPM = testNpm ?? "https://registry.npmjs.org";
// A package as npm names it, with a version or tag after it or not.
const NPM_SPEC = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@([^\s@/]+))?$/;

/** A plugin `kuvo/plugins/search` finds: its package's name, its version, what it says it is, and
 * its downloads last week. */
export interface PluginPackage {
  name: string;
  version: string | undefined;
  description: string | undefined;
  weekly: number | undefined;
}

/** What `kuvo/plugins/search` answers: the packages found, and a package (or version) named
 * that npm doesn't have. */
export interface PluginSearch {
  packages: PluginPackage[];
  missing?: string;
}

/** npm's search, as its registry answers it (`/-/v1/search`). */
interface NpmSearch {
  objects?: { package?: { name?: string; version?: string; description?: string }; downloads?: { weekly?: number } }[];
}

/** A package's record as npm installs from it: its versions and tags. */
interface NpmPackage {
  name?: string;
  versions?: Record<string, unknown>;
  "dist-tags"?: Record<string, string>;
}

/** `kuvo/plugins/search?q=`: npm's packages for opencode that `q` finds (with none, the most used
 * plugins), each `{name, version, description, weekly}`, the one it names exactly first. `q`
 * that names a package npm doesn't have says so (`missing`). */
export async function searchPlugins(query: string | null | undefined, signal?: AbortSignal): Promise<PluginSearch> {
  const text = String(query ?? "").trim().toLowerCase();
  // A package's record as npm installs from it (its versions and tags, not its whole history).
  const ask = async <Shape>(address: string, headers: Record<string, string> = {}): Promise<Shape | null> => {
    const answered = await fetch(address, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if (answered.status === 404) return null;
    if (!answered.ok) throw new Error(`npm answered ${answered.status}.`);
    return answered.json() as Promise<Shape>;
  };
  const spec = text.match(NPM_SPEC);
  const [found, named] = await Promise.all([
    ask<NpmSearch>(`${NPM}/-/v1/search?size=20&text=${encodeURIComponent(text ? `${text} keywords:opencode` : "keywords:opencode-plugin")}`),
    // Not known (npm didn't answer) is not missing.
    spec ? ask<NpmPackage>(`${NPM}/${spec[1].replace("/", "%2F")}`, { accept: "application/vnd.npm.install-v1+json" }).catch(() => undefined) : undefined,
  ]);
  const packages = (found?.objects ?? []).map(each => ({
    name: each.package?.name,
    version: each.package?.version,
    description: each.package?.description || undefined,
    weekly: each.downloads?.weekly,
  })).filter((each): each is PluginPackage => typeof each.name === "string");
  const answer: PluginSearch = { packages };
  if (spec && named?.name) {
    const listed = packages.find(each => each.name === named.name);
    const version = spec[2] && named.versions?.[spec[2]] ? spec[2] : named["dist-tags"]?.[spec[2]] ?? named["dist-tags"]?.latest;
    answer.packages = [{ name: named.name, version, description: listed?.description, weekly: listed?.weekly }, ...packages.filter(each => each !== listed)];
    // A version or a tag it doesn't have (a range, like ^1.2.0, it may well have).
    const exact = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec[2] ?? "") || /^[a-z][\w-]*$/i.test(spec[2] ?? "");
    if (spec[2] && exact && !named.versions?.[spec[2]] && !named["dist-tags"]?.[spec[2]]) answer.missing = `${named.name}@${spec[2]}`;
  } else if (named === null) {
    answer.missing = spec![1];
  }
  return answer;
}

// Settings › Engine's plugins (PROTOCOL.md, `kuvo/plugins/search`): npm's, found from this box.
export async function* pluginSearchRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  try {
    return yield* json(200, await searchPlugins(new URLSearchParams(request.path.split("?")[1] ?? "").get("q"), signal));
  } catch (error) {
    return yield* json(502, { message: "npm couldn't be reached from here. Check this computer's internet connection, then try again." });
  }
}
