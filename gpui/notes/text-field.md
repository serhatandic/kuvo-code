# Text field

**Ours:** `kuvo_ui/src/text_field/{mod,layout}.rs`. Tests: `kuvo_ui/tests/text_field.rs`.
Gallery page: `gallery/src/pages/text_field.rs`. Shots: `shots/text-field-{light,dark}.png`.

## What Zed does (studied, not copied)

Files read: `crates/ui_input/src/input_field.rs`, `crates/editor/src/editor.rs` (its
single-line and auto-height modes), `crates/editor/src/element.rs` (auto-height measuring),
`crates/editor/src/input.rs` (IME), all GPL-3.0, for behaviour only; and GPUI's own
`examples/input.rs`, `src/input.rs`, `src/text_system/{line,line_layout}.rs` (Apache-2.0).

**Adapted, with attribution:** parts of `text_field/mod.rs` and `layout.rs` are adapted from
GPUI's `examples/input.rs` (Apache-2.0, Zed Industries): the selection model with its reversed
flag, grapheme movement, copy/cut/paste, the UTF-16 helpers, the input-handler methods and the
underlined run for marked text. Both files say so at the top. Nothing comes from Zed's GPL
crates.

- Zed's field is its whole code editor in single-line mode inside a bordered box (label above,
  focused border, error text below). We don't have, or want, an editor here.
- Auto-height: measure the wrapped text at the available width, count rows, clamp to a minimum
  and maximum number of lines, scroll past the maximum.
- IME: the composition is marked and underlined; replacing marked text keeps it marked; the
  whole composition is one undo step; the OS asks for the bounds of a range (to place its
  candidate window) and for the offset under a point, all in UTF-16.
- GPUI's example (Apache) shows the contract: an `EntityInputHandler` on the entity, an element
  that shapes text and registers `ElementInputHandler` every paint, grapheme-aware movement.

## What we take as behaviour

- One `TextField` entity for one line and many. `multi_line(min, max)` grows from `min` to
  `max` lines with its text (measured with `request_measured_layout` at the real width), then
  scrolls, keeping the caret in view. One-line fields scroll sideways.
- Mac editing: grapheme-aware arrows (an emoji with a skin tone is one step), Option for words,
  Command for line and document ends, Control-A and Control-E, Shift to select, double-click a
  word, triple-click a line, drag and Shift-click to extend, Up and Down keep their column
  through short lines. Other systems get Control for words and Home and End for lines.
- Clipboard: copy, cut, paste; a one-line field turns pasted newlines into spaces.
- Undo and redo a word at a time (typing coalesces until a space), and an IME composition as
  one step, as in Zed.
- IME: marked text drawn with an underline, `bounds_for_range` from our wrapped layout so the
  candidate window sits under the text on any line, `character_index_for_point`, the
  character palette on Control-Command-Space.
- Return submits (`TextFieldEvent::Submit`); Shift-Return adds a line. A field can be told to
  add a line on Return instead. Escape sends `Cancel`.
- Look: 14 px text, 8 px radius, a strong hairline at rest, accent edge and halo when focused,
  accent caret, faint placeholder, grey selection when another field has focus; disabled
  fields sit on the sunken fill with faint text; `set_error` draws a red edge and the message
  under the field (the message comes from the box). `bare()` drops the box for a composer.
- Moving the caret ends a run of typing, so the next word is its own undo step (as on a Mac).
  The undo history is capped by the text it holds (8 MB), not by a count.
- Text is held the same way however it arrives (typed, pasted, set by code, or from an input
  method): a one-line field turns line breaks into spaces.
- Questions asked before the next paint (an input method placing its candidate window right
  after a keystroke, two arrow keys in one frame) reshape the text on demand, so the answer is
  about the text as it is, not as it was last drawn.

## Tests (through the window's key bindings)

Typing and deleting words, emoji, selecting and replacing, copy, cut and paste, undo and redo
granularity, Return and Shift-Return, the composer growing to its limit (measured from where
the field was drawn), Up and Down keeping the column, and an IME composition marked, committed
and undone in one step. IME calls go straight to the entity's input handler, which is what
GPUI's platform layer calls; the test platform has no input method to drive.

Also: Up, Down and the input method's caret query in an empty field (a crash the review
found), moving the caret starting a new undo step, bounds and offsets for text not yet drawn,
and text set from code following the typing rules.

## Not yet

- The caret doesn't blink (Zed blinks it). Easy to add with a timer; left out to keep shots
  and tests deterministic until there's a way to turn it off for them.
- No VoiceOver yet: GPUI has an accessibility layer (`examples/a11y.rs`) to wire in.
- A long placeholder in a growing field is cut to the field's minimum lines.
