// The phones paired with this box (PROTOCOL.md, "Paired phones"): listed, removed, and a link to
// pair another.

import { parsed } from "../../shared/json";
import type { Body } from "../../shared/json";
import type { PAIRING } from "../../shared/routes/box";
import type { Infer } from "../../shared/shape";
import { noteDocsChanged } from "../documents/changed";
import { IS_MAC } from "../home";
import { newPairingToken, pairingLink, removeAsMac, removePhones } from "../phones";
import { mainElsewhere, pairElsewhere } from "../setup/main-only";
import type { AnswerPiece, RouteContext } from "../server/context";
import { macLink, readLink, updateLink } from "../state";
import type { LinkState, Pairing } from "../state";

// The phones paired with this machine, and removing some (a lost one, say), from any phone
// paired with it: what a removal takes off stays off (see `removePhones`).
export async function* phonesRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { phone, json } = context;
  const link = readLink();
  const asking = phone?.key?.toString("base64url");
  // TODO(types): not held to `Phones` (shared/routes/box.ts): a phone kept here may have no name
  // (`Phone.name` is optional in state.ts), which the shape's `name: string` doesn't allow.
  return yield* json(200, {
    phones: (link?.phones ?? []).map(each => ({ key: each.key, name: each.name, added: each.added ?? null, pairing: each.pairing ?? "", you: each.key === asking })),
  });
}

// Removing some, by a phone paired here, or this Mac's app.
export async function* phonesRemoveRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, phone, phonesChanged, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const given = parsed(request.body) as Body<"phones">;
  // This Mac's app removes as the Mac does (Settings › Phone, or a removal a machine's
  // document brought).
  const asMac = IS_MAC && request.fromApp;
  // On this Mac, one before any phone's paired here (no link file yet) is kept all the same,
  // so the phone stays out once it's taken.
  const changed = updateLink(kept => {
    const link: LinkState | null = kept ?? (asMac ? { phones: [], removed: [] } : null);
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
export async function* pairingRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
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
  // Only your setup's main computer pairs phones: a member names it (PROTOCOL.md, "Your setup").
  const main = mainElsewhere(readLink());
  if (main) return yield* json(409, pairElsewhere(main));
  if (IS_MAC && !macLink.config?.phones) return yield* json(409, { message: "The phone link is off on this Mac." });
  const link = updateLink(current => current?.relay && current?.secret ? { ...current, [slot]: newPairingToken() } : null);
  if (!link) return yield* json(409, { message: IS_MAC ? "The phone link isn't ready yet. Try again in a moment." : "This machine has no relay to pair through." });
  macLink.wake?.();
  // (A box with a relay to pair through has its keys and name too.)
  return yield* json(200, { link: pairingLink({ ...link, pairing: link[slot] } as LinkState & { relay: string; secret: string; key: string; name: string; pairing: Pairing }), ends: Math.floor(link[slot]!.expires / 1000) } satisfies Infer<typeof PAIRING>);
}
