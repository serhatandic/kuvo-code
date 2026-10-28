// Codex's directives in its words (`:codex-file-citation{path="…" purpose="output"}`, as its skills
// tell it to cite files), which a chat that isn't Codex's own would show raw: a file it cites as
// what it made becomes a file shown in the conversation, one it cites in its words its path (which
// the apps make a link), and any other of its directives goes. Its words come in pieces, so a
// directive split between them is held back until it's whole.

import { basename } from "node:path"

/** What its words become: words, or a file it made, to show. */
export type Said = { text: string } | { made: string }

/** The start of a directive of Codex's, as it may be cut off at the end of a piece. */
const opening = ":codex-"
/** Most held back for a directive that doesn't close: past it, the words go as they are. */
const longest = 4096

export class CodexCitations {
  private held = ""

  /** What `words` (the next piece) say, with what's held back from before. */
  read(words: string): Said[] {
    const text = this.held + words
    this.held = ""
    const said: Said[] = []
    let from = 0
    let at = text.indexOf(":", from)
    while (at >= 0) {
      const rest = text.slice(at, at + opening.length)
      if (rest.length < opening.length && opening.startsWith(rest)) {
        // Perhaps a directive's start, cut off: held back for the next piece.
        this.held = text.slice(at)
        return push(said, text.slice(from, at))
      }
      if (rest === opening) {
        const end = closing(text, at)
        if (end === undefined) {
          if (text.length - at <= longest) {
            this.held = text.slice(at)
            return push(said, text.slice(from, at))
          }
        } else if (end >= 0) {
          push(said, text.slice(from, at))
          const directive = parse(text.slice(at, end + 1))
          if (directive) said.push(...directive)
          from = end + 1
          at = text.indexOf(":", from)
          continue
        }
      }
      at = text.indexOf(":", at + 1)
    }
    return push(said, text.slice(from))
  }

  /** What's still held back, as the words end (a directive that never closed, as it is). */
  end(): Said[] {
    const text = this.held
    this.held = ""
    return push([], text)
  }
}

/** Its words with its directives as plain names, where nothing can be shown (a title, a note). */
export function plainCitations(text: string): string {
  const reader = new CodexCitations()
  return [...reader.read(text), ...reader.end()].map((said) => ("text" in said ? said.text : basename(said.made))).join("")
}

function push(said: Said[], text: string): Said[] {
  if (!text) return said
  const last = said[said.length - 1]
  if (last && "text" in last) last.text += text
  else said.push({ text })
  return said
}

/**
 * Where the directive at `at` ends (its `}`, outside quotes); undefined while it may still be
 * coming, -1 when what's there isn't one.
 */
function closing(text: string, at: number): number | undefined {
  let index = at + opening.length
  while (index < text.length && /[a-z0-9-]/.test(text[index])) index++
  if (index === text.length) return undefined
  if (text[index] !== "{") return -1
  let quoted = false
  for (index++; index < text.length; index++) {
    const char = text[index]
    // One is on one line: past its end, it's words (an unclosed quote doesn't take the rest).
    if (char === "\n") return -1
    if (quoted && char === "\\") index++
    else if (char === '"') quoted = !quoted
    else if (char === "}" && !quoted) return index
  }
  return undefined
}

/** What a whole directive says: a file citation's file, or nothing for any other. */
function parse(directive: string): Said[] | undefined {
  const name = /^:codex-([a-z0-9-]+)\{/.exec(directive)?.[1]
  if (name !== "file-citation") return undefined
  const attributes = new Map<string, string>()
  for (const match of directive.matchAll(/([A-Za-z_][\w-]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) attributes.set(match[1], match[2].replace(/\\(.)/g, "$1"))
  const path = attributes.get("path")
  if (!path) return undefined
  if (attributes.get("purpose") === "output") return [{ made: path }]
  // Its path as code, which the apps make a link to the file, as for any path in a reply.
  const fence = path.includes("`") ? "``" : "`"
  return [{ text: `${fence}${path}${fence}` }]
}
