# The rail, the areas' sidebars and the title bar

The app's window since #707: the title bar across the top, the rail at the left, and beside it one
raised panel holding the open area's sidebar and its main view (option A of
`notes/sidebar-drafts.md`, with B's "Needs you"). Code: `kuvo/src/rail.rs`, `areas.rs`,
`title_bar.rs`, `area.rs`, the Sessions sidebar in `sidebar.rs`, the layout in `workspace.rs`.
Scenarios: `kuvo/tests/areas.rs`. Shots: `shots/screens-area-*-{light,dark}.png`.

## What Zed does (studied for behaviour and speed, nothing copied)

Read (GPL-3.0, behaviour only): `crates/workspace/src/dock.rs` (`Dock`, `PanelButtons`,
`activate_panel_internal`, `visible_entry`), `crates/workspace/src/workspace.rs`
(`focus_or_unfocus_panel`, `render_dock`), `crates/project_panel/src/project_panel.rs`
(`update_visible_entries`, `autoscroll`), `crates/outline_panel/src/outline_panel.rs`
(`set_active`, `update_cached_entries`), `crates/collab_ui/src/collab_panel.rs` (`update_entries`,
`select_next`), `crates/sidebar/src/sidebar.rs` (`rebuild_contents`, `apply_list_state_diff`) and
`crates/title_bar/src/title_bar.rs`.

- **Panels live on, hidden ones aren't drawn.** Every panel is made once and kept; the dock draws
  only the active one (through `.cached`, so it redraws only when the panel itself notifies), and
  tells panels when they become active or not, so a hidden one stops its work.
- **Lists are flat and virtual.** Each panel keeps a flat vector of its rows, rebuilt on the events
  that change it (debounced, or on a background thread), never in render; `uniform_list` draws
  only the rows in view. Rows of different heights use `ListState`, spliced only where the rows
  changed, so the rest keep their measured heights. The keyboard's selection is an index into the
  flat vector, brought into view with `scroll_to_item`.
- **Notify narrowly.** A panel notifies itself; the workspace doesn't redraw for it.
- **The buttons.** One per panel, its tooltip naming it and its key; the active one toggled;
  clicking it again closes the dock; a short count on a button; its element id carries whether it's
  active, so a tooltip from before doesn't linger. The title bar is an entity of its own.
- **Narrow windows.** Zed's docks never hide by themselves: they shrink to their smallest and grow
  back.

## What Kuvo takes

- Each area past Sessions is its own view (`AreaView`), made once and kept while hidden; only the
  open area's is drawn, and only it asks the box anything, as it opens (`only_the_area_on_screen_
  asks_the_box`). The rings are a view of their own, read on their own clock, so a reading redraws
  them, not the window.
- The rail's buttons: tooltip with the area's name and key (⌃1 to ⌃5), the open one filled, a count
  on the icon, clicking the open one folds its sidebar away; ids carry whether it's open.
- Spinners (which redraw every frame) only where something is at work: In Progress spins only when
  the box counts items in it.
- **Where we differ:** a narrow window (under 820 px) folds the area's sidebar away, as the user
  chose in the drafts (OpenBot's), rather than Zed's shrinking; the rail's button brings it out.

## Not done yet (speed)

- The Sessions sidebar is still drawn by the workspace, every row each time the window redraws
  (phase 2–3's). The next step, for hundreds of sessions: its own view with a flat row list rebuilt
  as the box's list changes, drawn through `ListState` spliced where rows changed (Zed's agent
  sidebar), the keyboard walking an index. The walking tests already drive it through keys, so
  they'd hold it.
- The title bar and rail are drawn by the workspace (cheap: a dozen elements), not views of their
  own.
- Views aren't drawn through `.cached` yet.
