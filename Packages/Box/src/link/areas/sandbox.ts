// `kuvo/sandbox`: whether agents' commands here run in the sandbox, and why not (PROTOCOL.md,
// "Sandbox"). It's on wherever it can run, with no switch; a client has it set up and checked
// again (`POST kuvo/sandbox/check`).

import type { SandboxState } from "../../shared/routes/sandbox";
import { fenceState, setUpFence, tellAgents } from "../fence/state";
import type { AnswerPiece, RouteContext } from "../server/context";

// (What agents are told goes with it at once, rather than at the box's next look.)
const shown = (): SandboxState => {
  const { on, able, agents, ...not } = fenceState();
  try { tellAgents(on); } catch {}
  return { on, able, agents, ...Object.fromEntries(Object.entries(not).filter(([, value]) => value !== undefined)) };
};

export async function* sandboxRoute({ request, json, route }: RouteContext): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  if (route === "kuvo/sandbox/check") {
    if (method !== "POST") return yield* json(405, {});
    setUpFence();
    return yield* json(200, shown());
  }
  if (method !== "GET") return yield* json(405, {});
  return yield* json(200, shown());
}
