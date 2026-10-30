// A goal's clock (PROTOCOL.md, "Work › Goals"): days, weeks and months as you live them, in your time
// zone (`KUVO_TZ`, which a machine's box is given, else this computer's), for a spend cap's period,
// a daily limit's midnight, and an end written without a zone.

/** Your time zone, if `KUVO_TZ` names one this runtime knows; this computer's otherwise. */
export function zone(): string | undefined {
  const name = process.env.KUVO_TZ;
  if (!name) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

/** The wall clock at `at`, in your zone. */
export function wall(at: number, timeZone = zone()): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find(each => each.type === type)?.value ?? 0);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

/** The moment a wall-clock time is in your zone (days past a month's end roll on). */
export function instant(year: number, month: number, day: number, hour = 0, minute = 0, timeZone = zone()): number {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let tries = 0; tries < 3; tries++) {
    const seen = wall(guess, timeZone);
    const shift = wanted - Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    if (!shift) break;
    guess += shift;
  }
  return guess;
}

/** The midnight that starts the day `at` is in. */
export function startOfDay(at: number): number {
  const now = wall(at);
  return instant(now.year, now.month, now.day);
}

/** The next midnight after `at`. */
export function nextMidnight(at: number): number {
  const now = wall(at);
  return instant(now.year, now.month, now.day + 1);
}

/** An ISO week's name, "2026-W44", for a date. */
function isoWeek(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() + 3 - weekday);
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type Period = "day" | "week" | "month" | "goal";

/** The period a moment falls in, by its name ("2026-10-29", "2026-W44", "2026-10", or "goal"). */
export function periodOf(per: Period, at: number): string {
  if (per === "goal") return "goal";
  const { year, month, day } = wall(at);
  const pad = (number: number) => String(number).padStart(2, "0");
  if (per === "month") return `${year}-${pad(month)}`;
  if (per === "day") return `${year}-${pad(month)}-${pad(day)}`;
  return isoWeek(year, month, day);
}

/** When the period a moment falls in ends (the midnight starting the next), or never for the goal's. */
export function periodEnd(per: Period, at: number): number | undefined {
  if (per === "goal") return undefined;
  const { year, month, day } = wall(at);
  if (per === "day") return instant(year, month, day + 1);
  if (per === "month") return instant(year, month + 1, 1);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return instant(year, month, day - weekday + 7);
}

/** A time written as a date (and a time), without a zone, in yours; one with a zone as it says; ms as
 * they are. Null for what isn't one. */
export function timeGiven(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const local = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (local) return instant(Number(local[1]), Number(local[2]), Number(local[3]), Number(local[4] ?? 0), Number(local[5] ?? 0));
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
