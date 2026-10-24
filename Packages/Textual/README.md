# Textual

The Markdown renderer for replies, in Kuvo Code and Kuvo Code for iPhone.

**This is a copy of [Textual](https://github.com/gonzalezreal/textual) by Guille Gonzalez (MIT),
at upstream 0.5.0 (`01b5187`), with changes of Kuvo Code's own.** Its tests, examples and scripts
aren't copied; `Tests` has tests of this copy's own.

## What's different from upstream

Upstream lays a text out over several passes: `StructuredText` parses its markup in an
`onChange(initial:)` after it's first drawn, and so do the inline styles and each fragment's
`Text`. A reply was laid out empty first, then at its size, so in a lazy stack its height changed a
frame after it appeared, and the conversation jumped while you scrolled up into it. Here:

- **One pass.** `StructuredText` parses, `WithInlineStyle` styles and `TextFragment` builds its
  `Text` as the view is drawn, each kept and made again only when what it's made from changes.
- **Less per fragment.** A fragment watches its container's size only when it has attachments,
  overlays its attachments only when it has some, takes link taps only when it has links, and
  lays out a view for the selection only while something is selected.
- **The code highlighter starts off the main thread.** Making it (JavaScriptCore with Prism)
  took a quarter of a second, on the first code block's way to the screen.
- **Selection asks for layouts only once it's needed (macOS).** Reading `Text.LayoutKey` has
  SwiftUI lay each text out once more, which cost about a third of drawing a reply. A text's
  `TextSelectionModel` turns active when the pointer rests on it in the active app, or on the
  first click (handled once the layouts are in); until then nothing reads them. Fragments pass
  their layouts on through `TextLayoutsKey`. Selectable text's links are opened by the selection's
  view, so fragments don't read layouts for link taps either. iOS is as upstream.
- **Block and table spacing in the first layout.** A style's `blockSpacing` is also a layout
  value the block stack reads as it lays a block out, and `tableCellSpacing` comes down to the
  table's grid through the environment; upstream waited for preferences, laying every block and
  table out again. A list or quote, whose own blocks set their spacing, takes a paragraph's.
- **Code colored at once.** Tokens are kept in a cache (`TokenCache`), so a code block made
  again is colored from its first frame, and `CodeHighlighting.prepare(markdown:)` reads code
  blocks into it ahead of time.
- **Images from files only, when asked.** `AttachmentLoader.localImage(relativeTo:)` loads a
  document's own pictures and refuses anything that isn't a file, so a previewed README doesn't
  reach the hosts its badges name.

- **Task lists.** An unordered list item that starts with `[ ] ` or `[x] ` (GitHub's task list)
  shows a checkbox in the bullet's place, without the brackets (`UnorderedList.swift`).
- **Math found as the Markdown is read.** Upstream's `.math` matched `$…$` and `$$…$$` in the
  parsed text, after Markdown had garbled the LaTeX (`\\` read as an escape, `_` and `*` as
  emphasis, `+ x` as a list item), and in prices. Foundation's parser can't be given syntax of its
  own, so `MathSyntax` reads the Markdown once with each `$`, `\(`, `\)`, `\[` and `\]` swapped
  for a private-use character: those that come out as text can open or close a formula, those in
  code or a link's address can't (`MathScanner`), and prices and the shell's `$$` are told apart
  there. Each formula is then swapped for one character while the Markdown is read for real, and
  put back in the line as `MathSyntax.inline` makes it, or as a code block of its own
  (`SyntaxExtension.math(_:)`; `.math` makes `MathAttachment`s and ` ```math ` blocks).

## Updating

Compare upstream's changes since `01b5187` with this copy, and port them by hand, keeping the
changes above.
