// One run of an agent, told as the engine tells its own: steps (one model call each) with their
// words, thinking and tool calls, as events the app's transcript applies, and as messages kept for
// a later read. Agents report what happens in plain calls; this keeps both in step.

import { emit } from "./events"
import { messageID, newID } from "./ids"
import type { Store } from "./store"
import type { AssistantMessage, Content, ModelRef, StructuredError, TokenUsage, ToolCall, ToolOutput } from "./wire"
import { noTokens } from "./wire"

export type Outcome = "succeeded" | "failed" | "interrupted"

export interface StepEnd {
  tokens?: TokenUsage
  cost?: number
  finish?: string
  error?: StructuredError
}

export class Turn {
  private step?: AssistantMessage
  /** The block being written: its kind and which of its kind it is in the step. */
  private block?: { kind: "text" | "reasoning"; ordinal: number; content: Content }
  /**
   * Blocks an agent keeps apart itself (the engine's, by kind and number): what's written for
   * each goes to it, even while another is being written (thinking and words interleave).
   */
  private keyed = new Map<string, { kind: "text" | "reasoning"; ordinal: number; content: Content }>()
  /** Each tool call's step: results come after the step that called them has ended. */
  private tools = new Map<string, { step: AssistantMessage; call: ToolCall }>()
  private ended = false
  readonly started = Date.now()
  /** What the run used, in all its steps. */
  tokens: TokenUsage = noTokens()
  cost = 0

  constructor(
    private readonly store: Store,
    readonly sessionID: string,
    private readonly directory: string,
    private model: ModelRef,
    private readonly agent: string,
  ) {
    emit("session.execution.started", { sessionID }, directory)
  }

  get isEnded() {
    return this.ended
  }

  private get messages() {
    return this.store.get(this.sessionID)?.messages ?? []
  }

  private save() {
    this.store.save(this.sessionID)
  }

  private send(type: string, data: Record<string, unknown>) {
    emit(type, { sessionID: this.sessionID, ...data }, this.directory)
  }

  setModel(model: ModelRef) {
    this.model = model
  }

  /** The model it runs on now. */
  get currentModel(): ModelRef {
    return this.model
  }

  // MARK: Steps

  /** A new model call. Any step still open ends first. */
  startStep(model?: ModelRef): string {
    if (this.ended) return ""
    if (this.step) this.endStep()
    const step: AssistantMessage = {
      type: "assistant",
      id: newID("msg"),
      time: { created: Date.now() },
      agent: this.agent,
      model: model ?? this.model,
      content: [],
    }
    this.step = step
    this.messages.push(step)
    this.send("session.step.started", { assistantMessageID: step.id, agent: step.agent, model: step.model, started: step.time.created })
    this.save()
    return step.id
  }

  private ensureStep(): AssistantMessage {
    if (!this.step) this.startStep()
    return this.step!
  }

  endStep(end: StepEnd = {}) {
    const step = this.step
    if (!step || this.ended) return
    this.endBlock()
    for (const key of [...this.keyed.keys()]) this.blockEnd(key)
    step.time.completed = Date.now()
    if (end.finish) step.finish = end.finish
    if (end.tokens) {
      step.tokens = end.tokens
      this.tokens = add(this.tokens, end.tokens)
    }
    if (end.cost !== undefined) {
      step.cost = end.cost
      this.cost += end.cost
    }
    if (end.error) step.error = end.error
    this.send("session.step.ended", {
      assistantMessageID: step.id,
      finish: step.finish ?? (end.error ? "error" : "stop"),
      cost: step.cost,
      tokens: step.tokens,
      error: end.error,
    })
    this.step = undefined
    this.save()
  }

  /** Usage reported for the whole run at its end, when the agent gives no per-step figures. */
  addUsage(tokens?: TokenUsage, cost?: number) {
    if (this.ended) return
    if (tokens) this.tokens = add(this.tokens, tokens)
    if (cost) this.cost += cost
  }

  // MARK: Words and thinking

  text(delta: string) {
    this.write("text", delta)
  }

  reasoning(delta: string) {
    this.write("reasoning", delta)
  }

  private write(kind: "text" | "reasoning", delta: string) {
    if (!delta || this.ended) return
    const step = this.ensureStep()
    if (this.block?.kind !== kind) {
      this.endBlock()
      const ordinal = step.content.filter((content) => content.type === kind).length
      const content: Content = kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "", time: { created: Date.now() } }
      step.content.push(content)
      this.block = { kind, ordinal, content }
      if (!step.time.streamed) step.time.streamed = Date.now()
      this.send(`session.${kind}.started`, { assistantMessageID: step.id, ordinal })
    }
    ;(this.block.content as { text: string }).text += delta
    this.send(`session.${kind}.delta`, { assistantMessageID: step.id, ordinal: this.block.ordinal, delta })
    this.save()
  }

  /** A block of the agent's own (see `keyed`) begins, if it hasn't. */
  blockStart(key: string, kind: "text" | "reasoning") {
    if (this.ended || this.keyed.has(key)) return
    const step = this.ensureStep()
    const ordinal = step.content.filter((content) => content.type === kind).length
    const content: Content = kind === "text" ? { type: "text", text: "" } : { type: "reasoning", text: "", time: { created: Date.now() } }
    step.content.push(content)
    this.keyed.set(key, { kind, ordinal, content })
    if (!step.time.streamed) step.time.streamed = Date.now()
    this.send(`session.${kind}.started`, { assistantMessageID: step.id, ordinal })
  }

  blockDelta(key: string, kind: "text" | "reasoning", delta: string) {
    if (!delta || this.ended) return
    if (!this.keyed.has(key)) this.blockStart(key, kind)
    const block = this.keyed.get(key)
    const step = this.step
    if (!block || !step) return
    ;(block.content as { text: string }).text += delta
    this.send(`session.${kind}.delta`, { assistantMessageID: step.id, ordinal: block.ordinal, delta })
    this.save()
  }

  blockEnd(key: string) {
    const block = this.keyed.get(key)
    const step = this.step
    if (!block || !step) return
    this.keyed.delete(key)
    if (block.content.type === "reasoning") block.content.time = { created: block.content.time?.created ?? Date.now(), completed: Date.now() }
    this.send(`session.${block.kind}.ended`, { assistantMessageID: step.id, ordinal: block.ordinal, text: (block.content as { text: string }).text })
  }

  /** The words or thinking being written are done (a tool call or another block follows). */
  endBlock() {
    const block = this.block
    const step = this.step
    if (!block || !step) return
    this.block = undefined
    if (block.content.type === "reasoning") block.content.time = { created: block.content.time?.created ?? Date.now(), completed: Date.now() }
    const text = (block.content as { text: string }).text
    this.send(`session.${block.kind}.ended`, { assistantMessageID: step.id, ordinal: block.ordinal, text })
  }

  // MARK: Tools

  /** A tool call begins; with `input`, it's called right away. */
  toolStart(id: string, name: string, input?: unknown) {
    if (this.ended) return
    if (this.tools.has(id)) {
      if (input !== undefined) this.toolCalled(id, input)
      return
    }
    this.endBlock()
    const step = this.ensureStep()
    const call: ToolCall = { type: "tool", id, name, state: { status: "streaming", input: "" }, time: { created: Date.now() } }
    step.content.push(call)
    this.tools.set(id, { step, call })
    this.send("session.tool.input.started", { assistantMessageID: step.id, id, name })
    if (input !== undefined) this.toolCalled(id, input)
    this.save()
  }

  /** The tool's name, changed as more is known: told as its start again, with the name it has now. */
  toolRename(id: string, name: string) {
    const tool = this.tools.get(id)
    if (!tool || tool.call.name === name) return
    tool.call.name = name
    if (this.ended) return
    this.send("session.tool.input.started", { assistantMessageID: tool.step.id, id, name })
    this.save()
  }

  toolInputDelta(id: string, delta: string) {
    const tool = this.tools.get(id)
    if (!tool || tool.call.state.status !== "streaming" || this.ended) return
    tool.call.state.input += delta
    this.send("session.tool.input.delta", { assistantMessageID: tool.step.id, id, delta })
  }

  toolCalled(id: string, input: unknown) {
    if (this.ended) return
    const tool = this.tools.get(id)
    if (!tool) return this.toolStart(id, "tool", input)
    if (tool.call.state.status === "completed" || tool.call.state.status === "error") return
    if (tool.call.state.status === "streaming") {
      this.send("session.tool.input.ended", { assistantMessageID: tool.step.id, id, text: JSON.stringify(input) })
    }
    tool.call.state = { status: "running", input, metadata: tool.call.state.status === "running" ? tool.call.state.metadata : undefined }
    tool.call.time = { ...tool.call.time, ran: tool.call.time?.ran ?? Date.now() }
    this.send("session.tool.called", { assistantMessageID: tool.step.id, id, input })
    this.save()
  }

  /** What a running tool has to show so far (a command's output, as it comes). */
  toolProgress(id: string, metadata: Record<string, unknown>) {
    const tool = this.tools.get(id)
    if (!tool || tool.call.state.status !== "running" || this.ended) return
    // Added to what it said before (a subagent's session stays with its progress).
    const merged = { ...((tool.call.state.metadata as Record<string, unknown> | undefined) ?? {}), ...metadata }
    tool.call.state.metadata = merged
    this.send("session.tool.progress", { assistantMessageID: tool.step.id, id, metadata: merged })
    this.save()
  }

  toolSucceeded(id: string, output: string | ToolOutput[], metadata?: Record<string, unknown>) {
    const tool = this.tools.get(id)
    if (!tool || this.ended) return
    if (tool.call.state.status === "streaming") this.toolCalled(id, safeJSON(tool.call.state.input))
    if (tool.call.state.status !== "running") return
    const content: ToolOutput[] = typeof output === "string" ? [{ type: "text", text: output }] : output
    tool.call.state = { status: "completed", input: tool.call.state.input, content, metadata: metadata ?? tool.call.state.metadata }
    tool.call.time = { ...tool.call.time, completed: Date.now() }
    this.send("session.tool.success", { assistantMessageID: tool.step.id, id, content, metadata: tool.call.state.metadata })
    this.save()
  }

  toolFailed(id: string, message: string, metadata?: Record<string, unknown>, type = "tool") {
    const tool = this.tools.get(id)
    if (!tool || this.ended) return
    if (tool.call.state.status === "completed" || tool.call.state.status === "error") return
    const input = tool.call.state.status === "streaming" ? safeJSON(tool.call.state.input) : tool.call.state.input
    const error = { type, message }
    const content: ToolOutput[] = message ? [{ type: "text", text: message }] : []
    // What it said while it ran (a subagent's session) stays, unless said anew.
    const kept = metadata ?? (tool.call.state.status === "running" ? tool.call.state.metadata : undefined)
    tool.call.state = { status: "error", input, error, content, metadata: kept }
    tool.call.time = { ...tool.call.time, completed: Date.now() }
    this.send("session.tool.failed", { assistantMessageID: tool.step.id, id, error, content, metadata: kept })
    this.save()
  }

  /** A note in the conversation from Kuvo Code, not the agent: "Going on with Codex…". */
  notice(text: string) {
    if (this.ended) return
    this.endBlock()
    if (this.step) this.endStep()
    const event = emit("session.synthetic", { sessionID: this.sessionID, text }, this.directory)
    this.messages.push({ type: "synthetic", id: messageID(event.id), time: { created: event.created }, text })
    this.save()
  }

  /** Tools still running from an attempt that gave up (Auto goes on with another model): stopped. */
  stopTools(message: string) {
    for (const [id, tool] of this.tools) {
      const status = tool.call.state.status
      if (status === "running" || status === "streaming") this.toolFailed(id, message)
    }
  }

  hasTool(id: string) {
    return this.tools.has(id)
  }

  toolInput(id: string): unknown {
    const state = this.tools.get(id)?.call.state
    return state && state.status !== "streaming" ? state.input : undefined
  }

  /** The step a tool call is in, for a permission it asks. */
  toolStep(id: string): string | undefined {
    return this.tools.get(id)?.step.id
  }

  // MARK: The end

  /** Ends the run: open steps close, tools still running are stopped, and the idle marker goes in. */
  finish(outcome: Outcome, error?: StructuredError) {
    if (this.ended) return
    this.endBlock()
    if (this.step) this.endStep(error && outcome === "failed" ? { error } : {})
    for (const [id, tool] of this.tools) {
      const status = tool.call.state.status
      if (status === "running" || status === "streaming") this.toolFailed(id, outcome === "interrupted" ? "Stopped." : "", undefined, outcome === "interrupted" ? "aborted" : "tool")
    }
    // Nothing more goes in (an agent given up on, still talking).
    this.ended = true
    const type = outcome === "succeeded" ? "session.execution.succeeded" : outcome === "failed" ? "session.execution.failed" : "session.execution.interrupted"
    const event = emit(type, { sessionID: this.sessionID, error }, this.directory)
    const record = this.store.get(this.sessionID)
    if (record) {
      record.messages.push({ type: "idle", id: messageID(event.id), time: { created: event.created }, outcome, error })
      const session = record.session
      session.outcome = outcome
      session.time.idle = event.created
      session.time.updated = event.created
      session.tokens = add(session.tokens, this.tokens)
      session.cost += this.cost
      emit("session.usage.updated", { sessionID: this.sessionID, cost: session.cost, tokens: session.tokens }, this.directory)
      this.store.save(this.sessionID, true)
    }
  }
}

function add(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
  }
}

function safeJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}
