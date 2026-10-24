// A stand-in engine for group chat tests: each seat answers its turn with its bot's next line (PASS
// once it has none), as the Mac's GroupChatTests do. Shared by the runner's tests and the tests of
// chats across computers.

/** The engine on the machine: each seat answers its turn with its bot's next line (PASS once it has none). */
export class Engine {
  readonly requests: { method: string; path: string; body: any; directory?: string }[] = []
  private seats = new Map<string, string>()
  private conversations = new Map<string, any[]>()
  private next = 1
  private server: ReturnType<typeof Bun.serve>
  /** What each bot's seat says, in turn, and what its own conversation reports on a part. */
  lines: Record<string, string[]> = {}
  reports: Record<string, string> = {}
  /** A seat that asks permission before it answers. */
  asking = new Set<string>()
  private permissions = new Map<string, { id: string }[]>()
  /** Bots whose seats take a while (at work meanwhile), and ones whose prompts stay queued. */
  slow = new Map<string, number>()
  stuck = new Set<string>()
  /** How much a bot's seat sends the model at each step (its context, in tokens): one for every reply, or one for each in turn (the last kept). */
  sizes: Record<string, number | number[]> = {}
  /** Prompts that take this long, by what they say. */
  slowPrompts = new Map<string, number>()
  /** A slow bot's thinking, shown with a file it reads, while it's at work. */
  working = new Map<string, string>()
  /** The accounts the engine lists, those it has ready, and seats whose provider turns them down with `failing`'s words. */
  integrations: any[] = [{ id: "p", name: "Provider P", methods: [{ type: "key" }], connections: [{ id: "c" }] }]
  providers: any[] = [{ id: "p" }]
  /** The model each bot's own conversation is on, when not its seat's ("m" of "p"). */
  ownModels: Record<string, { id: string; providerID: string }> = {}
  failing = new Map<string, string>()
  /** What MCP servers ask in a project folder (filed under no session), by folder. */
  shared = new Map<string, any[]>()
  /** A slow bot's tool still running while it's at work (an MCP server's), by its name. */
  running = new Map<string, string>()
  private busy = new Set<string>()
  private queued = new Map<string, { id: string }[]>()
  private deleted = new Set<string>()
  /** Each conversation's metadata, as it was set. */
  readonly metadata = new Map<string, any>()

  /** `onRequest`: told after each request is noted (what a test's wait looks again on). */
  constructor(private readonly onRequest?: () => void) {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => this.answer(request) })
  }

  get url() {
    return `http://127.0.0.1:${this.server.port}`
  }

  stop() {
    this.server.stop(true)
  }

  /** A conversation as it is already (a bot's own, with a part it was given before). */
  seed(session: string, messages: any[]) {
    this.conversations.set(session, messages)
  }

  seatsMade() {
    return this.requests.filter((request) => request.method === "POST" && request.path === "/api/session").map((request) => request.body.title as string)
  }

  prompts(session?: string) {
    return this.requests.filter((request) => request.path.endsWith("/prompt") && (!session || request.path.includes(session)))
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body: any = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json().catch(() => ({}))
    const header = request.headers.get("x-opencode-directory")
    this.requests.push({ method: request.method, path: url.pathname, body, ...(header ? { directory: decodeURIComponent(header) } : {}) })
    this.onRequest?.()
    const ok = (data: unknown = {}) => Response.json({ data })
    const parts = url.pathname.split("/").filter(Boolean)
    // What MCP servers ask, listed and turned down by folder.
    if (parts[2] === "global" && parts[3] === "form") {
      const folder = header ? decodeURIComponent(header) : ""
      if (request.method === "GET") return ok(this.shared.get(folder) ?? [])
      if (request.method === "DELETE") this.shared.set(folder, (this.shared.get(folder) ?? []).filter((form) => form.id !== parts[4]))
      return ok()
    }
    if (request.method === "POST" && url.pathname === "/api/session") {
      const id = `ses_seat${this.next++}`
      this.seats.set(id, String(body.title).split(" ")[0])
      return ok({ id, title: body.title, model: body.model, location: body.location })
    }
    if (request.method === "GET" && url.pathname === "/api/session") return ok([])
    if (url.pathname === "/api/integration") return ok(this.integrations)
    if (url.pathname === "/api/provider") return ok(this.providers)
    if (url.pathname === "/api/session/active") return ok(Object.fromEntries([...this.busy].map((id) => [id, { type: "busy" }])))
    const session = parts[2]
    const what = parts[3]
    // A seat deleted: gone, its run with it.
    if (request.method === "DELETE" && !what) {
      this.deleted.add(session)
      this.busy.delete(session)
      return ok()
    }
    if (this.deleted.has(session)) return Response.json({ message: "No such session." }, { status: 404 })
    if (request.method === "GET" && !what) {
      const own = session.startsWith("ses_own_") ? this.ownModels[session.slice("ses_own_".length)] : undefined
      return ok({ id: session, model: own ?? { id: "m", providerID: "p" }, ...(this.metadata.has(session) ? { metadata: this.metadata.get(session) } : {}) })
    }
    // Its metadata, as the engine keeps it (a seat's says whose it is).
    if (request.method === "PATCH" && !what && body?.metadata) {
      this.metadata.set(session, { ...(this.metadata.get(session) ?? {}), ...body.metadata })
      return ok()
    }
    // Steered into a run under way: it hears it at its next step, and its run goes on.
    if (what === "prompt" && body.delivery === "steer" && this.busy.has(session)) return ok()
    if (what === "prompt" && this.stuck.has(this.seats.get(session) ?? "")) {
      this.queued.set(session, [...(this.queued.get(session) ?? []), { id: body.id }])
      return ok()
    }
    if (what === "prompt") {
      const bot = this.seats.get(session)
      const owner = session.startsWith("ses_own_") ? session.slice("ses_own_".length) : undefined
      const line = bot ? (this.lines[bot]?.shift() ?? "PASS") : owner ? (this.reports[owner] ?? "") : ""
      const at = Date.now()
      const conversation = this.conversations.get(session) ?? []
      conversation.push({ type: "user", id: body.id, time: { created: at }, text: body.text })
      if (bot && this.asking.has(bot)) this.permissions.set(session, [{ id: "per_" + session }])
      const refused = bot ? this.failing.get(bot) : undefined
      if (refused) {
        conversation.push({ type: "assistant", id: body.id + "_a", time: { created: at + 1, completed: at + 2 }, agent: "build", model: { id: "m", providerID: "p" }, content: [], error: { message: refused } })
      } else if (line) {
        const sizes = bot ? this.sizes[bot] : undefined
        const size = Array.isArray(sizes) ? (sizes.length > 1 ? sizes.shift() : sizes[0]) : sizes
        conversation.push({ type: "assistant", id: body.id + "_a", time: { created: at + 1, completed: at + 2 }, agent: "build", model: { id: "m", providerID: "p" }, content: [{ type: "text", text: line }],
          ...(size ? { tokens: { input: size, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } : {}) })
      }
      const finish = () => {
        conversation.push({ type: "idle", id: body.id + "_i", time: { created: at + 3 }, outcome: "succeeded" })
        this.conversations.set(session, conversation)
        this.busy.delete(session)
      }
      const delay = (bot ? this.slow.get(bot) : undefined) ?? [...this.slowPrompts].find(([text]) => String(body.text).includes(text))?.[1]
      if (delay) {
        // At work a while, its answer not there yet.
        const said = conversation.pop()
        const thinking = bot ? this.working.get(bot) : undefined
        const tool = bot ? this.running.get(bot) : undefined
        if (tool) {
          conversation.push({ type: "assistant", id: body.id + "_t", time: { created: at + 1 }, agent: "build", model: { id: "m", providerID: "p" }, content: [
            { type: "tool", id: "call_t", name: tool, state: { status: "running", input: {} } },
          ] })
        }
        if (thinking) {
          conversation.push({ type: "assistant", id: body.id + "_w", time: { created: at + 1 }, agent: "build", model: { id: "m", providerID: "p" }, content: [
            { type: "reasoning", text: thinking },
            { type: "tool", id: "call_r", name: "read", state: { status: "completed", input: { path: "notes.txt" }, content: [{ type: "text", text: "what the notes say" }] } },
          ] })
        }
        this.conversations.set(session, conversation)
        this.busy.add(session)
        setTimeout(() => {
          if (said?.type === "assistant") conversation.push(said)
          finish()
        }, delay)
      } else {
        finish()
      }
      return ok()
    }
    if (what === "message") return ok([...(this.conversations.get(session) ?? [])].reverse())
    if (what === "inbox" && request.method === "GET") return ok(this.queued.get(session) ?? [])
    if (what === "inbox" && request.method === "DELETE") {
      this.queued.set(session, (this.queued.get(session) ?? []).filter((item) => item.id !== parts[4]))
      return ok()
    }
    if (what === "permission" && request.method === "GET") return ok(this.permissions.get(session) ?? [])
    if (what === "permission") {
      this.permissions.delete(session)
      return ok()
    }
    if (what === "form") return ok([])
    return ok()
  }
}
