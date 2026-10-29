// The sandbox agents' commands run in on a box (PROTOCOL.md, "Sandbox").

import { bool, type Infer, number, object, type RouteShape, string, words } from "../shape";

/** Whether every command the engine runs here goes through the sandbox (checked), why not, whether
 * you want it, whether this computer can at all, and whether the coding agents' own programs'
 * commands are sandboxed too. When it isn't on: why, as a word a client maps (`reason`), what you
 * can do (`action`) and the box's route that does it (`route`); what the computer needs first
 * (`needs`), which part of the check failed (`check`), and how many checks failed in a row. */
export const SANDBOX = object({
  on: bool, "why?": string, wanted: bool, able: bool, agents: bool,
  "reason?": words("off", "kernel", "macos", "engineMissing", "checking", "checkFailed", "plugin", "engineDown", "waiting"),
  "action?": words("turnOn", "help", "softwareUpdate", "retry", "fix", "restartEngine"),
  "route?": string, "needs?": string,
  "check?": words("folder", "tempFiles", "readsOwn", "writesOwn", "didntRun", "setup"),
  "failures?": number,
});

export type SandboxState = Infer<typeof SANDBOX>;

export const SANDBOX_ROUTES: RouteShape[] = [
  { route: "GET kuvo/sandbox", answers: { 200: SANDBOX } },
  { route: "PATCH kuvo/sandbox", answers: { 200: SANDBOX } },
  { route: "POST kuvo/sandbox/check", answers: { 200: SANDBOX } },
];
