// IDs in the engine's format, so they sort among its own and the app's: a prefix, 12 hex digits of
// (milliseconds × 4096 + counter), then 14 random base62 characters (OpenCodeKit's `Identifier`).

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let last = { timestamp: 0, counter: 0 }

function ascending(): string {
  const timestamp = Date.now()
  if (last.timestamp !== timestamp) last = { timestamp, counter: 0 }
  last.counter += 1
  const value = (BigInt(timestamp) * 0x1000n + BigInt(last.counter)) & 0xffffffffffffn
  const time = value.toString(16).padStart(12, "0")
  let random = ""
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  for (const byte of bytes) random += alphabet[byte % alphabet.length]
  return time + random
}

export const newID = (prefix: "ses" | "msg" | "evt" | "per" | "frm" | "att" | "call" | "shl" | "btw" | "rev" | "fnd") => `${prefix}_${ascending()}`

/** The message an event names as its own (the app's reducer does the same for idle markers). */
export const messageID = (eventID: string) => "msg_" + eventID.slice("evt_".length)
