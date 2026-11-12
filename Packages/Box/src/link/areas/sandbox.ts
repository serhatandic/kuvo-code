// `kuvo/sandbox`: whether agents' commands here run in the sandbox, and why not (PROTOCOL.md,
// "Sandbox"). It's on wherever it can run, with no switch; a client has it set up and checked
// again (`POST kuvo/sandbox/check`). And what goes beyond it: the commands agents ask to run outside
// it (`kuvo/sandbox/asks`, answered by a client), their tool (`kuvo/sandbox/tools`), and what you
// allowed each project (`kuvo/sandbox/allowed`). The asks wait in the box's long-running process,
// as Also Allowed is, which any other passes them to (vault/holder.ts).

import { isObject, parsed } from "../../shared/json";
import type { SandboxState } from "../../shared/routes/sandbox";
import { addableOwners, addRule, allowedFor, folderOfOwner, forgetGoneBots, listed, removeRule, RuleRefusal } from "../fence/allowed";
import { answerSandboxAsk, callSandboxTool, listSandboxAsks, onSandboxAsksChanged, SANDBOX_TOOLS, stoppedInAuto } from "../fence/outside";
import { answeredRestart, asksToRestart, fencePending, fenceState, restartSettled, setUpFence, tellAgents } from "../fence/state";
import { bridgeTarget, call } from "../engine/client";
import type { AnswerPiece, RouteContext } from "../server/context";
import { readLink } from "../state";
import { listAskReviews, listSettledReviews, onAskReviewsChanged } from "../work/reviewing";
import { askHolder, heldHere, holdsVault } from "../vault/holder";
import { callerOf, isCalling } from "../vault/who";

const NOT_OPEN = "This computer's box isn't running its own process: try again in a moment.";
const NOT_CALLING = "Only a conversation's own tool call can ask, and this one isn't running in it.";
const NOT_ON = "Commands aren't in the sandbox on this computer now, so there's nothing to ask: run the command with your shell tool.";
const PENDING = "The sandbox is being checked again (its last check didn't finish in time), so nothing can be let out of it yet: commands still run in it. Try again in a minute, or tell the user what you need.";

// (What agents are told goes with it at once, rather than at the box's next look.)
const shown = (): SandboxState => {
  const { on, able, agents, ...not } = fenceState();
  try { tellAgents(); } catch {}
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
      // A project's (`?project=`), or every rule here and whom else one can be added for: what a
      // GET with none named answers, and an add's or a removal's with `?all`.
      const query = new URLSearchParams(request.path.split("?")[1] ?? "");
      forgetGoneBots();
      const answer = async (of?: string) => ({ allowed: await listed(await allowedFor(of)), ...(of ? {} : { owners: addableOwners() }) });
      if (route === "kuvo/sandbox/allowed" && method === "GET") return yield* json(200, await answer(query.get("project") ?? undefined));
      if (route === "kuvo/sandbox/allowed" && method === "POST") {
        // For a project by its folder, or for a bot's own folder or the chats' by `owner`.
        const project = given.project === undefined && given.owner !== undefined ? folderOfOwner(given.owner) : given.project;
        const rule = await addRule({ ...given, project, by: clientName(context) });
        return yield* json(200, await answer(query.has("all") ? undefined : rule.project));
      }
      if (parts.length === 4 && method === "DELETE") {
        const id = idOf(parts[3]);
        const rule = (await allowedFor()).find(each => each.id === id);
        if (!rule || !removeRule(id)) return yield* json(404, { message: "That isn't in Also Allowed." });
        return yield* json(200, await answer(query.has("all") ? undefined : rule.project));
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
    if (!on) return yield* json(200, { text: fencePending() ? PENDING : NOT_ON, isError: true });
    // Only a call the conversation it names is making now, with these arguments (vault/who.ts).
    const args = isObject(given.arguments) ? given.arguments : {};
    const session = typeof given.session === "string" ? given.session : undefined;
    if (typeof given.name !== "string" || !await isCalling(session, [given.name], args, readEngine, readBridge)) {
      return yield* json(200, { text: NOT_CALLING, isError: true });
    }
    const caller = await callerOf(session, readEngine, readBridge);
    return yield* json(200, await callSandboxTool(given.name, args, caller, signal));
  }
  // A command the sandbox stopped, as the engine's plugin tells it when the agent's shell call ends:
  // in Auto, what the agent gets instead (`{text, exit}`), or why not after what it printed
  // (`{text}`); `{}` leaves it as it was.
  if (route === "kuvo/sandbox/stopped") {
    if (method !== "POST") return yield* json(405, {});
    const input = isObject(given.input) ? given.input : {};
    const session = typeof given.session === "string" ? given.session : undefined;
    if (!fenceState().on || typeof given.output !== "string") return yield* json(200, {});
    // Only a call the conversation it names is making now, with this input (vault/who.ts).
    if (!await isCalling(session, ["shell", "bash"], input, readEngine, readBridge)) return yield* json(200, {});
    const caller = await callerOf(session, readEngine, readBridge);
    const calling = () => isCalling(session, ["shell", "bash"], input, readEngine, readBridge);
    return yield* json(200, await stoppedInAuto(caller, input, given.output, calling, signal) ?? {});
  }
  if (route === "kuvo/sandbox/asks" || route === "kuvo/sandbox/asks/events") {
    if (method !== "GET") return yield* json(405, {});
    // With the box's one ask to restart the agents started before the sandbox was on, while it asks.
    // With how Auto's reviewer is taking up what the agents ask to work outside their folders, and
    // those it was checking or left for you that were answered or went since.
    const listed = () => ({ asks: listSandboxAsks(), ...(asksToRestart() ? { restart: true } : {}), reviews: listAskReviews(), settled: listSettledReviews() });
    if (route === "kuvo/sandbox/asks") return yield* json(200, listed());
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    let wake: () => void = () => {};
    const stops = [onSandboxAsksChanged(() => wake()), onAskReviewsChanged(() => wake())];
    const stop = () => { for (const each of stops) each(); };
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
