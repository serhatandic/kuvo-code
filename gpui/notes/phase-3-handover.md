# Phase 3 handover

## Where it stands (paused for quota, 2026-11-14)

Committed on `kuvo/gpui-phase-3-tool-output-ask-cards`:
1. **Tool output** (area 1): steps open to diffs, command output and search results, folded past
   12 lines. `kuvo_ui/src/output.rs`, `notes/screens-tool-output.md`, shots `screens-steps-*`.
2. **Sidebar search and keyboard** (area 4): by name as you type, conversations via `kuvo/search`
   from 3 characters; arrows/Return/Escape walk the list; ⌘⇧F. Shots `screens-search-*`,
   `screens-walking-*`.
3. New icons (image, paperclip, pencil, question, shield) for what's next.

**In progress, uncommitted:** the box worker's edits under `Packages/Box` (asks, queue items and
mentions routes; it had done the queue and mentions parts and was starting the asks area when
stopped). They're unchecked: review them, finish, and run the box's checks before committing.
The spec it was given:
- `sessions.asks`: `GET kuvo/sessions/<id>/asks` (+ `/events`), each ask worded by the box (title,
  command, diffs, resources, choices Allow Once / Always Allow… / Don’t Allow / Tell It What to Do
  Instead…, or a question's fields), and `POST kuvo/sessions/<id>/asks/<ask>` to answer.
- `queue.items`: `GET …/queue` gains `items`, one ordered list (held, engine's steer, its queue,
  the box's), plus `…/queue/events`; `DELETE …/queue/<item>` takes back an engine inbox item too,
  answering `removed` for Edit.
- `sessions.mentions`: `GET kuvo/sessions/<id>/mentions?for=files|agents&q=`, ranked as the Mac's
  `Mentions.matches` and `AgentReferences.matches`.

## Next
1. Finish and check the box routes (route-shapes, build-box, build-agents `--check`, compat.sh,
   test-box for the new tests and `bridge compat.test.js`/`bridge.test.js`).
2. `kuvo_box`: asks (read, follow, answer), queue (items, remove), mentions.
3. Ask cards in the conversation (in the composer's place, "2 of 3" pager as `AskPlace`), and drop
   the "can't answer yet" line.
4. Composer: attachments (paperclip, drop, chips with thumbnails, `file://` to this Mac's box),
   "@" and "&" lists from the box's mentions, the queue view (edit = remove + put back, remove).
5. Gate lists (`BoxGate.required` and `gate.rs`, plus `vectors.rs`), the phone's `DemoBox.swift`
   features in a phone worktree, `batch-build.sh --compile-only all`.
6. Shots of each, the reviewer pass, and the rest of this note (decisions for the user).

## Decisions for the user (so far)
- ⌘⇧F for the sidebar's search: a new shortcut (the Mac app has none; ⌘F there is Find in
  Conversation).
- The diff colours (theme tokens `diff_*`) and the fold at 12 lines: new look, built without drafts.
