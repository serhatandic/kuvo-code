// A stand-in engine for the box's keywords (goals, side questions, handoffs, reviews): its HTTP API
// and live event feed, a turn for each note to the agent as `turns` script them, and one-off
// answers in turn (a goal's check's verdicts, others' answers).

import { emit } from "../../../src/agents/events"

export type Turn = { text?: string; tool?: boolean; outcome?: "succeeded" | "failed" | "interrupted"; error?: string }

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
  turns: Turn[] = []
  /** Turns that wait for `finish` rather than ending at once. */
  holding = false
  /** Goal checks that wait for `answerChecks`. */
  holdingChecks = false
  /** Its model is one of OpenCode's free ones, which answer a check only in the session's own context. */
  freeModel = false
  /** A note sent while a turn runs waits for it to end (as the bridge's sessions take them), rather than joining it. */
  queuesNotes = false
  /** The folder its sessions work in. */
  directory = "/tmp/project"
  /** What each session asks you and waits on (its permissions and questions), by session. */
  readonly asks = new Map<string, { permission?: any[]; form?: any[] }>()
  /** How often what a session waits on was asked for. */
  asksLooked = 0
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
  private held: (() => void)[] = []
  private heldChecks: (() => void)[] = []
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

  emit(type: string, data: any) {
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
      if (url.pathname === "/api/session" && request.method === "POST") {
        const id = `ses_made${this.next++}`
        this.made.push({ id, ...body })
        this.conversations.set(id, [])
        if (body?.title) this.titles.set(id, body.title)
        return Response.json({ data: { id, ...body } })
      }
      const [, , session, what] = parts
      const conversation = this.conversations.get(session)
      if (!conversation) return Response.json({ message: "No such session." }, { status: 404 })
      if (!what && request.method === "DELETE") {
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
        // Newest first, or oldest first with `order=asc`, `limit` at most, as the engine pages them.
        const ordered = url.searchParams.get("order") === "asc" ? [...conversation] : [...conversation].reverse()
        return Response.json({ data: ordered.slice(0, Number(url.searchParams.get("limit") ?? ordered.length) || ordered.length) })
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
      if ((what === "permission" || what === "form") && request.method === "GET") {
        this.asksLooked += 1
        return Response.json({ data: this.asks.get(session)?.[what] ?? [] })
      }
      if (what === "generate") return await this.check("own", body.prompt, undefined, session)
      if (what === "prompt") {
        this.prompted.push({ session, text: body.text })
        return Response.json({ data: {} })
      }
      return Response.json({ data: {} })
    } finally {
      this.beat()
    }
  }

  /** What a one-off answer says when it isn't a goal's check (a side question's answer, a handoff's note, a review), in turn. */
  answers: string[] = []

  private async check(kind: "fresh" | "own", prompt: string, model?: any, session?: string) {
    this.checks.push({ kind, prompt, ...(model ? { model } : {}), ...(session ? { session } : {}) })
    this.beat()
    if (this.holdingChecks) await new Promise<void>((resolve) => this.heldChecks.push(resolve))
    // Met, once the script runs out.
    if (!prompt.includes("<goal>") && this.answers.length) return Response.json({ data: { text: this.answers.shift() } })
    return Response.json({ data: { text: this.verdicts.shift() ?? `{"verdict": "met", "reason": "Done."}` } })
  }
}

