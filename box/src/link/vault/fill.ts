// A browser's fill (`kuvo/vault/fill`): the values a sign-in or a field takes, for the browser's own
// process to put in the page, never the agent. Only where the page really is (the origin the
// browser reports, not the agent) is one of the item's sites; anywhere else it's refused, and the
// bot's use of the vault pauses (the tripwire).

import { isObject } from "../../shared/json";
import { oneLine } from "../../shared/text";
import type { VaultFill, VaultItem } from "../../shared/routes/vault";
import { itemNamed, noteUsed, readItems, siteOf, usableOn, valuesOf } from "./store";
import { type Caller, grantFor } from "./who";
import { hasOnce, mayUse, noteUse, tripwire } from "./use";

/** What a fill comes to: the values, or why not (`status` 403 refused, 404 nothing to fill). */
export type FillOutcome = { status: 200; value: VaultFill } | { status: 403 | 404 | 400; value: { message: string } };

const refused = (status: 403 | 404 | 400, message: string): FillOutcome => ({ status, value: { message } });

/** The page's site, from the origin the browser gives: https only (http only for localhost). */
function pageSite(origin: unknown): string | null {
  if (typeof origin !== "string") return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
    return siteOf(url.hostname);
  } catch {
    return null;
  }
}

/**
 * The values for `given`: `{origin, purpose: "sign-in" | "field", item?, field?, why?}`. A sign-in
 * without an item takes the one sign-in for the page's site the caller may use on its own (none, or
 * more than one: 404, and the browser asks you as before). An item named is used only on its own
 * sites, and asks you when its grant says so, or when there's none.
 */
export async function fill(given: unknown, caller: Caller, signal?: AbortSignal): Promise<FillOutcome> {
  const body = isObject(given) ? given : {};
  const site = pageSite(body.origin);
  if (!site) return refused(400, "Kuvo Code fills only on a secure page (https).");
  const purpose = body.purpose === "field" ? "field" : "sign-in";
  const why = typeof body.why === "string" ? oneLine(body.why, 300) : undefined;
  let item: VaultItem | null;
  if (body.item !== undefined && body.item !== null && body.item !== "") {
    item = itemNamed(body.item);
    if (!item) return refused(404, `There's no item “${oneLine(body.item, 80)}” in the vault.`);
    if (!usableOn(item, site)) return refused(403, tripwire(item, caller, site));
  } else {
    if (purpose === "field") return refused(400, "Name the item to fill from.");
    // (A seat's own, as its bot's would be: it's still asked for, below.)
    const own = readItems().filter(each => each.kind === "login" && usableOn(each, site) && (grantFor(each, { ...caller, seat: false }) === "own" || hasOnce(caller, each.id)));
    if (own.length !== 1) return refused(404, own.length ? "More than one sign-in fits this site." : "No sign-in in the vault is yours to use on this site.");
    item = own[0];
  }
  if (purpose === "field" && item.signInOnly) return refused(403, `“${item.name}” is only for signing in: use browser_sign_in.`);
  const may = await mayUse(item, caller, { site, ...(why ? { why } : {}), askWithout: true, signal });
  if (!may.ok) return refused(403, may.message);
  const values = await valuesOf(item.id);
  let filled: Record<string, string>;
  if (purpose === "sign-in") {
    if (item.kind !== "login") return refused(400, `“${item.name}” isn't a sign-in: fill one of its fields with browser_fill.`);
    filled = values.password !== undefined ? { password: values.password } : {};
  } else {
    const field = typeof body.field === "string" && body.field ? body.field.trim().toLowerCase() : item.kind === "login" ? "password" : item.fields.length === 1 ? item.fields[0] : "";
    if (field === "username" && item.username) filled = { username: item.username };
    else if (!field || values[field] === undefined) return refused(400, `Say which of “${item.name}”'s fields to fill: ${["username", ...item.fields].filter(each => each !== "username" || item!.username).join(", ")}.`);
    else filled = { [field]: values[field] };
  }
  noteUsed(item.id);
  noteUse(item, caller, { site, ...(why ? { why } : {}) }, may.how);
  return { status: 200, value: { item: { id: item.id, name: item.name }, ...(item.username ? { username: item.username } : {}), values: filled } };
}

/** The sign-ins for a page's site, by name, that a browser's card offers you (no values). */
export const signInsFor = (origin: unknown): { id: string; name: string; username?: string }[] => {
  const site = pageSite(origin) ?? siteOf(origin);
  if (!site) return [];
  return readItems().filter(item => item.kind === "login" && usableOn(item, site)).map(item => ({ id: item.id, name: item.name, ...(item.username ? { username: item.username } : {}) }));
};
