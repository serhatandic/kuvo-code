// Whether you're at a computer (PROTOCOL.md, "kuvo/attention"): notices for your phones wait a
// little while you are. And, on a Mac, its app's own notices for them.

import { isObject, parsed } from "../../shared/json";
import type { Body } from "../../shared/json";
import { IS_MAC } from "../home";
import { macTell } from "../mac/notices";
import { macAttendPeers } from "../mac/peers";
import { attentionGiven } from "../notices/hold";
import type { ATTENTION } from "../../shared/routes/box";
import type { Infer } from "../../shared/shape";
import type { Notice } from "../notices/notice";
import type { AnswerPiece, RouteContext } from "../server/context";

// On this Mac, what only its app knows for your phones (an ask from its panel's browser), held
// with the box's own; and one answered there, which then never goes. Its app's alone.
export async function* appNoticeRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, hold, json } = context;
  if (!IS_MAC || !request.fromApp || !hold) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const given = parsed(request.body) as Body<"id" | "notice">;
  if (route === "kuvo/attention/answered") {
    if (typeof given?.id !== "string") return yield* json(400, { message: "Send {id}." });
    hold.resolve(given.id);
    return yield* json(200, {});
  }
  if (!isObject(given?.notice) || typeof given.notice.title !== "string") return yield* json(400, { message: "Send {notice}." });
  // TODO(types): only its title is checked; its category, words and data reach the phones as this
  // Mac's app sent them (holding it to `Notice` would take a check here).
  macTell(given.notice as unknown as Notice);
  return yield* json(200, {});
}

// A client in use here (PROTOCOL.md, "kuvo/attention"): notices for your phones wait a little
// while one is. GET says whether one is, and how many wait.
export async function* attentionRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, phone, hold, json } = context;
  const method = request.method.toUpperCase();
  if (!hold) return yield* json(503, { message: "Only this machine's bridge holds its notices." });
  if (method === "GET" || method === "HEAD") return yield* json(200, { inUse: hold.inUse, held: hold.count } satisfies Infer<typeof ATTENTION>);
  if (method !== "POST") return yield* json(405, {});
  const given = attentionGiven(parsed(request.body));
  if (!given) return yield* json(400, { message: "Say for how many seconds you're in use (for: 0 for not), and which conversations are on your screen (sessions)." });
  // This Mac's app is "mac", as a Mac's word by mail is to a machine; and your machines hear it.
  hold.attend(IS_MAC && request.fromApp ? "mac" : `phone:${phone?.key?.toString("base64url") ?? ""}`, given);
  if (IS_MAC && request.fromApp) macAttendPeers(parsed(request.body) as Body<"elsewhere">, given);
  return yield* json(200, { for: given.seconds } satisfies { for: number });
}
