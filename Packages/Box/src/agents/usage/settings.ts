// The usage panel's settings, kept by the box (PROTOCOL.md, "Usage settings"): which cards and
// meters show and in what order, what's pinned to the menu bar, the total spend card's settings,
// Codex's fallback model and which notifications are on. Each part (a `unit`) carries the version of
// its last change, and your own computers' boxes share them (`settings-peers.ts`), the newest
// change winning, so every app sees one panel whichever box it asks. How a panel looks (density,
// theme, transparency, animation, the menu bar's style) is each app's own, never here.
//
// What a Mac kept before its box did comes in once (`take`, "import"): only into parts no box has
// set, at an import's version, which any change made since beats; between two imports the earlier
// wins, so a Mac set up today never puts its first-run defaults over the panel you made on another.

import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** The parts of the settings, each changed and shared whole. */
export const SETTINGS_UNITS = ["layout", "providers", "totalSpend", "codexFallback", "notifications"] as const
export type SettingsUnit = (typeof SETTINGS_UNITS)[number]

/** Which cards and meters show, their order, what's pinned and what shows only when a card opens. */
export interface LayoutSettings {
  /** The meters shown, by their id (`<provider>.<metric>`), in order. */
  placed: string[]
  /** The cards' order, by provider id. */
  providerOrder: string[]
  /** Each card's meters' order, shown or not. */
  metricOrder: Record<string, string[]>
  /** The meters pinned to the menu bar. */
  pinned: string[]
  /** The meters shown only when their card is opened. */
  expanded: string[]
  /** Meters that go below the card's divider when they're turned on. */
  expandOnEnable: string[]
  /** The default meters already offered once, so a default turned off isn't turned on again. */
  seeded: string[]
}

export interface ProvidersSettings {
  /** The cards turned on. */
  enabled: string[]
  /** Every card ever offered, so one turned off stays off and a new one is offered once. */
  known: string[]
}

export interface TotalSpendSettings {
  show: boolean
  /** The card's period and what it counts, as the panel names them. */
  period?: string
  metric?: string
}

export interface NotificationSettings {
  underTenPercent: boolean
  healthyToClose: boolean
  closeToRunningOut: boolean
}

export interface SettingsValues {
  layout?: LayoutSettings
  providers?: ProvidersSettings
  totalSpend?: TotalSpendSettings
  /** Codex's fallback model (`null`: none). */
  codexFallback?: string | null
  notifications?: NotificationSettings
}

/**
 * A part's version: `v` counts on from every version this box has seen (milliseconds since 1970,
 * or one past the highest seen when a clock is behind), `by` the box that made it (its link key),
 * which decides between two of the same `v`. `imported`: brought in from what a Mac kept before
 * (`v` is when), which any change beats.
 */
export interface Stamp {
  v: number
  by: string
  imported?: true
}

export interface KeptUnit {
  value: unknown
  stamp: Stamp
}

/** Whether `a` is newer than `b`: a change over an import, the later change, the earlier import. */
export function newer(a: Stamp, b: Stamp): boolean {
  if (!!a.imported !== !!b.imported) return !a.imported
  if (a.v !== b.v) return a.imported ? a.v < b.v : a.v > b.v
  return a.by > b.by
}

const LAYOUT_LISTS = ["placed", "providerOrder", "pinned", "expanded", "expandOnEnable", "seeded"] as const
const MOST_IDS = 1_000
const MOST_PROVIDERS = 200
const ID = /^[^\u0000-\u001f]{1,200}$/

const ids = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > MOST_IDS) return null
  const out: string[] = []
  for (const each of value) {
    if (typeof each !== "string" || !ID.test(each)) return null
    if (!out.includes(each)) out.push(each)
  }
  return out
}

const word = (value: unknown): string | undefined => (typeof value === "string" && /^[^\u0000-\u001f]{1,40}$/.test(value) ? value : undefined)

/** At most this much of what a newer box knows and this one doesn't, per part, kept as it came. */
const MOST_OTHER = 16_000
/** At most this many parts a newer box knows and this one doesn't, each at most this big. */
const MOST_OTHER_PARTS = 20
const MOST_OTHER_PART = 64_000
const OTHER_PART = /^[a-z][A-Za-z0-9]{0,39}$/

/**
 * JSON with every object's keys in one order: what two boxes hold reads the same, whichever of a
 * part's fields each knows (one it doesn't is kept after the rest, as it came).
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  if (value && typeof value === "object") {
    return "{" + Object.keys(value as object).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}"
  }
  return JSON.stringify(value) ?? "null"
}

/** The fields of a part this box doesn't know (a newer box's), kept as they came, while they're small. */
function others(given: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(given).filter(([key]) => !known.includes(key)))
  return Object.keys(rest).length && canonical(rest).length <= MOST_OTHER ? rest : {}
}

/** A part's value, checked and cleaned; undefined for one that isn't that part. */
export function checked(unit: SettingsUnit, value: unknown): unknown {
  const given = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  switch (unit) {
    case "layout": {
      if (!given) return undefined
      const order = given.metricOrder
      if (!order || typeof order !== "object" || Array.isArray(order) || Object.keys(order).length > MOST_PROVIDERS) return undefined
      const metricOrder: Record<string, string[]> = {}
      for (const [provider, list] of Object.entries(order)) {
        const each = ids(list)
        if (!ID.test(provider) || !each) return undefined
        metricOrder[provider] = each
      }
      const lists = LAYOUT_LISTS.map((key) => [key, ids(given[key] ?? [])] as const)
      if (lists.some(([, list]) => !list)) return undefined
      return { ...Object.fromEntries(lists), metricOrder, ...others(given, [...LAYOUT_LISTS, "metricOrder"]) } as LayoutSettings
    }
    case "providers": {
      const enabled = given && ids(given.enabled)
      const known = given && ids(given.known ?? [])
      return enabled && known ? { enabled, known, ...others(given!, ["enabled", "known"]) } : undefined
    }
    case "totalSpend": {
      if (!given || typeof given.show !== "boolean") return undefined
      const period = word(given.period)
      const metric = word(given.metric)
      return { show: given.show, ...(period ? { period } : {}), ...(metric ? { metric } : {}), ...others(given, ["show", "period", "metric"]) }
    }
    case "codexFallback":
      return value === null || (typeof value === "string" && ID.test(value)) ? value : undefined
    case "notifications": {
      if (!given) return undefined
      const flags = ["underTenPercent", "healthyToClose", "closeToRunningOut"] as const
      if (!flags.every((flag) => typeof given[flag] === "boolean")) return undefined
      return { ...Object.fromEntries(flags.map((flag) => [flag, given[flag]])), ...others(given, flags) } as unknown as NotificationSettings
    }
  }
}

const isUnit = (name: string): name is SettingsUnit => (SETTINGS_UNITS as readonly string[]).includes(name)

const stampOf = (value: unknown): Stamp | null => {
  if (!value || typeof value !== "object") return null
  const stamp = value as Record<string, unknown>
  if (!Number.isSafeInteger(stamp.v) || (stamp.v as number) < 0 || typeof stamp.by !== "string" || stamp.by.length > 200) return null
  return { v: stamp.v as number, by: stamp.by, ...(stamp.imported === true ? { imported: true as const } : {}) }
}

/** Each part kept, by name: this box's own, and those of a newer box it doesn't know (kept as they came). */
type Units = Record<string, KeptUnit>

/**
 * Parts as kept or told (`{unit: {value, stamp}}`), each checked; what isn't one left out. A part
 * this box doesn't know (a newer box's) is kept as it came, while there are few and they're small,
 * so two boxes of different versions still hold the same.
 */
export function unitsFrom(given: unknown): Units {
  const units: Units = {}
  if (!given || typeof given !== "object" || Array.isArray(given)) return units
  let other = 0
  for (const [name, kept] of Object.entries(given)) {
    if (!kept || typeof kept !== "object") continue
    const stamp = stampOf((kept as KeptUnit).stamp)
    if (!stamp) continue
    if (isUnit(name)) {
      const value = checked(name, (kept as KeptUnit).value)
      if (value !== undefined) units[name] = { value, stamp }
    } else if (OTHER_PART.test(name) && !(name in Object.prototype) && other < MOST_OTHER_PARTS && "value" in kept && canonical((kept as KeptUnit).value).length <= MOST_OTHER_PART) {
      units[name] = { value: (kept as KeptUnit).value, stamp }
      other++
    }
  }
  return units
}

/** The cards and meters a client knows (its own app's), by id: what it sends is whole for those alone. */
export interface Knows {
  cards: Set<string>
  meters: Set<string>
}

/** What a client said it knows (`knows: {cards, meters}`), checked; none for nothing it said. */
export function knowsFrom(given: unknown): Knows | undefined {
  if (!given || typeof given !== "object") return undefined
  const cards = ids((given as Record<string, unknown>).cards)
  const meters = ids((given as Record<string, unknown>).meters)
  return cards && meters ? { cards: new Set(cards), meters: new Set(meters) } : undefined
}

/** The fields of each part this box knows: others (a newer box's) are kept as they came. */
const FIELDS: Record<SettingsUnit, readonly string[]> = {
  layout: [...LAYOUT_LISTS, "metricOrder"],
  providers: ["enabled", "known"],
  totalSpend: ["show", "period", "metric"],
  codexFallback: [],
  notifications: ["underTenPercent", "healthyToClose", "closeToRunningOut"],
}

/**
 * `list` with the ids of `from` it hasn't that `other` says the client doesn't know, each put back
 * after the nearest one before it in `from` that's there (first when none is): a newer app's cards
 * and meters keep their places.
 */
function putBack(list: string[], from: unknown, other: (id: string) => boolean): string[] {
  const was = Array.isArray(from) ? (from as string[]) : []
  const out = [...list]
  was.forEach((id, index) => {
    if (!other(id) || out.includes(id)) return
    let before = index - 1
    while (before >= 0 && !out.includes(was[before]!)) before--
    out.splice(before < 0 ? 0 : out.indexOf(was[before]!) + 1, 0, id)
  })
  return out
}

/**
 * A part a client changed, with what it was before that the client doesn't know: the fields of
 * it a newer box knows and this one doesn't (always), and, when the client says which cards and
 * meters its app knows (`knows`), a newer app's cards and meters, in their places. So a client of
 * an older app never takes them from your other computers.
 */
function keeping(unit: SettingsUnit, before: unknown, given: unknown, knows?: Knows): unknown {
  if (!before || typeof before !== "object" || !given || typeof given !== "object") return given
  const was = before as Record<string, any>
  const now = { ...(given as Record<string, any>) }
  for (const [key, value] of Object.entries(was)) if (!FIELDS[unit].includes(key) && !(key in now)) now[key] = value
  if (knows) {
    const otherMeter = (id: string) => !knows.meters.has(id)
    const otherCard = (id: string) => !knows.cards.has(id)
    if (unit === "layout") {
      for (const key of ["placed", "pinned", "expanded", "expandOnEnable", "seeded"]) now[key] = putBack(now[key] ?? [], was[key], otherMeter)
      now.providerOrder = putBack(now.providerOrder ?? [], was.providerOrder, otherCard)
      const metricOrder: Record<string, string[]> = { ...(now.metricOrder ?? {}) }
      for (const [card, list] of Object.entries((was.metricOrder ?? {}) as Record<string, string[]>)) {
        metricOrder[card] = otherCard(card) && !metricOrder[card] ? list : putBack(metricOrder[card] ?? [], list, otherMeter)
      }
      now.metricOrder = metricOrder
    } else if (unit === "providers") {
      for (const key of ["enabled", "known"]) now[key] = putBack(now[key] ?? [], was[key], otherCard)
    }
  }
  return checked(unit, now) ?? given
}

/** A part's version as a client names it, to say what a change of it was made from. */
export const versionOf = (stamp: Stamp) => `${stamp.v}/${stamp.by}${stamp.imported ? "/i" : ""}`

/**
 * A box's usage settings, kept in its usage folder (`settings.json`, which keeps Codex's fallback
 * model where a box from before reads it too). `self`: this box's link key, once the link says it.
 * They belong to the setup they were shared in (`setup`): in another, the box starts over.
 */
export class UsageSettings {
  private units: Units = {}
  /** Whether what a Mac kept before came in here (once). */
  imported = false
  /**
   * The setup these were shared in, by its id; `null` while this box followed none (a machine two
   * people's Macs share); none named yet (a box from before this), whichever the link names first.
   */
  setup?: string | null
  /** The highest version seen, so a change counts on from it whatever this clock says. */
  private highest = 0
  private listeners: ((units: SettingsUnit[]) => void)[] = []
  /** Who made a change before the link named this box: two such never tie. */
  private readonly unnamed = "?" + randomBytes(8).toString("hex")

  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
    public self: () => string = () => "",
  ) {
    if (!file) return
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"))
      this.units = unitsFrom(saved?.units)
      this.imported = saved?.imported === true
      if (typeof saved?.setup === "string" || saved?.setup === null) this.setup = saved.setup
      // A box from before kept only Codex's fallback model: what was chosen there counts as an import.
      const codex = saved?.codex
      if (!this.units.codexFallback && codex && typeof codex === "object" && "fallback" in codex) {
        const value = checked("codexFallback", codex.fallback === "" ? null : codex.fallback)
        if (value !== undefined) this.units.codexFallback = { value, stamp: { v: Math.floor(statSync(file).mtimeMs), by: "", imported: true } }
      }
    } catch {}
    for (const unit of Object.values(this.units)) if (!unit.stamp.imported) this.highest = Math.max(this.highest, unit.stamp.v)
  }

  /** Told each time parts change (here, or from another of your computers). */
  listen(listener: (units: SettingsUnit[]) => void) {
    this.listeners.push(listener)
  }

  /**
   * The setup this box follows now (`id`, as the link says). The first named is taken as theirs by
   * a box from before this; another one (this computer left that setup and joined another, whose
   * computers may be another person's), or one after following none, starts over: every part goes,
   * and what this box's own Mac kept comes in again. True when it started over.
   */
  inSetup(id: string): boolean {
    if (this.setup === id) return false
    const was = this.setup
    this.setup = id
    if (was === undefined) {
      this.save()
      return false
    }
    this.units = {}
    this.imported = false
    this.save()
    for (const listener of this.listeners) listener([...SETTINGS_UNITS])
    return true
  }

  /** The link says this box follows no setup: noted, so a setup it joins later starts it over. */
  inNoSetup() {
    if (this.setup !== undefined) return
    this.setup = null
    this.save()
  }

  /** Each part's version, as a client names it (`versionOf`), of those this box knows. */
  versions(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.units).flatMap(([name, unit]) => (isUnit(name) ? [[name, versionOf(unit.stamp)]] : [])))
  }

  /** Codex's fallback model (none: undefined). */
  get codexFallback(): string | undefined {
    const value = this.units.codexFallback?.value
    return typeof value === "string" ? value : undefined
  }

  /** Whether Codex's fallback model was ever chosen (none counts), here or on another of your computers. */
  get chosen(): boolean {
    return !!this.units.codexFallback
  }

  setCodexFallback(model: string | null) {
    this.change({ codexFallback: model })
  }

  /** The parts' values (a part never set: absent, the panel's own default), of those this box knows. */
  values(): SettingsValues {
    return Object.fromEntries(Object.entries(this.units).flatMap(([name, unit]) => (isUnit(name) ? [[name, unit.value]] : []))) as SettingsValues
  }

  /** The parts as kept, with their versions (to tell another box), a newer box's too. */
  kept(): Units {
    return structuredClone(this.units)
  }

  /**
   * What's kept, hashed: two boxes with the same parts at the same versions say the same, whatever
   * version of Kuvo Code each is (a part or field one doesn't know is kept as it came).
   */
  digest(): string {
    const all = Object.keys(this.units)
      .sort()
      .map((name) => {
        const unit = this.units[name]!
        return [name, unit.stamp.v, unit.stamp.by, unit.stamp.imported === true, unit.value]
      })
    return createHash("sha256").update(canonical(all)).digest("hex").slice(0, 32)
  }

  /**
   * Parts changed here (through a route): each checked, then kept at a version past every one seen.
   * `knows`: the cards and meters the client knows; what it was before of others is kept. `based`:
   * the version of each part the client changed it from (`null`: it had none); a part that has
   * changed since (another computer's change came meanwhile) isn't changed, and is `stale`. A
   * message for a part that isn't what it should be; nothing changes then.
   */
  change(given: Record<string, unknown>, knows?: Knows, based?: Record<string, unknown>): { changed: SettingsUnit[]; stale: SettingsUnit[] } | { message: string } {
    const values: [SettingsUnit, unknown][] = []
    for (const [name, value] of Object.entries(given)) {
      if (!isUnit(name)) return { message: `There's no usage setting called ${name}.` }
      const clean = checked(name, value)
      if (clean === undefined) return { message: `That isn't a ${name} setting.` }
      values.push([name, keeping(name, this.units[name]?.value, clean, knows)])
    }
    const changed: SettingsUnit[] = []
    const stale: SettingsUnit[] = []
    for (const [name, value] of values) {
      const before = this.units[name]
      if (based && name in based && (before ? versionOf(before.stamp) : null) !== based[name]) {
        stale.push(name)
        continue
      }
      // (The same as it is: no new version, so nothing goes to your other computers.)
      if (before && !before.stamp.imported && canonical(before.value) === canonical(value)) continue
      this.highest = Math.max(this.now(), this.highest + 1)
      this.units[name] = { value, stamp: { v: this.highest, by: this.self() || this.unnamed } }
      changed.push(name)
    }
    if (changed.length) this.changed(changed)
    return { changed, stale }
  }

  /**
   * What a Mac kept before its box did, once: each part no box has set yet (here, or come from
   * another of your computers) at an import's version, this box's clock's now; the rest left as
   * they are. Nothing the second time. Each part checked; one that isn't what it should be is left out.
   */
  take(given: Record<string, unknown>): SettingsUnit[] {
    if (this.imported) return []
    const took: SettingsUnit[] = []
    const at = this.now()
    for (const [name, value] of Object.entries(given)) {
      if (!isUnit(name) || this.units[name]) continue
      const clean = checked(name, value)
      if (clean === undefined) continue
      this.units[name] = { value: clean, stamp: { v: at, by: this.self() || this.unnamed, imported: true } }
      took.push(name)
    }
    this.imported = true
    this.save()
    if (took.length) this.changed(took, false)
    return took
  }

  /** Parts another of your computers told: each newer than this box's taken. The parts that changed. */
  merge(given: unknown): SettingsUnit[] {
    const changed: string[] = []
    for (const [name, unit] of Object.entries(unitsFrom(given))) {
      if (!unit.stamp.imported) this.highest = Math.max(this.highest, unit.stamp.v)
      const before = this.units[name]
      if (before && !newer(unit.stamp, before.stamp)) continue
      this.units[name] = unit
      changed.push(name)
    }
    if (changed.length) this.changed(changed as SettingsUnit[])
    return changed.filter(isUnit)
  }

  private changed(units: SettingsUnit[], save = true) {
    if (save) this.save()
    for (const listener of this.listeners) listener(units)
  }

  private save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      // (Codex's fallback model where a box from before reads it, while it's one this box chose or took.)
      const codex = this.units.codexFallback ? { codex: { fallback: this.units.codexFallback.value } } : {}
      writeFileSync(this.file + ".new", JSON.stringify({ ...codex, kuvo: 1, units: this.units, ...(this.imported ? { imported: true } : {}), ...(this.setup !== undefined ? { setup: this.setup } : {}) }), { mode: 0o600 })
      renameSync(this.file + ".new", this.file)
    } catch {}
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

/** What a client reads: each part set (one never set is the panel's own default), and whether a Mac's came in. */
const answer = (settings: UsageSettings, extra: Record<string, unknown> = {}) => json({ data: { settings: settings.values(), versions: settings.versions(), imported: settings.imported, ...extra } })

/**
 * `GET api/kuvo/usage/settings` → `{data: {settings, versions, imported}}`; `PUT api/kuvo/usage/settings`
 * with the parts changed (`{layout?, providers?, totalSpend?, codexFallback?, notifications?}`, each
 * whole; `knows: {cards, meters}`, those the client's app knows: what it doesn't is kept; `based:
 * {part: version}`, what each was changed from: one changed since is left, `stale`) answers the same; `POST api/kuvo/usage/settings/import` with what a Mac kept before takes
 * the parts no box has set, once, and answers with `took` (PROTOCOL.md, "Usage settings").
 * `choices`: the models Codex's fallback model may be now.
 */
export async function settingsRoutes(settings: UsageSettings, choices: () => string[], method: string, rest: string[], body: () => Promise<any>): Promise<Response> {
  if (!rest.length && method === "GET") return answer(settings)
  if (!rest.length && method === "PUT") {
    const given = await body().catch(() => undefined)
    if (!given || typeof given !== "object" || Array.isArray(given)) return json({ message: "Say which settings change, each whole." }, 400)
    if ("codexFallback" in given && given.codexFallback !== null && (typeof given.codexFallback !== "string" || !choices().includes(given.codexFallback))) {
      return json({ message: "This model's prices aren't available now. Choose another model or None." }, 400)
    }
    const { knows, based, ...parts } = given as Record<string, unknown>
    const changed = settings.change(parts, knowsFrom(knows), based && typeof based === "object" && !Array.isArray(based) ? (based as Record<string, unknown>) : undefined)
    if ("message" in changed) return json({ message: changed.message }, 400)
    return answer(settings, changed.stale.length ? { stale: changed.stale } : {})
  }
  if (rest.length === 1 && rest[0] === "import" && method === "POST") {
    const given = await body().catch(() => undefined)
    if (!given || typeof given !== "object" || Array.isArray(given)) return json({ message: "Say what the settings were." }, 400)
    // (A fallback model this box can't price with now isn't one to take.)
    const { codexFallback, ...rest } = given as Record<string, unknown>
    const usable = codexFallback === null || (typeof codexFallback === "string" && choices().includes(codexFallback))
    return answer(settings, { took: settings.take(usable ? { ...rest, codexFallback } : rest) })
  }
  return json({ message: "Not available for this agent." }, 404)
}
