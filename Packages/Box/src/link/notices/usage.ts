// Bridge-decided quota facts, delivered through the same native/push path as a run's news.
import path from "node:path";
import { takeNotices } from "../../agents/usage/notices";
import { locked, textOf, writePrivate } from "../files";
import { RUN } from "../home";
import { keepTold } from "./told";
import type { Notice } from "./notice";

const file = path.join(RUN, "notices", "usage-delivered.json");
const wording = {
  underTenPercent: ["Almost Out", "Under 10% usage remaining for this window."],
  healthyToClose: ["Cutting It Close", "Projected to finish close to your limit."],
  closeToRunningOut: ["Will Run Out", "Projected to finish before the limit resets."],
};

/** The selected holder alone pushes; other own computers keep the identical ID for their Mac's delivery. */
export function usageNotices(data: Record<string, unknown>, tell: (notice: Notice) => unknown): void {
  for (const fact of takeNotices(data.notices)) {
    if (Date.now() - fact.at > 24 * 60 * 60_000) continue;
    const [title, body] = wording[fact.milestone];
    const notice: Notice = { category: "usage", title, subtitle: `${fact.service} ${fact.window}`, body, thread: `usage:${fact.row}`, data: { notice: fact.id, row: fact.row } };
    // Keep stable native delivery facts first, independently of whether a phone is reachable.
    keepTold(notice);
    if (data.push !== true) continue;
    let fresh = false;
    try {
      locked(file + ".lock", () => {
        let ids: Record<string, number> = {};
        try { ids = JSON.parse(textOf(file) ?? "{}"); } catch {}
        if (fact.id in ids) return;
        ids = Object.fromEntries(Object.entries(ids).filter(([, at]) => Date.now() - at < 24 * 60 * 60_000));
        // The transport/hold returns false if it could neither send nor durably retain this.
        if (tell(notice) === false) return;
        ids[fact.id] = Date.now();
        writePrivate(file, JSON.stringify(ids));
        fresh = true;
      });
    } catch {}
    if (!fresh) continue;

  }
}
