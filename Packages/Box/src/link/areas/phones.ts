// @ts-nocheck
// The phones paired with this box (PROTOCOL.md, "Paired phones"): listed, removed, and a link to
// pair another.

import { parsed } from "../../shared/json";
import { noteDocsChanged } from "../documents/changed";
import { IS_MAC } from "../home";
import { newPairingToken, pairingLink, removeAsMac, removePhones } from "../phones";
import { macLink, readLink, updateLink } from "../state";

// The phones paired with this machine, and removing some (a lost one, say), from any phone
// paired with it: what a removal takes off stays off (see `removePhones`).
export async function* phonesRoute(context) {
  const { phone, json } = context;
  const link = readLink();
  const asking = phone?.key?.toString("base64url");
  return yield* json(200, {
    phones: (link?.phones ?? []).map(each => ({ key: each.key, name: each.name, added: each.added ?? null, pairing: each.pairing ?? "", you: each.key === asking })),
  });
}

// Removing some, by a phone paired here, or this Mac's app.
export async function* phonesRemoveRoute(context) {
  const { request, phone, phonesChanged, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const given = parsed(request.body);
  // This Mac's app removes as the Mac does (Settings › Phone, or a removal a machine's
  // document brought).
  const asMac = IS_MAC && request.fromApp;
  // On this Mac, one before any phone's paired here (no link file yet) is kept all the same,
  // so the phone stays out once it's taken.
  const changed = updateLink(kept => {
    const link = kept ?? (asMac ? { phones: [], removed: [] } : null);
    return link && (asMac ? removeAsMac(link, given?.phones) : removePhones(link, phone?.key?.toString("base64url"), given?.phones)) ? link : null;
  });
  if (!changed) return yield* json(400, { message: "Only phones paired here can be removed, and never your Mac." });
  noteDocsChanged();
  // Once this answer is on its way: a phone that removed itself gets it too.
  setTimeout(() => phonesChanged(readLink() ?? changed), 200);
  return yield* json(200, {});
}

// A link for another phone to pair with this machine, as `kuvo-link.js pair` shows one: good
// once, for a while; a new one takes the place of the last. DELETE ends it.
export async function* pairingRoute(context) {
  const { request, json } = context;
  const method = request.method.toUpperCase();
  // This Mac's Settings › Phone has one of its own, apart from a phone's.
  const slot = IS_MAC && request.fromApp ? "appPairing" : "pairing";
  if (method === "DELETE") {
    // `?token=`: that link alone, so one closed late never ends a newer one.
    const token = new URLSearchParams(String(request.path ?? "").split("?")[1] ?? "").get("token");
    updateLink(link => {
      if (!link?.[slot] || (token && link[slot].token !== token)) return null;
      delete link[slot];
      return link;
    });
    macLink.wake?.();
    return yield* json(200, {});
  }
  if (method !== "POST") return yield* json(405, {});
  if (IS_MAC && !macLink.config?.phones) return yield* json(409, { message: "The phone link is off on this Mac." });
  const link = updateLink(current => current?.relay && current?.secret ? { ...current, [slot]: newPairingToken() } : null);
  if (!link) return yield* json(409, { message: IS_MAC ? "The phone link isn't ready yet. Try again in a moment." : "This machine has no relay to pair through." });
  macLink.wake?.();
  return yield* json(200, { link: pairingLink({ ...link, pairing: link[slot] }), ends: Math.floor(link[slot].expires / 1000) });
}
