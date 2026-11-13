# Chat list

**Ours:** `kuvo_ui/src/chat_list.rs`. Tests: `kuvo_ui/tests/chat_list.rs`.
Gallery page: `gallery/src/pages/chat_list.rs`. Shots: `shots/chat-list-{light,dark}.png`.

## What Zed does (studied, not copied)

Files read: `crates/agent_ui/src/conversation_view.rs` and
`crates/agent_ui/src/conversation_view/thread_view.rs` (GPL-3.0), and GPUI's
`src/elements/list.rs` (Apache-2.0), which does the heavy lifting for both of us.

- A variable-height `list` that only lays out what's near the view, following its tail.
- New entries are spliced in at the end; an entry whose text is streaming is re-measured in
  place, which keeps the reader's scroll anchor.
- Scrolling up with the wheel stops following; getting back to the bottom starts it again.
- Opening a thread jumps to the end. Zed has no floating jump button: it offers keyboard
  actions and a "Scroll to Bottom" menu item, and marks unparsed markdown as provisional so
  following doesn't jump on a wrong height.

## What we take as behaviour

- `ChatListState` wraps GPUI's `ListState`: bottom-aligned (a short conversation sits just
  above the composer, as in Messages and Slack), following its tail, with a 1200 px overdraw.
- `push` for new messages, `changed(ix)` for a message that grew (streaming, a tool result):
  the reader's place holds unless they're at the bottom, in which case the list follows.
- A floating button at the bottom centre appears whenever the reader is away from the latest:
  a round ↓ button, or a "↓ New messages" pill if something arrived since they scrolled up
  (Claude, ChatGPT and Slack do the same; Zed has no button). It jumps back and follows again.
- Keyboard scrolling (`scroll_by`) behaves like the wheel.

## Findings

- GPUI anchors a following list past its last item, so `ListState::scroll_by` counts from the
  bottom of the content rather than the top of the view, and a short scroll lands back at the
  end. `ChatListState::scroll_by` corrects for that (test:
  `scrolling_back_from_the_keyboard_moves_by_what_was_asked`). Worth reporting upstream.
- `ListState::is_scrolled_to_end` is unknown while a new message is unmeasured; the block
  keeps its last answer so the button doesn't flicker away as messages arrive.
- `ListState::bounds_for_item` is `None` for every item while the list is following, so the
  tests measure where messages were actually painted.
- An item laid out by `list` is its own layout root: give it `w_full()`, or it takes its
  content's width and text won't wrap to the list.

## Tests

A short conversation sits at the bottom; a streaming reply is followed; scrolling up with the
wheel keeps the message being read in place while text and new messages arrive; the jump button
(clicked where it's drawn) returns to the latest and following resumes; scrolling back down
re-engages following; keyboard scrolling moves by exactly what was asked and holds.

## Not yet

Page Up and Down and Home and End bindings; a scrollbar; keeping the place when an earlier
message changes height above the reader (GPUI anchors to the top visible item, which covers it).
