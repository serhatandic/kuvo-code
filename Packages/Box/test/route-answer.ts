// What a route answered, held to its shape (src/shared/routes, as the contract runner holds every
// answer: `offShape` in Packages/KuvoLink/Tests/Bridge/contract-runner.js), and a box's handler asked
// as a client asks it, for the box tests that run a route against a stand-in engine.

import { ERROR, ROUTES } from "../src/shared/routes"
import type { Shape } from "../src/shared/shape"

const isPlain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** Why `value` isn't of `shape`, at its first difference, or null when it is. */
export function unshaped(shape: Shape, value: unknown, at = "body"): string | null {
  if (value === undefined) return `${at} is missing`
  if (shape === "any") return null
  if (shape === "string" || shape === "number") return typeof value === shape ? null : `${at} should be a ${shape}, but is ${JSON.stringify(value)}`
  if (shape === "bool") return typeof value === "boolean" ? null : `${at} should be true or false`
  if (shape === "null") return value === null ? null : `${at} should be null, but is ${JSON.stringify(value)}`
  if ("literal" in shape) return value === shape.literal ? null : `${at} should be ${JSON.stringify(shape.literal)}`
  if ("list" in shape) {
    if (!Array.isArray(value)) return `${at} should be a list`
    for (const [index, each] of value.entries()) {
      const why = unshaped(shape.list, each, `${at}[${index}]`)
      if (why) return why
    }
    return null
  }
  if ("map" in shape) {
    if (!isPlain(value)) return `${at} should be an object`
    for (const [key, each] of Object.entries(value)) {
      const why = unshaped(shape.map, each, `${at}.${key}`)
      if (why) return why
    }
    return null
  }
  if ("object" in shape) {
    if (!isPlain(value)) return `${at} should be an object`
    const fields = new Map(Object.entries(shape.object).map(([name, each]) => [name.replace(/\?$/, ""), { shape: each, optional: name.endsWith("?") }]))
    for (const key of Object.keys(value)) if (!fields.has(key)) return `${at}.${key} isn't a field it has`
    for (const [name, field] of fields) {
      if (!(name in value)) {
        if (field.optional) continue
        return `${at}.${name} is missing`
      }
      const why = unshaped(field.shape, value[name], `${at}.${name}`)
      if (why) return why
    }
    return null
  }
  const whys = shape.oneOf.map(each => unshaped(each, value, at))
  return whys.includes(null) ? null : `${at} is none of what it can be: ${whys.join("; ")}`
}

/** Why an answer isn't what its route answers, or null when it is. */
export function offShape(method: string, requestPath: string, status: number, value: unknown): string | null {
  const parts = requestPath.split("?")[0]!.split("/")
  const known = ROUTES.find(each => {
    const [wanted, pattern] = each.route.split(" ")
    const want = pattern!.split("/")
    return wanted === method && want.length === parts.length && want.every((part, i) => (part.startsWith(":") ? parts[i] !== "" : part === parts[i]))
  })
  if (!known) return `${method} ${requestPath} has no shape`
  const shape = known.answers[status] ?? (status >= 400 ? ERROR : undefined)
  if (shape === undefined) return `${known.route} has no shape for ${status}`
  return shape === "bytes" ? null : unshaped(shape, value, "the answer")
}

type Handler = (request: { method: string; path: string; headers: Record<string, string>; body?: Buffer; fromApp?: boolean }, phone: undefined, signal?: AbortSignal) => AsyncGenerator<any>

/** `method path` asked of `handler` as a client asks it, its answer held to its route's shape. */
export async function ask(handler: Handler, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  let status = 0
  let text = ""
  for await (const piece of handler({ method, path, headers: {}, fromApp: true, ...(body !== undefined ? { body: Buffer.from(JSON.stringify(body)) } : {}) }, undefined)) {
    if ("head" in piece) status = piece.head.status
    if ("body" in piece) text += Buffer.from(piece.body).toString()
  }
  const json = text ? JSON.parse(text) : undefined
  const why = offShape(method, path, status, json)
  if (why) throw new Error(why)
  return { status, json }
}

/** A stream's lines (ndjson), each held to its route's shape, as they come: the next one each time
 * `next()` is called; `stop()` ends it. */
export function follow(handler: Handler, path: string): { next: () => Promise<any>; stop: () => void } {
  const stop = new AbortController()
  const pieces = handler({ method: "GET", path, headers: {}, fromApp: true }, undefined, stop.signal)
  let buffer = ""
  return {
    async next() {
      for (;;) {
        const end = buffer.indexOf("\n")
        if (end >= 0) {
          const line = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          const why = offShape("GET", path, 200, line)
          if (why) throw new Error(why)
          return line
        }
        const { value, done } = await pieces.next()
        if (done) throw new Error("The stream ended.")
        if ("body" in value) buffer += Buffer.from(value.body).toString()
      }
    },
    stop: () => stop.abort(),
  }
}
