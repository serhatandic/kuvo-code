// A file's change as a unified diff, as the engine gives its edits (`FileDiff`): the app draws it
// in the conversation and counts its lines.

import type { FileDiff } from "./wire"

export type Op = { kind: " " | "-" | "+"; line: string }

/** Past this many changed lines, what's between the unchanged start and end shows as rewritten. */
const searchLimit = 2_000

/** The shortest edit from `a` to `b` (Myers), as kept, removed and added lines (or words). */
export function edits(a: string[], b: string[]): Op[] {
  // What's the same at the start and at the end is kept as it is; only between is compared.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const ops: Op[] = []
  for (let i = 0; i < start; i++) ops.push({ kind: " ", line: a[i] })
  for (const op of middle(a.slice(start, endA), b.slice(start, endB))) ops.push(op)
  for (let i = endA; i < a.length; i++) ops.push({ kind: " ", line: a[i] })
  return ops
}

function middle(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  const removed = (): Op[] => a.map((line) => ({ kind: "-", line }))
  const added = (): Op[] => b.map((line) => ({ kind: "+", line }))
  if (!n) return added()
  if (!m) return removed()
  const max = n + m
  const limit = Math.min(max, searchLimit)
  const v = new Int32Array(2 * max + 2)
  // For each round, the furthest points before it, for diagonals -d…d: all the way back needs.
  const trace: Int32Array[] = []
  let found = false
  outer: for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(max - d, max + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[max + k] = x
      if (x >= n && y >= m) {
        found = true
        break outer
      }
    }
  }
  // Too different to be worth finding the shortest way: rewritten.
  if (!found) return [...removed(), ...added()]
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d]
    const at = (k: number) => t[k + d]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ kind: " ", line: a[--x] })
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "+", line: b[--y] })
      else ops.push({ kind: "-", line: a[--x] })
    }
  }
  return ops.reverse()
}

export function lines(text: string): string[] {
  if (text === "") return []
  const split = text.split("\n")
  if (split[split.length - 1] === "") split.pop()
  return split
}

/** The hunks of a unified diff from `before` to `after`, three lines around each change. */
export function unified(before: string, after: string, context = 3): { patch: string; additions: number; deletions: number } {
  const ops = edits(lines(before), lines(after))
  let additions = 0
  let deletions = 0
  for (const op of ops) {
    if (op.kind === "+") additions++
    else if (op.kind === "-") deletions++
  }
  let patch = ""
  let i = 0
  let oldLine = 1
  let newLine = 1
  // Where each op starts, on each side.
  const starts = ops.map((op) => {
    const at = { old: oldLine, new: newLine }
    if (op.kind !== "+") oldLine++
    if (op.kind !== "-") newLine++
    return at
  })
  while (i < ops.length) {
    if (ops[i].kind === " ") {
      i++
      continue
    }
    let start = Math.max(0, i - context)
    let end = i
    // The hunk runs on while changes come within twice the context of each other.
    while (end < ops.length) {
      if (ops[end].kind !== " ") {
        end++
        continue
      }
      let next = end
      while (next < ops.length && ops[next].kind === " ") next++
      if (next < ops.length && next - end <= context * 2) end = next
      else break
    }
    end = Math.min(ops.length, end + context)
    const slice = ops.slice(start, end)
    const oldCount = slice.filter((op) => op.kind !== "+").length
    const newCount = slice.filter((op) => op.kind !== "-").length
    const oldStart = oldCount === 0 ? starts[start].old - 1 : starts[start].old
    const newStart = newCount === 0 ? starts[start].new - 1 : starts[start].new
    patch += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`
    for (const op of slice) patch += op.kind + op.line + "\n"
    i = end
  }
  return { patch, additions, deletions }
}

function header(path: string): string {
  return path.startsWith("/") ? `--- ${path}\n+++ ${path}\n` : `--- a/${path}\n+++ b/${path}\n`
}

/** A file's change, as the engine reports one: with headers, paths as the agent named them. */
export function fileDiff(path: string, before: string | undefined, after: string | undefined): FileDiff {
  const { patch, additions, deletions } = unified(before ?? "", after ?? "")
  const status = before === undefined ? "added" : after === undefined ? "deleted" : "modified"
  return { file: path, patch: header(path) + patch, additions, deletions, status }
}

/** A unified diff someone else made (Codex's, Claude Code's hunks), with its lines counted. */
export function fromPatch(path: string, patch: string, status?: FileDiff["status"]): FileDiff {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true
    else if (!inHunk) continue
    else if (line.startsWith("+")) additions++
    else if (line.startsWith("-")) deletions++
  }
  const headed = patch.startsWith("---") || patch.startsWith("diff ") ? patch : header(path) + patch
  return { file: path, patch: headed, additions, deletions, status: status ?? "modified" }
}
