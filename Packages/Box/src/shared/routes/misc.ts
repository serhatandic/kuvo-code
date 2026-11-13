// A box's folders to choose one from (PROTOCOL.md, `kuvo/folders`), every file under one
// (`kuvo/folders/tree`), npm's plugins its engine can
// load (`kuvo/plugins/search`), an MCP server's program (`kuvo/programs`), a provider of your
// own's models (`kuvo/providers/models`), a sign-in's return loaded on the computer it's for
// (`kuvo/sign-in/return`), and the ways to sign in to an account and how a sign-in is going, in the
// box's words (`kuvo/sign-in/methods`, `kuvo/sign-in/status`).

import { any, bool, type Infer, list, nullable, number, object, type RouteShape, string } from "../shape";

/** The folders in one of this box's folders: its path, the home folder, the one it's in (null for
 * the top), and the folders in it, ordered as Finder orders names (`repository`: a git
 * repository's own checkout); asked with `files=1`, its files too, as the Files panel lists them. */
export const FOLDER_LIST = object({
  path: string,
  home: string,
  parent: nullable(string),
  folders: list(object({ name: string, "repository?": bool })),
  "files?": list(string),
});
/** Every file under one of this box's folders, by its path there, as a project's file filter and
 * "@" list them: git's list in a repository (`git`), else a walk that skips the usual heavy folders;
 * asked with `dated=1`, when each last changed (milliseconds since 1970, null where it can't say). */
export const FOLDER_TREE = object({ path: string, files: list(string), git: bool, "modified?": list(nullable(number)) });
/** Why a folder couldn't be read, as the computer says it ("Permission denied"). */
export const FOLDER_REFUSED = object({ message: string, "reason?": string });
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

/** The ways to sign in to an account, in the order a client offers them: each the engine's (`type`,
 * `id`, `form`) with the box's `label`, `legacy` for one offered apart, after the others; and the
 * environment variables that sign in to it too. */
export const SIGN_IN_METHODS = object({
  methods: list(object({ type: string, "id?": string, label: string, "form?": list(any), "legacy?": bool })),
  environment: list(string),
});

/** How a started sign-in is going, as the engine (or the coding agents' bridge) says, with, once it
 * ended without signing in (`failed`, `expired`), what a client says of it (`failure`). */
export const SIGN_IN_STATUS = object({
  status: string,
  "message?": string,
  "url?": string,
  "instructions?": string,
  "userCode?": string,
  "failure?": string,
});

export type FolderList = Infer<typeof FOLDER_LIST>;
export type FolderMade = Infer<typeof FOLDER_MADE>;
export type FolderRefused = Infer<typeof FOLDER_REFUSED>;
export type PluginSearch = Infer<typeof PLUGIN_SEARCH>;
export type ProgramFound = Infer<typeof PROGRAM_FOUND>;
export type ProviderModels = Infer<typeof PROVIDER_MODELS>;
export type SignInReturned = Infer<typeof SIGN_IN_RETURNED>;
export type SignInMethods = Infer<typeof SIGN_IN_METHODS>;
export type SignInStatus = Infer<typeof SIGN_IN_STATUS>;

/** Sessions whose conversation has what a search asked for, the latest first (`kuvo/search`):
 * each one's ID, the words around the first mention, and the session as the engine lists it
 * (`info`), for a client that doesn't list it (an older one, archived). Words a subagent's
 * conversation has find the one it works for, with that subagent's session as listed
 * (`subagent`). */
export const SEARCH_FOUND = object({ results: list(object({ session: string, snippet: string, info: any, "subagent?": any })) });

export type SearchFound = Infer<typeof SEARCH_FOUND>;

export const MISC_ROUTES: RouteShape[] = [
  { route: "GET kuvo/folders", answers: { 200: FOLDER_LIST, 403: FOLDER_REFUSED, 404: FOLDER_REFUSED, 500: FOLDER_REFUSED } },
  { route: "POST kuvo/folders", answers: { 200: FOLDER_MADE } },
  { route: "GET kuvo/folders/tree", answers: { 200: FOLDER_TREE, 400: object({ message: string }), 403: FOLDER_REFUSED, 404: FOLDER_REFUSED, 500: FOLDER_REFUSED, 503: object({ message: string }) } },
  { route: "GET kuvo/plugins/search", answers: { 200: PLUGIN_SEARCH } },
  { route: "GET kuvo/programs", answers: { 200: PROGRAM_FOUND } },
  { route: "POST kuvo/providers/models", answers: { 200: PROVIDER_MODELS } },
  { route: "POST kuvo/sign-in/return", answers: { 200: SIGN_IN_RETURNED } },
  { route: "GET kuvo/sign-in/methods", answers: { 200: SIGN_IN_METHODS } },
  { route: "GET kuvo/sign-in/status", answers: { 200: SIGN_IN_STATUS } },
  { route: "GET kuvo/search", answers: { 200: SEARCH_FOUND } },
];
