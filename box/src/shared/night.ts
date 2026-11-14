// The night's window where you are (02:00 to 05:00 in `KUVO_TZ`, else the computer's own zone):
// when a box updates itself, and when its coding agents' bridge holds new turns to take a new
// version it couldn't find a quiet moment for (PROTOCOL.md, "Updates").

/** Which night it is (its date, `2026-11-12`), while it's the window; null otherwise. */
export function nightOf(date = new Date(), zone: string | undefined = process.env.KUVO_TZ): string | null {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone || undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hourCycle: "h23" })
      .formatToParts(date).map(part => [part.type, part.value]));
  } catch {
    return null;
  }
  const hour = Number(parts.hour);
  return hour >= 2 && hour < 5 ? `${parts.year}-${parts.month}-${parts.day}` : null;
}
