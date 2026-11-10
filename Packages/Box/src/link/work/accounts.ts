// The account each of a bot's sessions runs on (`account` in `kuvo/work`), as Settings › Accounts
// lists it on this box: its provider's name, and for a coding agent's account you added, the name
// you gave it ("Work"; its own sign-in has none). The engine's sign-ins have no name of yours, so
// none is said. Custom Auto picks one each turn, so its sessions say none.

import { isObject } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { WorkAccount } from "../../shared/routes/work";
import { call } from "../engine/client";

/** How long the engine or the coding agents' bridge has to say, before the work goes without. */
const ASK_WAIT = 5_000;

/** The accounts `target` (the engine, or the coding agents' bridge) lists, by provider; empty when
 * it can't say. Its list as it last checked it (never `fresh`: the bridge would ask each agent's
 * program again for every read of the work). */
async function accountsOn(target: Target, signal?: AbortSignal): Promise<Map<string, WorkAccount>> {
  const wait = AbortSignal.timeout(ASK_WAIT);
  const listed = await call(target, "GET", "/api/integration", undefined, signal ? AbortSignal.any([signal, wait]) : wait).catch(() => null);
  const accounts = new Map<string, WorkAccount>();
  for (const each of Array.isArray(listed) ? listed : []) {
    if (!isObject(each) || typeof each.id !== "string" || typeof each.name !== "string" || !each.name.trim()) continue;
    const name = each.name.trim();
    // A coding agent's account you added: the name you gave it.
    const label = isObject(each.metadata) && each.metadata.source === "agent" && typeof each.metadata.accountLabel === "string" ? each.metadata.accountLabel.trim() : "";
    accounts.set(each.id, label ? { name, label } : { name });
  }
  return accounts;
}

/** The accounts the sessions given run on, by session: each place they run asked once. */
export async function workAccounts(sessions: { id: string; target: Target; provider?: string }[], signal?: AbortSignal): Promise<Map<string, WorkAccount>> {
  const asked = new Map<number, Promise<Map<string, WorkAccount>>>();
  const accounts = new Map<string, WorkAccount>();
  await Promise.all(sessions.map(async ({ id, target, provider }) => {
    if (!provider || provider === "auto") return;
    if (!asked.has(target.port)) asked.set(target.port, accountsOn(target, signal));
    const account = (await asked.get(target.port)!).get(provider);
    if (account) accounts.set(id, account);
  }));
  return accounts;
}
