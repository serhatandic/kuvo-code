# The new sidebar (#707): handover

## Done

The user's pick from `notes/sidebar-drafts.md`, built into the app (`gpui/kuvo`), replacing phase
2's sidebar. Notes: `notes/screens-rail.md` (with the Zed study). Scenarios: `kuvo/tests/areas.rs`
(11). Shots: `shots/screens-area-*-{light,dark}.png`, and every earlier `screens-*` shot rendered
again in the new layout.

- **Layout (option A):** title bar across the top; a 60 px rail with 20 px icons and counts on them;
  the area's sidebar (272 px) and its main view share one raised panel, rounded against the rail.
  The conversation's title and project are in the title bar; so is the side panel's button.
- **The rail** (`kuvo/src/rail.rs`): Sessions, Bots, Work Queue, Computers; at the foot a ring per
  account, Help (opens the docs) and Settings. Tooltips name each area and its key. Clicking the
  open area folds its sidebar away, or brings it back.
- **⌃1 to ⌃5** switch areas from anywhere in the window (`kuvo/src/area.rs`); back in Sessions the
  keyboard returns to the conversation or the landing view. **⌘[ and ⌘]** go back and forward (the
  Mac's ⌘[ is Back too).
- **Narrow window:** under 820 px the area's sidebar folds away and the rail stays; its button
  brings it out beside the main view; ⌘⇧F brings it out with the search. A wide window shows it
  again.
- **Sessions:** "Needs you" on top (B's): sessions waiting on you across projects, in the box's
  order, each with its project and what it asks; the open session is highlighted there only. The
  rest is phase 2–3's sidebar (search, walking, projects, chats), less its New Session row and foot
  (now the title bar's + and switcher). The keyboard walks "Needs you" too.
- **Bots** (`kuvo/src/areas.rs`): each bot with a still face (its look's colour and shape, calm
  eyes; not animated, as the user asked), what it's doing (or its job), a count of what waits on
  you or a spinner; then Group Chats (unread dot, last time).
- **Work Queue:** In Progress and the box's categories (dots by KuvoClient's rule), with counts.
- **Computers:** this box, then the machines it runs sessions on (`kuvo/machines`) with the box's
  status words and a dot for how each is reached.
- **Settings:** the Mac's sections, in its groups. "+N" past four rings opens Usage; the empty ring
  (no account) opens Accounts.
- **Placeholder pages:** every row in Bots, Work Queue, Computers and Settings opens a plain page:
  its name, and "This page isn't in this app yet. For now, open it in Kuvo Code on your Mac or
  iPhone."
- **Title bar** (`kuvo/src/title_bar.rs`): the computer switcher (this box, its state when not
  connected; its menu says switching isn't in the app yet, and offers Show Computers), back,
  forward (disabled at either end) and +.
- **Rings:** each account's service mark (OpenUsage's provider icons, MIT, as Kuvo Code already
  ships them; `assets/marks/`, recorded in `LICENSES-DEPS.md`; none from Zed), the arc and its
  colour by the box's level; resting on one shows the account, its plan and each window with when it
  starts over. Read every two minutes while the app runs.
- `kuvo_box::areas`: typed reads of `kuvo/bots`, `kuvo/groups`, `kuvo/work-queue` (categories),
  `kuvo/machines`, `kuvo/agents/api/kuvo/limits` (rows) and `kuvo/waiting`. A row a newer box sends
  in a shape this can't read is left out, not the list.
- The stand-in box answers all of these (`kuvo/src/stand_in/areas.rs`), with #711's fields;
  `StandIn::before_711()` answers as a box does today.
- `cargo build`, `cargo test` (workspace) and `cargo clippy --all-targets` for kuvo, kuvo_box and
  kuvo_ui pass clean. Every run with `KUVO_*` unset and the stand-in box only.

## BOX-NEEDED (#711)

`grep -rn BOX-NEEDED gpui/kuvo gpui/kuvo_box/src`. The app reads each as an optional field in the
shape below (`kuvo_box/src/areas.rs`) and works out none of it: a box that doesn't send it gets the
plain form (shown in `screens-area-before-711-*`). The shapes are proposals; #711 decides, and the
reads and the stand-in follow whatever it picks.

| What | Route and shape | Where it's drawn | Until then |
|---|---|---|---|
| What waits on you, per area | new `GET kuvo/waiting` (+ `/events`) → `{sessions, bots, queue, …}` | `rail.rs`, the rail's counts | no counts (asked once; a 404 isn't asked again) |
| "Needs you" | same route, `needsYou: [{session, asks}]`, in the box's order, `asks` in its words | `sidebar.rs`, `lines` | no group |
| A ring's share and level | `rows[].ring: {used, level: calm\|near\|over}` in `GET kuvo/agents/api/kuvo/limits` (+ `kuvo.limits.updated`) | `rail.rs`, `ring_button` | the track and mark alone |
| A window's level | `rows[].windows[].level` | `rail.rs`, `account_card` | a quiet meter |
| What a bot is doing | `now: {working, asking, words}` on each bot in `GET kuvo/bots` (+ `/events`) | `areas.rs`, `bots_rows` | its job, no count or spinner |
| The queue's counts | `counts: {inProgress, categories: {<id>: n}}` in `GET kuvo/work-queue?owner=all&glance=1` (+ events) | `areas.rs`, `queue_rows` | no counts |
| Computers as one list | new `GET kuvo/computers` (+ events) → `[{key, name, kind, shared, reach, version, system, working}]` | `areas.rs`, `computer_rows`; `title_bar.rs`, the switcher | this box, and `kuvo/machines` (a Mac's machines only) |
| A project's sums | `projects[<dir>].{asking, working}` in the sessions listing | `sidebar.rs`, the project row | phase 2's count in the client (left to move, not extended) |

## Left

- **Not built (no new features):** the areas' own pages (bots, the queue, a computer, Settings);
  searches in the other areas' sidebars; New Bot, Add a Machine, New Category; the queue's Show
  Only filters; switching the window to another computer (the app reaches this Mac's box only); a
  live follow of bots, groups, the queue and machines (each is read as its area opens);
  `kuvo/waiting/events` (read again as the session list changes); the light/dark toggle that sat in
  the old sidebar's foot (⌘⇧L still switches).
- **Speed** (`notes/screens-rail.md`): the Sessions sidebar is still drawn row by row by the
  workspace; next is its own view with a flat row list and `ListState` spliced where rows change.
- Group chats that can't be read leave the Bots list without them, unsaid.
- No VoiceOver labels (GPUI has no accessibility here yet); larger text not tried.
- The ring's hover card has no shot (it needs the pointer to rest); `account_card` is drawn from
  the same data as the rings.
- The phone: a rail doesn't fit; `notes/sidebar-drafts.md` ("The phone") suggests the tab bar. Not
  sent to a phone session: the GPUI app isn't shipped and the phone's look is the Swift one's.
- Docs and CHANGELOG: none needed (the desktop client isn't shipped; the Mac and the phone don't
  change).

## Decisions for the user

- **The page words** for areas not built yet: "This page isn't in this app yet. For now, open it
  in Kuvo Code on your Mac or iPhone." (phase 2's wording). Recommended: keep until the pages come.
- **Narrow at 820 px**, and the sidebar brought out pushing the conversation over (not floating, as
  option C did). Recommended: keep (A's).
- **⌘[ and ⌘]** for back and forward (as the Mac's Back). Recommended: keep.
- **No New Bot, Add a Machine or New Category rows** (the drafts had them): left out rather than
  shown doing nothing. Recommended: add each with its page.
- **The marks:** OpenUsage's provider icons (already in Kuvo Code) rather than models.dev's logos,
  because they're by the box's service ids and include Cursor and Antigravity. Monochrome, in the
  ring's ink. A brand question if the user wants them in colour.
- **Rings read every two minutes** while the app runs (the box reads accounts on its own clock).
- **The proposed shapes for #711** (above): `kuvo/waiting` carrying both the counts and "Needs
  you"; the box session should confirm or change them.
- **Bot shapes, still:** round, squircle, pebble, gem and bloom are drawn as rounded squares of
  different corners, not the Mac's own outlines.
