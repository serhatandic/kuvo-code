# Sidebar drafts: a rail and each area's own sidebar (OpenBot's layout)

Drafts only, for the user to pick from: `gallery/src/drafts/`, fixed sample data, nothing in the app
(`gpui/kuvo`) uses them. Shots: `shots/sidebar-<a|b|c>-<scene>-<light|dark>.png`, rendered by
`cargo run -p kuvo_gallery --features shots --bin shots -- sidebar`; in the gallery window, the
"Sidebar drafts" page switches between them.

## The layout

Two sidebars, as OpenBot's: a narrow **rail** switches between the big areas (Sessions, Bots, Work
Queue, Computers, with Help and Settings at its foot), and beside it **the area's own sidebar**,
Search on top, then that area's navigation:

- Sessions: projects with their sessions nested, then chats (phase 2's rows: a spinner at work, an
  accent dot and time waiting on you, a count per project, "+" per project under the pointer).
- Bots: each bot with a still avatar (the animated faces aren't brought over) and what it's doing,
  New Bot, then group chats.
- Work Queue: In Progress, its categories (Next, Later, a custom one, Parked, Done) with counts,
  then Show Only (issues and pull requests, a computer, Deleted).
- Computers: your computers with how each is reached and what's at work there, Add a Machine,
  shared machines.
- Settings: its sections, in the Mac's groups.

At the rail's foot, one **usage ring per signed-in account**: the arc is the share of its fullest
window, green (or grey, in C), amber from 70%, red from 90%; hovering or clicking shows the
account's windows, each with when it starts over. The title bar has the computer switcher ("This
Mac ⌄") in OpenBot's workspace switcher's place, then back, forward and New Session.

**The switcher and the Computers area.** The title bar's switcher picks whose box the window shows
(its sessions, bots and Work Queue); the Computers area lists your computers and their state, and
opening one there shows its page without switching, with "Switch to devbox" on it.

**Many accounts.** The rings follow the box's order; past the option's room (4 in A and C, 3 in B)
the rest wait behind "+N", which opens Settings › Usage. With none signed in, an empty ring with
"+" says to sign in to see the limits there.

**Bots** show a still face (their tint and form, calm eyes) standing in for the Mac's `BotAvatar`
drawn without animation; the full faces aren't brought over yet.

## The options

- **A, OpenBot's layout.** 60 px rail, 20 px icons, counts on the icons, coloured rings. The area's
  sidebar and the main view share one raised panel with a rounded corner against the rail; the
  conversation's title sits in the title bar; back, forward and + sit at the sidebar's edge.
  Narrow: the area's sidebar folds away, the rail stays.
- **B, labelled rail with Needs you.** An 84 px rail with words under each icon and the percentage
  under each ring (Slack's rail). The Sessions sidebar opens with "Needs you" (Capy's): sessions
  waiting on you across projects, with what each asks. The main view is an inset card. Narrow:
  the rail drops its words.
- **C, compact.** A 48 px rail with 14 px icons, dots for "waiting", names on hover (with their
  shortcut), quiet grey rings that colour only near a limit. The area's sidebar names its area with
  its "+", and folds projects. Narrow: the area's sidebar floats over the conversation.

## What Zed does (studied, not copied)

Zed has no separate activity bar; its equivalent is the dock's panel buttons. Read, for behaviour
only (GPL code, nothing copied): `crates/workspace/src/dock.rs` (`PanelButtons`, `Panel::icon_label`)
and `crates/title_bar/src/title_bar.rs` (`render_project_name`, `render_project_host`).

- One icon button per panel, with a tooltip naming it and its shortcut; the one whose panel is open
  shows as toggled.
- Clicking the open panel's button closes the dock; another button switches to its panel.
- A panel can put a short count on its button (`icon_label`: changes, terminals).
- Right-clicking a button moves its panel to another dock.
- The title bar names the project (truncated; nothing open says "Open Recent Project") and opens
  the recent projects picker; a remote project shows its host beside it, and "Disconnected",
  dimmed, when it's lost.

Kuvo takes the first three: the open area's button is filled, clicking it again folds its sidebar
away (A's narrow window), tooltips carry the shortcut (C), and counts sit on the buttons (A and B).
Moving areas between docks isn't taken: the rail has one place. The computer switcher follows
Zed's project name and host: it names the computer and opens the list of yours; one that can't be
reached would say so there, as Zed's "Disconnected" (not drawn in these drafts).

## Where Kuvo differs from OpenBot, and why

- OpenBot's rail has flows, stats and a store; Kuvo's has its own areas, and Help opens the docs.
- A ring's mark is a letter here; the real marks are the box's `service` (a brand question for the
  user: the services' logos).
- OpenBot's rings are always in their provider's colour; ours show how close the account is to its
  limit, as the brief asks.

## Left for the box (`grep -rn BOX-NEEDED gpui/`)

Every place a draft draws what the box doesn't say yet has a `// BOX-NEEDED:` comment naming what
the box should say and where. None is built; the box sessions take them.

## The phone

A rail doesn't fit a phone. There the same areas would be the tab bar (Sessions, Bots, Work Queue,
Computers, Settings), each tab opening its area's list, and the rings a row at the top of
Settings › Usage, or of the Sessions tab, with the same colours.

## Decisions for the user

- Which option (or which parts of each).
- Keys for the areas: ⌘1 to ⌘8 are the Mac's tabs, so none is shown yet.
- The rail's icons at 20 px in A and B (OpenBot's size; the brief keeps 20 for cards), or 14 as C.
- The services' marks in the rings (letters stand in), a brand question.
- Icons beside Settings' sections, as the Mac's sidebar has (not drawn: most aren't in our set).

## Picked (2026-11-14)

Option A's layout, with B's "Needs you"; ⌃1 to ⌃5 for the areas; large rail icons; the services'
real marks in the rings; bot faces still. Built into the app in #707: `notes/screens-rail.md`,
`notes/sidebar-handover.md`.
