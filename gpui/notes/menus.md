# Menus and popovers

**Ours:** `kuvo_ui/src/menu.rs`. Tests: `kuvo_ui/tests/menu.rs`. Gallery page:
`gallery/src/pages/menus.rs`. Shots: `shots/menus-{light,dark}.png`.

## What Zed does (studied, not copied)

Files read: `crates/ui/src/components/{context_menu,popover_menu,right_click_menu,dropdown_menu,
popover,tooltip}.rs` (GPL-3.0), and GPUI's `src/elements/{anchored,deferred,div}.rs` and the
tooltip placement in `src/window.rs` (Apache-2.0).

- A menu is a focusable entity that emits a dismiss event: headers, separators, entries with an
  icon, a check, a shortcut, disabled entries, submenus.
- Keyboard: next and previous wrap and skip what can't be chosen; Return confirms; Escape
  cancels. Losing focus or a press outside closes it.
- A popover menu draws its menu with `anchored()` inside `deferred()` (so it paints above
  everything), attached under its trigger and kept inside the window; it remembers what had
  focus and gives it back; focus moves into the menu a frame later, because deferred elements
  join the focus tree late; a press on the trigger while open closes rather than reopens.
- Right-click menus open at the pointer. Tooltips appear after 500 ms (GPUI), hoverable ones
  stay while the pointer is on them.

## What we take as behaviour

- `Menu`: headers, separators and entries (icon, detail text, shortcut, check, disabled,
  destructive). 30 px rows with 8 px radius inside 4 px padding, so the menu's 12 px radius
  nests around them; elevated fill, hairline border, soft shadow.
- Keyboard as Zed and macOS: Up and Down wrap and skip headers, separators and disabled
  entries; Return or Space chooses; Escape closes; a press outside closes. The pointer
  highlights what it's over; leaving clears only a highlight the pointer made, so the
  keyboard's survives a resting pointer (found by a test).
- `PopoverMenu` (a dropdown) with a `PopoverMenuHandle` so code can open one; focus returns to
  where it was when it closes. `ContextMenuArea` opens at the pointer and stays inside the
  window. `HoverCard` uses GPUI's hoverable tooltip. `Tooltip` gains a shortcut keycap.

## Tests

The keyboard skips a disabled entry and choosing closes the menu and returns focus; Up wraps to
the last entry; Escape and a click outside close without choosing, and a second press on the
trigger closes; a right-click opens the menu at the pointer and a click chooses.

## Not yet

Submenus, type-to-select, keeping the menu open for toggles, and checking the hover card's
delay in a test (GPUI's timer).
