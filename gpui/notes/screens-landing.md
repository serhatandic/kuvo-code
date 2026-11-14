# The landing view (Zed's empty thread)

Shots: `shots/screens-landing-*`, `screens-empty-*` (a box with no projects yet).

## What Zed does

Read: `crates/agent_ui/src/conversation_view/thread_view.rs` (what it draws with no messages),
`crates/agent_ui/src/conversation_view.rs`, `crates/agent_ui/src/agent_panel.rs`. Behaviour only.

- No welcome screen: with no messages, the composer grows to fill the panel. With no project
  open, it offers to open or clone one.

## What Kuvo takes, and where we differ

We follow Capy's landing (the user's reference), not Zed's:

- The composer in the middle of the card, a little above centre, on the dotted backdrop, with
  where it starts above it: the project chip (every project the box lists, newest first, then
  "No project", a chat) and the box it's on with its dot.
- It starts in the newest project until another is picked; a project's "+" in the sidebar opens it
  in that project.
- The model and effort chips offer what the box offers (the coding agents' too), starting on the
  model the box says new ones start on (`kuvo/models/offered`'s `starting`); where it says nothing
  runs, the chip says "Choose a Model" and Send waits.
- Send starts the session on the box (`POST kuvo/sessions`, `sessions.start.empty`, in the project
  or as a chat, on the model picked), then sends what was written to it through the typed send, so
  "/" works from the first message as the box decides, and opens it. Where the message couldn't
  go after the session was made, the session opens with it back in its composer, saying why.
