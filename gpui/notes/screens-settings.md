# Settings

The Settings area (⌃5): its sidebar (a title, "Search settings…", the sections with icons) and a
page for each section this app has, the rest a plain page saying where they are. The layout is the
user's OpenBot reference: a big page title, quiet group labels, one rounded card of rows a group
with hairlines between rows, each row's name (medium) and grey line on the left and its control on
the right (a menu with ⌃⌄, a switch, buttons), generous spacing, on the sidebar's soft grey.
Code: `kuvo/src/settings/` (`mod.rs` the view and its changes, `rows.rs` what each page lists,
`page.rs` the drawing, `sign_in.rs` the sign-in sheet); `kuvo_box/src/accounts.rs` and
`settings.rs`. Scenarios: `kuvo/tests/settings.rs`. Shots: `shots/screens-settings-*` and
`shots/screens-sign-in-*`.

## What Zed does (studied for behaviour and speed, nothing copied)

Read (GPL-3.0, behaviour only): `crates/settings_ui/src/settings_ui.rs` (`SettingsWindow`,
`render_nav`, `render_page`, `reset_list_state`, `update_matches`, `build_filter_table`,
`filter_matches_to_file`), `crates/settings_ui/src/pages/llm_providers_page.rs`
(`render_provider_section`, `render_api_key_providers_item`, `get_or_create_configuration_view`).

- **The nav is a `uniform_list`, the page a `list` with a `ListState`.** The page's items (its
  title, each section header, each setting, a spacer at the end) are a flat index, and only those
  on screen are laid out. The list is `reset` only when the number of visible items changes (a
  page switch, a search), and `remeasure`d when the font size changes; nothing is rebuilt in
  render.
- **Search is a filter table.** One bool per item per page, worked out off the main thread
  (fuzzy, on a background task), then the nav shows pages with any match and the page only the
  matching items; a header goes with its items.
- **Views made once.** A provider's configuration view (its key field and its state) is created
  the first time it's drawn and kept, so typing in it never rebuilds it.
- **A provider's key.** "API Key Configured" with Reset Key once there's one; one from an
  environment variable can't be reset here and says which variable; otherwise a key field, where
  to get one, and "Or set the … env var".

## What Kuvo takes

- The page is a `gpui::list` over a flat `Vec<Item>` (title, group labels, rows, notes), worked out
  in `rebuild` only when what it's drawn from changes (a reading, the search, a change on its way,
  the appearance) and compared, so an unchanged page keeps its measured rows; `ListState::reset`
  only when the items differ. Accounts' 20-odd rows, or a long list of providers, cost only those
  on screen.
- Search filters sections and rows by name and line, case-insensitively (the list is short, so
  no background task); a section's name keeps its whole page; a page with nothing found shows the
  first that has something. The first search reads every page, so it can find on all of them.
- Each page reads the box only as it opens (and again each time), each change goes to the box's
  route with the row busy meanwhile, and the box's answer is what's drawn after; a refusal shows
  over the page in the box's words. The sign-in sheet is made once per sign-in and keeps its fields.
- A key's field is masked (dots, never copied or cut): a new `TextField::masked()`.
- Where we differ: no "Reset Key" in place (Disconnect forgets a plan's keys and sign-ins, as the
  Mac does); a provider with only an environment variable says to set it, as the box's `environment`
  lists it.

## Accounts

The box's facts, drawn: the coding agents' accounts (`kuvo/agents/api/integration`), then the
engine's plans and providers signed in (or ended), then the rest to add, each in its side's order,
with the box's ways in (`kuvo/sign-in/accounts`). Sign In only where the box offers a way;
Install where the agent isn't installed; Sign In Again where a sign-in ended (the agent's
`signInEnded`, or `kuvo/accounts/ended`); Disconnect (`kuvo/accounts/<id>/forget`, asked first)
where this box keeps a key or sign-in; an agent's menu has Sign In Again…, Sign Out (where it
`signsOut`) and Remove Account… (one you added, asked first).

The sheet (the Mac's `ConnectView` steps): the box's ways in order, legacy ones under "Other ways
to sign in", "Or set … in your shell profile"; one way alone starts at once. A key: masked field,
the way's form, Connect, and the engine's refusal under the field. Credentials on the computer: the
form, then connect. In the browser: the page opens, a device code is shown and copied, "Paste a
Code" where it may end on one (`acceptsCode`), the status asked about once a second
(`kuvo/sign-in/status`) until it's done or the box's `failure` words; Cancel gives it up on the
engine; ten unanswered asks give up.
