// Your permission rules, as the engine reads them: for an action on resources, the last rule that
// matches says allow, deny or ask. With none, the engine's default: tools run without asking.

import type { PermissionRule } from "./wire"

export function matches(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === value) return true
  // "git push *" is git push with anything after it, or nothing, as the engine reads it.
  if (pattern.endsWith(" *") && value === pattern.slice(0, -2)) return true
  const expression = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  // Across lines too (a commit message, a script), as the engine reads it.
  return new RegExp(expression, "s").test(value)
}

export function evaluate(rules: PermissionRule[] | undefined, action: string, resources: string[]): "allow" | "deny" | "ask" {
  return ruled(rules, action, resources) ?? "allow"
}

/** What your rules say, if any of them is about it. */
export function ruled(rules: PermissionRule[] | undefined, action: string, resources: string[]): "allow" | "deny" | "ask" | undefined {
  let effect: "allow" | "deny" | "ask" | undefined
  for (const rule of rules ?? []) {
    if (!matches(rule.action, action)) continue
    const targets = resources.length ? resources : ["*"]
    if (targets.every((resource) => matches(rule.resource, resource))) effect = rule.effect
  }
  return effect
}

/** Ask First: edits or commands wait for an OK (the app's ToolApproval.askFirst). */
export function asksFirst(rules: PermissionRule[] | undefined): boolean {
  return (rules ?? []).some((rule) => rule.effect === "ask" && ["edit", "shell", "write", "patch", "*"].includes(rule.action))
}
