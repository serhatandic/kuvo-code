// @ts-nocheck
// Sign-ins that ended (PROTOCOL.md, "kuvo/accounts")
// A run on this box's engine refused its model's sign-in (it ran out and couldn't be renewed: the
// engine says only "Request failed" then), by provider: the credential in use then. A step on that
// provider's model that ends well says it works after all; signed in again, the one in use is
// another, and it isn't ended. Kept in `run/ended-sign-ins.json`, so whichever of the box's
// processes answers (its link, `box route`) says the same, and a box started again still knows.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { engineGet } from "../engine/client";
import { writePrivate } from "../files";
import { RUN } from "../home";

const ENDED_SIGN_INS_FILE = path.join(RUN, "ended-sign-ins.json");

function readEndedSignIns() {
  try {
    const kept = JSON.parse(fs.readFileSync(ENDED_SIGN_INS_FILE, "utf8"));
    return new Map(Object.entries(isObject(kept) ? kept : {}).filter(([, credential]) => typeof credential === "string"));
  } catch {
    return new Map();
  }
}

function changeEndedSignIns(change) {
  const ended = readEndedSignIns();
  change(ended);
  try {
    if (ended.size) writePrivate(ENDED_SIGN_INS_FILE, JSON.stringify(Object.fromEntries(ended)));
    else fs.rmSync(ENDED_SIGN_INS_FILE, { force: true });
  } catch {}
}

export async function noteSignIn(event, source) {
  const ended = event.type === "session.execution.failed";
  if (!ended && (event.type !== "session.step.ended" || !readEndedSignIns().size)) return;
  if (ended && (event.data?.error?.type !== "provider.auth" || !String(event.data?.error?.message ?? "").startsWith("Request failed"))) return;
  const id = event.data?.sessionID;
  if (typeof id !== "string") return;
  const provider = (await engineGet(source, `api/session/${encodeURIComponent(id)}`))?.data?.model?.providerID;
  if (typeof provider !== "string") return;
  if (!ended) return void changeEndedSignIns(each => each.delete(provider));
  const active = await activeCredential(source, provider);
  if (active?.method === "oauth" && active.credentialID) changeEndedSignIns(each => each.set(provider, active.credentialID));
}

// `provider`'s sign-in in use, as its engine lists it.
async function activeCredential(engine, provider) {
  const integrations = (await engineGet(engine, "api/integration"))?.data;
  return (Array.isArray(integrations) ? integrations : []).find(each => each?.id === provider)?.connections?.find(each => each?.type === "credential") ?? null;
}

// The plans whose sign-in in use ended.
export async function endedProviders(engine) {
  const providers = [];
  for (const [provider, credential] of readEndedSignIns()) {
    if ((await activeCredential(engine, provider).catch(() => null))?.credentialID === credential) providers.push(provider);
  }
  return providers.sort();
}

// Signs this box out of one of your plans (Settings › Accounts' Disconnect): its sign-ins and keys,
// never an integration's server. False for what isn't a plan here.
export async function forgetPlan(engine, id) {
  const integrations = (await engineGet(engine, "api/integration"))?.data;
  const plan = (Array.isArray(integrations) ? integrations : []).find(each => each?.id === id);
  if (!plan || plan.metadata?.source === "mcp") return false;
  const entries = (await engineGet(engine, "api/credential"))?.data;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.integrationID !== id || typeof entry.id !== "string") continue;
    await fetch(`http://127.0.0.1:${engine.port}/api/credential/${encodeURIComponent(entry.id)}`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    }).then(response => response.body?.cancel()).catch(() => {});
  }
  changeEndedSignIns(each => each.delete(id));
  return true;
}
