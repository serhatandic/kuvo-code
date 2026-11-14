// Successful (or deliberately silenced) phone delivery, separate from native notice retention.
import path from "node:path";
import { locked, textOf, writePrivate } from "../files";
import { RUN } from "../home";
import type { Notice } from "./notice";

const keptFor = 24 * 60 * 60_000;

/** A failed disk write must neither crash a timer nor resend a push this process already sent.
 * Dirty marks stay in memory and are retried on the next read/change. */
export class UsageDeliveryJournal {
  private dirty: Record<string, number> = {};
  constructor(private file: string) {}
  private read(): Record<string, number> {
    try {
      const value = JSON.parse(textOf(this.file) ?? "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, number] => typeof pair[1] === "number" && Number.isFinite(pair[1])));
    } catch { return {}; }
  }
  private flush(): void {
    if (!Object.keys(this.dirty).length) return;
    try {
      locked(this.file + ".lock", () => {
        const ids = { ...this.read(), ...this.dirty };
        writePrivate(this.file, JSON.stringify(Object.fromEntries(Object.entries(ids).filter(([, at]) => Date.now() - at < keptFor))));
        this.dirty = {};
      });
    } catch {}
  }
  has(key: string): boolean {
    const marked = key in this.dirty || key in this.read();
    this.flush();
    return marked;
  }
  mark(key: string): void {
    this.dirty[key] = Date.now();
    this.flush();
  }
}
const journal = new UsageDeliveryJournal(path.join(RUN, "notices", "usage-delivered.json"));
const id = (notice: Notice) => notice.category === "usage" ? notice.data?.notice : undefined;
export const usageDelivered = (notice: Notice): boolean => { const key = id(notice); return !!key && journal.has(key); };
export const usageSentTo = (notice: Notice, phone: string): boolean => { const key = id(notice); return !!key && journal.has(`${key}/phone/${phone}`); };
export const finishUsageForPhone = (notice: Notice, phone: string): void => { const key = id(notice); if (key) journal.mark(`${key}/phone/${phone}`); };

/** Called after every intended phone took its push, or notifications were deliberately off. */
export function finishUsage(notice: Notice): void {
  const key = id(notice);
  if (key) journal.mark(key);
}
