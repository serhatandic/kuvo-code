# Phase 5 handover: Settings, Accounts and signing in

## Done

Notes: `notes/screens-settings.md` (with the Zed study). Scenarios: `kuvo/tests/settings.rs` (27,
real clicks and keys against the stand-in, a sign-in followed on the test's clock), two more in
`kuvo/tests/areas.rs` (the rings), a masked field in `kuvo_ui/tests/text_field.rs`, unit tests
for the box reads (`kuvo_box`: the shared `Vectors/sign-in.json` ways and failures, usage
settings, config paths, the rings' windows). Shots: `shots/screens-settings-*` and
`shots/screens-sign-in-*`, light and dark, each looked at; every other shot rendered again for the
restyle.

1. **Settings' sidebar** (`kuvo/src/settings/page.rs`, drawn in `areas.rs`' Settings view):
   "Settings", "Search settings…", the seven sections built (General, Accounts, Usage, Models,
   Permissions, Notifications, Browser) with icons, then "In Kuvo Code on Your Mac" with the Mac's
   other sections, each opening a page saying it isn't in this app yet. The search filters
   sections and rows; Escape clears it.
2. **Pages** (the OpenBot reference's layout, `rows.rs`): General (Theme, the only setting this
   app has of its own); Accounts (below); Usage (each account's windows as the rings' hover card,
   by KuvoClient's names); Models (`kuvo/config`'s `model`, `agents.title.model`,
   `subagent_model`, from the engine's models offered, each sent with what was read, `was`);
   Permissions (`kuvo/approval`: the mode new sessions start in, Full Access, Auto held, other
   computers' switch; `kuvo/sandbox` in the box's words, its button only where the box words it;
   `kuvo/sandbox/allowed` with Remove);
   Notifications (the usage notices, #631 G, as one part from its version, and the box's words for
   providers that can't send them); Browser (`kuvo/browser/settings`, #693: search engine, tidying
   agents' tabs, offering to save sign-ins, and the sites never offered with Offer Again).
3. **Accounts and signing in** (`rows.rs`, `sign_in.rs`, `kuvo_box/src/accounts.rs`): every agent
   and provider the box lists, signed-in state in its words, and every way the box offers: in the
   browser (followed through `kuvo/sign-in/status`), a device code (shown and copied), a code
   pasted back, a key (masked), credentials on the computer with their form; Install, Sign Out,
   Remove Account (asked first) and Disconnect (asked first, `kuvo/accounts/<id>/forget`).
4. **The look the user asked for, in the theme** (`kuvo_ui/src/theme.rs`, one place): see "The
   restyle" below. **Two rings an account** on the rail (`rail.rs`), outer the short window, inner
   the long, each by its own level; one where the box says one, one for the fullest window from a
   box before #711.
5. `kuvo_ui`: `TextField::masked()`; `row::selected_card`; menu items and switches carry debug
   selectors; the theme's `sidebar`, `card`, `selected_card`, `selected_edge`, `icon`, and
   `Theme::selected_shadow`; icons thinned as they load (`icon::STROKE`); `icon::mark_color`.
6. `cargo build`, `cargo test` and `cargo clippy --workspace --all-targets` clean. Every run with
   `KUVO_*` unset and the stand-in box only; no real key, sign-in or page (the stand-in's pages are
   at `.invalid`).

## The restyle (the user's three asks, in the theme)

- **Icons:** every outline icon loads with a 1.0 stroke in its 16-unit box (1.25 px at the rail's
  20 px, 1 px at a row's 16 px; the files say 1.3, the spinner keeps its 1.6). At rest they're the
  theme's new `icon` grey, `#7D7D7D` light, `#8F8F8F` dark (3:1 at least, lighter than muted text,
  held by the theme's test); the selected one `text`.
- **Surfaces:** the rail and title bar on `background` (`#F3F3F3`, was `#F7F7F7`), the areas'
  sidebars and Settings pages on `sidebar` (`#F8F8F8` light, `#141414` dark), Settings' cards on
  `card` (white, `#1E1E1E`).
- **Selection:** a selected row or rail tile is a card of its own (`selected_card`, white in
  light, `#232323` dark, with a hairline `selected_edge` and a soft shadow), not a grey wash; rows'
  titles 14 px regular (were 13 px, medium when selected), lines 13 px, rows 32 px.
- **Rings:** tracks in the lightest border, the arcs 2.5 px, a second ring 1.5 px inside, the
  service's mark in its maker's colour (Claude's orange; black-and-white marks in the text colour).
- **Badges:** 16 px (were 18).
- Before and after: `git show 7aafa3842:gpui/shots/screens-area-bots-light.png` against
  `shots/screens-area-bots-light.png` (and `-dark`).

## BOX-NEEDED

`grep -rn BOX-NEEDED gpui/kuvo gpui/kuvo_box/src`. Each is drawn plainly until the box says it;
the shapes are proposals.

| What | Route and shape | Where it's drawn | Until then |
|---|---|---|---|
| Which window is each ring | `rows[].windows[].span: short\|long` in `GET kuvo/agents/api/kuvo/limits` (#711) | `rail.rs`, `ring_button`; `kuvo_box/src/areas.rs`, `Account::rings` | one ring, the fullest window (the stand-in sends it) |
| Which engine integrations are providers | `kind: provider\|search\|agentDuplicate` on each account in `GET kuvo/sign-in/accounts`, or the box leaving the rest out (web search services, MCP servers' sign-ins, `claude-agent`) | `kuvo_box/src/accounts.rs`, `side_accounts` | every account the box lists, unfiltered (no rule ported) |
| An account's mark | `service` (the limits' ids) on each account in `GET kuvo/sign-in/accounts` | `settings/rows.rs`, `provider_row` | the provider's first letter (agents use the bridge's `metadata.agent`) |
| A device code, the engine's too | `userCode` on `POST api/integration/<id>/connect/oauth`'s answer or `GET kuvo/sign-in/status`, for Copilot, OpenCode, SuperGrok | `settings/sign_in.rs`, `waiting` | the page and its instructions, no code apart (the bridge says it for agents) |
| The sandbox's words | `why` for every `reason`, and `actionLabel`, the words of the button that does `action` at its `route`, in `GET kuvo/sandbox` | `kuvo_box/src/settings.rs`, `Sandbox`; `settings/rows.rs`, `permissions` | "Sandbox" On or Off; off, the box's `why`, else "This needs your OK."; a button only with the box's words and route (none today) |
| A window's level (#711, as before) | `windows[].level` | `rail.rs`, `settings/page.rs` `windows` | quiet grey meters and arcs |

## Review

One reviewer pass. Fixed, each with a test that fails on the code before where one can:
- **MUST:** the page jumped to the top whenever a row changed (a busy row, an answer):
  `ListState::reset` cleared the scroll. Only the items that differ are spliced now
  (`the_page_keeps_its_place_when_a_row_changes`).
- A search typed before the pages were read found nothing until typed again: the page found is
  picked again as each reading comes in (`live::a_search_typed_before_the_pages_are_read_…`, run the
  app's way, the box asked off the window's thread); the Settings sidebar is redrawn as Settings
  changes (it wasn't, in the app).
- Two quick changes in one group (the notices, the sites never offered) could undo each other, as
  each is sent whole: the group's other controls are held until the box answers.
- Closing a sheet mid-request: Accounts is read again however it closed; a sign-in still starting
  is given up on the engine as soon as it has started (`closing_a_sign_in_under_way_…`).
- The give-up said "the engine started over" for any error: only unanswered asks (404, 504, no
  answer) count now; any other refusal shows the box's words at once
  (`a_sign_in_the_engine_forgot_is_given_up_after_a_while`).
- `kuvo/accounts/ended` answering 503 dropped "Sign-in ended": what was last read is kept
  (`sign_ins_ended_stay_marked_while_the_box_cant_say`); the engine not running leaves the agents'
  accounts on the page with a note (it failed the page).
- The sheet and the confirm weren't dialogs: Escape closes both, and the sidebar is dimmed and
  blocked under them (`escape_closes_the_sign_in_and_the_confirm`).
- A `span` or `level` a newer box names otherwise no longer drops the window (read as none).
- NITs fixed: a masked field is one word to the keyboard and hands input methods its dots only; a
  ring whose window started over keeps its place, empty; the Usage test checks each window; one
  subscription for the open sheet, not one kept per sheet ever opened.
- NITs left: Permissions', Vault's and Privacy's icons are all the shield (the set has no better
  yet); clearing the search doesn't go back to the section open before it; the composer's and the
  Files panel's selections keep the grey wash (they sit on white, not the sidebar grey).

## The lead's follow-up

Stand-ins draw a neutral default and port no rule or wording the box should own: Accounts lists
every account the box returns (KuvoClient's `EngineProviders` rule removed), and the sandbox row
words nothing of its own (its "Check Again" and the client's sentences removed; the box's `why`,
or "This needs your OK.", and a button only with the box's words and route). Tests:
`accounts_lists_the_agents_and_providers_as_the_box_says_them` (unfiltered),
`the_sandbox_is_drawn_in_the_boxs_words` (on, off with the box's words and button, off with none).

## Left

- **Not built (no new features):** adding another agent account (its name asked first), Rename,
  Use This Account (`api/credential/<id>/activate`), Refresh Models, Update / Update All and their
  outcomes, Agents Use Resets Without Asking, "Your Own" providers, Bring your subscriptions
  (`kuvo/accounts/found`), a usage limit on an agent's row (Custom Auto's `limits`); Permissions'
  rules and Always Allowed, Add Folder; the browser's history and website data; the Mac's other
  sections (placeholders); a default effort (the box keeps none: only each Mac's last pick).
- **Left in the client, view words:** an account's line (`account_line`: "Signed in as …", "API
  key · …", "From VAR", "Sign-in ended") and a mode's name (KuvoClient's `ApprovalWords`) are this
  app's words over the box's facts, as the Mac's are; the ten-misses give-up's words are the Mac's.
  Accounts' grouping (signed in or ended, then the rest) reads `connections` and the ended facts.
- **Install** waits on the bridge's answer (a few minutes at most); the row says "Installing…"
  meanwhile; a refusal shows over the page.
- **Not live:** Settings reads each page as it opens, not on the box's events (`config.updated`,
  `integration.updated`, `kuvo.usage.settings`, `kuvo.limits.updated`); a sign-in done reads
  Accounts again.
- No VoiceOver labels (GPUI has none here yet); larger text not tried. The ring's hover card still
  has no shot.
- The phone: no change (the GPUI app isn't shipped; the restyle is GPUI's alone). Docs and
  CHANGELOG: none needed (nothing users run changes).

## Decisions for the user

Built without drafts, to the user's OpenBot reference and the lead's notes:

- **Settings' sidebar:** the seven built sections first, the Mac's other sixteen under "In Kuvo
  Code on Your Mac" (each a placeholder page). Recommended: keep until those pages come; or hide
  them.
- **Section names:** "Models" (the Mac's Agents › models), "Permissions" for approval and the
  sandbox. Recommended: keep.
- **Marks in their makers' colours** (the user's ask): Claude's orange `#D97757`; the others are
  black-and-white marks drawn in the text colour. A brand question if more colours are wanted.
- **The theme values** above (greys, the selected card, 1.0 stroke, `#7D7D7D` icons).
  Recommended: keep; they apply everywhere, the conversation and panel included.
- **Search** filters by plain words, no fuzzy matching (Zed's is fuzzy). Recommended: keep for
  so short a list.
- **One way alone starts at once** (the Mac's): a single Sign In opens the browser straight away.
- **Disconnect and Remove are asked first** (the Mac doesn't ask for Disconnect). Recommended:
  keep: it forgets keys.
- **Theme in General**: Light and Dark only (no System yet: the app follows ⌘⇧L).
