// What a typed message means, and what a conversation's composer offers after "/" (PROTOCOL.md,
// "What a typed message means").

import { any, bool, type Infer, list, nullable, number, object, type RouteShape, string, words } from "../shape";
import { SESSION_AUTOPILOT } from "./autopilot";

/** A keyword a conversation offers: its name ("loop", typed "/loop"), its name in a list, what it
 * does in a line, and what follows it, in grey until something's written (null: it takes nothing). */
export const OFFERED_KEYWORD = object({ name: string, title: string, summary: string, argument: nullable(string) });

/** What "/" offers in a conversation: its keywords, then the engine's commands and yours (its own
 * /review as /review-quick where the keyword has the name; none a keyword hides). */
export const TYPED_OFFERS = object({ keywords: list(OFFERED_KEYWORD), commands: list(object({ name: string, "description?": string })) });

/** What goes back to the composer: `text` into an empty one; beside words written since, `beside`
 * in front of them where it's given, else `text`. */
export const TYPED_RESTORE = object({ text: string, "beside?": string });

/** What a typed text meant: what the box did (`goal`, `goalCleared`, `askedBot`, `autopilot`,
 * `wakeUp`, `sideQuestion`, `handoff`, `review`), then what the client does, in this order
 * (`showGoal`, `plan`, `toggleAutopilot`, `compact`, `shell`, `command`, `send`, `sideThread`), and
 * what goes back to the composer, saying why (`restore`, `error`). The composer's files go with
 * `send` or `command` (else they stay); its quotes with `send` when `quoted` (else they stay). */
export const TYPED = object({
  "keyword?": string,
  "goal?": any, "goalCleared?": bool, "askedBot?": bool, "autopilot?": SESSION_AUTOPILOT,
  "wakeUp?": object({ due: number, every: string, note: string }),
  "sideQuestion?": any, "handoff?": any, "review?": any,
  "showGoal?": bool, "plan?": words("toggle", "on"), "toggleAutopilot?": bool, "compact?": bool,
  "shell?": string, "command?": object({ name: string, arguments: string }),
  "send?": object({ text: string, "typed?": string, "quoted?": bool, "steer?": bool }),
  "sideThread?": bool,
  "restore?": TYPED_RESTORE, "error?": string,
});

export type TypedAnswer = Infer<typeof TYPED>;

const REFUSED = object({ message: string });
/** A send it couldn't answer for: why, and what goes back to the composer (as `restore`). */
const SEND_REFUSED = object({ message: string, "restore?": TYPED_RESTORE });

export const TYPED_ROUTES: RouteShape[] = [
  { route: "GET kuvo/sessions/:id/typed", answers: { 200: TYPED_OFFERS, 404: REFUSED, 503: REFUSED } },
  { route: "POST kuvo/sessions/:id/typed", answers: { 200: TYPED, 400: REFUSED, 404: SEND_REFUSED, 503: SEND_REFUSED } },
];
