// Projects (PROTOCOL.md, "Projects"): the box's own list, which every client reads and changes.

import { bool, type Infer, list, number, object, type RouteShape, string } from "../shape";

/** A project: its folder, its name (only when it isn't the folder's own), its other folders, the
 * commands its Run and its terminal start with (left out for none), and `removed`, for one Remove
 * Project took off the list, kept with its settings for when one of its sessions comes back; and
 * the bot that made it, for one a bot made (`make_project`). */
export const PROJECT = object({
  directory: string,
  "name?": string,
  folders: list(string),
  "run?": string,
  "terminal?": string,
  "removed?": bool,
  "madeBy?": object({ bot: string, name: string, at: number }),
});
/** The box's projects, newest first. */
export const PROJECTS = object({ projects: list(PROJECT) });

export type Project = Infer<typeof PROJECT>;
export type Projects = Infer<typeof PROJECTS>;

export const PROJECT_ROUTES: RouteShape[] = [
  { route: "GET kuvo/projects", answers: { 200: PROJECTS } },
  { route: "PUT kuvo/projects", answers: { 200: object({ project: PROJECT }) } },
  // Removed: how many of its sessions were archived.
  // (A project with sessions that couldn't be archived stays, and says how many were and weren't.)
  { route: "DELETE kuvo/projects", answers: { 200: object({ archived: number }), 409: object({ message: string, archived: number, kept: number }) } },
];
