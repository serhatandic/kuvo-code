// The sandbox agents' commands run in on a box (PROTOCOL.md, "Sandbox").

import { bool, type Infer, object, type RouteShape, string } from "../shape";

/** Whether every command the engine runs here goes through the sandbox (checked), why not, whether
 * you want it, whether this computer can at all, and whether the coding agents' own programs'
 * commands are sandboxed too. */
export const SANDBOX = object({ on: bool, "why?": string, wanted: bool, able: bool, agents: bool });

export type SandboxState = Infer<typeof SANDBOX>;

export const SANDBOX_ROUTES: RouteShape[] = [
  { route: "GET kuvo/sandbox", answers: { 200: SANDBOX } },
  { route: "PATCH kuvo/sandbox", answers: { 200: SANDBOX } },
];
