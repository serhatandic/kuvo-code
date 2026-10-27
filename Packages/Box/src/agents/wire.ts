// The engine's wire format, the parts Kuvo Code reads (OpenCodeKit's Session, Message, events…).
// The bridge answers in it, so the app shows these sessions as it does the engine's.

export type Millis = number

export interface ModelRef {
  id: string
  providerID: string
  variant?: string
}

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export const noTokens = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

export interface StructuredError {
  type: string
  message: string
  status?: number
}

export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface Session {
  id: string
  parentID?: string
  projectID: string
  agent?: string
  model?: ModelRef
  cost: number
  tokens: TokenUsage
  outcome?: "succeeded" | "failed" | "interrupted"
  time: { created: Millis; updated: Millis; idle?: Millis; viewed?: Millis; archived?: Millis }
  title?: string
  location: { directory: string }
  permissions?: PermissionRule[]
  metadata?: Record<string, unknown>
  /** Taken back to before this message (undo), until the next message makes it final. */
  revert?: { messageID: string; files?: FileDiff[] }
}

export interface MessageTime {
  created: Millis
  streamed?: Millis
  completed?: Millis
}

export interface Attachment {
  mime: string
  name?: string
  data?: string
  source?: { type: "uri"; uri: string } | { type: "inline" }
}

export type ToolOutput = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }

export type ToolState =
  | { status: "streaming"; input: string }
  | { status: "running"; input: unknown; metadata?: unknown }
  | { status: "completed"; input: unknown; content: ToolOutput[]; metadata?: unknown }
  | { status: "error"; input: unknown; error: StructuredError; content?: ToolOutput[]; metadata?: unknown }

export interface ToolCall {
  type: "tool"
  id: string
  name: string
  state: ToolState
  time?: { created?: Millis; ran?: Millis; completed?: Millis }
}

export type Content = { type: "text"; text: string; time?: MessageTime } | { type: "reasoning"; text: string; time?: MessageTime } | ToolCall

export interface UserMessage {
  type: "user"
  id: string
  time: MessageTime
  text: string
  files?: Attachment[]
}

export interface AssistantMessage {
  type: "assistant"
  id: string
  time: MessageTime
  agent: string
  model: ModelRef
  content: Content[]
  finish?: string
  cost?: number
  tokens?: TokenUsage
  error?: StructuredError
}

export interface NoticeMessage {
  type: "synthetic" | "system"
  id: string
  time: MessageTime
  text: string
  description?: string
  /** What it's about, for the app (`source: "shell"`: a command left running ended). */
  metadata?: Record<string, unknown>
}

export interface IdleMessage {
  type: "idle"
  id: string
  time: MessageTime
  outcome: "succeeded" | "failed" | "interrupted"
  error?: StructuredError
}

export interface ModelSwitchMessage {
  type: "model-switched"
  id: string
  time: MessageTime
  model: ModelRef
  previous?: ModelRef
}

export interface AgentSwitchMessage {
  type: "agent-switched"
  id: string
  time: MessageTime
  agent: string
  previous?: string
}

/** A command you ran yourself with "!": it and what it printed are in the conversation. */
export interface ShellMessage {
  type: "shell"
  id: string
  time: MessageTime
  shellID: string
  command: string
  status: "running" | "completed" | "failed"
  exit?: number
  output?: { output: string; truncated: boolean }
}

export type Message = UserMessage | AssistantMessage | NoticeMessage | IdleMessage | ModelSwitchMessage | AgentSwitchMessage | ShellMessage

export interface FileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
  source?: { type: string; messageID: string; id: string }
  message?: string
}

export type Decision = "once" | "always" | "reject"

export interface FormOption {
  value: string
  label: string
  description?: string
}

export interface FormField {
  key: string
  title?: string
  description?: string
  required?: boolean
  type: "string" | "multiselect" | "boolean" | "external"
  options?: FormOption[]
  custom?: boolean
  url?: string
  /** How a string is written: "password" hides it as you type. */
  format?: string
}

export interface FormRequest {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: FormField[]
}

export type FormAnswer = Record<string, unknown>

export interface Model {
  id: string
  providerID: string
  name: string
  family?: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  variants: { id: string }[]
  time: { released: Millis }
  cost: { input: number; output: number }[]
  status: string
  enabled: boolean
  limit: { context: number; output: number }
}

export type IntegrationMethod =
  | { type: "oauth"; id: string; label: string }
  | { type: "key"; label?: string }
  | { type: "env"; names: string[] }

export interface Connection {
  type: string
  id?: string
  label?: string
  method?: string
  name?: string
  status?: { status: string; message: string; url?: string }
}

export interface Integration {
  id: string
  name: string
  metadata?: Record<string, unknown>
  methods: IntegrationMethod[]
  connections: Connection[]
}

export interface OAuthAttempt {
  attemptID: string
  url: string
  instructions: string
  mode: "auto" | "code"
  /** With `auto`: the page may end on a code to paste instead. */
  acceptsCode?: boolean
  time: { created: Millis; expires: Millis }
}

export interface OAuthStatus {
  status: "pending" | "complete" | "failed" | "expired"
  message?: string
  /** The sign-in page, when it comes after the attempt started (an agent downloaded first), with
   * what to do there and its device code, if it has one. */
  url?: string
  instructions?: string
  userCode?: string
}

export interface ServerEvent {
  id: string
  type: string
  created: Millis
  location?: { directory: string }
  data: Record<string, unknown>
}
