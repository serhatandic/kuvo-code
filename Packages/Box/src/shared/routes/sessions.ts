// A conversation carried on with the coding agents (PROTOCOL.md, `kuvo/sessions/<id>/agents`), as
// picking one of their models in it does.

import { type Infer, object, type RouteShape, string } from "../shape";

/** The coding agents' session it goes on in now. */
export const CARRIED = object({ session: string });

export type Carried = Infer<typeof CARRIED>;

export const SESSION_ROUTES: RouteShape[] = [
  { route: "POST kuvo/sessions/:id/agents", answers: { 200: CARRIED } },
];
