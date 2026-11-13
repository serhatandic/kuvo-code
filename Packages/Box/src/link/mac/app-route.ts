// What a phone asks of the Mac's own routes, passed to the app through its host (`link/route`).

import { EMPTY } from "../crypto/keys";
import { forgetHostProof, openAppHost, proveHost } from "../host-interface";
import type { AnswerPiece, Asker, LinkRequest } from "../server/context";

/** The app's own answer to `request`, as it comes; null when the app isn't there to answer (gone,
 * starting again, closed with the keeper left to say so, or an older one): only an answer of its own
 * says it's its own (`x-kuvo-answer`), whatever its status. */
export async function appAnswer(request: LinkRequest, phone: Asker | undefined, signal?: AbortSignal): Promise<Response | null> {
  // (A Mac's box in a home of its own: the open app's own host, as it registered, `openAppHost`.)
  const host = openAppHost();
  if (!host) return null;
  let response: Response;
  try {
    // Nothing goes until it's proved it's this Mac's app: once for each host.json, which is
    // enough because this box (`serve`) ends with its app (its stdin closes), so no other
    // process can take the app's port while this box still trusts it, without the file changing;
    // for each request where it's the open app's own host (a Mac's box in a home of its own,
    // which outlives the app: `proveHost`).
    await proveHost(host, signal);
    response = await fetch(`${host.url}/link/route`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
      body: JSON.stringify({
        method: request.method,
        path: request.path,
        headers: request.headers ?? {},
        body: Buffer.from(request.body ?? EMPTY).toString("base64"),
        phone: phone?.key?.toString("base64url") ?? null,
      }),
      signal,
    });
  } catch {
    // Gone from there (or not proved): proved again before anything more is sent there.
    if (!signal?.aborted) forgetHostProof();
    return null;
  }
  if (response.headers.get("x-kuvo-answer") === "1") return response;
  await response.body?.cancel().catch(() => {});
  return null;
}

/** The app's answer passed on as it comes. One cut off as it came (the app gone halfway) ends as cut
 * off, not as a whole answer. */
export async function* passedOn(response: Response, signal?: AbortSignal): AsyncGenerator<AnswerPiece> {
  const headers: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/json" };
  const cache = response.headers.get("cache-control");
  if (cache) headers["cache-control"] = cache;
  yield { head: { status: response.status, headers } };
  if (!response.body) return;
  for await (const chunk of response.body) {
    if (signal?.aborted) break;
    yield { body: Buffer.from(chunk) };
  }
}
