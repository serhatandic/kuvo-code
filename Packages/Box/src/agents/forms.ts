// Forms an agent's tools ask you to fill in (MCP elicitation, over Codex's app-server or ACP),
// as the app's questions ask them.

import type { FormField } from "./wire"

/** One field of an MCP server's form (its JSON schema), as the app asks it. */
export function elicitationField(key: string, field: any, required: boolean): FormField {
  const title = field?.title ?? key
  const description = field?.description ?? undefined
  if (field?.type === "boolean") return { key, title, description, required, type: "boolean" }
  if (field?.type === "array") {
    const options = (field.items?.anyOf ?? field.items?.oneOf ?? (field.items?.enum ?? []).map((value: string) => ({ const: value, title: value }))).map((option: any) => ({ value: String(option.const), label: String(option.title ?? option.const) }))
    return { key, title, description, required, type: "multiselect", options }
  }
  const named = field?.oneOf ?? field?.anyOf
  const options = named ? named.map((option: any) => ({ value: String(option.const), label: String(option.title ?? option.const) })) : field?.enum?.map((value: string, index: number) => ({ value, label: field.enumNames?.[index] ?? value }))
  return { key, title, description, required, type: "string", options, custom: !options, ...(field?.format === "password" ? { format: "password" } : {}) }
}
