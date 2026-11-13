// A notice for your phones (PROTOCOL.md, "Notifications"): its payload, masked and cut to fit a push,
// and the relay's push of it, sealed for one phone.

import { sortedJSON } from "../../shared/json";
import { cut, prefixBytes } from "../../shared/text";
import { sealOneWay } from "../crypto/noise";
import { Frame, frame, relayPush } from "../relay/frames";
import { masked } from "./mask";

/** What a notice is about (PROTOCOL.md, "Notifications"), for its buttons: what's asked of you, or news. */
export type NoticeCategory = "permission" | "question" | "ask" | "finished" | "failed" | "report" | "blocked" | "message" | "usage";

/** Where a notice opens (`session` or `group`), and what answering takes it back (`request`, `ask`). */
export interface NoticeData {
  notice?: string;
  row?: string;
  session?: string;
  group?: string;
  request?: string;
  /** The session asking, when it isn't the one shown (a subagent's). */
  requestSession?: string;
  /** "0": its notification mustn't answer it from buttons. */
  answerable?: "0";
  /** "0": a permission's Always would save more than its notification shows, so a phone that
   * can't name what it saves has no Always there. */
  always?: "0";
  /** A permission's Always as its button says what it saves: "Always Allow git push". */
  alwaysTitle?: string;
  ask?: string;
  /** What an agent asks of the vault (`kuvo/vault/asks`). */
  vaultAsk?: string;
  /** A command an agent wants to run outside the sandbox (`kuvo/sandbox/asks`). */
  sandboxAsk?: string;
  /** "1": shown quietly (what a goal needs of you, its digest): in the list, never lighting the
   * screen or making a sound. */
  quiet?: "1";
  /** "1": what a goal needs of you, where you asked to be woken (shown, with its sound, not quietly). */
  wake?: "1";
}

/** A notice for your phones, as the box words it, before it's masked and cut. */
export interface Notice {
  title?: string;
  subtitle?: string;
  body?: string;
  category: NoticeCategory;
  thread?: string;
  data?: NoticeData;
}

/** A notification's payload, as a phone gets it. */
export interface NoticePayload {
  t: "notify";
  title: string;
  subtitle?: string;
  body?: string;
  category: NoticeCategory;
  thread: string;
  data: NoticeData;
}

// The bridge tells your phones what happens in this machine's sessions, Mac connected or not: a
// permission or a question asked, a run finished or failed, a bot's news (PROTOCOL.md,
// "Notifications"). A Mac never tells them a machine's news, so each comes once, from here.
export const NOTICE_LIMIT = 2500;


// A notification's JSON, under NOTICE_LIMIT bytes: what doesn't fit of the body ends in "…".
export function noticeJSON(notice: Notice): Buffer {
  // What it shows masked, as the Mac's own notifications are: a phone's lock screen never shows
  // a key.
  const value: NoticePayload = { t: "notify", title: cut(masked(String(notice.title ?? "")), 200), category: notice.category, thread: String(notice.thread ?? ""), data: notice.data ?? {} };
  if (notice.subtitle) value.subtitle = cut(masked(String(notice.subtitle)), 200);
  let body = masked(String(notice.body ?? ""));
  while (true) {
    const json = Buffer.from(sortedJSON({ ...value, body }));
    if (json.length <= NOTICE_LIMIT || !body) return json;
    const room = Buffer.byteLength(body) - (json.length - NOTICE_LIMIT) - Buffer.byteLength("…");
    body = room <= 0 ? "" : prefixBytes(body, room).trimEnd() + "…";
  }
}

// The relay's push of `json` to a phone ({key, address}, base64url), sealed for it alone.
export function pushTo(phone: { key: string; address: string }, json: Buffer, hostKey: Buffer): Buffer {
  const mail = frame(Frame.mail, 0, sealOneWay(json, hostKey, Buffer.from(phone.key, "base64url")).message);
  return relayPush(Buffer.from(phone.address, "base64url"), mail);
}
