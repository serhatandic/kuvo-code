// Bridge-decided quota facts, delivered through the same native/push path as a run's news.
import { currentNotice, noticeAccountName, takeNotices } from "../../agents/usage/notices";
import { keepTold } from "./told";
import type { NoticeHold } from "./hold";
import type { Notice } from "./notice";

import { usageDelivered } from "./usage-delivery";
const wording = {
  underTenPercent: ["Almost Out", "Under 10% usage remaining for this window."],
  healthyToClose: ["Cutting It Close", "Projected to finish close to your limit."],
  closeToRunningOut: ["Will Run Out", "Projected to finish before the limit resets."],
};

/** The selected holder alone pushes; other own computers keep the identical ID for their Mac's delivery. */
export function usageNotices(data: Record<string, unknown>, tell: (notice: Notice) => unknown): void {
  for (const fact of takeNotices(data.notices)) {
    if (!currentNotice(fact, Date.now())) continue;
    const [title, body] = wording[fact.milestone];
    const notice: Notice = { category: "usage", title, subtitle: `${fact.accountName ?? noticeAccountName(fact.service)} ${fact.windowName ?? "Limit"}`, body, thread: `usage:${fact.row}`, data: { notice: fact.id, row: fact.row, at: String(fact.at), ...(fact.resetsAt !== undefined ? { expires: String(fact.resetsAt) } : {}) } };
    // Keep stable native delivery facts first, independently of whether a phone is reachable.
    keepTold(notice, { at: fact.at });
    // Queue acceptance is not successful phone delivery. The hold journals only after sending;
    // a minute's catch-up retries an unconsumed fact while its short replay window is current.
    if (data.push === true && !usageDelivered(notice)) tell(notice);
  }
}

/** Both event and reconnect snapshots reconcile queued copies before any can be retried. */
export function usageSnapshot(data: Record<string, unknown>, tell: (notice: Notice) => unknown, hold?: Pick<NoticeHold, "reconcileUsage"> | null): void {
  const all = takeNotices(data.notices), eligible = takeNotices(data.ownNotices);
  hold?.reconcileUsage(eligible.map(n => n.id), all.map(n => n.id));
  usageNotices({ notices: eligible, push: true }, tell);
  usageNotices({ notices: all, push: false }, tell);
}
