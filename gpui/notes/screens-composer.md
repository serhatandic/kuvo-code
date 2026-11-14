# The composer (Zed's message editor)

Shots: `shots/screens-asking-*` (a reply written), `screens-slash-*` ("/" offering what the box
offers), `screens-conversation-*` (Stop while a run is under way).

## What Zed does

Read: `crates/agent_ui/src/message_editor.rs`, `crates/agent_ui/src/completion_provider.rs`,
`crates/agent_ui/src/agent_model_selector.rs`, `language_model_selector.rs`, `mode_selector.rs`,
`profile_selector.rs`, the composer in `thread_view.rs`, `assets/keymaps/default-macos.json`.
Behaviour only.

- A field that grows from one line, with a row of chips under it: the model (with its provider's
  icon) and the thinking effort as small borderless buttons with a chevron, each opening a menu.
- Send is a filled icon button: muted while empty, accent with text; while it generates with the
  field empty it's Stop. Esc stops.
- Return sends, Shift-Return adds a line.
- "/" opens a completion list of commands with their descriptions; a pick fills the field.
- Sending while it runs queues the message (or steers, by choice).

## What Kuvo takes

- The text field block, bare in a card, growing to ten lines; Return sends, Shift-Return adds a
  line.
- What's written goes through `kuvo_box`'s typed send (#668): a plain message straight to the box
  as fields (`kuvo/sessions/<id>/send`); "/" and "!" to the box first (`…/typed`), which says
  what they mean and what's sent. What the box puts back goes back in the field, with its reason
  under it; what it did shows as a line under the composer ("Switched to Plan.", a side question
  asked, a handoff being written). What's this client's to do that it can't yet (a "!" command,
  compacting, Autopilot, goals, side threads) says so plainly, and what was written stays in the
  field.
- "/" lists what the box offers there (`GET …/typed`), names starting with what's typed first,
  then those containing it, each by name (as KuvoClient's `SlashCommands.matches`), scrolling
  past eight: ↑↓
  move, Tab or Return takes it ("/review "), Esc puts the list away. A keyword the text starts
  with shows as a chip above the field ("/plan"), as the sent message shows it.
- The model chip names the conversation's model as the box says (`kuvo/sessions/models`), "Choose
  a Model" when it's gone or there's none (as KuvoClient's `SessionModelState.namesModel`), and
  "Model" while the box hasn't said, so one can still be picked. Its menu lists what the box
  offers (`kuvo/models/offered`, without retiring or hidden ones) on the conversation's own side,
  as the box says each one's `side`: only those are picked in place (`api/session/<id>/model`).
  Another side's models carry a conversation to a new session (`kuvo/sessions/<id>/agents`), which
  this app doesn't do yet: the menu says so. The effort chip lists the model's `efforts`, as the box
  offers them, titled as every client titles them. A side the box couldn't say keeps what it said
  before, and is asked again in a while, longer each time; a model whose state couldn't be read
  keeps what was said of it. The model is read again as the conversation opens, and as its box
  says its accounts, models, settings or Custom Auto's lists changed (or this conversation's model
  did), from the conversation's own events. A model that can't run keeps the message in the field,
  saying why and pointing to Kuvo Code on your Mac or iPhone (worded as KuvoClient's
  `SessionModelState`).
- Each conversation keeps its own composer while you're in another: its draft, and a send still
  on its way, whose failure puts the text back with why.
- Send is an accent arrow; with nothing written while the session works, it's Stop (Esc too), which
  asks the box to stop (`kuvo/sessions/<id>/stop`).
- Sending while it runs steers, as the box's `send` does by default.

## Where we differ, and why

- No queue view, no attachments, no "@" or "&" yet: phase 3.
- The model menu isn't searchable yet (Zed's is): the box offers a short list today.
- Picking another model while a run is under way takes effect from its next step. The Mac app also
  stops the step and adds a note; that's logic the box should own, so it isn't copied here.
