// What changed between two versions, as every client shows it alike: prose (memory, skills, notes,
// Markdown) as its lines with the words that changed marked in them; code as a unified diff's
// hunks. Worked out here, on the box, so the Mac and the phone mark the same words.

import { edits, lines, unified } from "../diff"

/** A run of words: kept, added (`+`) or removed (`-`). */
export interface Run {
  t: " " | "+" | "-"
  text: string
}

/**
 * A line of the newer version and how it came to be: the same, added, removed, or changed (with
 * its words marked). Long stretches that stayed the same are folded to a count.
 */
export type Line =
  | { kind: "same"; text: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "changed"; runs: Run[] }
  | { kind: "folded"; lines: number }

export type Changes =
  | { style: "words"; lines: Line[]; added: number; removed: number }
  | { style: "lines"; patch: string; added: number; removed: number }

/** Unchanged lines kept around each change before the rest of a stretch folds. */
const around = 3
/**
 * A changed line this much rewritten reads better as removed and added whole: measured against
 * the shorter of the two, so a line that grew (or shrank) reads as the words added (or removed).
 */
const rewritten = 0.6

/** The changes from `before` to `after`, as words (`prose`) or lines. */
export function changes(before: string, after: string, prose: boolean): Changes {
  if (!prose) {
    const { patch, additions, deletions } = unified(before, after)
    return { style: "lines", patch, added: additions, removed: deletions }
  }
  const ops = edits(lines(before), lines(after))
  const out: Line[] = []
  let added = 0
  let removed = 0
  let i = 0
  while (i < ops.length) {
    if (ops[i].kind === " ") {
      out.push({ kind: "same", text: ops[i].line })
      i++
      continue
    }
    // A run of removed and added lines: paired up in order, each pair's words compared.
    const gone: string[] = []
    const come: string[] = []
    while (i < ops.length && ops[i].kind !== " ") {
      if (ops[i].kind === "-") gone.push(ops[i].line)
      else come.push(ops[i].line)
      i++
    }
    const pairs = Math.min(gone.length, come.length)
    for (let p = 0; p < pairs; p++) {
      const runs = words(gone[p], come[p])
      const kept = runs.filter((run) => run.t === " ").reduce((sum, run) => sum + run.text.trim().length, 0)
      const size = Math.min(gone[p].trim().length, come[p].trim().length) || 1
      if (kept / size < 1 - rewritten) {
        out.push({ kind: "removed", text: gone[p] }, { kind: "added", text: come[p] })
      } else {
        out.push({ kind: "changed", runs })
      }
      added++
      removed++
    }
    for (const text of gone.slice(pairs)) {
      out.push({ kind: "removed", text })
      removed++
    }
    for (const text of come.slice(pairs)) {
      out.push({ kind: "added", text })
      added++
    }
  }
  return { style: "words", lines: fold(out), added, removed }
}

/** Words and the spaces between them, each its own token, so a run keeps its spacing. */
function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]/gu) ?? []
}

/**
 * One line's change, word by word: each stretch of changes (with the lone spaces between its
 * words) as what was removed, then what was added, so "old words" → "new words" reads whole.
 */
export function words(before: string, after: string): Run[] {
  const ops = edits(tokens(before), tokens(after))
  const runs: Run[] = []
  const push = (t: Run["t"], text: string) => {
    if (!text) return
    const last = runs.at(-1)
    if (last && last.t === t) last.text += text
    else runs.push({ t, text })
  }
  let i = 0
  while (i < ops.length) {
    if (ops[i].kind === " ") {
      push(" ", ops[i++].line)
      continue
    }
    let gone = ""
    let come = ""
    for (;;) {
      while (i < ops.length && ops[i].kind !== " ") {
        if (ops[i].kind === "-") gone += ops[i].line
        else come += ops[i].line
        i++
      }
      // A lone space and more changes after it: one stretch.
      if (i + 1 < ops.length && /^\s+$/.test(ops[i].line) && ops[i + 1].kind !== " ") {
        gone += ops[i].line
        come += ops[i].line
        i++
        continue
      }
      break
    }
    push("-", gone)
    push("+", come)
  }
  return runs
}

/** Long stretches that stayed the same, folded to a count, with a few lines kept by each change. */
function fold(all: Line[]): Line[] {
  const out: Line[] = []
  let i = 0
  while (i < all.length) {
    if (all[i].kind !== "same") {
      out.push(all[i++])
      continue
    }
    let end = i
    while (end < all.length && all[end].kind === "same") end++
    const first = i === 0
    const last = end === all.length
    const keepStart = first ? 0 : around
    const keepEnd = last ? 0 : around
    if (end - i > keepStart + keepEnd + 1) {
      out.push(...all.slice(i, i + keepStart), { kind: "folded", lines: end - i - keepStart - keepEnd }, ...all.slice(end - keepEnd, end))
    } else {
      out.push(...all.slice(i, end))
    }
    i = end
  }
  return out
}

/**
 * `text` with `patch` taken back out (what it was before the change), each hunk where it says or
 * a little above or below; undefined when one doesn't fit (it changed since).
 */
export function unapply(patch: string, text: string): string | undefined {
  const hunks = parse(patch)
  if (!hunks.length) return undefined
  const result = lines(text)
  for (const hunk of hunks.reverse()) {
    const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1
    const fits = (at: number) => at >= 0 && at + hunk.after.length <= result.length && hunk.after.every((line, j) => result[at + j] === line)
    const tries = [start]
    for (let d = 1; d <= 50; d++) tries.push(start - d, start + d)
    const at = tries.find(fits)
    if (at === undefined) return undefined
    result.splice(at, hunk.after.length, ...hunk.before)
  }
  const ending = text.endsWith("\n") || text === "" ? "\n" : ""
  return result.length ? result.join("\n") + ending : ""
}

/** The fewest lines of context a diff keeps around a change (unified diffs keep three or more). */
const leastContext = 3

/**
 * `text` with `patch` taken back out, only when the patch fits `text` exactly: each hunk where it
 * says, and a hunk with less context than diffs keep at its start (or end) sits at the start (or
 * end) of the file, as it did when the patch was made. Undefined otherwise (the file changed
 * again since), so no state is made up from a later one.
 */
export function unapplyExactly(patch: string, text: string): string | undefined {
  const hunks = parse(patch)
  if (!hunks.length) return undefined
  const result = lines(text)
  const length = result.length
  for (const hunk of hunks) {
    const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1
    if (at < 0 || at + hunk.after.length > length || !hunk.after.every((line, j) => result[at + j] === line)) return undefined
    if (hunk.leading < leastContext && at !== 0) return undefined
    if (hunk.trailing < leastContext && at + hunk.after.length !== length) return undefined
  }
  for (const hunk of [...hunks].reverse()) {
    const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1
    result.splice(at, hunk.after.length, ...hunk.before)
  }
  const ending = text.endsWith("\n") || text === "" ? "\n" : ""
  return result.length ? result.join("\n") + ending : ""
}

interface Hunk {
  newStart: number
  newCount: number
  before: string[]
  after: string[]
  /** Unchanged lines before its first change, and after its last. */
  leading: number
  trailing: number
  /** A change seen in it yet. */
  changes?: boolean
}

function parse(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  for (const line of patch.split("\n")) {
    const head = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (head) {
      hunks.push({ newStart: Number(head[1]), newCount: head[2] === undefined ? 1 : Number(head[2]), before: [], after: [], leading: 0, trailing: 0 })
      continue
    }
    const hunk = hunks.at(-1)
    if (!hunk || !line) continue
    const text = line.slice(1)
    if (line[0] === " ") {
      hunk.before.push(text)
      hunk.after.push(text)
      if (hunk.changes) hunk.trailing++
      else hunk.leading++
    } else if (line[0] === "-" || line[0] === "+") {
      if (line[0] === "-") hunk.before.push(text)
      else hunk.after.push(text)
      hunk.changes = true
      hunk.trailing = 0
    }
  }
  return hunks
}
