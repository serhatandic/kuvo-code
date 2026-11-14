// Numbers as UsageKit reads them from JSON a log or a database holds.

/** `ProviderParse.number`: a number (not a boolean), or text that is one; finite. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value)) {
    const found = Number(value)
    return Number.isFinite(found) ? found : undefined
  }
  return undefined
}
