// A stand-in engine for the box's keywords (goals, side questions, handoffs, reviews): its HTTP API
// and live event feed, a turn for each note to the agent as `turns` script them, and one-off
// answers in turn (a goal's check's verdicts, others' answers).

import { emit } from "../../../src/agents/events"

/** `steps`: model calls before its last, each a message of its own, as a long turn has them. */
export type Turn = { text?: string; tool?: boolean; steps?: number; outcome?: "succeeded" | "failed" | "interrupted"; error?: string }

/** The engine: a turn for each note, as `turns` script them, and the goal check's verdicts in turn. */
export class StandIn {
  readonly conversations = new Map<string, any[]>()
  readonly synthetic: { session: string; text: string; description?: string }[] = []
  /** Each check asked: afresh on the session's model (`fresh`), or in the session's own context (`own`). */
  readonly checks: { kind: "fresh" | "own"; prompt: string; model?: any; session?: string }[] = []
  /** Messages sent as yours (`/prompt`), by session. */
  readonly prompted: { session: string; text: string }[] = []
  prompts(session: string) {
    return this.prompted.filter((each) => each.session === session)
  }
  /** Sessions made through it (`POST /api/session`), with what they were made with. */
  readonly made: any[] = []
  verdicts: string[] = []
  /** A goal's check fails with these words (a model's limit, say), rather than answering. */
  verdictError?: string
  turns: Turn[] = []
  /** Turns that wait for `finish` rather than ending at once. */
  holding = false
  /** Goal checks that wait for `answerChecks`. */
  holdingChecks = false
  /** Reads of a conversation's messages that wait for `answerReads` (a look under way). */
  holdingReads = false
  /** Its model is one of OpenCode's free ones, which answer a check only in the session's own context. */
  freeModel = false
  /** A note sent while a turn runs waits for it to end (as the bridge's sessions take them), rather than joining it. */
  queuesNotes = false
  /** The folder its sessions work in. */
  directory = "/tmp/project"
  /** Sessions whose parent is another (a subagent's). */
  readonly parents = new Map<string, string>()
  /** Metadata given to sessions, by session, as last set. */
  readonly metadata = new Map<string, any>()
  /** Titles given to sessions, by session. */
  readonly titles = new Map<string, string>()
  /** More of what a session says of itself (its agent, permissions, a model with its effort), by session. */
  readonly details = new Map<string, any>()
  /** Its events go out as the bridge's own (`emit`), not on its feed. */
  emitsAsBridge = false
  /** A message sent as yours (`/prompt`) takes a turn, as `turns` script it. */
  promptsTakeTurns = false
  /** Sessions deleted (`DELETE /api/session/<id>`). */
  readonly deleted: string[] = []
  /** Sessions interrupted (`POST /api/session/<id>/interrupt`). */
  readonly interrupted: string[] = []
  private held: (() => void)[] = []
  private heldChecks: (() => void)[] = []
  private heldReads: (() => void)[] = []
  private queued = new Map<string, { text: string; description?: string }[]>()
  private busy = new Set<string>()
  private feeds = new Set<ReadableStreamDefaultController<Uint8Array>>()
  private next = 1
  private server: ReturnType<typeof Bun.serve>

  constructor(private readonly beat: () => void) {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (request) => this.answer(request) })
  }

  get url() {
    return `http://127.0.0.1:${this.server.port}`
  }

  get listening() {
    return this.feeds.size > 0
  }

  stop() {
    for (const feed of this.feeds) feed.close()
    this.server.stop(true)
  }

  session(id: string, messages: any[] = []) {
    this.conversations.set(id, messages)
  }

  /** You (or another client) wrote to it: it takes a turn. */
  write(session: string, text: string) {
    this.add(session, { type: "user", text })
    this.turn(session)
  }

  /** The turns held, ended. */
  finish() {
    for (const end of this.held.splice(0)) end()
  }

  /** A note that waited for the turn before it: its own turn now. */
  deliver(session: string) {
    const waiting = this.queued.get(session)?.shift()
    if (!waiting) return
    this.add(session, { type: "synthetic", text: waiting.text, description: waiting.description })
    this.turn(session)
  }

  answerChecks() {
    for (const answer of this.heldChecks.splice(0)) answer()
  }

  get readsHeld() {
    return this.heldReads.length
  }

  /** The reads held, answered as the conversation is now; later ones aren't held. */
  answerReads() {
    this.holdingReads = false
    for (const answer of this.heldReads.splice(0)) answer()
  }

  /** Told each event it sends, as a place's `listen` would be. */
  onEmit?: (type: string, data: any) => void

  emit(type: string, data: any) {
    this.onEmit?.(type, data)
    if (this.emitsAsBridge) return void emit(type, data)
    const line = new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_${this.next++}`, type, data })}\n\n`)
    for (const feed of this.feeds) feed.enqueue(line)
  }

  private add(session: string, message: any) {
    this.conversations.get(session)!.push({ id: `msg_${String(this.next++).padStart(4, "0")}`, time: { created: Date.now() }, ...message })
  }

  private note(session: string, text: string, description?: string) {
    this.synthetic.push({ session, text, description })
    this.add(session, { type: "synthetic", text, description })
  }

  private turn(session: string) {
    const turn = this.turns.shift() ?? { tool: true, text: "Working on it." }
    this.busy.add(session)
    this.emit("session.execution.started", { sessionID: session })
    const end = () => {
      for (let step = 0; step < (turn.steps ?? 0); step++) this.add(session, { type: "assistant", content: [{ type: "text", text: `Step ${step + 1}.` }] })
      const content = [...(turn.tool ? [{ type: "tool", name: "bash", state: { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "1 failing" }] } }] : []), ...(turn.text ? [{ type: "text", text: turn.text }] : [])]
      if (content.length) this.add(session, { type: "assistant", content })
      const outcome = turn.outcome ?? "succeeded"
      this.add(session, { type: "idle", outcome, ...(turn.error ? { error: { message: turn.error } } : {}) })
      this.busy.delete(session)
      this.emit(`session.execution.${outcome}`, { sessionID: session })
      this.beat()
    }
    if (this.holding) this.held.push(end)
    else end()
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)
    if (url.pathname === "/api/event") {
      let controller: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start: (feed) => {
          controller = feed
          this.feeds.add(feed)
          this.beat()
        },
        cancel: () => void this.feeds.delete(controller),
      })
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
    }
    const body: any = request.method === "POST" || request.method === "PATCH" ? await request.json().catch(() => ({})) : undefined
    try {
      if (url.pathname === "/api/session/active") return Response.json({ data: Object.fromEntries([...this.busy].map((id) => [id, { type: "busy" }])) })
      if (url.pathname === "/api/experimental/generate") {
        if (this.freeModel) return Response.json({ message: "Free usage limit reached." }, { status: 503 })
        return await this.check("fresh", body.prompt, body.model)
      }
      // Sessions made through it, a page (no cursor): those in `directory` when it's asked.
      if (url.pathname === "/api/session" && request.method === "GET") {
        this.listings += 1
        const directory = url.searchParams.get("directory")
        const listed = this.made.filter((each) => this.conversations.has(each.id) && (!directory || each.location?.directory === directory))
        for (const answer of this.heldMade.splice(0)) answer()
        return Response.json({ data: listed.map((each) => ({ id: each.id, ...(each.parentID ? { parentID: each.parentID } : {}), ...(each.metadata ? { metadata: each.metadata } : {}), location: each.location })) })
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        const id = `ses_made${this.next++}`
        this.made.push({ id, ...body })
        this.conversations.set(id, [])
        if (body?.title) this.titles.set(id, body.title)
        // As the engine says it: flat, with its parent.
        this.emit("session.created", { sessionID: id, ...(body?.parentID ? { parentID: body.parentID } : {}) })
        // Made, its answer on its way back until sessions are next listed.
        if (this.answersMadeOnListing && body?.metadata?.kuvo?.reviewPart) {
          this.beat()
          await new Promise<void>((resolve) => this.heldMade.push(resolve))
        }
        return Response.json({ data: { id, ...body } })
      }
      const [, , session, what] = parts
      if (what === "message" && this.holdingMessages) {
        this.heldMessages += 1
        this.beat()
        await new Promise<void>((resolve) => this.messagesHeld.push(resolve))
      }
      if (what === "message" && this.holdingReads) await new Promise<void>((resolve) => (this.heldReads.push(resolve), this.beat()))
      const conversation = this.conversations.get(session)
      if (!conversation) return Response.json({ message: "No such session." }, { status: 404 })
      if (!what && request.method === "DELETE") {
        this.deleted.push(session)
        this.conversations.delete(session)
        return Response.json({ data: {} })
      }
      if (!what && request.method === "PATCH") {
        if (typeof body?.title === "string") this.titles.set(session, body.title)
        if (body?.metadata) this.metadata.set(session, body.metadata)
        return Response.json({ data: {} })
      }
      if (!what) return Response.json({ data: { id: session, model: { providerID: "p", id: "m" }, ...(this.details.get(session) ?? {}), ...(this.titles.has(session) ? { title: this.titles.get(session) } : {}), ...(this.parents.has(session) ? { parentID: this.parents.get(session) } : {}), ...(this.metadata.has(session) ? { metadata: this.metadata.get(session) } : {}), location: { directory: this.directory } } })
      if (what === "message") {
        // Newest first, or oldest first with `order=asc`, `limit` at most, as the engine pages them:
        // the next page from `cursor`, which a page names while there's more.
        const ordered = url.searchParams.get("order") === "asc" ? [...conversation] : [...conversation].reverse()
        const after = url.searchParams.get("cursor")
        const start = after ? ordered.findIndex((message) => message.id === after) + 1 : 0
        const limit = Number(url.searchParams.get("limit") ?? ordered.length) || ordered.length
        const data = ordered.slice(start, start + limit)
        return Response.json({ data, cursor: start + limit < ordered.length ? { next: data.at(-1).id } : {} })
      }
      if (what === "synthetic") {
        if (this.busy.has(session) && this.queuesNotes) {
          this.synthetic.push({ session, text: body.text, description: body.description })
          this.queued.set(session, [...(this.queued.get(session) ?? []), { text: body.text, description: body.description }])
        } else if (this.busy.has(session)) {
          // Steered into the turn under way: the agent reads it at its next step.
          this.note(session, body.text, body.description)
        } else {
          this.note(session, body.text, body.description)
          this.turn(session)
        }
        return Response.json({ data: {} })
      }
      if (what === "fork") {
        // A copy up to the message, with its source's metadata, as the coding agents' bridge makes one.
        const at = conversation.findIndex((message) => message.id === body?.before)
        if (at < 0) return Response.json({ message: "That message isn't in this session." }, { status: 404 })
        const id = `ses_fork${this.next++}`
        this.conversations.set(id, structuredClone(conversation.slice(0, at)))
        if (this.titles.has(session)) this.titles.set(id, this.titles.get(session)!)
        if (this.metadata.has(session)) this.metadata.set(id, structuredClone(this.metadata.get(session)))
        return Response.json({ data: { id, title: this.titles.get(id), ...(this.metadata.has(id) ? { metadata: this.metadata.get(id) } : {}), location: { directory: this.directory } } })
      }
      if (what === "generate") return await this.check("own", body.prompt, undefined, session)
      if (what === "prompt") {
        this.prompted.push({ session, text: body.text })
        // A review's part: its reviewer answers as a one-off answer would, in a turn of its own.
        const made = this.made.find((each) => each.id === session)
        if (made?.metadata?.kuvo?.reviewPart) {
          // Taken, not yet begun (its answer on its way back).
          if (this.holdingPrompts) {
            this.beat()
            await new Promise<void>((resolve) => this.heldPrompts.push(resolve))
          }
          this.add(session, { type: "user", text: body.text })
          if (this.turnsBeginLate) this.heldTurns.push(() => void this.readPart(session, body.text, made.model))
          else void this.readPart(session, body.text, made.model)
          return Response.json({ data: {} })
        }
        if (this.promptsTakeTurns) {
          this.add(session, { type: "user", text: body.text })
          this.turn(session)
        }
        return Response.json({ data: {} })
      }
      if (what === "interrupt") {
        this.interrupted.push(session)
        // A part reading ends where it is, as the engine stops a turn.
        if (this.interruptEndsParts && this.busy.has(session) && this.made.find((each) => each.id === session)?.metadata?.kuvo?.reviewPart) {
          this.busy.delete(session)
          this.add(session, { type: "idle", outcome: "interrupted" })
          this.emit("session.execution.interrupted", { sessionID: session })
        }
        return Response.json({ data: {} })
      }
      return Response.json({ data: {} })
    } finally {
      this.beat()
    }
  }

  /** What a one-off answer says when it isn't a goal's check (a side question's answer, a handoff's note, a review), in turn. */
  answers: string[] = []

  /** A review's part read in its session: counted with the checks, held with them, its answer the next one scripted. */
  private async readPart(session: string, prompt: string, model?: any) {
    this.checks.push({ kind: "fresh", prompt, ...(model ? { model } : {}), session })
    this.busy.add(session)
    this.emit("session.execution.started", { sessionID: session })
    this.beat()
    if (this.holdingChecks) await new Promise<void>((resolve) => this.heldChecks.push(resolve))
    if (!this.conversations.has(session) || !this.busy.has(session)) return
    const failing = this.failingParts > 0
    if (failing) this.failingParts -= 1
    if (!failing) this.add(session, { type: "assistant", content: [{ type: "text", text: this.answers.shift() ?? `{"summary": "Fine.", "findings": []}` }] })
    this.add(session, { type: "idle", outcome: failing ? "failed" : "succeeded" })
    this.busy.delete(session)
    if (!this.silentParts) this.emit(failing ? "session.execution.failed" : "session.execution.succeeded", { sessionID: session })
    this.beat()
  }

  /** A conversation's messages are answered only at `answerMessages`, as it is then. */
  holdingMessages = false
  /** Times its messages were asked for while `holdingMessages`. */
  heldMessages = 0
  private messagesHeld: (() => void)[] = []
  answerMessages() {
    for (const answer of this.messagesHeld.splice(0)) answer()
  }

  /** A part's prompt is taken but its turn doesn't begin until `beginPrompts`. */
  holdingPrompts = false
  private heldPrompts: (() => void)[] = []
  beginPrompts() {
    for (const begin of this.heldPrompts.splice(0)) begin()
  }
  /** A part's prompt is answered before its turn begins, at `beginTurns`. */
  turnsBeginLate = false
  private heldTurns: (() => void)[] = []
  beginTurns() {
    for (const begin of this.heldTurns.splice(0)) begin()
  }
  /** A part's session, once made, is answered for only as sessions are next listed. */
  answersMadeOnListing = false
  private heldMade: (() => void)[] = []
  /** Times sessions were listed (`GET /api/session`). */
  listings = 0
  /** An interrupt ends a part's turn as interrupted (the engine's way); otherwise it's only counted. */
  interruptEndsParts = false

  /** Parts whose reading fails, next. */
  failingParts = 0
  /** A part's end goes untold (its events lost, as when the feed was away). */
  silentParts = false

  /** The feed drops, as when the engine's connection blips: a client connects again. */
  drop() {
    for (const feed of this.feeds) feed.close()
    this.feeds.clear()
  }

  private async check(kind: "fresh" | "own", prompt: string, model?: any, session?: string) {
    this.checks.push({ kind, prompt, ...(model ? { model } : {}), ...(session ? { session } : {}) })
    this.beat()
    if (this.holdingChecks) await new Promise<void>((resolve) => this.heldChecks.push(resolve))
    if (this.verdictError && prompt.includes("<goal>")) return Response.json({ message: this.verdictError }, { status: 429 })
    // Met, once the script runs out.
    if (!prompt.includes("<goal>") && this.answers.length) return Response.json({ data: { text: this.answers.shift() } })
    return Response.json({ data: { text: this.verdicts.shift() ?? `{"verdict": "met", "reason": "Done."}` } })
  }
}

