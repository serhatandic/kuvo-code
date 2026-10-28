// Every route's answers, as the contract suite holds both boxes to them (Vectors/routes/shapes,
// written by scripts/route-shapes.sh). A route the scenarios ask that isn't here fails the suite,
// and so does an answer that isn't its route's shape.

import { object, type RouteShape, string } from "../shape";
import { ARTIFACT_ROUTES } from "./artifacts";
import { ASK_ROUTES } from "./asks";
import { BOT_ROUTES } from "./bots";
import { BOX_ROUTES } from "./box";
import { CHANGES_ROUTES } from "./changes";
import { GROUP_ROUTES } from "./groups";
import { INTEGRATION_ROUTES } from "./integrations";
import { MAC_ROUTES } from "./mac";
import { MISC_ROUTES } from "./misc";
import { PERSONALITY_ROUTES } from "./personalities";
import { PROJECT_ROUTES } from "./projects";
import { SESSION_ROUTES } from "./sessions";
import { SETTINGS_ROUTES } from "./settings";
import { SKILL_ROUTES } from "./skills";
import { WAKE_ROUTES } from "./wakes";
import { WORKTREE_ROUTES } from "./worktrees";

/** What a route that refuses says, as JSON: why, in words to show (`message`), and for a file that
 * can't be used, its problem alone (`problem`). One that says nothing is `{}`. A route that says
 * more when it refuses has a shape of its own for that status. */
export const ERROR = object({ "message?": string, "problem?": string });

/** What the box passes on as it came, from the engine (`api/…`) or the coding agents' bridge
 * (`kuvo/agents/…`): theirs, not the box's, to define. */
export const PASSED_ON = ["api/", "kuvo/agents/"];

export const ROUTES: RouteShape[] = [
  ...ARTIFACT_ROUTES,
  ...ASK_ROUTES,
  ...BOT_ROUTES,
  ...BOX_ROUTES,
  ...CHANGES_ROUTES,
  ...MAC_ROUTES,
  ...GROUP_ROUTES,
  ...INTEGRATION_ROUTES,
  ...MISC_ROUTES,
  ...PERSONALITY_ROUTES,
  ...PROJECT_ROUTES,
  ...SESSION_ROUTES,
  ...SETTINGS_ROUTES,
  ...SKILL_ROUTES,
  ...WAKE_ROUTES,
  ...WORKTREE_ROUTES,
];
