// Sign-ins that ended (PROTOCOL.md, "kuvo/accounts")
// A run on this box's engine refused its model's sign-in (it ran out and couldn't be renewed: the
// engine says only "Request failed" then), by provider: the credential in use then. A step on that
// provider's model that ends well says it works after all; signed in again, the one in use is
// another, and it isn't ended. Kept in `run/ended-sign-ins.json`, so whichever of the box's
// processes answers (its link, `box route`) says the same, and a box started again still knows.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { EngineRecord, Target } from "../../shared/records";
import { engineGet } from "../engine/client";
import { refreshModels } from "../engine/models";
import type { EngineAnswer, UncheckedAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import { writePrivate } from "../files";
import { RUN } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";
import type { Credentials } from "../../shared/routes/box";

/** An engine's event, as this reads it: its type, its session, and a failed run's error. */
export interface SignInEvent {
  type: string;
  data?: { sessionID?: unknown; error?: { type?: string; message?: unknown } };
}

/** A provider (a plan, or an integration's server) as its engine lists it (`api/integration`). */
interface EngineIntegration {
  id?: string;
  metadata?: { source?: string };
  connections?: EngineConnection[];
}

/** One of a provider's connections: a sign-in's (`credential`) says how it's signed in and which
 * of its credentials it is (`id`). */
interface EngineConnection {
  type?: string;
  method?: string;
  id?: string;
}

/** A sign-in (or a key) as the engine keeps it and lists it (`api/credential`): the integration
 * it's for, its label, whether it's the one in use, and its value, whose `type` says what it is
 * (`oauth` for a sign-in). */
export interface EngineCredential {
  id: string;
  integrationID: string;
  label: string;
  active: boolean;
  value: { type: string; [field: string]: unknown };
}

/** A sign-in as `kuvo/credentials` lists it. */
export type ListedCredential = Credentials["credentials"][number];

const ENDED_SIGN_INS_FILE = path.join(RUN, "ended-sign-ins.json");

function readEndedSignIns(): Map<string, string> {
  try {
    const kept = JSON.parse(fs.readFileSync(ENDED_SIGN_INS_FILE, "utf8"));
    return new Map(Object.entries(isObject(kept) ? kept : {}).filter(([, credential]) => typeof credential === "string") as [string, string][]);
  } catch {
    return new Map();
  }
}

function changeEndedSignIns(change: (ended: Map<string, string>) => void) {
  const ended = readEndedSignIns();
  change(ended);
  try {
    if (ended.size) writePrivate(ENDED_SIGN_INS_FILE, JSON.stringify(Object.fromEntries(ended)));
    else fs.rmSync(ENDED_SIGN_INS_FILE, { force: true });
  } catch {}
}

export async function noteSignIn(event: SignInEvent, source: Target): Promise<void> {
  const ended = event.type === "session.execution.failed";
  if (!ended && (event.type !== "session.step.ended" || !readEndedSignIns().size)) return;
  if (ended && (event.data?.error?.type !== "provider.auth" || !String(event.data?.error?.message ?? "").startsWith("Request failed"))) return;
  const id = event.data?.sessionID;
  if (typeof id !== "string") return;
  // (As the engine answers it: a session it has, whole; one it hasn't is an error.)
  const provider = (await engineGet(source, `api/session/${encodeURIComponent(id)}`) as EngineAnswer<EngineSession>)?.data?.model?.providerID;
  if (typeof provider !== "string") return;
  if (!ended) return void changeEndedSignIns(each => each.delete(provider));
  const active = await activeCredential(source, provider);
  if (active?.method === "oauth" && active.id) changeEndedSignIns(each => each.set(provider, active.id!));
}

// Each plan's sign-in in use, as its engine lists them; it throws when the engine can't say.
async function signInsInUse(engine: Target): Promise<(provider: string) => EngineConnection | null> {
  const integrations = (await engineGet(engine, "api/integration") as UncheckedAnswer)?.data;
  if (!Array.isArray(integrations)) throw new Error("The engine didn't list its plans.");
  return provider => (integrations as EngineIntegration[]).find(each => each?.id === provider)?.connections?.find(each => each?.type === "credential") ?? null;
}

// `provider`'s sign-in in use, as its engine lists it.
async function activeCredential(engine: Target, provider: string): Promise<EngineConnection | null> {
  return (await signInsInUse(engine))(provider);
}

// The plans whose sign-in in use ended. It throws when the engine can't say which it uses: none
// of them is said to work again for that.
export async function endedProviders(engine: Target): Promise<string[]> {
  const ended = readEndedSignIns();
  if (!ended.size) return [];
  const inUse = await signInsInUse(engine);
  return [...ended].filter(([provider, credential]) => inUse(provider)?.id === credential).map(([provider]) => provider).sort();
}

// Signs this box out of one of your plans (Settings › Accounts' Disconnect): its sign-ins and keys,
// never an integration's server. 404 for what isn't a plan here; when the engine can't list them or
// won't remove one, why, with what it didn't remove still there (and its plan still said to have
// ended, if it had).
export async function forgetPlan(engine: Target, id: string): Promise<{ status: 200 | 404 } | { status: 502 | 503; message: string }> {
  const integrations = (await engineGet(engine, "api/integration") as UncheckedAnswer)?.data;
  const entries = (await engineGet(engine, "api/credential") as UncheckedAnswer)?.data;
  if (!Array.isArray(integrations) || !Array.isArray(entries)) return { status: 503, message: "The engine isn't answering. Try again in a moment." };
  const plan = (integrations as EngineIntegration[]).find(each => each?.id === id);
  if (!plan || plan.metadata?.source === "mcp") return { status: 404 };
  let refused = 0;
  for (const entry of entries as EngineCredential[]) {
    if (entry?.integrationID !== id || typeof entry.id !== "string") continue;
    const removed = await fetch(`http://127.0.0.1:${engine.port}/api/credential/${encodeURIComponent(entry.id)}`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    // Gone already (removed meanwhile from another device) is removed.
    }).then(response => (response.body?.cancel(), response.ok || response.status === 404), () => false);
    if (!removed) refused++;
  }
  if (refused) return { status: 502, message: refused === 1 ? "The engine didn't remove a sign-in. Try again." : `The engine didn't remove ${refused} sign-ins. Try again.` };
  changeEndedSignIns(each => each.delete(id));
  return { status: 200 };
}

// The plans whose sign-in ran out and couldn't be renewed (a run on one was refused), signing out
// of one, as Settings › Accounts' Disconnect does (PROTOCOL.md, "kuvo/accounts"), and a provider's
// models asked of again (Refresh Models, `engine/models.ts`).
export async function* accountsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, readEngine, json } = context;
  let engine: EngineRecord | null = null;
  try { engine = readEngine(); } catch {}
  if (!engine?.port) return yield* json(503, { message: "The engine isn't running." });
  if (route === "kuvo/accounts/ended") {
    if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* json(405, {});
    const providers = await endedProviders(engine).catch(() => null);
    if (!providers) return yield* json(503, { message: "The engine isn't answering. Try again in a moment." });
    return yield* json(200, { providers });
  }
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const action = route.endsWith("/refresh") ? "refresh" : "forget";
  let id: string | null = null;
  try { id = decodeURIComponent(route.slice("kuvo/accounts/".length, -`/${action}`.length)); } catch {}
  if (!id || id.includes("/")) return yield* json(404, {});
  if (action === "refresh") {
    const refreshed = await refreshModels(engine, id).catch(() => ({ status: 503 as const, message: "The engine isn't answering. Try again in a moment." }));
    return yield* json(refreshed.status, refreshed.status === 200 ? { waiting: refreshed.waiting } : "message" in refreshed ? { message: refreshed.message } : {});
  }
  const forgot = await forgetPlan(engine, id).catch(() => ({ status: 503 as const, message: "The engine isn't answering. Try again in a moment." }));
  return yield* json(forgot.status, "message" in forgot ? { message: forgot.message } : {});
}

// This machine's sign-ins, listed (`api/credential` has what each is signed in with too).
export async function* credentialsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, readEngine, text } = context;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
  let engine: EngineRecord;
  try {
    engine = readEngine();
  } catch {
    return yield* text(503, "The engine isn't running.");
  }
  let listed: ListedCredential[];
  try {
    const response = await fetch(`http://127.0.0.1:${engine.port}/api/credential`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal,
    });
    if (!response.ok) return yield* text(502, "The engine didn't answer.");
    listed = ((await response.json() as { data?: EngineCredential[] })?.data ?? []).map(credential => ({
      id: String(credential.id), integrationID: String(credential.integrationID), label: String(credential.label ?? ""), active: Boolean(credential.active),
    }));
  } catch {
    return yield* text(502, "The engine didn't answer.");
  }
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ credentials: listed })) };
  return;
}
