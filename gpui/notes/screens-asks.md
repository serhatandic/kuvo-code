# What a conversation asks you (Zed's permission buttons; the Mac's ask cards)

Shots: `shots/screens-asking-*` (a permission, "1 of 2"), `screens-question-*` (the agent's
question). Code: `kuvo/src/ask_card.rs`; `kuvo_box::asks`.

## What Zed does

Read: `crates/agent_ui/src/conversation_view/thread_view.rs` (`render_permission_buttons`,
`render_permission_buttons_flat`, `render_permission_buttons_with_dropdown`,
`render_permission_granularity_dropdown`, `allow_once`/`reject_once` actions),
`crates/agent_ui/src/conversation_view/elicitation.rs` (an MCP server's form). Behaviour only.

- A permission shows on its tool call's card, in the thread: the call (its command, or the diff)
  above a row of buttons, one per option the agent offers: Allow Once (✓), Always Allow (✓✓,
  sometimes with a dropdown of how wide), Reject (✕). Keyboard actions allow once and reject.
- An elicitation is a form of fields rendered in the thread, with Accept, Decline and Cancel.

## What Kuvo takes

As the Mac and the phone show them, rather than Zed's, so every client answers alike:

- One card in the composer's place while anything waits (the composer comes back once nothing
  does), the keyboard on it. Several: "1 of 2" with ‹ ›, staying on the one shown while others
  come and go (KuvoClient's `AskPlace`, ported with its test).
- Everything on it is the box's words (`GET kuvo/sessions/<id>/asks`, followed by its
  `…/events`): the title ("Allow running this command?"), what it would run (the whole command
  line), change (each file's diff) or reach (what it covers), and its answers in order, numbered:
  Allow Once, Always Allow with what it saves as code, Don’t Allow, Tell It What to Do Instead….
  Number keys pick; Return is Allow Once; Escape opens Instead's line, whose words go as Don't
  Allow with them.
- The agent's question: one of its questions at a time, its choices numbered (a click or a number
  picks; one that takes several toggles), a line for your own words where it takes them, Skip and
  Next/Answer, × to put it away unanswered. A form this app can't take says to answer it on the
  Mac or iPhone.
- Answers go through the box (`POST kuvo/sessions/<id>/asks/<ask>`), which sends them to the
  engine or the coding agents' bridge for the session that asked (a subagent's too). One answered
  elsewhere meanwhile (`404`) goes; one that couldn't go says why on the card.

## Where we differ, and why

- In the composer's place, not on the tool call: the Mac's and the phone's place, and an ask stays
  in view however far the conversation has scrolled.
- No dropdown for how wide Always is: the box words what Always saves.
