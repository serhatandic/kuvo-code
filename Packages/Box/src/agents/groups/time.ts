// When a repeating meeting comes back, as the Mac's `Wakes.Repeat.next` has it: every so many
// minutes or hours, or on days, weeks and weekdays at a time of day, on the clock of the user's
// time zone, whatever daylight saving did meanwhile.

export type Repeat = { kind: "minutes" | "hours" | "days" | "weeks"; count: number } | { kind: "weekdays" }

/** 30m, 2h, 1d, 1w or weekdays, as kuvo-wake takes it: at most a year, and no leading zero. */
export function parseRepeat(text: string): Repeat | undefined {
  if (text === "weekdays") return { kind: "weekdays" }
  const unit = text.slice(-1)
  const digits = text.slice(0, -1)
  if (!/^[1-9][0-9]*$/.test(digits) || text.length > 7) return undefined
  const count = Number(digits)
  if (unit === "m" && count >= 5 && count <= 525_600) return { kind: "minutes", count }
  if (unit === "h" && count <= 8_760) return { kind: "hours", count }
  if (unit === "d" && count <= 366) return { kind: "days", count }
  if (unit === "w" && count <= 52) return { kind: "weeks", count }
  return undefined
}

export const keepsTimeOfDay = (every: Repeat) => every.kind === "days" || every.kind === "weeks" || every.kind === "weekdays"
export const keepsWeekday = (every: Repeat) => every.kind === "weeks"

interface Local {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  /** 1 is Sunday. */
  weekday: number
}

const formats = new Map<string, Intl.DateTimeFormat>()
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** What the clock and calendar say at `time` (milliseconds) in `zone`. */
function local(time: number, zone: string): Local {
  let format = formats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    })
    formats.set(zone, format)
  }
  const parts: Record<string, string> = {}
  for (const part of format.formatToParts(new Date(time))) parts[part.type] = part.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday) + 1,
  }
}

/** How far ahead of UTC `zone`'s clock is at `time`, in milliseconds (to the minute). */
function offset(time: number, zone: string): number {
  const at = local(time, zone)
  const wall = Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute)
  return wall - Math.floor(time / 60_000) * 60_000
}

/**
 * The moment `zone`'s clock reads this date and time. One the clocks skipped (the hour they go
 * forward) is that much later; one they read twice (going back), the first time.
 */
function moment(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const before = wall - offset(wall - 86_400_000, zone)
  const after = wall - offset(wall + 86_400_000, zone)
  const reads = (time: number) => {
    const at = local(time, zone)
    return Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute) === wall
  }
  const fits = [before, after].filter(reads)
  if (fits.length > 0) return Math.min(...fits)
  return before
}

/** The calendar date `days` after this one. */
function plusDays(date: { year: number; month: number; day: number }, days: number) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

const daysBetween = (from: { year: number; month: number; day: number }, to: { year: number; month: number; day: number }) =>
  Math.round((Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / 86_400_000)

/** Minutes into the day `time` is, on `zone`'s clock. */
export function minutesOf(time: number, zone: string): number {
  const at = local(time, zone)
  return at.hour * 60 + at.minute
}

/** Saturday or Sunday on `zone`'s calendar: weekdays are Monday to Friday. */
export function isWeekend(time: number, zone: string): boolean {
  const day = local(time, zone).weekday
  return day === 1 || day === 7
}

/**
 * The first time after `now` it comes back, from when it was due (milliseconds). Days, weeks and
 * weekdays come back at `at` (minutes into the day; the time of day it was due without one), and
 * weeks on `weekday` (1 is Sunday; the day it was due without one). Weekdays skip weekends.
 */
export function next(every: Repeat, due: number, now: number, zone: string, at?: number, weekday?: number): number {
  if (every.kind === "minutes" || every.kind === "hours") {
    const period = every.count * (every.kind === "hours" ? 3_600_000 : 60_000)
    return due + (Math.floor((now - due) / period) + 1) * period
  }
  const days = every.kind === "days" ? every.count : every.kind === "weeks" ? every.count * 7 : 1
  const minutes = at ?? minutesOf(due, zone)
  let first = local(due, zone) as { year: number; month: number; day: number; weekday?: number }
  // The day it keeps nearest to the one it was due (a new time zone can put that the day before or after).
  if (keepsWeekday(every) && weekday !== undefined) {
    const shift = (weekday - local(due, zone).weekday + 7) % 7
    first = plusDays(first, shift > 3 ? shift - 7 : shift)
  }
  // Whole periods missed first, but not one still to come today; then one at a time.
  const missed = daysBetween(first, local(now, zone))
  let periods = Math.max(1, Math.trunc(missed / days))
  for (let tries = 0; tries < 400; tries++, periods++) {
    const day = plusDays(first, periods * days)
    const time = moment(day.year, day.month, day.day, Math.floor(minutes / 60), minutes % 60, zone)
    if (time > now && (every.kind !== "weekdays" || !isWeekend(time, zone))) return time
  }
  return now + days * 86_400_000
}

/** The day of the week `time` is on `zone`'s calendar (1 is Sunday). */
export function weekdayOf(time: number, zone: string): number {
  return local(time, zone).weekday
}

/** What a meeting's topic is when you give none, as the Mac's. */
export const defaultTopic = "Our regular meeting: where things stand, and what's next."

/**
 * A meeting as you set it up (a phone, as Edit Group Chat on the Mac does: `BotGroup.Meeting.planned`):
 * at `next` (seconds since 1970), repeating `every` (null for once), about `topic`. Its next time
 * is after now: a repeating one's next round if `next` has passed; on weekdays, a weekday. With its
 * time and repeat as `before` had them, it keeps the time of day (and a week's day) it had; a time
 * picked anew is the one it keeps from then on. A string says why it can't be.
 */
export function planMeeting(
  plan: { next: number; every?: string | null; topic?: string },
  before: { next: string; every?: string; at?: number; weekday?: number } | undefined,
  zone: string,
  now = Date.now(),
): { next: string; every?: string; topic: string; at?: number; weekday?: number } | string {
  if (typeof plan?.next !== "number" || !Number.isFinite(plan.next)) return "That isn't a meeting."
  const every = plan.every ?? undefined
  const repeat = every === undefined ? undefined : parseRepeat(String(every))
  if (every !== undefined && !repeat) return `“${every}” isn't how often a meeting can come back.`
  // To the minute, as the Mac plans it.
  const time = Math.floor(plan.next / 60) * 60_000
  const kept = before && Date.parse(before.next) === time && (before.every ?? undefined) === every ? before : undefined
  const at = repeat && keepsTimeOfDay(repeat) ? (kept?.at ?? minutesOf(time, zone)) : undefined
  const weekday = repeat && keepsWeekday(repeat) ? (kept?.weekday ?? weekdayOf(time, zone)) : undefined
  let when = time
  if (when <= now && repeat) when = next(repeat, when, now, zone, at, weekday)
  for (let tries = 0; repeat?.kind === "weekdays" && isWeekend(when, zone) && tries < 7; tries++) {
    const day = plusDays(local(when, zone), 1)
    const clock = local(when, zone)
    when = moment(day.year, day.month, day.day, clock.hour, clock.minute, zone)
  }
  if (when <= now) return "That time has passed. Pick one to come."
  const topic = String(plan.topic ?? "").trim() || defaultTopic
  return {
    next: new Date(when).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(every !== undefined ? { every } : {}),
    topic,
    ...(at !== undefined ? { at } : {}),
    ...(weekday !== undefined ? { weekday } : {}),
  }
}
