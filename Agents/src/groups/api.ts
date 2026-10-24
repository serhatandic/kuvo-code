// What a group chat on a machine asks of where its bots' seats run: the machine's engine, or this
// bridge itself for a seat on a coding agent's model. Both answer the engine's API.

import type { ModelRef } from "../wire"
import type { Rule } from "./rules"

export interface Requester {
  /** `directory`: the project folder what's asked is tied to (what MCP servers ask there). */
  request<T = any>(method: string, path: string, body?: unknown, timeout?: number, directory?: string): Promise<T>
}

/** A server that answers the engine's API at `url` behind `password` (this bridge, from inside it). */
export function server(url: string, password: string): Requester {
  const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
  return {
    async request<T>(method: string, path: string, body?: unknown, timeout = 30_000, directory?: string): Promise<T> {
      const response = await fetch(url.replace(/\/$/, "") + path, {
        method,
        headers: {
          Authorization: authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
      const text = await response.text()
      let value: any
      try {
        value = text ? JSON.parse(text) : undefined
      } catch {
        value = text
      }
      if (!response.ok) {
        const error: any = new Error(value?.message ?? `It answered ${response.status}.`)
        error.status = response.status
        throw error
      }
      return value as T
    },
  }
}

const at = (id: string) => "/api/session/" + encodeURIComponent(id)
/** Where the engine files what MCP servers ask (FormRequest.anySession). */
const sharedSession = "global"

/** The calls a group chat makes, as the Mac's OpenCodeAPI makes them. */
export class SeatAPI {
  constructor(readonly requester: Requester) {}

  async active(): Promise<Set<string>> {
    const answer = await this.requester.request("GET", "/api/session/active")
    return new Set(Object.keys(answer?.data ?? {}))
  }

  /** Every session, a page at a time (newest first). */
  async sessions(): Promise<any[]> {
    const all: any[] = []
    let query = "limit=100&order=desc"
    for (let pages = 0; pages < 50; pages++) {
      const answer = await this.requester.request("GET", `/api/session?${query}`)
      const data: any[] = Array.isArray(answer?.data) ? answer.data : []
      all.push(...data)
      const next = answer?.cursor?.next
      if (data.length < 100 || !next) break
      query = `limit=100&cursor=${encodeURIComponent(next)}`
    }
    return all
  }

  async session(id: string): Promise<any> {
    return (await this.requester.request("GET", at(id)))?.data
  }

  /**
   * The account `model` runs on: its provider's name, and whether it's signed out of, as the
   * engine has it: one of its accounts, not among the providers it has ready (signed in, or
   * needing no sign-in, as OpenCode Zen's free models). A provider of a project's own settings,
   * which the engine lists only in that project, isn't one. Unknown while it lists none (still
   * starting).
   */
  async account(model: ModelRef): Promise<{ name: string; signedOut: boolean } | undefined> {
    const [providers, integrations] = await Promise.all([this.requester.request("GET", "/api/provider"), this.requester.request("GET", "/api/integration")])
    const ready: unknown[] = Array.isArray(providers?.data) ? providers.data.map((each: any) => each?.id) : []
    if (!ready.length) return undefined
    const listed: any[] = Array.isArray(integrations?.data) ? integrations.data : []
    const provider = listed.find((each) => each?.id === model.providerID)
    return { name: String(provider?.name ?? model.providerID), signedOut: provider !== undefined && !ready.includes(model.providerID) }
  }

  async create(directory: string, title: string, agent: string | undefined, model: ModelRef | undefined, permissions: Rule[]): Promise<any> {
    const body: Record<string, unknown> = { title, location: { directory }, permissions }
    if (agent) body.agent = agent
    if (model) body.model = model
    return (await this.requester.request("POST", "/api/session", body))?.data
  }

  async setPermissions(id: string, rules: Rule[]) {
    await this.requester.request("PATCH", at(id), { permissions: rules })
  }

  async setMetadata(id: string, metadata: Record<string, unknown>) {
    await this.requester.request("PATCH", at(id), { metadata })
  }

  async setInstruction(id: string, key: string, text: string) {
    await this.requester.request("PUT", `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/${encodeURIComponent(key)}`, { value: text })
  }

  async removeInstruction(id: string, key: string) {
    await this.requester.request("DELETE", `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries/${encodeURIComponent(key)}`)
  }

  async delete(id: string) {
    await this.requester.request("DELETE", at(id))
  }

  async prompt(id: string, message: string, text: string, delivery: "steer" | "queue") {
    await this.requester.request("POST", at(id) + "/prompt", { id: message, text, delivery })
  }

  async interrupt(id: string) {
    await this.requester.request("POST", at(id) + "/interrupt")
  }

  async selectModel(id: string, model: ModelRef) {
    await this.requester.request("POST", at(id) + "/model", { model })
  }

  async selectAgent(id: string, agent: string) {
    await this.requester.request("POST", at(id) + "/agent", { agent })
  }

  /** Waiting input to the next step (`steer`, which also wakes an idle session) or after the run. */
  async setDelivery(id: string, item: string, delivery: "steer" | "queue") {
    await this.requester.request("PATCH", `${at(id)}/inbox/${encodeURIComponent(item)}`, { delivery })
  }

  async cancelInbox(id: string, item: string) {
    await this.requester.request("DELETE", `${at(id)}/inbox/${encodeURIComponent(item)}`)
  }

  async inbox(id: string): Promise<{ id: string }[]> {
    return (await this.requester.request("GET", at(id) + "/inbox"))?.data ?? []
  }

  /** The newest messages, oldest first, and where the page before them starts. */
  async messages(id: string, limit: number, cursor?: string): Promise<{ data: any[]; cursor?: string }> {
    const query = cursor ? `limit=${limit}&cursor=${encodeURIComponent(cursor)}` : `limit=${limit}&order=desc`
    const answer = await this.requester.request("GET", `${at(id)}/message?${query}`)
    const data: any[] = Array.isArray(answer?.data) ? [...answer.data].reverse() : []
    return { data, cursor: answer?.cursor?.next ?? answer?.cursor?.previous }
  }

  async permissions(id: string): Promise<{ id: string }[]> {
    return (await this.requester.request("GET", at(id) + "/permission"))?.data ?? []
  }

  async reject(id: string, permission: string, message: string) {
    await this.requester.request("POST", `${at(id)}/permission/${encodeURIComponent(permission)}/reply`, { decision: "reject", message })
  }

  async forms(id: string): Promise<{ id: string }[]> {
    return (await this.requester.request("GET", at(id) + "/form"))?.data ?? []
  }

  async dismiss(id: string, form: string, message: string) {
    await this.requester.request("DELETE", `${at(id)}/form/${encodeURIComponent(form)}?message=${encodeURIComponent(message)}`)
  }

  /** What MCP servers ask in a project folder: the engine files it under no session, only the folder. */
  async sharedForms(directory: string): Promise<{ id: string; metadata?: any }[]> {
    return (await this.requester.request("GET", at(sharedSession) + "/form", undefined, undefined, directory))?.data ?? []
  }

  async dismissShared(form: string, directory: string) {
    await this.requester.request("DELETE", `${at(sharedSession)}/form/${encodeURIComponent(form)}`, undefined, undefined, directory)
  }
}
