// The record as a client reads it (`kuvo/artifacts` in PROTOCOL.md), which the box's link passes
// on as it is, at `/api/kuvo/link/artifacts…`: lists for a conversation, a bot, a group chat or a
// project, followed as they change; each artifact's versions, their bytes and what changed; pins.

import { changes } from "./changes"
import { privateReasons } from "./policy"
import { isProse, isText, type Kind } from "./kinds"
import type { Artifact, ArtifactStore, Scope, Summary, Version } from "./store"

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const message = (status: number, text: string) => json({ message: text }, status)

const kinds = new Set<Kind>(["memory", "skill", "image", "page", "document", "download", "code", "file"])

/** Times as a client takes them: seconds since 1970. */
const seconds = (text?: string | null) => {
  if (!text) return null
  const time = Date.parse(text)
  return Number.isFinite(time) ? time / 1000 : null
}

function clientVersion(version: Version) {
  return { ...version, at: seconds(version.at) }
}

function clientHeader(artifact: Omit<Artifact, "versions">, store: ArtifactStore) {
  return {
    ...artifact,
    restorable: store.canRestore(artifact),
    updated: seconds(artifact.updated),
    gone: seconds(artifact.gone),
    ...(artifact.shown ? { shown: seconds(artifact.shown) } : {}),
    pinned: artifact.pinned ? { ...artifact.pinned, at: seconds(artifact.pinned.at) } : null,
  }
}

export function clientSummary(summary: Summary, store: ArtifactStore) {
  return { ...clientHeader(summary, store), latest: clientVersion(summary.latest) }
}

export function clientArtifact(artifact: Artifact, store: ArtifactStore) {
  const { versions, ...header } = artifact
  return { ...clientHeader(header, store), versions: versions.map(clientVersion) }
}

/** The scope a list asks for: exactly one of a conversation, a bot, a group chat or a project, with filters. */
function scopeOf(query: URLSearchParams): Scope | string {
  const named = (["session", "bot", "group", "project"] as const).filter((key) => query.get(key))
  if (named.length !== 1) return "Say whose: one of session, bot, group or project."
  const scope: Scope = { [named[0]]: query.get(named[0])! }
  const kind = query.get("kind")
  if (kind) {
    if (!kinds.has(kind as Kind)) return `There's no kind called ${kind}.`
    scope.kind = kind as Kind
  }
  if (query.get("pinned") === "1") scope.pinned = true
  if (query.get("by")) scope.by = query.get("by")!
  return scope
}

/**
 * `/api/kuvo/link/artifacts[/…]`. `parts` is what follows `artifacts`. A box whose record didn't
 * start answers 503.
 */
export async function artifactRoutes(store: ArtifactStore | undefined, method: string, parts: string[], query: URLSearchParams, body: () => Promise<any>, signal?: AbortSignal): Promise<Response> {
  if (!store) return message(503, "This computer's record of what its agents made isn't running. Try again in a moment.")
  const [first, second, third, fourth] = parts
  // What's being recorded now first, so a turn that just ended reads as it ended.
  await store.settled()

  if (!first) {
    if (method !== "GET") return message(405, "Read them with GET.")
    const scope = scopeOf(query)
    if (typeof scope === "string") return message(400, scope)
    return json(list(store, scope, Math.min(500, Math.max(1, Number(query.get("limit")) || 200)), beforeOf(query)))
  }

  if (first === "events" || (first === "timeline" && second === "events")) {
    if (method !== "GET") return message(405, "Follow them with GET.")
    const scope = scopeOf(query)
    if (typeof scope === "string") return message(400, scope)
    return followed(store, first === "timeline" ? () => timeline(store, scope) : () => list(store, scope), signal)
  }

  if (first === "timeline" && !second) {
    if (method !== "GET") return message(405, "Read it with GET.")
    const scope = scopeOf(query)
    if (typeof scope === "string") return message(400, scope)
    return json(timeline(store, scope, Math.min(500, Math.max(1, Number(query.get("limit")) || 200)), beforeOf(query)))
  }

  if (first === "storage") {
    if (!second && method === "POST") {
      // Your budget for older versions, in bytes (Settings › Storage).
      const { budget } = (await body()) ?? {}
      if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) return message(400, "Say the budget for older versions, in bytes (budget).")
      store.setBudget(budget)
      return json(store.storage())
    }
    if (!second) return method === "GET" ? json(store.storage()) : message(405, "Read it with GET, or set its budget with POST.")
    if (second === "clear" && method === "POST") {
      const { before } = (await body()) ?? {}
      const at = typeof before === "number" ? new Date(before * 1000).toISOString() : undefined
      return json({ cleared: store.clearOlder(at), ...store.storage() })
    }
    return message(404, "No such route.")
  }

  const artifact = store.get(first)
  if (!artifact) return message(404, "That isn't in this computer's record.")

  if (!second) return method === "GET" ? json(clientArtifact((await store.checkGone(artifact.id)) ?? artifact, store)) : message(405, "Read it with GET.")

  if (second === "pin") {
    if (method !== "POST") return message(405, "Pin it with POST.")
    const { pinned, note } = (await body()) ?? {}
    if (typeof pinned !== "boolean") return message(400, "Say whether it's pinned (pinned).")
    const changed = await store.pin(artifact.id, pinned ? { by: "you", ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}) } : null)
    return changed ? json(clientArtifact(changed, store)) : message(409, "It couldn't be kept now. Try again in a moment.")
  }

  if (second === "restore") {
    if (method !== "POST") return message(405, "Restore it with POST.")
    const { version } = (await body()) ?? {}
    if (!Number.isInteger(version)) return message(400, "Say which version to put back (version).")
    const restored = await store.restore(artifact.id, version)
    return typeof restored === "string" ? message(409, restored) : json(clientArtifact(restored, store))
  }

  if (second === "versions" && third !== undefined) {
    const n = Number(third)
    const version = Number.isInteger(n) ? artifact.versions.find((each) => each.n === n) : undefined
    if (!version) return message(404, "There's no such version.")
    if (!fourth) {
      if (method !== "GET") return message(405, "Read it with GET.")
      const bytes = store.bytes(artifact.id, n)
      if (!bytes) return message(410, notKept(version))
      return new Response(bytes, { headers: { "Content-Type": artifact.type, "Content-Length": String(bytes.length) } })
    }
    if (fourth === "changes") {
      if (method !== "GET") return message(405, "Read them with GET.")
      // From the version before, or the one asked for.
      const from = query.get("from") !== null ? artifact.versions.find((each) => each.n === Number(query.get("from"))) : [...artifact.versions].reverse().find((each) => each.n < n)
      // What's likely a secret: never shown, not even what changed.
      if (version.reason && privateReasons.has(version.reason)) return message(410, notKept(version))
      // Code git keeps: the change its tool call made.
      if (version.patch) return json({ style: "lines", patch: version.patch, added: version.lines?.added ?? 0, removed: version.lines?.removed ?? 0, from: from?.n ?? null, to: n })
      if (!isText(artifact.type)) {
        // Pictures and PDFs: shown side by side by the client, from each version's bytes.
        return json({ style: artifact.kind === "image" || artifact.type === "application/pdf" ? "pair" : "none", from: from?.n ?? null, to: n })
      }
      const after = version.status === "deleted" ? "" : store.bytes(artifact.id, n)
      const before = from ? (from.status === "deleted" ? "" : store.bytes(artifact.id, from.n)) : ""
      if (after === null || after === undefined || before === null || before === undefined) return message(410, version.kept ? "The version before isn't kept, so what changed can't be shown." : notKept(version))
      return json({ ...changes(before.toString(), after.toString(), isProse(artifact.path)), from: from?.n ?? null, to: n })
    }
  }
  return message(404, "No such route.")
}

/**
 * `POST /api/kuvo/artifacts/noted {path, session, via}`: a file a conversation got without a tool
 * call naming it, as this box's own programs tell it (its agent browser's downloads). Not one a
 * client reaches: the box's link passes on only `kuvo/artifacts`' own routes, and keeps
 * `kuvo/agents/` off the bridge's `api/kuvo/artifacts…` too.
 */
export async function notedRoute(noted: ((session: string, path: string, via: string) => Promise<boolean>) | undefined, method: string, body: () => Promise<any>): Promise<Response> {
  if (!noted) return message(503, "This computer's record of what its agents made isn't running. Try again in a moment.")
  if (method !== "POST") return message(405, "Tell it with POST.")
  const { path, session, via } = (await body()) ?? {}
  if (typeof path !== "string" || !path.startsWith("/")) return message(400, "Say the file's whole path (path).")
  if (typeof session !== "string" || !session) return message(400, "Say whose it is (session).")
  if (via !== "download") return message(400, "Say how it came (via: download).")
  return (await noted(session, path, via)) ? json({ ok: true }) : message(404, "There's no such conversation on this computer.")
}

/** Why a version can't be read, in words. */
function notKept(version: Version): string {
  if (version.status === "deleted") return "It was deleted then."
  switch (version.reason) {
    case "secret": return "It looks like it holds a secret, so no copy is kept."
    case "ignored": return "Git ignores it, so no copy is kept."
    case "git": return "Git keeps this file's history: see it in Changes."
    case "too-big": return "It's too big to keep a copy of."
    case "low-disk": return "The disk was nearly full, so no copy was kept."
    default: return "That version is no longer kept."
  }
}

/** `before`: the `next` of the page before (an opaque cursor). */
function beforeOf(query: URLSearchParams) {
  return query.get("before") || undefined
}

function list(store: ArtifactStore, scope: Scope, limit = 200, before?: string) {
  const { artifacts, next } = store.list(scope, { limit, before })
  return { artifacts: artifacts.map((each) => clientSummary(each, store)), next }
}

function timeline(store: ArtifactStore, scope: Scope, limit = 200, before?: string) {
  const { entries, next } = store.timeline(scope, { limit, before })
  return { entries: entries.map(({ artifact, version }) => ({ artifact: clientHeader(artifact, store), version: clientVersion(version) })), next }
}

/** What `read` gives now, and again each time something in the record changes, a line each. */
function followed(store: ArtifactStore, read: () => unknown, signal?: AbortSignal): Response {
  const encoder = new TextEncoder()
  let stop = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Its client gone already: nothing to follow.
      if (signal?.aborted) return controller.close()
      let last = ""
      let pending: ReturnType<typeof setTimeout> | undefined
      const look = () => {
        pending = undefined
        const line = JSON.stringify(read())
        if (line === last) return
        last = line
        try {
          controller.enqueue(encoder.encode(line + "\n"))
        } catch {
          stop()
        }
      }
      // Several changes at once (a turn's edits) go as one line.
      const unsubscribe = store.onChange(() => {
        pending ??= setTimeout(look, 100)
      })
      const onAbort = () => {
        stop()
        try {
          controller.close()
        } catch {}
      }
      stop = () => {
        unsubscribe()
        if (pending) clearTimeout(pending)
        signal?.removeEventListener("abort", onAbort)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      look()
    },
    cancel() {
      stop()
    },
  })
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } })
}
