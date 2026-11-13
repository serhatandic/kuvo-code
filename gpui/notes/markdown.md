# Markdown

**Ours:** `kuvo_ui/src/markdown.rs`. Gallery page: `gallery/src/pages/markdown.rs` (and the agent
replies on the chat list page). Shots: `shots/markdown-{light,dark}.png`.

## What Zed does (studied, not copied)

Files read: `crates/markdown/src/{markdown.rs,parser.rs,selection.rs}` (GPL-3.0), and GPUI's
`src/elements/text.rs` (`StyledText`, `InteractiveText`, Apache-2.0).

- Parses with pulldown-cmark on a background task into a flat list of events with source
  ranges; re-parses as text streams in; marks unfinished parses so the chat list doesn't follow
  a wrong height.
- Draws a div per block and a `StyledText` per run of inline text; headings scale per level;
  lists have a top-aligned bullet column; quotes a left bar; inline code in the buffer font on a
  faint fill; links in the accent colour, opening on a press-and-release on the same link.
- Full text selection (character, word, line), copy as plain text or markdown.

## What we take as behaviour

- pulldown-cmark (MIT) with strikethrough, task lists and tables, parsed into our own small
  block tree (`parse`), then drawn. Parsing is synchronous: chat-sized messages parse in well
  under a millisecond; a background parse comes when long documents need it.
- Our type only: H1 at 24 medium, H2 and H3 at 14 medium with space above, H4 to H6 at 13
  medium muted; body 14/20; strong text takes the medium weight (the brief allows two).
- Lists: a 22 px marker column (•, 1., or a task checkbox in the accent colour), nesting by
  indent. Quotes: a 2 px bar and muted text. Tables: hairline grid, sunken header row.
  Rules: a hairline. Code: block 7's `CodeBlock`.
- Links: accent colour, pointing hand, open on click (GPUI's `InteractiveText`, which, like Zed,
  only fires when the press and release land on the same link), and the address shows on hover
  before you click. Only `http`, `https` and `mailto` links open; anything else (`file://`, an
  app's own scheme), which a reply could hide behind harmless words, is drawn as plain text.
- Tables share their width by how much each column holds, so paths get the room.
- Streaming: half-written markup shows as typed until it closes (tested).

## Not yet

- Selecting and copying text from a message. GPUI's text elements don't select; this needs our
  own selection layer over the text layouts, as Zed has. The most important gap for a chat.
- Inline code can't be smaller than its line (GPUI runs share one size), so SF Mono sits at
  the body size.
- Images, footnotes, and GitHub-style alerts.
