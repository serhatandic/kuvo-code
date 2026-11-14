// Providers of your own (PROTOCOL.md, `kuvo/providers/models`): the models one lists, asked from
// this box, so `localhost` is the computer the engine reaches it from.

import { parsed } from "../../shared/json";
import type { ProviderModels } from "../../shared/routes/misc";
import type { AnswerPiece, JSONAnswer, RouteContext } from "../server/context";

/** What `providerModels` is sent: the provider's address, its API, and its headers as written. */
interface ProviderAsk {
  url?: unknown;
  api?: unknown;
  headers?: unknown;
}

/** `POST kuvo/providers/models {"url", "api"?, "headers"?}`: a provider of your own's models, as
 * its service lists them, asked from this box (so `localhost` is this computer): `{"reached":
 * true, "models": [id…]}`, `{"reached": true, "needsKey": true}` when it wants its key first, or
 * `{"reached": false, "message"}`. `api` "anthropic" asks as Anthropic's API does. */
export async function providerModels(body: ProviderAsk | null | undefined, signal?: AbortSignal): Promise<JSONAnswer<ProviderModels, { message: string }>> {
  const given = typeof body?.url === "string" ? body.url.trim() : "";
  let base: URL;
  try {
    base = new URL(given);
    if (!["http:", "https:"].includes(base.protocol)) throw new Error();
  } catch {
    return { status: 400, value: { message: "Send the provider's address, starting with http:// or https://." } };
  }
  // Headers written out in the settings (not ones that name an environment variable or a file).
  const written = body?.headers && typeof body.headers === "object" ? (body.headers as Record<string, unknown>) : {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(written)) {
    if (typeof value === "string" && !value.includes("{env:") && !value.includes("{file:") && /^[!-~]+$/.test(name)) headers[name] = value;
  }
  if (body?.api === "anthropic") headers["anthropic-version"] ??= "2023-06-01";
  // `<its path>/models`, with its query kept; Anthropic's list asked for whole (it pages by 20).
  const address = new URL(base.href);
  address.pathname = `${address.pathname.replace(/\/+$/, "")}/models`;
  if (body?.api === "anthropic" && !address.searchParams.has("limit")) address.searchParams.set("limit", "1000");
  const deadline = AbortSignal.timeout(10_000);
  let answered: Response;
  try {
    // Never followed elsewhere: its headers are for this address only.
    answered = await fetch(address, { headers, redirect: "manual", signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  } catch (error) {
    const timedOut = (error as Error | null)?.name === "TimeoutError";
    return { status: 200, value: { reached: false, message: timedOut ? "It didn't answer in time." : "Nothing answers at this address." } };
  }
  if (answered.status >= 300 && answered.status < 400) {
    const to = answered.headers.get("location");
    return { status: 200, value: { reached: false, message: to ? `It sends its list of models to ${new URL(to, address).host}. Use that address instead.` : `It answered ${answered.status} for its list of models.` } };
  }
  if (answered.status === 401 || answered.status === 403) return { status: 200, value: { reached: true, needsKey: true } };
  if (!answered.ok) return { status: 200, value: { reached: false, message: `It answered ${answered.status} for its list of models. Check the address, often ending in /v1.` } };
  const listed = (await answered.json().catch(() => null)) as { data?: unknown; models?: unknown } | unknown[] | null;
  const entries = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : Array.isArray(listed?.models) ? listed.models : null;
  if (!entries) return { status: 200, value: { reached: false, message: "It answered, but not with a list of models. Check the address, often ending in /v1." } };
  const ids = entries.map(each => (typeof each === "string" ? each : (each as { id?: unknown; name?: unknown } | null)?.id ?? (each as { name?: unknown } | null)?.name));
  const models = [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))].sort();
  return { status: 200, value: { reached: true, models } };
}

// A provider of your own's models, as its service lists them to this box.
export async function* providerModelsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const { status, value } = await providerModels(parsed(request.body) as ProviderAsk | null, signal);
  return yield* json(status, value);
}
