// The live event feed (`GET /api/event`), as the engine sends it: server-sent events, a
// `server.connected` first, and a heartbeat every 15 seconds (the app drops a feed that goes quiet).

import { newID } from "./ids"
import type { ServerEvent } from "./wire"

type Listener = (event: ServerEvent) => void

const listeners = new Set<Listener>()

/** Sends an event to every open feed; returns it, for its ID. */
export function emit(type: string, data: Record<string, unknown>, directory?: string): ServerEvent {
  const event: ServerEvent = { id: newID("evt"), type, created: Date.now(), data }
  if (directory) event.location = { directory }
  for (const listener of listeners) listener(event)
  return event
}

/** Every event as it's sent, to a listener of the bridge's own (its tests). */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function feed(): Response {
  const encoder = new TextEncoder()
  let listener: Listener | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ServerEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          stop()
        }
      }
      const stop = () => {
        if (listener) listeners.delete(listener)
        if (heartbeat) clearInterval(heartbeat)
        listener = undefined
        heartbeat = undefined
      }
      send({ id: newID("evt"), type: "server.connected", created: Date.now(), data: {} })
      listener = send
      listeners.add(send)
      heartbeat = setInterval(() => send({ id: newID("evt"), type: "server.heartbeat", created: Date.now(), data: {} }), 15_000)
    },
    cancel() {
      if (listener) listeners.delete(listener)
      if (heartbeat) clearInterval(heartbeat)
    },
  })
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  })
}
