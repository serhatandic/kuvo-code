// The host interface (PROTOCOL.md, "Host interface"): what only this Mac's app can do for its
// box, which the box asks it for where `run/host.json` says it answers: its keys, which it keeps in
// the Keychain, what its browser is signed in to, and moving what the box lets go of to the Trash.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../shared/json";
import { oneLine } from "../shared/text";
import { HOST_VAULT_SECRET, KEYS_ON_HOST, LAUNCH_HOST, OWN_HOME_MAC, RUN } from "./home";

/** A key store's trouble, said in plain words: the caller answers `503 {"message"}` with it. */
export class KeysUnavailable extends Error {}

// Where this Mac's app answers, as it writes it each time its host interface starts (`run/host.json`,
// `{"url", "password"}`, only you can read it): read again for each call, so an app whose host
// interface started again, at a new address, is reached without the box starting again. One started
// with it in its environment uses that while there's no file (`LAUNCH_HOST`, home.ts).
const HOST_FILE = path.join(RUN, "host.json");

/** Where this Mac's app answers its host calls, and its password there. `said` is what said so:
 * `run/host.json`'s text, or "launch" for the one the box was started with. */
export interface HostAddress {
  url: string;
  password: string;
  said: string;
}

/** What one of the app's host calls answers: a JSON object, whose fields its caller checks. */
export type HostAnswer = Record<string, unknown>;

export const NOT_ANSWERING = "Kuvo Code isn't answering for this Mac's keys. Try again in a moment.";

/** Where this Mac's app says it answers now, or null: none for a machine's box, nor while the app
 * isn't answering. `said` is what said so (the file's text), for the proof it gave. */
export function appHost(): HostAddress | null {
  if (!KEYS_ON_HOST) return null;
  try {
    const text = fs.readFileSync(HOST_FILE, "utf8");
    const said: { url?: unknown; password?: unknown } | null = JSON.parse(text);
    if (typeof said?.url === "string" && said.url && typeof said?.password === "string" && said.password) {
      return { url: said.url.replace(/\/+$/, ""), password: said.password, said: text };
    }
  } catch {}
  return LAUNCH_HOST && { ...LAUNCH_HOST, said: "launch" };
}

/** What the app signs for `hello`: the nonce and where it was reached (`127.0.0.1:<port>`). */
function helloProof(password: string, nonce: string, url: string): string {
  const reached = new URL(url);
  return crypto.createHmac("sha256", password).update(`kuvo-host-hello\0${nonce}\0${reached.hostname}:${reached.port || 80}`).digest("hex");
}

// What last proved it's this Mac's app (the host.json text it was found by): asked once for each;
// and with the vault's secret, for the vault's calls.
let provenBy: string | null = null;
let vaultProvenBy: string | null = null;
/** Its app's host interface started again (or failed): proved again before anything more is sent there. */
export function forgetHostProof() {
  provenBy = null;
  vaultProvenBy = null;
}

/** That it's this Mac's app at `host`, not whatever took its port after it (a host.json left by an
 * app that crashed): it signs a nonce of ours, with where we reached it, with the password (`hello`,
 * asked without the password, so nothing else can learn it there). Bound to where we reached it, a
 * proof relayed from the app at another port (by another user's process on this Mac) fails. Nothing
 * else is sent until it has. */
export async function proveHost(host: HostAddress, signal?: AbortSignal): Promise<void> {
  if (provenBy === host.said) return;
  const nonce = crypto.randomBytes(32).toString("hex");
  let proof: Buffer | null = null;
  try {
    const response = await fetch(`${host.url}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    const answer = await (response.json() as Promise<{ proof?: unknown } | null>).catch(() => null);
    if (response.ok && typeof answer?.proof === "string") proof = Buffer.from(answer.proof);
  } catch {}
  const expected = Buffer.from(helloProof(host.password, nonce, host.url));
  if (!proof || proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) throw new KeysUnavailable(NOT_ANSWERING);
  provenBy = host.said;
}


/** That it's this Mac's app at `host` that the vault's calls go to: it signs a nonce of ours, with
 * where we reached it, with the vault's secret, which only the app and this box hold (the password
 * is in a file an agent's command can read, and rewrite to send this box elsewhere). */
async function proveVaultHost(host: HostAddress): Promise<void> {
  if (!HOST_VAULT_SECRET) {
    // A Mac's box in a home of its own: only its service (`serve`) is given the vault's secret, so a
    // command of its own (`box route`) can't reach its vault.
    throw new KeysUnavailable(OWN_HOME_MAC ? "This Mac's vault can only be reached by its running box, not by a one-off command." : "Kuvo Code on this Mac didn't give its vault its secret. Quit Kuvo Code and open it again.");
  }
  if (vaultProvenBy === host.said) return;
  const nonce = crypto.randomBytes(32).toString("hex");
  let proof: Buffer | null = null;
  try {
    const response = await fetch(`${host.url}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce, vault: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const answer = await (response.json() as Promise<{ vaultProof?: unknown } | null>).catch(() => null);
    if (response.ok && typeof answer?.vaultProof === "string") proof = Buffer.from(answer.vaultProof);
  } catch {}
  const reached = new URL(host.url);
  const expected = Buffer.from(crypto.createHmac("sha256", HOST_VAULT_SECRET).update(`kuvo-host-vault\0${nonce}\0${reached.hostname}:${reached.port || 80}`).digest("hex"));
  if (!proof || proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) throw new KeysUnavailable(NOT_ANSWERING);
  vaultProvenBy = host.said;
}

/** What a vault call carries instead of the secret: its HMAC of the call, its body and when. */
const vaultAuth = (call: string, body: string, at: number) =>
  crypto.createHmac("sha256", HOST_VAULT_SECRET ?? "").update(`kuvo-host-vault-call\0${call}\0${crypto.createHash("sha256").update(body).digest("hex")}\0${at}`).digest("hex");

/** What this Mac's box let go of (in its trash), moved on by its app to the Finder's Trash (`trash`);
 * nothing without its app. */
export async function hostTrash(folder: string): Promise<void> {
  const host = appHost();
  if (!host) return;
  await proveHost(host);
  const response = await fetch(`${host.url}/trash`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
    body: JSON.stringify({ path: folder }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel().catch(() => {});
}

/** One of the app's host calls (`keys/names`, `sites/signed-in`…): its answer's JSON, or null for a 404 when `missing` is fine. */
export function askHost(host: HostAddress, call: string, body: unknown, missing?: false): Promise<HostAnswer>;
export function askHost(host: HostAddress, call: string, body: unknown, missing: boolean): Promise<HostAnswer | null>;
export async function askHost(host: HostAddress, call: string, body: unknown, missing = false): Promise<HostAnswer | null> {
  await proveHost(host);
  const sent = JSON.stringify(body);
  // The vault's calls only to the app proved with the vault's secret, each with its own proof.
  const vault = call.startsWith("vault/");
  if (vault) await proveVaultHost(host);
  const at = Date.now();
  let response;
  try {
    response = await fetch(`${host.url}/${call}`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json", ...(vault ? { "x-kuvo-vault-auth": vaultAuth(call, sent, at), "x-kuvo-vault-at": String(at) } : {}) },
      body: sent,
      // Reading or saving one can wait on you (a Keychain prompt on this Mac): two minutes for those.
      signal: AbortSignal.timeout(["keys/get", "keys/set", "link/identity", "vault/get", "vault/set"].includes(call) ? 120_000 : 15_000),
    });
  } catch {
    // Gone from there: proved again before anything more is sent there.
    provenBy = null;
    vaultProvenBy = null;
    throw new KeysUnavailable(NOT_ANSWERING);
  }
  if (missing && response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  let answer: HostAnswer | null = null;
  try { answer = await response.json() as HostAnswer | null; } catch {}
  if (response.status < 200 || response.status > 299) {
    const said = typeof answer?.message === "string" && answer.message.trim() ? ` ${oneLine(answer.message, 300)}` : "";
    throw new KeysUnavailable(`This Mac's keys couldn't be reached (${response.status}).${said}`);
  }
  return answer ?? {};
}


/** Whether this Mac's browser is signed in to the sites the agent uses there, by integration, as its
 * app reads their cookies; null where that can't be told (a machine's box, or its app not answering). */
export async function siteSignIns(): Promise<Record<string, unknown> | null> {
  const host = appHost();
  if (!host) return null;
  try {
    const answer = await askHost(host, "sites/signed-in", {});
    return isObject(answer?.sites) ? answer.sites : null;
  } catch {
    return null;
  }
}

// One of the app's host calls for the link, its JSON, once the app has proved it's this Mac's
// (`askHost`); null when it isn't there or doesn't answer it.
export async function linkHost(call: string, body?: unknown): Promise<HostAnswer | null> {
  const host = appHost();
  if (!host) return null;
  try {
    return await askHost(host, call, body ?? {});
  } catch {
    return null;
  }
}
