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
import { listBots } from "../bots/list";
import { macSign, readLink } from "../state";
import type { AnswerPiece, RouteContext } from "../server/context";
import type { VaultGrant } from "../../shared/routes/vault";
import { note, readActivity } from "../vault/activity";
import { answer as answerAsk, listAsks, onAsksChanged } from "../vault/asks";
import { fill } from "../vault/fill";
import { AGENTS_LATER, agentsUseVault } from "../vault/gate";
import { askHolder, holdsVault } from "../vault/holder";
import {
  addItem, changeItem, currentUnlockKey, generationsTold, givenWho, notePrimeTrouble, isLocked, isMade, itemByID, LOCKED, makeVault, onHost, primeGenerations, readGrants, readItems,
  removeItem, setGrant, setPaused, unlockWith, valuesOf, VaultRefusal, vaultState,
} from "../vault/store";
import { callTool, VAULT_TOOLS } from "../vault/tools";
import { callerOf, callingNow, isCalling } from "../vault/who";

const NOT_OPEN = "This computer's vault isn't open: Kuvo Code's link here isn't running. Try again in a moment.";
const CLIENTS_ONLY = "Only Kuvo Code on your Mac or iPhone can do this.";
const NOT_CALLING = "Only a conversation's own tool call can use the vault, and this one isn't running in it.";
const stringOf = (value: unknown) => (typeof value === "string" ? value : undefined);
// The tool calls a fill was answered for, each once.
const filledFor = new Set<string>();
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");

// The grants as clients show them: a bot's only while it's on this computer. One deleted (or moved
// away) can't use the vault here, and its grants, kept in the vault's signed file, aren't taken out
// of it by whichever process deleted it; one moved back has them again.
function shownGrants(grants: VaultGrant[]): VaultGrant[] {
  const here = new Set(listBots().map(bot => bot.id));
  return grants.filter(grant => !grant.who.bot || here.has(grant.who.bot));
}

/** A client: its name, as activity shows it ("Mac", or a phone's name, which phones may share),
 * and who it is (`by`), which activity keeps to tell each client what it did itself. */
interface Client {
  name: string;
  by: string;
}

/** Who's asking, as a client: a phone (by its link key), this Mac's app, the Mac over SSH with the
 * unlock key (one Mac's can't be told from another's) or its own proof (by its key); null for
 * anyone else (an agent's command on this computer). */
function clientOf({ request, phone }: RouteContext): Client | null {
  if (phone?.key) {
    const key = phone.key.toString("base64url");
    return { name: readLink()?.phones?.find(each => each.key === key)?.name || "iPhone", by: `phone:${key}` };
  }
  const mac = { name: "Mac", by: "mac" };
  if (request.fromApp) return mac;
  // Proved over the vault's socket (vault/holder.ts), or with the key itself, which unlocks a locked one.
  if (request.vaultClient) return mac;
  // Or the Mac's proof for this request alone.
  const proved = provedRequest(request);
  if (proved) return { name: "Mac", by: `mac:${proved}` };
  const key = request.headers["x-kuvo-vault-key"];
  if (typeof key === "string" && unlockWith(key)) return mac;
  return null;
}

// Proofs used already, by their nonce, until they'd be too old anyway: each works once.
const PROOF_FOR = 300_000;
const usedProofs = new Map<string, number>();

/** The Mac that set this machine up (its key), when `proof` is its, asking for its vault's key: its
 * signing key's signature of `kuvo-vault-key\0<this machine's id on its Macs>\0<at>\0<nonce>`, made
 * within five minutes, and not used before; null when it isn't. */
function provedMac(given: Record<string, unknown>, tag = "kuvo-vault-key", rest = ""): string | null {
  const link = readLink();
  const mac = typeof given.mac === "string" ? given.mac : "";
  const at = Number(given.at);
  const nonce = typeof given.nonce === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(given.nonce) ? given.nonce : "";
  const sign = mac ? macSign(link, mac) : null;
  if (!sign || !nonce || !(link?.macs ?? []).includes(mac) || !Number.isFinite(at) || Math.abs(Date.now() - at) > PROOF_FOR || typeof given.proof !== "string") return null;
  const now = Date.now();
  for (const [used, until] of usedProofs) if (until < now) usedProofs.delete(used);
  if (usedProofs.has(nonce)) return null;
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(sign, "base64url")]), format: "der", type: "spki" });
    const signature = Buffer.from(given.proof, "base64url");
    const good = signature.length === 64 && typeof link?.id === "string" && crypto.verify(null, Buffer.from(`${tag}\0${link.id}\0${at}\0${nonce}${rest}`), key, signature);
    if (good) usedProofs.set(nonce, now + 2 * PROOF_FOR);
    return good ? mac : null;
  } catch {
    return null;
  }
}

/** The Mac that set this machine up (its key), when a request carries its proof for it alone
 * (`x-kuvo-vault-proof`, base64url JSON `{mac, at, nonce, proof}`): its signing key's signature of
 * `kuvo-vault-request\0<this machine's id>\0<at>\0<nonce>\0<METHOD>\0<path>\0<sha256 of the body, hex>`,
 * within five minutes, each nonce once. The Mac's unlock key never goes with such a request. */
export function provedRequest(request: RouteContext["request"]): string | null {
  const header = request.headers["x-kuvo-vault-proof"];
  if (typeof header !== "string") return null;
  let given: Record<string, unknown> = {};
  try { given = JSON.parse(Buffer.from(header, "base64url").toString("utf8")); } catch { return null; }
  const hash = crypto.createHash("sha256").update(request.body ?? Buffer.alloc(0)).digest("hex");
  return provedMac(given, `kuvo-vault-request`, `\0${request.method.toUpperCase()}\0${request.path}\0${hash}`);
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
    // This Mac's newest generations from its app before anything is read (vault/store.ts), and a
    // change answered once its app has the new ones.
    if (onHost()) await primeGenerations().catch(error => notePrimeTrouble(String((error as Error)?.message ?? error)));
    let first = true;
    for await (const piece of answerVault(context)) {
      if (first && onHost()) await generationsTold();
      first = false;
      yield piece;
    }
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
    if (method === "GET") return yield* json(200, { tools: agentsUseVault() ? VAULT_TOOLS : [] });
    if (method !== "POST") return yield* json(405, {});
    if (!agentsUseVault()) return yield* json(200, { text: AGENTS_LATER, isError: true });
    // Only a call the conversation it names is making now, with these arguments (vault/who.ts).
    const args = isObject(given.arguments) ? given.arguments : {};
    if (typeof given.name !== "string" || !await isCalling(stringOf(given.session), [given.name], args, readEngine, readBridge)) {
      return yield* json(200, { text: NOT_CALLING, isError: true });
    }
    const caller = await callerOf(given.session, readEngine, readBridge);
    return yield* json(200, await callTool(given.name, args, caller, signal));
  }
  if (route === "kuvo/vault/fill") {
    if (method !== "POST") return yield* json(405, {});
    // Its values are for the browser's own process alone: on this Mac, the app's panel browser.
    // (On a machine, the browser and anything you run there share your account: PROTOCOL.md.)
    if (onHost() && !request.fromApp) return yield* json(403, { message: CLIENTS_ONLY });
    // Until agents may use the vault here, only what Kuvo Code did before it: a sign-in you let
    // agents make on their own on this site, for browser_sign_in. Anything else asks you, as
    // without a vault.
    const open = agentsUseVault();
    if (!open && (given.purpose === "field" || (given.item !== undefined && given.item !== null && given.item !== ""))) {
      return yield* json(404, { message: AGENTS_LATER });
    }
    if (isLocked()) return yield* json(423, { message: LOCKED });
    // And one fill for each such call: what races the browser for it gets nothing more.
    const call = await callingNow(stringOf(given.session), open ? ["browser_sign_in", "browser_fill"] : ["browser_sign_in"], null, readEngine, readBridge);
    if (!call || filledFor.has(call)) return yield* json(403, { message: NOT_CALLING });
    filledFor.add(call);
    if (filledFor.size > 1000) filledFor.delete(filledFor.values().next().value!);
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
    // Its files read first: the state says what reading them found.
    const items = isLocked() ? [] : readItems();
    const grants = shownGrants(readGrants());
    return yield* json(200, { state: vaultState(), items, grants });
  }
  if (route === "kuvo/vault/pause") {
    if (method !== "POST") return yield* json(405, {});
    // A bot, or a conversation that isn't a bot's (paused by the tripwire).
    const bot = typeof given.bot === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(given.bot) ? given.bot : undefined;
    const paused = given.paused === true;
    setPaused(paused, bot);
    note({ what: paused ? "paused" : "resumed", client: client.name, by: client.by, ...(bot ? { bot } : {}) });
    return yield* json(200, vaultState());
  }
  if (route === "kuvo/vault/activity") {
    if (method !== "GET") return yield* json(405, {});
    const query = new URLSearchParams(request.path.split("?")[1] ?? "");
    const entries = readActivity({
      item: query.get("item") ?? undefined,
      bot: query.get("bot") ?? undefined,
      session: query.get("session") ?? undefined,
      before: Number(query.get("before")) || undefined,
      limit: Number(query.get("limit")) || undefined,
    });
    // Each line marked when this client did it, by who it is, not its name; who did the rest stays
    // here. A line an older box kept without who did it names no client, so none reads it as theirs.
    return yield* json(200, {
      entries: entries.map(({ by, ...entry }) => {
        if (by === client.by) return { ...entry, mine: true };
        if (by === undefined && entry.client !== undefined) {
          const { client: _, ...unclaimed } = entry;
          return unclaimed;
        }
        return entry;
      }),
    });
  }
  if (route === "kuvo/vault/grants") {
    if (method === "GET") return yield* json(200, { grants: shownGrants(readGrants()) });
    if (method !== "POST") return yield* json(405, {});
    const who = givenWho(given.who);
    if (typeof given.item !== "string" || !who) return yield* json(400, { message: "Send {\"item\", \"who\": {\"bot\"} or {\"project\"} or {\"everyone\": true}, \"how\": \"own\" | \"ask\" | null}." });
    const grants = setGrant(given.item, who, given.how ?? null);
    const item = itemByID(given.item);
    note({ what: given.how ? "granted" : "ungranted", client: client.name, by: client.by, ...(item ? { item: item.id, itemName: item.name, kind: item.kind } : {}), ...(who.bot ? { bot: who.bot } : {}), ...(typeof given.how === "string" ? { how: given.how } : {}) });
    return yield* json(200, { grants: shownGrants(grants) });
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
    return yield* json(answerAsk(idOf(parts[3]), { answer, ...(item ? { item } : {}), client: client.name, by: client.by }) ? 200 : 404, {});
  }

  // Items: a machine's needs its key in memory; one made by a client's first item gives that client the key.
  if (route === "kuvo/vault/items") {
    if (method !== "POST") return yield* json(405, {});
    let key: string | undefined;
    if (!isMade()) key = makeVault();
    if (isLocked()) return yield* json(423, { message: LOCKED });
    const item = await addItem(given);
    note({ what: "added", client: client.name, by: client.by, item: item.id, itemName: item.name, kind: item.kind });
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
      note({ what: "shown", client: client.name, by: client.by, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, { values });
    }
    // Whether what a client has is what's kept (a password you signed in with, to offer to save it
    // or not): told without giving the values, so nothing's shown and nothing's noted.
    if (parts.length === 5 && parts[4] === "same") {
      if (method !== "POST") return yield* json(405, {});
      const item = itemByID(id);
      if (!item) return yield* json(404, { message: "That item isn't in this vault." });
      const asked = isObject(given) && isObject(given.values) ? given.values : null;
      if (!asked || !Object.keys(asked).length || !Object.values(asked).every(value => typeof value === "string")) return yield* json(400, { message: "Send {\"values\": {…}}." });
      const values = await valuesOf(id);
      return yield* json(200, { same: Object.entries(asked).every(([name, value]) => typeof values?.[name] === "string" && values[name] === value) });
    }
    if (parts.length !== 4) return yield* json(404, {});
    if (method === "PATCH") {
      const item = await changeItem(id, given);
      note({ what: "changed", client: client.name, by: client.by, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, { item });
    }
    if (method === "DELETE") {
      const item = await removeItem(id);
      note({ what: "removed", client: client.name, by: client.by, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, {});
    }
    return yield* json(405, {});
  }
  return yield* json(404, { message: `There's no ${oneLine(route, 80)}.` });
}
