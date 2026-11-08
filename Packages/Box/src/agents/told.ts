// What a conversation was last told of the app's instructions, for agents that take them only as
// it starts (Claude Code's system prompt, Codex's developer instructions): a conversation they go
// on with keeps the ones it started with, whatever they're given since. So when they changed (it
// moved to another computer, its worktree or project's folders changed), the next message says
// what changed, once, ahead of yours.

/** The instructions a conversation has, by what its state says: undefined when that isn't known (one from before this was kept). */
export function toldOf(state: Record<string, unknown>, key: string): string | undefined {
  const told = state[key]
  return typeof told === "string" ? told : undefined
}

/** Paragraphs, as the instructions' entries are joined (an entry may hold several). */
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)

/**
 * What to say ahead of a message, when the instructions are `now` and the conversation was told
 * `before` (undefined: not known, so they're all said). Nothing when nothing changed.
 */
export function instructionsNote(before: string | undefined, now: string): string | undefined {
  if (before === now) return undefined
  if (before === undefined) {
    if (!now.trim()) return undefined
    return `<system-reminder>\nKuvo Code's instructions for you, as they are now. Where they differ from what you were told before, these hold:\n\n${now.trim()}\n</system-reminder>`
  }
  const was = paragraphs(before)
  const is = paragraphs(now)
  const added = is.filter((part) => !was.includes(part))
  const removed = was.filter((part) => !is.includes(part))
  // (Only their spacing or order changed.)
  if (!added.length && !removed.length) return undefined
  const parts = ["Kuvo Code changed your instructions since you were last told them."]
  if (added.length) parts.push(`Where they differ from what you were told before, this holds now:\n\n${added.join("\n\n")}`)
  if (removed.length) parts.push(`Replaced or taken out:\n\n${removed.join("\n\n")}`)
  return `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`
}
