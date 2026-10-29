// `kuvo/sandbox`: whether agents' commands here run in the sandbox, and why not (PROTOCOL.md,
// "Sandbox"); a client turns it on or off (`PATCH {on}`). A command in the sandbox can't turn it
// off: the setting is in the box's own folder, which it can't write.

import { isObject, parsed } from "../../shared/json";
import type { SandboxState } from "../../shared/routes/sandbox";
import { fenceState, setFenceWanted } from "../fence/state";
import type { AnswerPiece, RouteContext } from "../server/context";

const shown = (): SandboxState => {
  const { on, why, wanted, able, agents } = fenceState();
  return { on, ...(why ? { why } : {}), wanted, able, agents };
};

export async function* sandboxRoute({ request, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  if (method === "GET") return yield* json(200, shown());
  if (method !== "PATCH") return yield* json(405, {});
  const given = parsed(request.body);
  if (!isObject(given) || typeof given.on !== "boolean") return yield* json(400, { message: "Send {on}: true or false." });
  setFenceWanted(given.on);
  return yield* json(200, shown());
}
