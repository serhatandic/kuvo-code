// Signing in to an account (PROTOCOL.md, "Signing in"): the ways a client offers, in the box's order
// and words (`kuvo/sign-in/methods`), and how a started sign-in is going, with what to say when it
// didn't work (`kuvo/sign-in/status`), so every client offers and says the same. The engine (or
// the coding agents' bridge, for an agent's account) does the signing in; the box only orders and
// words what it offers. Held to Packages/KuvoLink/Vectors/sign-in.json.

import type { Target } from "../../shared/records";
import { pause } from "../../shared/wait";
import { call } from "../engine/client";
import { planHides } from "../work/model-rule";
import { agentsDown } from "./agents-down";
import { engineDown } from "./engine";
import type { AnswerPiece, RouteContext } from "../server/context";

export const SIGN_IN_METHODS_ROUTE = "kuvo/sign-in/methods";
export const SIGN_IN_STATUS_ROUTE = "kuvo/sign-in/status";

/** A way to sign in as the engine (or the bridge) lists it (`api/integration`'s `methods`). */
interface ListedMethod {
  type?: unknown;
  id?: unknown;
  label?: unknown;
  form?: unknown;
  names?: unknown;
}

/** An account as the engine (or the bridge) lists it: its ways in, and how it's signed in now. */
export interface ListedAccount {
  id?: unknown;
  methods?: unknown;
  connections?: unknown;
}

/** A way to sign in, as a client offers it: the engine's own (`type`, `id`, `form`, as a client
 * starts it with), with the box's `label`, and `legacy` for one its maker keeps for older setups,
 * which a client offers apart, after the others. */
export interface OfferedMethod {
  type: "oauth" | "external" | "key";
  id?: string;
  label: string;
  form?: unknown[];
  legacy?: true;
}

/** Signing in with an account leads, then credentials the computer already has, then a key. */
const ORDER = { oauth: 0, external: 1, key: 2 } as const;

/** What a key's button says when the engine gives it no words of its own. */
export const KEY_LABEL = "Use an API key";
/** What a sign-in's button says when the engine gives it no words of its own. */
export const SIGN_IN_LABEL = "Sign in";

/** The ways a client offers to sign in to `account`, in order (each kind by `ORDER`, the engine's
 * order within a kind, legacy ones last), and the environment variables that sign in to it too. A
 * plan whose sign-in goes through a coding agent (ChatGPT's through Codex, SuperGrok's through Grok)
 * isn't offered for the engine's provider, unless it's signed in that way already (it can be again). */
export function signInMethods(account: ListedAccount): { methods: OfferedMethod[]; environment: string[] } {
  const provider = typeof account.id === "string" ? account.id : "";
  const listed = (Array.isArray(account.methods) ? account.methods : []).filter((method): method is ListedMethod => !!method && typeof method === "object");
  const connections = Array.isArray(account.connections) ? account.connections : [];
  const signedInWithPlan = connections.some(connection => (connection as { method?: unknown } | null)?.method === "oauth");
  const offered: OfferedMethod[] = [];
  for (const method of listed) {
    const type = method.type;
    if (type !== "oauth" && type !== "external" && type !== "key") continue;
    const id = typeof method.id === "string" ? method.id : undefined;
    // (The engine's oauth and external ways always have an id: one without can't be started.)
    if (type !== "key" && !id) continue;
    if (type === "oauth" && !signedInWithPlan && planHides(provider, id!)) continue;
    const given = typeof method.label === "string" ? method.label.trim() : "";
    const label = given || (type === "key" ? KEY_LABEL : SIGN_IN_LABEL);
    offered.push({
      type,
      ...(type !== "key" ? { id } : {}),
      label,
      ...(Array.isArray(method.form) ? { form: method.form } : {}),
      ...(/legacy/i.test(label) ? { legacy: true as const } : {}),
    });
  }
  // A stable sort: the engine's order within each kind.
  const methods = offered
    .map((method, at) => ({ method, at }))
    .sort((a, b) => Number(!!a.method.legacy) - Number(!!b.method.legacy) || ORDER[a.method.type] - ORDER[b.method.type] || a.at - b.at)
    .map(each => each.method);
  const environment = listed
    .filter(method => method.type === "env" && Array.isArray(method.names))
    .flatMap(method => (method.names as unknown[]).filter((name): name is string => typeof name === "string" && name !== ""));
  return { methods, environment };
}

/** What a client says of a sign-in that ended without signing in: `expired`, or `failed` with the
 * engine's `message` (a sign-in page that sends back an error hands the engine its OAuth code, as
 * `access_denied` when you turn it down there, which the engine passes on as it is). */
export function failureWords(status: "failed" | "expired", message?: unknown): string {
  if (status === "expired") return "The sign-in timed out. Try again.";
  const said = typeof message === "string" ? message.trim() : "";
  if (!said) return "Signing in didn’t work.";
  const lower = said.toLowerCase();
  if (lower.includes("access_denied")) return "The sign-in was turned down on its page. Try again to sign in.";
  if (lower.includes("server_error") || lower.includes("temporarily_unavailable")) return "The service couldn’t sign you in just now. Try again in a moment.";
  // The page's answer was for another try: an address pasted from an earlier sign-in.
  if (lower.includes("state mismatch") || lower.includes("state_mismatch")) return "That page was from an earlier sign-in. Try again to sign in.";
  // Another OAuth code, on its own: in words.
  if (/^[a-z]+(_[a-z]+)+$/.test(said)) return `Signing in didn’t work (${said.replaceAll("_", " ")}).`;
  return said;
}

/** Where `query` asks about: the coding agents' bridge (`agents=1`, for an agent's account), else
 * the engine; or why it can't be asked now. */
function placeOf(query: URLSearchParams, context: RouteContext): { target: Target } | { down: string } {
  if (query.get("agents") === "1") {
    const bridge = context.bridge();
    return bridge ? { target: bridge } : { down: agentsDown() ?? "The coding agents aren't running. Try again in a moment." };
  }
  try {
    return { target: context.readEngine() };
  } catch {
    return { down: engineDown() };
  }
}

/** The longest a status ask waits for a change (`wait`), in seconds. */
const MOST_WAIT = 25;

/** `GET kuvo/sign-in/methods?integration=<id>[&agents=1]` and `GET kuvo/sign-in/status?integration=<id>&attempt=<id>[&agents=1][&wait=<seconds>]`:
 * with `wait`, a sign-in still going is asked again each second, answered as soon as what it says
 * changes or it ends, else once that long has passed (for a client that asks through a process run
 * each time, as a Mac asks a machine's box over SSH). */
export async function* signInRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const query = new URLSearchParams(request.path.split("?")[1] ?? "");
  const integration = query.get("integration")?.trim() ?? "";
  const attempt = route === SIGN_IN_STATUS_ROUTE ? query.get("attempt")?.trim() ?? "" : null;
  if (!integration || attempt === "") return yield* json(400, { message: attempt === "" ? "Say which sign-in (integration, attempt)." : "Say which account (integration)." });
  const place = placeOf(query, context);
  if ("down" in place) return yield* json(503, { message: place.down });
  // (A status ask has a limit for each read instead: one that waits for a change takes longer.)
  const deadline = AbortSignal.timeout(15_000);
  const asking = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    if (attempt === null) {
      // The whole list, as clients list accounts (the bridge reads each agent's anew for one alone).
      const listed = await call(place.target, "GET", "/api/integration", undefined, asking);
      const account = (Array.isArray(listed) ? listed : []).find(each => (each as ListedAccount | null)?.id === integration) as ListedAccount | undefined;
      if (!account) return yield* json(404, { message: `There's no ${integration} to sign in to here.` });
      return yield* json(200, signInMethods(account));
    }
    const statusRoute = `/api/integration/${encodeURIComponent(integration)}/connect/oauth/${encodeURIComponent(attempt)}`;
    const read = async (): Promise<Record<string, unknown> | null> => {
      const each = AbortSignal.timeout(15_000);
      return (await call(place.target, "GET", statusRoute, undefined, signal ? AbortSignal.any([signal, each]) : each)) as Record<string, unknown> | null;
    };
    let said = await read();
    const wait = Math.min(Math.max(Number(query.get("wait")) || 0, 0), MOST_WAIT) * 1000;
    if (wait > 0) {
      const first = JSON.stringify(said), until = Date.now() + wait;
      while (said?.status === "pending" && JSON.stringify(said) === first && Date.now() < until && !signal?.aborted) {
        await pause(1000, signal);
        if (signal?.aborted) break;
        said = await read();
      }
    }
    const status = said?.status;
    if (status !== "pending" && status !== "complete" && status !== "failed" && status !== "expired") return yield* json(502, { message: "The sign-in's status couldn't be read." });
    return yield* json(200, { ...said, ...(status === "failed" || status === "expired" ? { failure: failureWords(status, said?.message) } : {}) });
  } catch (error) {
    if (attempt === null ? deadline.aborted : (error as Error | null)?.name === "TimeoutError") return yield* json(504, { message: "It didn't answer in time. Try again." });
    const status = (error as { status?: unknown } | null)?.status;
    const message = error instanceof Error && error.message ? error.message : "It didn't answer.";
    return yield* json(typeof status === "number" && status >= 400 ? status : 502, { message });
  }
}
