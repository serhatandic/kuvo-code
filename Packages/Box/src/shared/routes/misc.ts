// A box's folders to choose one from (PROTOCOL.md, `kuvo/folders`), npm's plugins its engine can
// load (`kuvo/plugins/search`), an MCP server's program (`kuvo/programs`), a provider of your
// own's models (`kuvo/providers/models`), and a sign-in's return loaded on the computer it's for
// (`kuvo/sign-in/return`).

import { bool, type Infer, list, nullable, number, object, type RouteShape, string } from "../shape";

/** The folders in one of this box's folders: its path, the home folder, the one it's in (null for
 * the top), and the folders in it, ordered as Finder orders names (`repository`: a git
 * repository's own checkout). */
export const FOLDER_LIST = object({
  path: string,
  home: string,
  parent: nullable(string),
  folders: list(object({ name: string, "repository?": bool })),
});
/** A new folder, made where it was asked. */
export const FOLDER_MADE = object({ path: string });

/** npm's packages a search finds, the one it names exactly first: each one's name, version, what
 * it says it is and its downloads last week, where npm says; `missing`, a package (or version)
 * named that npm doesn't have. */
export const PLUGIN_SEARCH = object({
  packages: list(object({ name: string, "version?": string, "description?": string, "weekly?": number })),
  "missing?": string,
});

/** A program an MCP server's command names, and where this box runs it from (null: it hasn't it,
 * or, `unknown`, it can't tell from here). */
export const PROGRAM_FOUND = object({ name: string, path: nullable(string), "unknown?": bool });

/** A provider of your own's models, as it lists them to this box: `reached` and the models, or
 * `needsKey` when it asks for its key first; not reached, what's wrong. */
export const PROVIDER_MODELS = object({ reached: bool, "models?": list(string), "needsKey?": bool, "message?": string });

/** The status the computer's own address answered a sign-in's return with (2xx or 3xx: it took it). */
export const SIGN_IN_RETURNED = object({ status: number });

export type FolderList = Infer<typeof FOLDER_LIST>;
export type FolderMade = Infer<typeof FOLDER_MADE>;
export type PluginSearch = Infer<typeof PLUGIN_SEARCH>;
export type ProgramFound = Infer<typeof PROGRAM_FOUND>;
export type ProviderModels = Infer<typeof PROVIDER_MODELS>;
export type SignInReturned = Infer<typeof SIGN_IN_RETURNED>;

export const MISC_ROUTES: RouteShape[] = [
  { route: "GET kuvo/folders", answers: { 200: FOLDER_LIST } },
  { route: "POST kuvo/folders", answers: { 200: FOLDER_MADE } },
  { route: "GET kuvo/plugins/search", answers: { 200: PLUGIN_SEARCH } },
  { route: "GET kuvo/programs", answers: { 200: PROGRAM_FOUND } },
  { route: "POST kuvo/providers/models", answers: { 200: PROVIDER_MODELS } },
  { route: "POST kuvo/sign-in/return", answers: { 200: SIGN_IN_RETURNED } },
];
