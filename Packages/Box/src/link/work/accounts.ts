// The account each of a bot's sessions runs on (`account` in `kuvo/work`), as Settings › Accounts
// lists it on this box: its provider's name, and the account's own name where that tells it apart.
// A coding agent's: the name you gave one you added ("Work"); its own sign-in has none. The
// engine's: the one it uses now (it uses one at a time), named only where it has more than one.
// Custom Auto picks one each turn, so its sessions say none.

import { isObject } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { WorkAccount } from "../../shared/routes/work";
import { call } from "../engine/client";

/** How long the engine or the coding agents' bridge has to say, before the work goes without. */
const ASK_WAIT = 5_000;

/** `provider`'s account, as `target` (the engine, or the coding agents' bridge) lists it; null
 * when it can't say. */
async function accountOf(target: Target, provider: string, signal?: AbortSignal): Promise<WorkAccount | null> {
  const wait = AbortSignal.timeout(ASK_WAIT);
  const listed = await call(target, "GET", `/api/integration/${encodeURIComponent(provider)}`, undefined, signal ? AbortSignal.any([signal, wait]) : wait).catch(() => null);
  if (!isObject(listed) || typeof listed.name !== "string" || !listed.name.trim()) return null;
  const name = listed.name.trim();
  const named = (label: unknown) => (typeof label === "string" && label.trim() ? { name, label: label.trim() } : { name });
  // A coding agent's account: the name you gave it.
  if (isObject(listed.metadata) && listed.metadata.source === "agent") return named(listed.metadata.accountLabel);
  // The engine's: the one in use (listed first), by its name where there are others to tell it from.
  const signIns = Array.isArray(listed.connections) ? listed.connections.filter(each => isObject(each) && each.type === "credential") as Record<string, unknown>[] : [];
  return signIns.length > 1 ? named(signIns[0]!.label) : { name };
}

/** The accounts the sessions given run on, by session: each provider asked once where it runs. */
export async function workAccounts(sessions: { id: string; target: Target; provider?: string }[], signal?: AbortSignal): Promise<Map<string, WorkAccount>> {
  const asked = new Map<string, Promise<WorkAccount | null>>();
  const accounts = new Map<string, WorkAccount>();
  await Promise.all(sessions.map(async ({ id, target, provider }) => {
    if (!provider || provider === "auto") return;
    const key = `${target.port}|${provider}`;
    if (!asked.has(key)) asked.set(key, accountOf(target, provider, signal));
    const account = await asked.get(key)!;
    if (account) accounts.set(id, account);
  }));
  return accounts;
}
