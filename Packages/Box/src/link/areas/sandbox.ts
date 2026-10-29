// `kuvo/sandbox`: whether agents' commands here run in the sandbox, and why not (PROTOCOL.md,
// "Sandbox"); a client turns it on or off (`PATCH {on}`), or has it set up and checked again
// (`POST kuvo/sandbox/check`). A command in the sandbox can't turn it off: the setting is in the
// box's own folder, which it can't write.

import { isObject, parsed } from "../../shared/json";
import type { SandboxState } from "../../shared/routes/sandbox";
import { fenceState, setFenceWanted, setUpFence } from "../fence/state";
import type { AnswerPiece, RouteContext } from "../server/context";

const shown = (): SandboxState => {
  const { on, wanted, able, agents, ...not } = fenceState();
  return { on, wanted, able, agents, ...Object.fromEntries(Object.entries(not).filter(([, value]) => value !== undefined)) };
};

export async function* sandboxRoute({ request, json, route }: RouteContext): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  if (route === "kuvo/sandbox/check") {
    if (method !== "POST") return yield* json(405, {});
    setUpFence();
    return yield* json(200, shown());
  }
  if (method === "GET") return yield* json(200, shown());
  if (method !== "PATCH") return yield* json(405, {});
  const given = parsed(request.body);
  if (!isObject(given) || typeof given.on !== "boolean") return yield* json(400, { message: "Send {on}: true or false." });
  setFenceWanted(given.on);
  return yield* json(200, shown());
}
