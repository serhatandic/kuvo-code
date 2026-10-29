// A model's limit, as every part of a box reads it (Auto holding a model back, a goal pausing until
// the reset): when it resets, from the agent's or the engine's words, and whether an error is one.

/**
 * When a limit resets, from an agent's words for it ("Your limit will reset in 6 days, 19 hours",
 * "try again in 3h 20m"), if they say (milliseconds since 1970).
 */
export function resetsIn(text: string | undefined, now = Date.now()): number | undefined {
  const found = text?.match(/(?:resets?|try again|available again)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i)
  if (!found) return undefined
  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }
  let total = 0
  for (const part of found[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) total += Number(part[1]) * (units[part[2]!.toLowerCase()] ?? 0)
  // (A month at most: a plan's allowance comes back within one.)
  return total > 0 ? now + Math.min(total, 31 * 86_400_000) : undefined
}

/** The time zone KUVO_TZ names, if it names one this runtime knows. */
function zone(): string | undefined {
  const name = process.env.KUVO_TZ
  if (!name) return undefined
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name })
    return name
  } catch {
    return undefined
  }
}

/**
 * "4:30 PM", or "Oct 21, 9:00 AM" when it isn't today: in your time zone (on a machine, the
 * Mac's, which its launch gives as KUVO_TZ).
 */
export function resetTime(at: number): string {
  const timeZone = zone()
  const day = (date: Date) => date.toLocaleDateString("en-US", { timeZone })
  const date = new Date(at)
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone })
  if (day(date) === day(new Date())) return time
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone })}, ${time}`
}


/** Whether an error's words say a model's limit was reached (a plan's window, a rate limit, a 429),
 * which resets, rather than something that failed. */
export function isLimit(text: string | undefined): boolean {
  return Boolean(text && /\b429\b|rate.?limit|usage limit|limit (?:was |has been )?reached|reached (?:its|your|the) (?:usage )?limit|quota|too many requests|resets? in|try again in|overloaded|capacity/i.test(text))
}
