// @ts-nocheck
// The host interface (PROTOCOL.md, "Host interface"): what only this Mac's app can do for its
// box, which the box asks it for where `run/host.json` says it answers: its keys, which it keeps in
// the Keychain, what its browser is signed in to, and moving what the box lets go of to the Trash.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../shared/json";
import { oneLine } from "../shared/text";
import { RUN } from "./home";

/** The only names the box ever asks for. */
export const STORED_KEY = /^KUVO_KEY_[A-Z0-9_]+$/;

/** A key store's trouble, said in plain words: the caller answers `503 {"message"}` with it. */
export class KeysUnavailable extends Error {}

// Where this Mac's app answers, as it writes it each time its host interface starts (`run/host.json`,
// `{"url", "password"}`, only you can read it): read again for each call, so an app whose host
// interface started again, at a new address, is reached without the box starting again. One started
// with it in its environment (`KUVO_HOST_URL`, `KUVO_HOST_PASSWORD`) uses that while there's no file,
// its password out of its environment at once, so nothing it runs (git, kuvo-wake) has it.
const HOST_FILE = path.join(RUN, "host.json");
const LAUNCH_HOST = process.env.KUVO_HOST_URL && process.env.KUVO_HOST_PASSWORD
  ? { url: process.env.KUVO_HOST_URL.replace(/\/+$/, ""), password: process.env.KUVO_HOST_PASSWORD } : null;
// A box whose keys its app keeps (this Mac's, KUVO_KEYS_ON_HOST), without a way to reach it: its
// keys can't be reached, rather than kept in files of its own instead of your Keychain.
export const KEYS_ON_HOST = process.env.KUVO_KEYS_ON_HOST === "1" || Boolean(process.env.KUVO_HOST_URL);
delete process.env.KUVO_HOST_PASSWORD;

export const NOT_ANSWERING = "Kuvo Code isn't answering for this Mac's keys. Try again in a moment.";

/** Where this Mac's app says it answers now, or null: none for a machine's box, nor while the app
 * isn't answering. `said` is what said so (the file's text), for the proof it gave. */
export function appHost() {
  if (!KEYS_ON_HOST) return null;
  try {
    const text = fs.readFileSync(HOST_FILE, "utf8");
    const said = JSON.parse(text);
    if (typeof said?.url === "string" && said.url && typeof said?.password === "string" && said.password) {
      return { url: said.url.replace(/\/+$/, ""), password: said.password, said: text };
    }
  } catch {}
  return LAUNCH_HOST && { ...LAUNCH_HOST, said: "launch" };
}

/** What the app signs for `hello`: the nonce and where it was reached (`127.0.0.1:<port>`). */
function helloProof(password, nonce, url) {
  const reached = new URL(url);
  return crypto.createHmac("sha256", password).update(`kuvo-host-hello\0${nonce}\0${reached.hostname}:${reached.port || 80}`).digest("hex");
}

// What last proved it's this Mac's app (the host.json text it was found by): asked once for each.
let provenBy = null;
/** Its app's host interface started again (or failed): proved again before anything more is sent there. */
export function forgetHostProof() {
  provenBy = null;
}

/** That it's this Mac's app at `host`, not whatever took its port after it (a host.json left by an
 * app that crashed): it signs a nonce of ours, with where we reached it, with the password (`hello`,
 * asked without the password, so nothing else can learn it there). Bound to where we reached it, a
 * proof relayed from the app at another port (by another user's process on this Mac) fails. Nothing
 * else is sent until it has. */
export async function proveHost(host) {
  if (provenBy === host.said) return;
  const nonce = crypto.randomBytes(32).toString("hex");
  let proof = null;
  try {
    const response = await fetch(`${host.url}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(15_000),
    });
    const answer = await response.json().catch(() => null);
    if (response.ok && typeof answer?.proof === "string") proof = Buffer.from(answer.proof);
  } catch {}
  const expected = Buffer.from(helloProof(host.password, nonce, host.url));
  if (!proof || proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) throw new KeysUnavailable(NOT_ANSWERING);
  provenBy = host.said;
}


/** What this Mac's box let go of (in its trash), moved on by its app to the Finder's Trash (`trash`);
 * nothing without its app. */
export async function hostTrash(folder) {
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
export async function askHost(host, call, body, missing = false) {
  await proveHost(host);
  let response;
  try {
    response = await fetch(`${host.url}/${call}`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      // Reading or saving one can wait on you (a Keychain prompt on this Mac): two minutes for those.
      signal: AbortSignal.timeout(["keys/get", "keys/set", "link/identity"].includes(call) ? 120_000 : 15_000),
    });
  } catch {
    // Gone from there: proved again before anything more is sent there.
    provenBy = null;
    throw new KeysUnavailable(NOT_ANSWERING);
  }
  if (missing && response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  let answer = null;
  try { answer = await response.json(); } catch {}
  if (response.status < 200 || response.status > 299) {
    const said = typeof answer?.message === "string" && answer.message.trim() ? ` ${oneLine(answer.message, 300)}` : "";
    throw new KeysUnavailable(`This Mac's keys couldn't be reached (${response.status}).${said}`);
  }
  return answer ?? {};
}


/** Whether this Mac's browser is signed in to the sites the agent uses there, by integration, as its
 * app reads their cookies; null where that can't be told (a machine's box, or its app not answering). */
export async function siteSignIns() {
  const host = appHost();
  if (!host) return null;
  try {
    const answer = await askHost(host, "sites/signed-in", {});
    return isObject(answer?.sites) ? answer.sites : null;
  } catch {
    return null;
  }
}
