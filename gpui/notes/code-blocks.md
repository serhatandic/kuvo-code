# Code blocks

**Ours:** `kuvo_ui/src/code_block.rs`. Gallery page: `gallery/src/pages/code_blocks.rs`.
Shots: `shots/code-blocks-{light,dark}.png`.

## What Zed does (studied, not copied)

Files read: `crates/markdown/src/markdown.rs` (its code-block rendering and copy button),
`crates/language/src/language.rs` (`highlight_text_resolved`), and the numbered tool-output
blocks in `crates/agent_ui/src/conversation_view/thread_view.rs` (all GPL-3.0).

- The fence's language is looked up by name or extension; tree-sitter parses the block with the
  grammar's highlight query; captures map to theme colours. Results are cached by text.
- Rounded block on the editor background, buffer font, long lines scroll sideways in their own
  scroll area (a scroll container needs a `flex` parent and a `flex_none` child in GPUI).
- A Copy button at the top right (on hover in the agent panel) turns into a green check for
  two seconds.
- No line numbers in markdown; the agent panel adds a gutter for `cat -n`-style output.

## What we take as behaviour

- tree-sitter (MIT) with tree-sitter-highlight and the grammars' own highlight queries (all
  MIT): Rust, TypeScript, TSX, JavaScript, Python, JSON, Bash and Go, with common aliases
  (`ts`, `sh`, `py`, ...). Captures map to nine kinds coloured by the theme's syntax palette.
  Unknown languages are plain. Highlights are cached by language and text.
- A card: 16 px radius, sunken fill, hairline border; a header with the language and a Copy
  button that reads "✓ Copied" for two seconds (always visible: hover-only controls are hard
  to find and don't work on touch).
- SF Mono at 13/20; long lines scroll sideways inside the block, keeping their margin at the
  end. Comments and line numbers are checked for contrast on the block's fill (3:1 and 2:1).
- Copy says "Copied" for two seconds after the latest click.
- Line numbers are optional: on for files and diffs, off in messages, as in Zed.

## Not yet

- Wrapping long lines as an option; a scrollbar or edge fade showing there's more to the right.
- Highlighting runs on the UI thread (fast for message-sized code, cached); large files will
  want it on a background task.
- More languages (Swift, CSS, HTML, YAML, TOML, Markdown) as their MIT grammars are added.
