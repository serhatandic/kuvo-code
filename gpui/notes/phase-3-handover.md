# Phase 3 handover

## Done

Notes per area: `notes/screens-tool-output.md`, `screens-asks.md`, `screens-composer.md` and
`screens-sidebar.md` (each names the Zed files read). Shots in `shots/screens-*-{light,dark}.png`.
Scenarios in `kuvo/tests/screens.rs`.

1. **Tool output.** A tool step opens to an edit's diff (numbered, added and removed lines on their
   washes, "+4 −2" on the row), a command's output under `$ command`, or a search's results; long
   output folds to 12 lines with "Show all N lines". Block: `kuvo_ui/src/output.rs`. Shots:
   `screens-steps-*`.
2. **Asks.** Permissions and the agent's questions as a card in the composer's place, worded by the
   box (`kuvo/sessions/<id>/asks`, followed by its events) and answered through it (`POST
   …/asks/<ask>`): numbered answers, number keys, Return (Allow Once), Escape (Tell It What to Do
   Instead…), a question's choices and your own words, "1 of 2" across asks (`AskPlace`, ported).
   The phase 2 line about asks this app couldn't answer is gone. Shots: `screens-asking-*`,
   `screens-question-*`.
3. **The composer.** Attachments (paperclip, drop, thumbnails and chips, `file://` on this Mac's
   box; files alone can be sent): `screens-attached-*`. "@" and "&" from the box's mentions route,
   with an agent picked named on send: `screens-files-*`, `screens-agents-*`. The queue over the
   composer in the box's order, with Edit (back to the composer) and Remove: `screens-conversation-*`.
4. **The sidebar.** Search by name as you type, and from three characters the conversations the box
   finds (`kuvo/search`); arrows walk the list from the search, Return opens or folds, Escape
   leaves, ⌘⇧F to the search: `screens-search-*`, `screens-walking-*`.
5. `kuvo_box`: `asks`, `queue`, `mentions`, `search` (and `Listing::named`), `File::at`, a follow of
   a box's ndjson list (`Followed`), `Request::delete`.
6. Clippy clean for kuvo, kuvo_box and kuvo_ui with all targets (phase 0's warnings fixed too).

## Review

One reviewer pass. Fixed: a digit typed in a card's own line answered the permission (now words,
with a test that presses the keys and fails without the fix); the box's own asks showed nothing
(now `other` cards, `dismiss: false`); a card that just replaced another took the key meant for it;
an MCP form had no way out (× when the box says `dismiss`); a newer ask kind spoiled the whole list
(now left out); asks reached a machine's kept server up to 15 s late (the events route looks at
the asks file each second); failures of the asks and queue follows weren't drawn (a quiet line
now); the empty conversation said "Write below" under a card; mentions asked the box on every key
(a 150 ms pause now); "Show all" past 400 lines overpromised. Left for the user: which steps open
(Decisions).

## Second review (the lead's)

Fixed, each with a test: a held key answered the next ask (keys ignored while held, and until the
card shown has been still 600 ms, as the Mac's `KeysTyped`); Return with nothing picked threw a
question away; the card never had the keyboard in the app (it takes it as it comes, gives it back
as it goes); your own answer racing the box's update swallowed the next key (gone with the quiet
rule); Skip looped on a required question (off for one that needs an answer); the box's own asks
blocked the conversation (they sit over a usable composer); the live follows were untested (the
stand-in follows asks and queues, and a scenario runs the follows' threads, held steady 15 of 15).
Box: a subagent listing that fails says the engine isn't answering, so asks don't seem gone; MCP
servers' forms filed under no session show in the conversation whose step runs that server's
tool; `GET …/queue` answers `items` only with `?items=1`, so the Mac's and the phone's reads are as
before; a held box still answers a conversation's asks (`BoxGate`, `gate.rs`, PROTOCOL.md). NITs:
an ask missing a field spoils none of the rest (held to `answers.json`'s shape); lines are cut at
400 characters and patches read only once shown; Return in an empty search does nothing; old
suggestions go as the mention changes; a shared "@" listing stops only once no request waits on
it; a bridge test for `DELETE …/queue/<item>` taking back what the engine holds.

**Decided (point 4):** which tool steps open is drawing, and stays in the client (`details()`).
PROTOCOL.md has a "Tool steps" table (names and aliases, the target, what opens), and every
client's samples are `Packages/KuvoLink/Vectors/tool-steps.json`, which gpui's tests read. **The
phone should test its step rows against the same file** when it next touches them.

## Box changes

All additive, each with its route shape, PROTOCOL.md section, feature name and tests
(`Packages/Box/test/session-asks.test.ts`, `queue-items.test.ts`, `mentions.test.ts`):

- `sessions.asks` ("A conversation's asks"): `GET kuvo/sessions/<id>/asks` (and `…/events`), every
  permission and question waiting in a conversation and its subagents, worded as the Mac's cards
  (title, command, diffs, what it covers, numbered answers, what Always saves); `POST
  …/asks/<ask>` answers the session that asked (Instead: a reject with your words). An MCP form, or
  one with fields a client can't take, is `other`.
- `queue.items` ("The queue"): `GET …/queue` gains `items`, every message waiting in the order
  clients show them (null while the engine can't be read), and `…/queue/events`; `DELETE
  …/queue/<item>` takes one back from the engine's inbox too, answering `removed` for Edit.
- `sessions.mentions` ("Mentions"): `GET kuvo/sessions/<id>/mentions?for=files|agents&q=`, ranked
  as the Mac's `Mentions.matches` and `AgentReferences.matches`, the "&" detail in the Mac's words.
- The update gate: the three names in KuvoClient's `BoxGate.required` and gpui's `gate.rs` (the same
  list, held so by `vectors.rs`), and PROTOCOL.md's list. The phone's sample Mac lists them:
  kuvo-code-ios branch `kuvo/gpui-phase-3-demo-features` (worktree
  `~/.kuvo-code/tmp/kuvo-gpui-p3/phone`), to merge together with this one.
- Checks: `route-shapes.sh`, `build-box.sh` and `build-agents.sh --check`, `compat.sh`, the new
  box tests (15), `test-box.sh bridge compat.test.js` (3) and `bridge.test.js` (54) pass.
- Not done for the box: tried on Linux (nothing in it differs between macOS and Linux); a test
  against the coding agents' bridge (only an engine stand-in); Always's hover and VoiceOver words
  (`AlwaysWords.help`, `spoken`) aren't in the asks shape yet. Through `box route`, asks Auto's
  reviewer took up aren't left out (only the long-running process knows them).
- Docs: nothing users see changed (the desktop client isn't shipped; the Mac and phone don't use
  the new routes yet), so no kuvo-web page or CHANGELOG line.

## Open

- **Not built:** Steer and Send Now on a queued message, Undo after Remove, Resume for a paused
  queue (the box has the routes); pasting a picture; a found conversation opening Find on its
  words; accents folded in the sidebar's name match.
- **Files to a machine's box** go as `file://`, which only this Mac's box can read: the app reaches
  this Mac's box only today. Once it reaches machines, a file goes inline (`data:`) there, as the
  Mac app sends them (`Attachments.prepareForMachine`).
- **Left in the client:** the sidebar's match by name (`Listing::named`), as the Mac and the phone
  do it; `kuvo/search` could match names too, so no client does. The mention being typed is read
  from the end of what's written (`mention_query`), as the Mac's `Mentions.query` and
  `AgentReferences.query` read it: it decides when to ask the box, nothing more.
- The box's own asks (a command outside the sandbox, something from the vault) show as a card that
  says to answer them on the Mac or iPhone: this app can't answer them yet. Through `box route` (a
  machine over SSH) they aren't listed: only the long-running process has them.
- Edit on a queued message brings back its words and files, not the keyword it went with (the
  box's `removed` doesn't carry it).
- `DELETE …/queue/<item>` now also takes back what the engine holds; the Mac and the phone take
  those back through the engine directly, so nothing changes for them.
- From phase 2, still open: commands shown as typed, machines, paging's jump, the follows' wiring
  untested at app level.

- **Box costs left as they are** (cheap enough for now, worth a look later): any ask on the box has
  every followed conversation read its asks again whole; a queue follow looks at `queues.json`
  each second; `queueItems` reads one file per message waiting on the box.

## Decisions for the user

Built without drafts (the user was away): each is the Mac's or Zed's behaviour in the phase 0 look,
and every colour and size is in `kuvo_ui/src/theme.rs` or the block, easy to change.

- **⌘⇧F** puts the keyboard in the sidebar's search: a new shortcut (the Mac app has none; ⌘F there
  is Find in Conversation). Recommended: keep it.
- **Diff colours** (theme tokens `diff_added_wash`, `diff_removed_wash`, `diff_added`,
  `diff_removed`) and the fold at 12 lines. Recommended: keep.
- **The ask card in the composer's place** (the Mac's and the phone's), rather than on the tool call
  in the conversation (Zed's). Recommended: keep, as every Kuvo client answers alike.
- **The queue over the composer** as a sunken card, actions under the pointer. Recommended: keep,
  and add Steer and Send Now next.
- **Five new icons** (image, paperclip, pencil, question, shield), drawn in the set's style.
- The keyboard's cursor in the sidebar is the accent's ring: the accent is still the user's call.
- **The card's keys** answer only once it's been still a moment (600 ms, as the Mac's `KeysTyped`),
  and never from a held key; the keyboard goes to a card as it comes and back to the composer as it
  goes. (Replaces the first review's "press again" line.)
