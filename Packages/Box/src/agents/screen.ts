// What a program run in a terminal shows, as a terminal would: its output played onto a screen of
// cells. A terminal UI (Claude Code's) redraws only the cells that changed, jumping over the ones
// that didn't, so the plain stream has its words in pieces and out of order; the screen has them
// whole, where they're seen.

/** A line the screen shows, through any rows it wrapped onto. */
type Row = string[]

export class Screen {
  private rows: Row[] = [[]]
  /** Rows that carry on onto the next (the cursor wrapped off their end). */
  private wrapped = new Set<number>()
  private row = 0
  private col = 0
  /** At the last column with a character there: the next one wraps. */
  private pending = false
  private saved = { row: 0, col: 0 }
  /** The first row on the screen now (rows above it have scrolled off). */
  private top = 0
  /** The screen it was on, while a program uses the other one. */
  private main?: { rows: Row[]; wrapped: Set<number>; row: number; col: number; top: number }
  /** An escape sequence cut off at the end of a read, for the next. */
  private carry = ""
  /** Whether the cursor's row was written since it came there. */
  private dirty = false

  /** `onLine`: a line the cursor has left, once something was written on it. */
  constructor(
    readonly cols: number,
    readonly height: number,
    private readonly onLine?: (line: string) => void,
  ) {}

  write(input: string) {
    const text = this.carry + input
    this.carry = ""
    let at = 0
    while (at < text.length) {
      const char = text[at]
      if (char === "\x1b") {
        const end = sequenceEnd(text, at)
        if (end < 0) {
          // A string (a title, a link) draws nothing: only its start is kept, and an ESC that may
          // begin its end. Any other sequence too long to be one is dropped.
          if (STRINGS.includes(text[at + 1])) this.carry = text.slice(at, at + 2) + (text.length - at > 2 && text.endsWith("\x1b") ? "\x1b" : "")
          else if (text.length - at <= MAX_SEQUENCE) this.carry = text.slice(at)
          return
        }
        this.escape(text.slice(at, end))
        at = end
        continue
      }
      const code = text.codePointAt(at)!
      const size = code > 0xffff ? 2 : 1
      at += size
      if (char === "\r") this.moveTo(this.row, 0)
      else if (char === "\n" || char === "\v" || char === "\f") this.moveTo(this.row + 1, this.col, "line")
      else if (char === "\b") this.moveTo(this.row, Math.max(0, this.col - 1))
      else if (char === "\t") this.moveTo(this.row, Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8))
      else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) this.put(String.fromCodePoint(code))
    }
  }

  /** Everything on it, top to bottom: wrapped rows as one line, the end of each line's spaces gone. */
  text(): string {
    const lines: string[] = []
    for (let row = 0; row < this.rows.length; row++) {
      const start = row
      while (this.continues(row)) row++
      lines.push(this.join(start, row))
    }
    return lines.join("\n").replace(/\n+$/, "")
  }

  /** The line the cursor is on, as far as it's drawn. */
  current(): string {
    return this.line(this.row).replace(/\n$/, "")
  }

  /** The line a row is part of, with a line break after it only when it's complete: an empty or
   * full last row may carry on yet. */
  private line(row: number): string {
    let start = row
    while (start > 0 && this.continues(start - 1)) start--
    let end = row
    while (this.continues(end)) end++
    const last = this.rows[end] ?? []
    const complete = !this.full(end) && (end === start || this.cells(last).trim() !== "")
    return this.join(start, end) + (complete ? "\n" : "")
  }

  private continues(row: number): boolean {
    return row + 1 < this.rows.length && (this.wrapped.has(row) || this.full(row))
  }

  private full(row: number): boolean {
    const cells = this.rows[row] ?? []
    return cells.length >= this.cols && cells[this.cols - 1] !== undefined && cells[this.cols - 1] !== " "
  }

  private join(start: number, end: number): string {
    let text = ""
    for (let row = start; row <= end; row++) text += this.cells(this.rows[row] ?? [])
    return text.trimEnd()
  }

  private cells(row: Row): string {
    let text = ""
    for (let col = 0; col < row.length; col++) text += row[col] ?? " "
    return text
  }

  private put(char: string) {
    const width = Bun.stringWidth(char)
    if (width === 0) return
    if (this.pending || this.col + width > this.cols) {
      this.wrapped.add(this.row)
      this.moveTo(this.row + 1, 0, "wrap")
    }
    const cells = this.rowAt(this.row)
    cells[this.col] = char
    // A wide character's second cell.
    if (width === 2) cells[this.col + 1] = ""
    this.dirty = true
    this.col += width
    if (this.col >= this.cols) {
      this.col = this.cols - 1
      this.pending = true
    }
  }

  private rowAt(row: number): Row {
    while (this.rows.length <= row) this.rows.push([])
    return this.rows[row]
  }

  /** `jump`: a cursor move, which stops at the screen's edges. `line`: a new line, which scrolls the
   * screen at its bottom. `wrap`: onto the next row of the same line, which isn't left then. */
  private moveTo(row: number, col: number, how: "jump" | "line" | "wrap" = "jump") {
    row = Math.max(this.top, how === "jump" ? Math.min(row, this.top + this.height - 1) : Math.min(row, this.row + 1))
    if (row !== this.row) {
      const wrapping = how === "wrap"
      if (this.dirty && !wrapping) this.left()
      this.dirty &&= wrapping
      this.row = row
      this.rowAt(row)
      // Past the bottom: the screen scrolls.
      if (row >= this.top + this.height) this.scroll(row - this.height + 1)
    }
    this.col = Math.max(0, Math.min(this.cols - 1, col))
    this.pending = false
  }

  /** The screen's first row now, and only so much of what scrolled off above it kept. */
  private scroll(top: number) {
    this.top = top
    const drop = this.top - MAX_SCROLLBACK
    if (drop < MAX_SCROLLBACK) return
    this.rows.splice(0, drop)
    this.wrapped = new Set([...this.wrapped].filter((row) => row >= drop).map((row) => row - drop))
    this.row -= drop
    this.top -= drop
    this.saved = { row: Math.max(0, this.saved.row - drop), col: this.saved.col }
  }

  /** The cursor's line, said as it leaves it. */
  private left() {
    this.onLine?.(this.line(this.row))
  }

  /** Blanks from one column to another (not including it) on a row. */
  private erase(row: number, from: number, to: number) {
    const cells = this.rows[row]
    if (!cells) return
    for (let col = from; col < Math.min(to, cells.length); col++) cells[col] = " "
    this.wrapped.delete(row)
    if (row === this.row) this.dirty = true
  }

  private escape(sequence: string) {
    const kind = sequence[1]
    if (kind === "[") return this.control(sequence)
    if (kind === "7") this.saved = { row: this.row, col: this.col }
    else if (kind === "8") this.moveTo(this.saved.row, this.saved.col)
    else if (kind === "D") this.moveTo(this.row + 1, this.col, "line")
    else if (kind === "E") this.moveTo(this.row + 1, 0, "line")
    else if (kind === "M") this.moveTo(this.row - 1, this.col)
    else if (kind === "c") {
      for (let row = this.top; row < this.rows.length; row++) this.erase(row, 0, Infinity)
      this.moveTo(this.top, 0)
    }
    // The rest (strings, character sets, keypad modes) draws nothing.
  }

  private control(sequence: string) {
    const final = sequence[sequence.length - 1]
    const body = sequence.slice(2, -1)
    const mark = /^[<=>?]/.test(body) ? body[0] : ""
    const params = (mark ? body.slice(1) : body).replace(/[ -/]+$/, "").split(";").map((each) => Number.parseInt(each, 10))
    const n = Number.isFinite(params[0]) && params[0] > 0 ? params[0] : 1
    const raw = Number.isFinite(params[0]) ? params[0] : 0
    if (mark === "?") {
      if ((final === "h" || final === "l") && params.some((each) => each === 1049 || each === 1047 || each === 47)) this.otherScreen(final === "h")
      return
    }
    // Keyboard modes, queries (`ESC[<u`, `ESC[>0q`): nothing drawn.
    if (mark) return
    switch (final) {
      case "A": return this.moveTo(this.row - n, this.col)
      case "B": case "e": return this.moveTo(this.row + n, this.col)
      case "C": case "a": return this.moveTo(this.row, this.col + n)
      case "D": return this.moveTo(this.row, Math.max(0, this.col - n))
      case "E": return this.moveTo(this.row + n, 0)
      case "F": return this.moveTo(this.row - n, 0)
      case "G": case "`": return this.moveTo(this.row, n - 1)
      case "d": return this.moveTo(this.top + n - 1, this.col)
      case "H": case "f": {
        const col = Number.isFinite(params[1]) && params[1] > 0 ? params[1] : 1
        return this.moveTo(this.top + n - 1, col - 1)
      }
      case "K": {
        if (raw === 0) this.erase(this.row, this.col, Infinity)
        else if (raw === 1) this.erase(this.row, 0, this.col + 1)
        else this.erase(this.row, 0, Infinity)
        return
      }
      case "J": {
        if (raw === 0) {
          this.erase(this.row, this.col, Infinity)
          for (let row = this.row + 1; row < this.rows.length; row++) this.erase(row, 0, Infinity)
        } else if (raw === 1) {
          for (let row = this.top; row < this.row; row++) this.erase(row, 0, Infinity)
          this.erase(this.row, 0, this.col + 1)
        } else {
          for (let row = this.top; row < this.rows.length; row++) this.erase(row, 0, Infinity)
        }
        return
      }
      case "X": return this.erase(this.row, this.col, this.col + n)
      case "P": {
        const cells = this.rowAt(this.row)
        cells.splice(this.col, n)
        this.dirty = true
        return
      }
      case "@": {
        const cells = this.rowAt(this.row)
        if (cells.length > this.col) cells.splice(this.col, 0, ...Array(Math.min(n, this.cols - this.col)).fill(" "))
        cells.length = Math.min(cells.length, this.cols)
        this.dirty = true
        return
      }
      case "s": if (!body) this.saved = { row: this.row, col: this.col }; return
      case "u": if (!body) this.moveTo(this.saved.row, this.saved.col); return
    }
    // Colors, scroll regions and the rest: nothing moves.
  }

  private otherScreen(on: boolean) {
    if (on && !this.main) {
      if (this.dirty) this.left()
      this.main = { rows: this.rows, wrapped: this.wrapped, row: this.row, col: this.col, top: this.top }
      this.rows = [[]]
      this.wrapped = new Set()
      this.row = this.col = this.top = 0
    } else if (!on && this.main) {
      if (this.dirty) this.left()
      ;({ rows: this.rows, wrapped: this.wrapped, row: this.row, col: this.col, top: this.top } = this.main)
      this.main = undefined
    }
    this.dirty = false
    this.pending = false
  }
}

/** What starts a string: a title, a link, a query. */
const STRINGS = "]P_^X"
/** The longest escape sequence kept for the next read. */
const MAX_SEQUENCE = 4096
/** How many rows that scrolled off the top are kept (a sign-in's page and words are well within). */
const MAX_SCROLLBACK = 1000

/** Where the escape sequence at `at` ends, or -1 when it's cut off. */
function sequenceEnd(text: string, at: number): number {
  const kind = text[at + 1]
  if (kind === undefined) return -1
  if (kind === "[") {
    for (let index = at + 2; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) return index + 1
      // Not a control sequence after all: only its start is skipped.
      if (code < 0x20 || code > 0x7e) return at + 2
    }
    return -1
  }
  // A string (a title, a link, a query) to its end: BEL or ESC \.
  if (STRINGS.includes(kind)) {
    for (let index = at + 2; index < text.length; index++) {
      if (text[index] === "\x07") return index + 1
      if (text[index] === "\x1b") return text[index + 1] === undefined ? -1 : text[index + 1] === "\\" ? index + 2 : index
    }
    return -1
  }
  // Intermediate bytes, then a final one (`ESC ( B`, a character set).
  let index = at + 1
  while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index++
  if (index >= text.length) return -1
  return index + 1
}
