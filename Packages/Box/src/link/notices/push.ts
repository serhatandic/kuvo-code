// Notices to your phones on the relay (PROTOCOL.md, "Notifications"), the same from this Mac's box
// and a machine's bridge: each sealed for every phone that's said where it is and handed to the
// relay connection; and what the relay answered of each push (`pushed`), kept in
// `run/notices/pushed.json`, so a phone that hears nothing can be told from one that was sent nothing.

import path from "node:path";
import { finishUsageForPhone, usageSentTo } from "./usage-delivery";
import { isObject } from "../../shared/json";
import { textOf, writePrivate } from "../files";
import { RUN } from "../home";
import { readLink } from "../state";
import { noticeJSON, pushTo } from "./notice";
import type { LinkState, Phone } from "../state";
import type { Notice } from "./notice";

/** The relay connection a notice goes on, as far as this needs it. */
export interface PushHost {
  welcomed?: boolean;
  send: (bytes: Buffer) => boolean | void;
}

/** `notice` for each of `link`'s phones that's said where it is, sealed and handed to `host`, the
 * relay connection that's up: true once it went out to one at least, or there's no phone to send it
 * to; false when it can't go now (no connection, or one closing as it's handed over), to be tried
 * again. */
export function sendToPhones(host: PushHost | null | undefined, link: LinkState | null | undefined, notice: Notice): boolean {
  const usage = notice.category === "usage" && !!notice.data?.notice;
  const phones = (link?.phones ?? []).filter((phone): phone is Phone & { address: string } => typeof phone.address === "string" && phone.address !== "");
  const pending = usage ? phones.filter(phone => !usageSentTo(notice, phone.key)) : phones;
  if (!pending.length) return true;
  if (!host?.welcomed || !link?.key) return false;
  const json = noticeJSON(notice);
  const key = Buffer.from(link.key, "base64url");
  let sent = 0;
  for (const phone of pending) {
    // Only a connection that took it: one closing takes nothing.
    try {
      if (host.send(pushTo(phone, json, key)) === true) {
        sent += 1;
        if (usage) finishUsageForPhone(notice, phone.key);
      }
    } catch {}
  }
  return usage ? sent === pending.length : sent > 0;
}

/** How a push went, as the relay answers it (`0x06`): Apple took it, no phone is registered at that
 * address, this box isn't one the phone takes pushes from, Apple refused it, or an answer this box
 * doesn't know yet (a newer relay's). */
export type PushOutcome = "sent" | "noPhone" | "notAllowed" | "refused" | "unknown";
const OUTCOMES: readonly PushOutcome[] = ["sent", "noPhone", "notAllowed", "refused"];

/** What the relay last answered of a push to one phone: when, how it went, and when one last went
 * through (`sent`, ms since 1970), if one has. */
export interface PushAnswer {
  at: number;
  outcome: PushOutcome;
  sent?: number;
}

export const PUSHED_FILE = path.join(RUN, "notices", "pushed.json");

/** What the relay last answered for each phone, by the phone's key. */
export function readPushed(): Record<string, PushAnswer> {
  try {
    const kept = JSON.parse(textOf(PUSHED_FILE) ?? "{}");
    return isObject(kept) ? kept as Record<string, PushAnswer> : {};
  } catch {
    return {};
  }
}

/** The relay's answer to a push to the phone at `address`, kept by that phone's key (one this box
 * doesn't know is let go). */
export function notePushed(address: Buffer, status: number, now = Date.now(), link: LinkState | null = readLink()): void {
  const where = address.toString("base64url");
  const phone = (link?.phones ?? []).find(each => each.address === where);
  if (!phone) return;
  const outcome = OUTCOMES[status] ?? "unknown";
  const kept = readPushed();
  const sent = outcome === "sent" ? now : kept[phone.key]?.sent;
  // Only phones this box still has.
  const known = new Set((link?.phones ?? []).map(each => each.key));
  const next: Record<string, PushAnswer> = {};
  for (const [key, answer] of Object.entries(kept)) if (known.has(key)) next[key] = answer;
  next[phone.key] = { at: now, outcome, ...(typeof sent === "number" ? { sent } : {}) };
  try { writePrivate(PUSHED_FILE, JSON.stringify(next)); } catch {}
}
