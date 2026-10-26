// Skills (PROTOCOL.md, "Skills"): each box's own skills folder, its Recently Deleted, and GitHub's
// collections, which a box reaches for every client.

import { bool, type Infer, list, map, NOTHING, number, object, type RouteShape, string } from "../shape";

/** The skills folder: where its engine reads them, the folders in it by name (not hidden ones),
 * and those installed from GitHub, by folder, with the repository and folder there they came from. */
export const SKILLS = object({ folder: string, folders: list(string), github: map(object({ repository: string, path: string })) });
/** A skill's SKILL.md, as it's written. */
export const SKILL_TEXT = object({ text: string });

/** A skill in Recently Deleted, newest first: its entry's id, the folder it goes back under, what
 * its SKILL.md says it is (`name` the folder's when it doesn't say), and when it was put away and
 * when it goes, in seconds since 1970. */
export const DELETED_SKILL = object({ id: string, folder: string, name: string, "description?": string, deleted: number, goes: number });
/** Recently Deleted. */
export const SKILL_TRASH = object({ entries: list(DELETED_SKILL) });
/** A skill by its folder's name: one restored, or installed from GitHub. */
export const SKILL_NAMED = object({ name: string });

/** A collection of skills on GitHub: its repository (`owner/name`), and what it's called and is. */
export const SKILL_REPOSITORY = object({ id: string, owner: string, name: string, title: string, summary: string });
/** The well-known collections, roughly most popular first. */
export const SKILL_LIBRARY = object({ repositories: list(SKILL_REPOSITORY) });
/** What a skill's SKILL.md says it is, in its front matter (`{}` when GitHub doesn't say). */
export const SKILL_ABOUT = object({ "name?": string, "description?": string });
/** A collection's skills: each one's name, its folder there (`""` for the repository itself), its
 * files and what its SKILL.md says it is; `partial` when GitHub cut a very big one's list short. */
export const SKILL_COLLECTION = object({
  repository: SKILL_REPOSITORY,
  skills: list(object({ name: string, path: string, files: list(string), about: SKILL_ABOUT })),
  partial: bool,
});

export type Skills = Infer<typeof SKILLS>;
export type SkillText = Infer<typeof SKILL_TEXT>;
export type DeletedSkill = Infer<typeof DELETED_SKILL>;
export type SkillTrash = Infer<typeof SKILL_TRASH>;
export type SkillNamed = Infer<typeof SKILL_NAMED>;
export type SkillRepository = Infer<typeof SKILL_REPOSITORY>;
export type SkillLibrary = Infer<typeof SKILL_LIBRARY>;
export type SkillAbout = Infer<typeof SKILL_ABOUT>;
export type SkillCollection = Infer<typeof SKILL_COLLECTION>;

export const SKILL_ROUTES: RouteShape[] = [
  { route: "GET kuvo/skills", answers: { 200: SKILLS } },
  { route: "GET kuvo/skills/:name", answers: { 200: SKILL_TEXT } },
  { route: "PUT kuvo/skills/:name", answers: { 200: NOTHING } },
  { route: "DELETE kuvo/skills/:name", answers: { 200: NOTHING } },
  { route: "GET kuvo/skill-trash", answers: { 200: SKILL_TRASH } },
  { route: "POST kuvo/skill-trash/:id/restore", answers: { 200: SKILL_NAMED } },
  { route: "GET kuvo/skill-library", answers: { 200: SKILL_LIBRARY } },
  { route: "POST kuvo/skill-library/install", answers: { 200: SKILL_NAMED } },
  { route: "GET kuvo/skill-library/:owner/:name", answers: { 200: SKILL_COLLECTION } },
  { route: "GET kuvo/skill-library/:owner/:name/about", answers: { 200: SKILL_ABOUT } },
];
