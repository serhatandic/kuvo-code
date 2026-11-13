# Rows and lists

**Ours:** `kuvo_ui/src/row.rs` (`NavRow`, `SectionHeader`, `ListRow`, `row_card`). Gallery page:
`gallery/src/pages/rows.rs` (and the gallery's own sidebar). Shots: `shots/rows-{light,dark}.png`.

## What Zed does (studied, not copied)

Files read: `crates/ui/src/components/list/{list_item,list,list_header,list_separator}.rs`,
`crates/ui/src/components/count_badge.rs`, `crates/ui/src/components/ai/thread_item.rs`, and
how `crates/project_panel/src/project_panel.rs` uses `uniform_list` (all GPL-3.0).

- A full-width row with start and end slots; hover, pressed and selected washes only when
  enabled; indentation by level; an end slot that can show only on hover, or swap with another
  on hover (one fades out as the other fades in, in the same place).
- Long titles truncate; the agent sidebar's rows show status (spinner, error) at the start and
  reveal actions on hover. Count badges are small pills, "99+" past 99.

## What we take as behaviour

- `NavRow`: 30 px, 8 px radius, 14 px icon or any leading element (avatar, status dot,
  spinner) centred in an icon's width so labels line up; label truncates with an ellipsis;
  trailing slot (badge, time, shortcut); an action that takes the trailing slot's place under
  the pointer without shifting anything; selected rows fill and go medium; muted and disabled
  rows; indentation for children; tab stop with the accent edge on keyboard focus.
- `SectionHeader`: a 12 px faint label whose actions appear under the pointer (Capy, Linear).
- `ListRow` and `row_card`: the onboarding and settings rows from the references: a 36 px icon
  tile at the card icon size, a title over a detail line, an end slot; hairlines between rows,
  inset from the card's edge. Rows that open something take the hover wash.
- `shown(..)` draws hover or pressed without a pointer, for the gallery.

## Not yet

Virtualised long lists (GPUI's `uniform_list`, as Zed's project panel), drag to reorder,
selection with the arrow keys across a list, and a disclosure chevron for collapsible groups.
