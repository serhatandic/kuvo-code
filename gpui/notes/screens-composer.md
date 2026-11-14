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
  under it; what it did shows as a line under the composer ("Switched to Plan."). What's this
  client's to do that it can't yet (a "!" command, compacting, Autopilot, goals, side threads)
  says so plainly, and nothing is lost.
- "/" lists what the box offers there (`GET …/typed`), filtered as you type: ↑↓ move, Tab or
  Return takes it ("/review "), Esc puts the list away. A keyword the text starts with shows as
  a chip above the field, as the box will read it.
- The model chip names the conversation's model as the box says (`kuvo/sessions/models`), "Choose
  a Model" when it's gone or there's none; its menu lists what the box offers
  (`kuvo/models/offered`, without retiring or hidden ones). The effort chip lists the model's
  efforts (its variants), titled as every client titles them; a pick sets the conversation's model
  (`api/session/<id>/model`). A model that can't run keeps the message in the field, saying why
  (worded as KuvoClient's `SessionModelState`).
- Send is an accent arrow; with nothing written while the session works, it's Stop (Esc too), which
  asks the box to stop (`kuvo/sessions/<id>/stop`).
- Sending while it runs steers, as the box's `send` does by default.

## Where we differ, and why

- No queue view, no attachments, no "@" or "&" yet: phase 3.
- The model menu isn't searchable yet (Zed's is): the box offers a short list today.
- Picking another model while a run is under way takes effect from its next step. The Mac app also
  stops the step and adds a note; that's logic the box should own, so it isn't copied here.
