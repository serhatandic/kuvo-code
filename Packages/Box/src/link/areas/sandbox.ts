// `kuvo/sandbox`: whether agents' commands here run in the sandbox, and why not (PROTOCOL.md,
// "Sandbox"). It's on wherever it can run, with no switch; a client has it set up and checked
// again (`POST kuvo/sandbox/check`). And what goes beyond it: the commands agents ask to run outside
// it (`kuvo/sandbox/asks`, answered by a client), their tool (`kuvo/sandbox/tools`), and what you
// allowed each project (`kuvo/sandbox/allowed`). The asks wait in the box's long-running process,
// as Also Allowed is, which any other passes them to (vault/holder.ts).

import { isObject, parsed } from "../../shared/json";
import type { SandboxState } from "../../shared/routes/sandbox";
import { addRule, allowedFor, removeRule, RuleRefusal } from "../fence/allowed";
import { answerSandboxAsk, callSandboxTool, listSandboxAsks, onSandboxAsksChanged, SANDBOX_TOOLS } from "../fence/outside";
import { answeredRestart, asksToRestart, fenceState, restartSettled, setUpFence, tellAgents } from "../fence/state";
import { bridgeTarget, call } from "../engine/client";
import type { AnswerPiece, RouteContext } from "../server/context";
import { readLink } from "../state";
import { askHolder, heldHere, holdsVault } from "../vault/holder";
import { callerOf, isCalling } from "../vault/who";

const NOT_OPEN = "This computer's box isn't running its own process: try again in a moment.";
const NOT_CALLING = "Only a conversation's own tool call can ask, and this one isn't running in it.";
const NOT_ON = "Commands aren't in the sandbox on this computer now, so there's nothing to ask: run the command with your shell tool.";

// (What agents are told goes with it at once, rather than at the box's next look.)
const shown = (): SandboxState => {
  const { on, able, agents, ...not } = fenceState();
  try { tellAgents(on); } catch {}
  return { on, able, agents, ...Object.fromEntries(Object.entries(not).filter(([, value]) => value !== undefined)) };
};

const idOf = (part: string | undefined) => {
  try { return decodeURIComponent(part ?? ""); } catch { return ""; }
};

/** Who answered, as an ask's rule keeps it: a phone by its name, else this Mac. */
function clientName({ phone }: RouteContext): string {
  if (!phone?.key) return "Mac";
  const key = phone.key.toString("base64url");
  return readLink()?.phones?.find(each => each.key === key)?.name || "iPhone";
}

export async function* sandboxRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json, route, signal, readEngine, readBridge } = context;
  const method = request.method.toUpperCase();
  if (route === "kuvo/sandbox/check") {
    if (method !== "POST") return yield* json(405, {});
    setUpFence();
    return yield* json(200, shown());
  }
  if (route === "kuvo/sandbox") {
    if (method !== "GET") return yield* json(405, {});
    return yield* json(200, shown());
  }
  const body = parsed(request.body);
  const given = isObject(body) ? body : {};
  // Your answer to its one ask: the agents bridge restarts those started before it was on (each
  // between turns), or they finish as they are. Either way, it isn't asked again.
  if (route === "kuvo/sandbox/restart") {
    if (method !== "POST") return yield* json(405, {});
    if (typeof given.restart !== "boolean") return yield* json(400, { message: "Say whether to restart them: restart, true or false." });
    const bridge = given.restart ? bridgeTarget() : null;
    if (bridge) {
      const told = await call(bridge, "POST", "/api/kuvo/sandbox/restart", {}, AbortSignal.timeout(10_000)).then(() => true, () => false);
      if (!told) return yield* json(503, { message: "The coding agents' bridge didn't answer: try again in a moment." });
    }
    answeredRestart();
    return yield* json(200, shown());
  }
  const parts = route.split("/");

  // The asks, the agents' tool and Also Allowed are the box's long-running process's.
  if (!heldHere(route)) return yield* json(404, {});
  if (!holdsVault()) {
    const answer = await askHolder(request, signal);
    if (!answer) return yield* json(503, { message: NOT_OPEN });
    return yield* [{ head: { status: answer.status, headers: { "content-type": answer.type || "application/json" } } }, { body: Buffer.from(answer.body, "base64") }];
  }

  if (route === "kuvo/sandbox/allowed" || parts[2] === "allowed") {
    try {
      if (route === "kuvo/sandbox/allowed" && method === "GET") {
        const project = new URLSearchParams(request.path.split("?")[1] ?? "").get("project") ?? undefined;
        return yield* json(200, { allowed: allowedFor(project) });
      }
      if (route === "kuvo/sandbox/allowed" && method === "POST") {
        const rule = addRule({ ...given, by: clientName(context) });
        return yield* json(200, { allowed: allowedFor(rule.project) });
      }
      if (parts.length === 4 && method === "DELETE") {
        const id = idOf(parts[3]);
        const rule = allowedFor().find(each => each.id === id);
        if (!rule || !removeRule(id)) return yield* json(404, { message: "That isn't in Also Allowed." });
        return yield* json(200, { allowed: allowedFor(rule.project) });
      }
      return yield* json(405, {});
    } catch (error) {
      if (error instanceof RuleRefusal) return yield* json(400, { message: error.message });
      throw error;
    }
  }

  if (route === "kuvo/sandbox/tools") {
    const on = fenceState().on;
    // What a tool server lists (`tools/list`): only while commands here are in the sandbox.
    if (method === "GET") return yield* json(200, { tools: on ? SANDBOX_TOOLS : [] });
    if (method !== "POST") return yield* json(405, {});
    if (!on) return yield* json(200, { text: NOT_ON, isError: true });
    // Only a call the conversation it names is making now, with these arguments (vault/who.ts).
    const args = isObject(given.arguments) ? given.arguments : {};
    const session = typeof given.session === "string" ? given.session : undefined;
    if (typeof given.name !== "string" || !await isCalling(session, [given.name], args, readEngine, readBridge)) {
      return yield* json(200, { text: NOT_CALLING, isError: true });
    }
    const caller = await callerOf(session, readEngine, readBridge);
    return yield* json(200, await callSandboxTool(given.name, args, caller, signal));
  }
  if (route === "kuvo/sandbox/asks" || route === "kuvo/sandbox/asks/events") {
    if (method !== "GET") return yield* json(405, {});
    // With the box's one ask to restart the agents started before the sandbox was on, while it asks.
    const listed = () => ({ asks: listSandboxAsks(), ...(asksToRestart() ? { restart: true } : {}) });
    if (route === "kuvo/sandbox/asks") return yield* json(200, listed());
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    let wake: () => void = () => {};
    const stop = onSandboxAsksChanged(() => wake());
    let sent = "";
    // Until that's settled here (and said), looked at every few seconds too, as the agents bridge
    // notes it and you answer it (perhaps through another of the box's processes).
    const looks = setInterval(() => { if (!restartSettled() || sent.includes('"restart"')) wake(); }, 5_000);
    try {
      while (!signal?.aborted) {
        const now = JSON.stringify(listed());
        if (now !== sent) yield { body: Buffer.from(now + "\n") };
        sent = now;
        await new Promise<void>(done => {
          wake = done;
          signal?.addEventListener("abort", () => done(), { once: true });
        });
      }
    } finally {
      clearInterval(looks);
      stop();
    }
    return;
  }
  if (parts.length === 4 && parts[2] === "asks") {
    if (method !== "POST") return yield* json(405, {});
    const answer = given.answer;
    if (answer !== "once" && answer !== "always" && answer !== "no") return yield* json(400, { message: "Answer “once”, “always” or “no”." });
    return yield* json(answerSandboxAsk(idOf(parts[3]), { answer, client: clientName(context) }) ? 200 : 404, {});
  }
  return yield* json(404, {});
}
