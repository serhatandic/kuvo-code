// The vault's routes (PROTOCOL.md, "Vault"): a client's Vault page (its items, values, grants,
// activity, Pause and what agents ask), and the agents' own door (`kuvo/vault/tools`, and a
// browser's `kuvo/vault/fill`). The process that holds the vault answers them; any other passes
// them to it (vault/holder.ts).
//
// Who may do what: your phones (through the relay, by their keys) and this Mac's own app are
// clients; a request from this computer itself (the Mac over SSH, through `box route`) is a client
// only with the vault's unlock key (`x-kuvo-vault-key`), which only your clients keep. Agents reach
// only the tools and fills, under their grants.

import crypto from "node:crypto";
import { isObject, parsed } from "../../shared/json";
import { oneLine } from "../../shared/text";
import { macSign, readLink } from "../state";
import type { AnswerPiece, RouteContext } from "../server/context";
import { note, readActivity } from "../vault/activity";
import { answer as answerAsk, listAsks, onAsksChanged } from "../vault/asks";
import { fill } from "../vault/fill";
import { askHolder, holdsVault } from "../vault/holder";
import {
  addItem, changeItem, currentUnlockKey, givenWho, isLocked, isMade, itemByID, LOCKED, makeVault, onHost, readGrants, readItems,
  removeItem, setGrant, setPaused, unlockWith, valuesOf, VaultRefusal, vaultState,
} from "../vault/store";
import { callTool, VAULT_TOOLS } from "../vault/tools";
import { callerOf } from "../vault/who";

const NOT_OPEN = "This computer's vault isn't open: Kuvo Code's link here isn't running. Try again in a moment.";
const CLIENTS_ONLY = "Only Kuvo Code on your Mac or iPhone can do this.";
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** Who's asking, as a client: a phone (by its name), this Mac's app, the Mac over SSH with the
 * unlock key; null for anyone else (an agent's command on this computer). */
function clientOf({ request, phone }: RouteContext): string | null {
  if (phone?.key) {
    const key = phone.key.toString("base64url");
    return readLink()?.phones?.find(each => each.key === key)?.name || "iPhone";
  }
  if (request.fromApp) return "Mac";
  const key = request.headers["x-kuvo-vault-key"];
  if (typeof key === "string" && unlockWith(key)) return "Mac";
  return null;
}

/** Whether `proof` is a Mac that set this machine up, asking for its vault's key: its signing key's
 * signature of `kuvo-vault-key\0<at>`, made within five minutes. */
function provedMac(given: Record<string, unknown>): boolean {
  const link = readLink();
  const mac = typeof given.mac === "string" ? given.mac : "";
  const at = Number(given.at);
  const sign = mac ? macSign(link, mac) : null;
  if (!sign || !(link?.macs ?? []).includes(mac) || !Number.isFinite(at) || Math.abs(Date.now() - at) > 300_000 || typeof given.proof !== "string") return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(sign, "base64url")]), format: "der", type: "spki" });
    const signature = Buffer.from(given.proof, "base64url");
    return signature.length === 64 && crypto.verify(null, Buffer.from(`kuvo-vault-key\0${at}`), key, signature);
  } catch {
    return false;
  }
}

const idOf = (part: string | undefined) => {
  try { return decodeURIComponent(part ?? ""); } catch { return ""; }
};

export async function* vaultRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  if (!holdsVault()) {
    const answer = await askHolder(context.request, context.signal);
    if (!answer) return yield* context.json(503, { message: NOT_OPEN });
    return yield* [{ head: { status: answer.status, headers: { "content-type": answer.type || "application/json" } } }, { body: Buffer.from(answer.body, "base64") }];
  }
  try {
    yield* answerVault(context);
  } catch (error) {
    if (error instanceof VaultRefusal) return yield* context.json(error.status, { message: error.message });
    throw error;
  }
}

async function* answerVault(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, json, signal, readEngine, readBridge } = context;
  const method = request.method.toUpperCase();
  const body = parsed(request.body);
  const given = isObject(body) ? body : {};
  const parts = route.split("/");

  // The agents' door, and a browser's fills: under the caller's grants, from anyone here.
  if (route === "kuvo/vault/tools") {
    // What a tool server lists (`tools/list`), in this box's own words.
    if (method === "GET") return yield* json(200, { tools: VAULT_TOOLS });
    if (method !== "POST") return yield* json(405, {});
    const caller = await callerOf(given.session, readEngine, readBridge);
    return yield* json(200, await callTool(given.name, given.arguments, caller, signal));
  }
  if (route === "kuvo/vault/fill") {
    if (method !== "POST") return yield* json(405, {});
    if (isLocked()) return yield* json(423, { message: LOCKED });
    const caller = await callerOf(given.session, readEngine, readBridge);
    const outcome = await fill(given, caller, signal);
    return yield* json(outcome.status, outcome.value);
  }
  // The unlock key is its own proof.
  if (route === "kuvo/vault/unlock") {
    if (method !== "POST") return yield* json(405, {});
    if (!isMade() || onHost()) return yield* json(200, vaultState());
    if (!unlockWith(given.key)) return yield* json(403, { message: "That isn't this vault's key." });
    return yield* json(200, vaultState());
  }
  // The key for a client to keep: a phone, this Mac's app, or the Mac over SSH proving itself.
  if (route === "kuvo/vault/key") {
    if (method !== "POST") return yield* json(405, {});
    if (onHost()) return yield* json(409, { message: "This Mac's vault is its Keychain: it has no key to give." });
    if (!clientOf(context) && !provedMac(given)) return yield* json(403, { message: CLIENTS_ONLY });
    if (!isMade()) return yield* json(200, { key: makeVault() });
    const key = currentUnlockKey();
    if (!key) return yield* json(423, { message: LOCKED });
    return yield* json(200, { key });
  }

  const client = clientOf(context);
  if (!client) return yield* json(403, { message: CLIENTS_ONLY });

  if (route === "kuvo/vault") {
    if (method !== "GET") return yield* json(405, {});
    return yield* json(200, { state: vaultState(), items: isLocked() ? [] : readItems(), grants: readGrants() });
  }
  if (route === "kuvo/vault/pause") {
    if (method !== "POST") return yield* json(405, {});
    const bot = typeof given.bot === "string" && /^bot_[A-Za-z0-9]+$/.test(given.bot) ? given.bot : undefined;
    const paused = given.paused === true;
    setPaused(paused, bot);
    note({ what: paused ? "paused" : "resumed", client, ...(bot ? { bot } : {}) });
    return yield* json(200, vaultState());
  }
  if (route === "kuvo/vault/activity") {
    if (method !== "GET") return yield* json(405, {});
    const query = new URLSearchParams(request.path.split("?")[1] ?? "");
    return yield* json(200, { entries: readActivity({
      item: query.get("item") ?? undefined,
      bot: query.get("bot") ?? undefined,
      session: query.get("session") ?? undefined,
      before: Number(query.get("before")) || undefined,
      limit: Number(query.get("limit")) || undefined,
    }) });
  }
  if (route === "kuvo/vault/grants") {
    if (method === "GET") return yield* json(200, { grants: readGrants() });
    if (method !== "POST") return yield* json(405, {});
    const who = givenWho(given.who);
    if (typeof given.item !== "string" || !who) return yield* json(400, { message: "Send {\"item\", \"who\": {\"bot\"} or {\"project\"} or {\"everyone\": true}, \"how\": \"own\" | \"ask\" | null}." });
    const grants = setGrant(given.item, who, given.how ?? null);
    const item = itemByID(given.item);
    note({ what: given.how ? "granted" : "ungranted", client, ...(item ? { item: item.id, itemName: item.name, kind: item.kind } : {}), ...(who.bot ? { bot: who.bot } : {}), ...(typeof given.how === "string" ? { how: given.how } : {}) });
    return yield* json(200, { grants });
  }
  if (route === "kuvo/vault/asks" || route === "kuvo/vault/asks/events") {
    if (method !== "GET") return yield* json(405, {});
    if (route === "kuvo/vault/asks") return yield* json(200, { asks: listAsks() });
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    let wake: () => void = () => {};
    const stop = onAsksChanged(() => wake());
    try {
      while (!signal?.aborted) {
        yield { body: Buffer.from(JSON.stringify({ asks: listAsks() }) + "\n") };
        await new Promise<void>(done => {
          wake = done;
          signal?.addEventListener("abort", () => done(), { once: true });
        });
      }
    } finally {
      stop();
    }
    return;
  }
  if (parts.length === 4 && parts[2] === "asks") {
    if (method !== "POST") return yield* json(405, {});
    const answer = given.answer;
    if (answer !== "once" && answer !== "always" && answer !== "no") return yield* json(400, { message: "Answer “once”, “always” or “no”." });
    const item = typeof given.item === "string" ? given.item : undefined;
    if (item && !itemByID(item)) return yield* json(404, { message: "That item isn't in this vault." });
    return yield* json(answerAsk(idOf(parts[3]), { answer, ...(item ? { item } : {}), client }) ? 200 : 404, {});
  }

  // Items: a machine's needs its key in memory; one made by a client's first item gives that client the key.
  if (route === "kuvo/vault/items") {
    if (method !== "POST") return yield* json(405, {});
    let key: string | undefined;
    if (!isMade()) key = makeVault();
    if (isLocked()) return yield* json(423, { message: LOCKED });
    const item = await addItem(given);
    note({ what: "added", client, item: item.id, itemName: item.name, kind: item.kind });
    return yield* json(200, { item, ...(key ? { key } : {}) });
  }
  if (parts[2] === "items" && parts.length >= 4) {
    if (isLocked()) return yield* json(423, { message: LOCKED });
    const id = idOf(parts[3]);
    if (parts.length === 5 && parts[4] === "values") {
      if (method !== "GET") return yield* json(405, {});
      const item = itemByID(id);
      if (!item) return yield* json(404, { message: "That item isn't in this vault." });
      const values = await valuesOf(id);
      note({ what: "shown", client, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, { values });
    }
    if (parts.length !== 4) return yield* json(404, {});
    if (method === "PATCH") {
      const item = await changeItem(id, given);
      note({ what: "changed", client, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, { item });
    }
    if (method === "DELETE") {
      const item = await removeItem(id);
      note({ what: "removed", client, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, {});
    }
    return yield* json(405, {});
  }
  return yield* json(404, { message: `There's no ${oneLine(route, 80)}.` });
}
