// What this Mac's app asks of a Mac's box in a home of its own for the keys the box holds (#333
// piece 6a; PROTOCOL.md, "This Mac's app", "Its keys"): once the box has moved, its keys are its
// helper's copies in your Keychain, which the app can't read and must never make anew, so the box
// does with them what the app did. Only for Kuvo Code on this Mac (`fromApp`, its box's server's
// password): never a phone, nor an agent's command (`box route` is anyone's on this computer).
//
// - `kuvo/box/proof` (`POST`): this Mac's proof for one of your machines, signed with its link's
//   signing key, as a machine's vault takes one (vault.ts, `provedMac`): `{machine}` for its vault's
//   key, `{machine, method, path, hash}` for one request. `{mac, at, nonce, proof}`.
// - `kuvo/box/kept-keys?bot=<id>`: a machine's bot's own keys an earlier Kuvo Code kept in this
//   Mac's Keychain, for the app to give the machine (for released Macs: `keptKeysRoute`'s marker):
//   `GET` them (`{keys: {<variable>: <value>}}`), `DELETE` those it has (`{names}`). Only a bot that
//   isn't this box's own: this box's bots' keys are theirs (`kuvo/bots/<id>/keys`).

import crypto from "node:crypto";
import { isObject, parsed } from "../../shared/json";
import { signWith } from "../documents/format";
import { botHere } from "../bots/here";
import { OWN_HOME_MAC } from "../home";
import { KeysUnavailable, linkHost } from "../host-interface";
import { botVariable, deleteKey, keyNames, keyWork, readKey } from "../keys";
import { ownKey } from "../peers/known";
import { readLink } from "../state";
import type { AnswerPiece, RouteContext } from "../server/context";

const ONLY_APP = "Only Kuvo Code on this Mac can ask for that.";
const ONLY_OWN_HOME = "Only a Mac's box in a home of its own does this for its app.";
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
/** A machine's id as its Macs name it (`link.json`'s `id`), with nothing that could run into the next part. */
const MACHINE = /^[^\0]{1,300}$/;

/** This Mac's link key (its private half) and signing key, as the box has them: from its link once
 * it's on, else asked of its host (the helper, from your Keychain), never made here. Null when its
 * host can't give them now. */
async function macIdentity(): Promise<{ key: string; sign: string } | null> {
  const link = readLink();
  if (typeof link?.key === "string" && typeof link.sign === "string" && KEY_TEXT.test(link.key) && KEY_TEXT.test(link.sign)) return { key: link.key, sign: link.sign };
  const given = await linkHost("link/identity", {});
  if (!given || ![given.key, given.sign].every(value => typeof value === "string" && KEY_TEXT.test(value))) return null;
  return { key: given.key as string, sign: given.sign as string };
}

/** What a request proof covers, as given: its method, its path and its body's SHA-256 (hex); null for
 * a proof of the vault's key, undefined for what isn't either. */
function requestOf(given: Record<string, unknown>): { method: string; path: string; hash: string } | null | undefined {
  if (given.method === undefined && given.path === undefined && given.hash === undefined) return null;
  const { method, path, hash } = given;
  if (typeof method !== "string" || !/^[A-Za-z]{1,10}$/.test(method) || typeof path !== "string" || !/^[^\0]{1,4000}$/.test(path)
    || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return undefined;
  return { method: method.toUpperCase(), path, hash };
}

/** `kuvo/box/proof`: this Mac's proof for one of your machines (`{machine}`, or with `method`, `path`
 * and `hash` for one request), signed by this box with the Mac's signing key: `{mac, at, nonce, proof}`. */
export async function* proofRoute({ request, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  if (!request.fromApp) return yield* json(403, { message: ONLY_APP });
  if (!OWN_HOME_MAC) return yield* json(409, { message: ONLY_OWN_HOME });
  const given = parsed(request.body);
  const asked = isObject(given) ? requestOf(given) : undefined;
  if (!isObject(given) || typeof given.machine !== "string" || !MACHINE.test(given.machine) || asked === undefined) {
    return yield* json(400, { message: "Say which machine (machine), and for one request its method, path and body's SHA-256 (hash)." });
  }
  const identity = await macIdentity();
  const mac = identity && ownKey({ key: identity.key });
  if (!identity || !mac) return yield* json(503, { message: "This Mac's link keys can't be read from your Keychain now. Try again in a moment." });
  const at = Date.now();
  // Once only: a machine takes each nonce once.
  const nonce = crypto.randomBytes(18).toString("base64url");
  const signed = asked
    ? `kuvo-vault-request\0${given.machine}\0${at}\0${nonce}\0${asked.method}\0${asked.path}\0${asked.hash}`
    : `kuvo-vault-key\0${given.machine}\0${at}\0${nonce}`;
  return yield* json(200, { mac, at, nonce, proof: signWith(identity.sign, Buffer.from(signed)) });
}

// COMPAT(0.7 bot-keys-keychain): a machine's bots' keys this Mac's Keychain kept, handed to their machines. Goes 3 months after 0.8.0.
/** `kuvo/box/kept-keys?bot=<id>`: the keys of its own an earlier Kuvo Code kept here for a bot on one
 * of your machines (`GET`), and those taken away once the machine has them (`DELETE {names}`). */
export async function* keptKeysRoute({ request, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "DELETE") return yield* json(405, {});
  if (!request.fromApp) return yield* json(403, { message: ONLY_APP });
  if (!OWN_HOME_MAC) return yield* json(409, { message: ONLY_OWN_HOME });
  const bot = new URLSearchParams(request.path.split("?")[1] ?? "").get("bot") ?? "";
  if (!/^bot_[A-Za-z0-9]{1,60}$/.test(bot)) return yield* json(400, { message: "Say which bot (?bot=…)." });
  if (botHere(bot)) return yield* json(409, { message: "That bot is this box's own: its keys are at kuvo/bots/<id>/keys." });
  const suffix = botVariable("", bot);
  try {
    const names = await keyNames({ suffix });
    if (method === "GET") {
      const keys: Record<string, string> = {};
      for (const name of names) {
        const value = await readKey(name);
        if (value != null) keys[name] = value;
      }
      return yield* json(200, { keys });
    }
    const given = parsed(request.body);
    const asked = isObject(given) && Array.isArray(given.names) ? given.names : null;
    if (!asked || !asked.every(name => typeof name === "string" && names.includes(name))) return yield* json(400, { message: "Say which of its keys (names), as GET lists them." });
    await keyWork(async () => { for (const name of asked as string[]) await deleteKey(name); });
    return yield* json(200, {});
  } catch (error) {
    if (error instanceof KeysUnavailable) return yield* json(503, { message: error.message });
    throw error;
  }
}
