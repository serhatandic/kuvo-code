// What a program run in a terminal shows (`claude setup-token`'s, for its token): its output played
// onto a screen as a terminal would, so words a terminal UI draws in pieces come out whole.

import "../safety"
import { describe, expect, test } from "bun:test"
import { Screen } from "../../src/agents/screen"

const TOKEN = "sk-ant-oat01-" + "Ab3_xY9-kQ".repeat(10)

/** A screen, and the lines it says the cursor left. */
function screen(cols = 1000, rows = 50) {
  const lines: { text: string }[] = []
  const shown = new Screen(cols, rows, (text) => lines.push({ text }))
  return { shown, lines }
}

describe("a terminal's screen", () => {
  test("a line that wrapped at the edge of an 80-column terminal comes back as one", () => {
    const { shown, lines } = screen(80)
    shown.write(`Your OAuth token:\r\n\r\n${TOKEN}\r\n\r\nStore this token securely.\r\n`)
    expect(lines.map((line) => line.text)).toContain(TOKEN + "\n")
    expect(shown.text()).toBe(`Your OAuth token:\n\n${TOKEN}\n\nStore this token securely.`)
  })

  test("a line broken at the edge by the program itself (a full row, then a new line) is joined too", () => {
    const { shown, lines } = screen(80)
    shown.write(`${TOKEN.slice(0, 80)}\r\n${TOKEN.slice(80)}\r\n\r\nStore this token securely.\r\n`)
    expect(lines.map((line) => line.text)).toContain(TOKEN + "\n")
  })

  test("a line is said only once the cursor leaves it, and a wrapped one never by its first part alone", () => {
    const { shown, lines } = screen(80)
    shown.write(TOKEN.slice(0, 60))
    expect(lines).toEqual([])
    shown.write(TOKEN.slice(60, 85))
    // On its second row now, still being drawn.
    expect(lines).toEqual([])
    expect(shown.current()).toBe(TOKEN.slice(0, 85))
    shown.write(TOKEN.slice(85) + "\r\n")
    expect(lines.map((line) => line.text)).toEqual([TOKEN + "\n"])
  })

  test("a redraw that jumps over unchanged cells leaves the line as it's seen", () => {
    const { shown } = screen()
    shown.write(`Paste code here if prompted > ${"x".repeat(20)}`)
    // Claude Code's way: back to the start, then only what changed.
    shown.write(`\r\x1b[1mDone\x1b[22m\x1b[K\r\n\x1b[1B\r\x1b[5C! \x1b[12Gok`)
    expect(shown.text()).toBe("Done\n\n     ! " + " ".repeat(4) + "ok")
  })

  test("codes cut between two reads, and ones that draw nothing (keyboard modes, character sets, links), leave nothing", () => {
    const { shown } = screen()
    for (const part of ["\x1b[3", "8;5;174mHi\x1b", "[<u\x1b", "(B there\x1b]8;;https://x", ".test\x1b\\link\x1b]8;;\x07\x1b[>0q"]) shown.write(part)
    expect(shown.text()).toBe("Hi therelink")
  })

  test("what a program draws on the other screen goes when it leaves it", () => {
    const { shown } = screen()
    shown.write("before\r\n\x1b[?1049hfull screen\x1b[?1049l")
    expect(shown.text()).toBe("before")
  })

  test("huge counts, and a code that never ends, stay within the screen", () => {
    const { shown } = screen(80, 24)
    shown.write("top\x1b[999999999Bbottom\x1b[999999999A\x1b[2G\x1b[999999999@\x1b[999999999;999999999HX")
    const lines = shown.text().split("\n")
    expect(lines).toHaveLength(24)
    expect(lines[0]).toBe("t")
    expect(lines[23]).toBe("   bottom" + " ".repeat(70) + "X")
    shown.write("\r\nnext\x1b]0;" + "x".repeat(100_000))
    shown.write("y".repeat(100_000) + "\x07after")
    expect(shown.current().length).toBeLessThan(200)
    // So much scrolled by that only the last of it is kept.
    for (let line = 0; line < 5_000; line++) shown.write(`line ${line}\r\n`)
    expect(shown.text()).toContain("line 4999")
    expect(shown.text()).not.toContain("line 10\n")
  })

  test("wide characters take two cells, so a jump after one lands where the terminal puts it", () => {
    const { shown } = screen()
    shown.write("✔ ok\r界x\x1b[4Gy")
    expect(shown.text()).toBe("界xy")
  })
})
