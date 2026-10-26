// @ts-nocheck
// Forwarding to the engine
// What isn't the box's own goes on to the engine, or to the coding agents' bridge (`kuvo/agents/…`),
// a phone's prompts with who they name told, and that they're from a phone.

import { engineDown } from "../areas/engine";
import { holdArchived } from "../areas/wakes";
import { namedIn } from "./naming";
import { canonicalPath, REQUEST_HEADERS, RESPONSE_HEADERS } from "./paths";

export const AGENTS = "kuvo/agents/";

// The block a prompt from a phone ends with, for the agent, in the Mac's words (FromPhone.swift):
// the user is on their iPhone, where a file is shown with show_file. Never shown.
export const FROM_PHONE = ["<from-phone>", "The user sent this from Kuvo Code on their iPhone.", "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it. A widget (show_widget) shows there too: keep it narrow, and make it work with taps rather than hovering.", "</from-phone>"].join("\n");

// A prompt's body with the block at the end of its text, once; any other body as it is.
export function fromPhone(body) {
  let prompt;
  try {
    prompt = JSON.parse(Buffer.from(body ?? "").toString());
  } catch {
    return body;
  }
  if (typeof prompt?.text !== "string" || prompt.text.trimEnd().endsWith("</from-phone>")) return body;
  return Buffer.from(JSON.stringify({ ...prompt, text: `${prompt.text}\n\n${FROM_PHONE}` }));
}

// Passes `path` to the engine or the agents' bridge on this machine, with its password, and
// streams back what it answers. What's sent is the path as `canonicalPath` writes it, which is
// what `allows` checks.
export async function* forward(target, path, request, signal, allows, naming = null, down = engineDown) {
  const method = request.method.toUpperCase();
  const sent = canonicalPath(path);
  if (sent === null || !allows(sent, method)) {
    yield { head: { status: 403, headers: { "content-type": "text/plain" } } };
    yield { body: Buffer.from("That isn't available over the link.") };
    return;
  }
  const url = new URL(`http://127.0.0.1:${target.port}/${sent}`);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const given = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of REQUEST_HEADERS) if (given[name]) headers[name] = given[name];
  // A message the phone sends: who it names with "&" (`naming`), and that it's from the phone, go
  // with it.
  const prompt = method === "POST" && /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
  // A session's metadata changed: whether it was archived before, as the engine has it (null when
  // it can't say). A phone sends all of it with any change (a pin, say), the flag as it was too.
  const changed = method === "PATCH" && /^\/api\/session\/([^/]+)$/.exec(url.pathname);
  let wasArchived = null;
  if (changed) {
    try {
      const before = await fetch(url, { headers, signal });
      if (before.ok) wasArchived = (await before.json())?.data?.metadata?.["kuvo.archived"] === true;
    } catch {}
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : prompt ? fromPhone(await namedIn(request.body, decodeURIComponent(prompt[1]), naming)) : request.body,
      signal,
    });
  } catch (error) {
    // Not answering (starting again, say): said so, unless the asker went.
    if (signal?.aborted) throw error;
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: down() })) };
    return;
  }
  const out = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) out[name] = value;
  }
  // Archived or brought back (`kuvo.archived` in its metadata), here with the Mac closed too: its
  // wake-ups wait, or come back, as a Mac's Archive has it. Only when that changed.
  if (changed && response.ok) {
    let archived;
    try { archived = JSON.parse(Buffer.from(request.body ?? []).toString("utf8"))?.metadata?.["kuvo.archived"]; } catch {}
    if (typeof archived === "boolean" && archived !== wasArchived) try { holdArchived(decodeURIComponent(changed[1]), archived); } catch {}
  }
  yield { head: { status: response.status, headers: out } };
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield { body: Buffer.from(value) };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}