//! Menus and popovers: a menu of actions, a dropdown that opens one from a button, a context
//! menu that opens where you right-click, hover cards and tooltips.
//!
//! A menu takes the keyboard while it's open: Up and Down move through the entries (skipping
//! headers, separators and disabled entries, and wrapping around), Return chooses, Escape or a
//! click outside closes it and gives focus back to where it was.

use std::{cell::RefCell, rc::Rc};

use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, DismissEvent, ElementId, Entity,
    EventEmitter, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyBinding, MouseButton,
    ParentElement, Pixels, Point, Render, RenderOnce, SharedString, StatefulInteractiveElement,
    Styled, Subscription, Window, actions, anchored, deferred, div, point, prelude::FluentBuilder as _,
    px,
};

use crate::{
    button::keycap,
    icon::{Icon, IconName, IconSize},
    theme::{ActiveTheme, StyledType, TypeSize, radius, space},
};

actions!(menu, [SelectNext, SelectPrevious, Confirm, Dismiss]);

const CONTEXT: &str = "KuvoMenu";

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("down", SelectNext, Some(CONTEXT)),
        KeyBinding::new("up", SelectPrevious, Some(CONTEXT)),
        KeyBinding::new("enter", Confirm, Some(CONTEXT)),
        KeyBinding::new("space", Confirm, Some(CONTEXT)),
        KeyBinding::new("escape", Dismiss, Some(CONTEXT)),
    ]);
}

/// The menu's padding: with 8 px rows inside, the 12 px `radius::POPOVER` corners nest.
const MENU_PADDING: Pixels = px(4.);

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

/// One line of a menu.
pub enum MenuItem {
    Entry(MenuEntry),
    Header(SharedString),
    Separator,
}

pub struct MenuEntry {
    label: SharedString,
    detail: Option<SharedString>,
    icon: Option<IconName>,
    shortcut: Option<SharedString>,
    checked: bool,
    disabled: bool,
    destructive: bool,
    handler: Option<Handler>,
}

impl MenuEntry {
    pub fn new(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            detail: None,
            icon: None,
            shortcut: None,
            checked: false,
            disabled: false,
            destructive: false,
            handler: None,
        }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A second, quieter label after the first (a model's speed, a branch's ahead count).
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn shortcut(mut self, keys: impl Into<SharedString>) -> Self {
        self.shortcut = Some(keys.into());
        self
    }

    /// Marks the current choice with a check.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Drawn in the danger colour: deleting, stopping, signing out.
    pub fn destructive(mut self) -> Self {
        self.destructive = true;
        self
    }

    pub fn on_select(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.handler = Some(Rc::new(handler));
        self
    }
}

/// A menu. Build it with entries, then open it with a [`PopoverMenu`] or a [`ContextMenuArea`].
pub struct Menu {
    items: Vec<MenuItem>,
    selected: Option<usize>,
    /// Whether the pointer made the highlight; only then does the pointer leaving clear it.
    selected_by_pointer: bool,
    focus: FocusHandle,
    width: Pixels,
}

impl EventEmitter<DismissEvent> for Menu {}

impl Focusable for Menu {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Menu {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self { items: Vec::new(), selected: None, selected_by_pointer: false, focus: cx.focus_handle(), width: px(240.) }
    }

    pub fn entry(mut self, entry: MenuEntry) -> Self {
        self.items.push(MenuItem::Entry(entry));
        self
    }

    pub fn header(mut self, label: impl Into<SharedString>) -> Self {
        self.items.push(MenuItem::Header(label.into()));
        self
    }

    pub fn separator(mut self) -> Self {
        self.items.push(MenuItem::Separator);
        self
    }

    pub fn width(mut self, width: Pixels) -> Self {
        self.width = width;
        self
    }

    /// Highlights the first entry that can be chosen (as when a menu opens from the keyboard).
    pub fn highlight_first(&mut self, cx: &mut Context<Self>) {
        self.selected = self.step(None, 1);
        self.selected_by_pointer = false;
        cx.notify();
    }

    /// The highlighted entry's label.
    pub fn selected_label(&self) -> Option<SharedString> {
        match self.items.get(self.selected?)? {
            MenuItem::Entry(entry) => Some(entry.label.clone()),
            _ => None,
        }
    }

    fn selectable(&self, ix: usize) -> bool {
        matches!(&self.items[ix], MenuItem::Entry(e) if !e.disabled)
    }

    fn step(&self, from: Option<usize>, by: isize) -> Option<usize> {
        let count = self.items.len() as isize;
        if count == 0 {
            return None;
        }
        let mut ix = from.map_or(if by > 0 { -1 } else { count }, |f| f as isize);
        for _ in 0..count {
            ix = (ix + by).rem_euclid(count);
            if self.selectable(ix as usize) {
                return Some(ix as usize);
            }
        }
        None
    }

    fn select_next(&mut self, _: &SelectNext, _: &mut Window, cx: &mut Context<Self>) {
        self.selected = self.step(self.selected, 1);
        self.selected_by_pointer = false;
        cx.notify();
    }

    fn select_previous(&mut self, _: &SelectPrevious, _: &mut Window, cx: &mut Context<Self>) {
        self.selected = self.step(self.selected, -1);
        self.selected_by_pointer = false;
        cx.notify();
    }

    fn confirm(&mut self, _: &Confirm, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ix) = self.selected {
            self.choose(ix, window, cx);
        }
    }

    fn dismiss(&mut self, _: &Dismiss, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(DismissEvent);
    }

    fn choose(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selectable(ix) {
            return;
        }
        let handler = match &self.items[ix] {
            MenuItem::Entry(entry) => entry.handler.clone(),
            _ => None,
        };
        cx.emit(DismissEvent);
        if let Some(handler) = handler {
            handler(window, cx);
        }
    }
}

impl Render for Menu {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let c = &theme.colors;
        // One leading column, shared by checks and icons (as in macOS menus), so every label in
        // a menu starts at the same place.
        let has_leading = self.items.iter().any(|i| matches!(i, MenuItem::Entry(e) if e.checked || e.icon.is_some()));
        let rows = self.items.iter().enumerate().map(|(ix, item)| -> AnyElement {
            match item {
                MenuItem::Separator => div().h(px(1.)).mx(space::S2).my(space::S1).bg(c.border_strong).into_any_element(),
                MenuItem::Header(label) => div()
                    .px(space::S2)
                    .pt(space::S2)
                    .pb(space::S1)
                    .text_ui(TypeSize::Caption)
                    .text_color(c.text_faint)
                    .child(label.clone())
                    .into_any_element(),
                MenuItem::Entry(entry) => {
                    let selected = self.selected == Some(ix);
                    let color = if entry.disabled {
                        c.text_faint
                    } else if entry.destructive {
                        c.danger
                    } else {
                        c.text
                    };
                    let icon_color = if entry.disabled { c.text_faint } else if entry.destructive { c.danger } else { c.text_muted };
                    div()
                        .id(ix)
                        .flex()
                        .items_center()
                        .gap(space::S2)
                        .h(px(30.))
                        .px(space::S2)
                        .rounded(radius::NAV)
                        .text_ui(TypeSize::Small)
                        .text_color(color)
                        .when(selected, |d| d.bg(c.hover))
                        .when(!entry.disabled, |d| {
                            d.cursor_pointer()
                                .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                                    if *hovered && this.selected != Some(ix) {
                                        this.selected = Some(ix);
                                        this.selected_by_pointer = true;
                                        cx.notify();
                                    }
                                }))
                                .on_click(cx.listener(move |this, _, window, cx| this.choose(ix, window, cx)))
                        })
                        .when(has_leading, |d| {
                            let leading = if entry.checked {
                                Some(Icon::new(IconName::Check).size(IconSize::Nav).color(c.accent))
                            } else {
                                entry.icon.map(|i| Icon::new(i).size(IconSize::Nav).color(icon_color))
                            };
                            d.child(div().flex().w(IconSize::Nav.pixels()).flex_none().children(leading))
                        })
                        .child(div().flex_1().min_w_0().truncate().child(entry.label.clone()))
                        .children(entry.detail.clone().map(|d| div().text_color(c.text_faint).child(d)))
                        .children(entry.shortcut.clone().map(|k| {
                            div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(k)
                        }))
                        .into_any_element()
                }
            }
        });
        div()
            .id("menu")
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::select_next))
            .on_action(cx.listener(Self::select_previous))
            .on_action(cx.listener(Self::confirm))
            .on_action(cx.listener(Self::dismiss))
            .on_mouse_down_out(cx.listener(|_, _, _, cx| cx.emit(DismissEvent)))
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if !hovered && this.selected_by_pointer && this.selected.is_some() {
                    this.selected = None;
                    cx.notify();
                }
            }))
            .occlude()
            .flex()
            .flex_col()
            .w(self.width)
            .p(MENU_PADDING)
            .rounded(radius::POPOVER)
            .bg(c.elevated)
            .border_1()
            .border_color(c.border)
            .shadow(theme.elevated_shadow())
            .children(rows)
    }
}

/// Opens a menu from code (a shortcut, or the gallery's shot) and tells whether one is open.
#[derive(Clone, Default)]
pub struct PopoverMenuHandle(Rc<RefCell<Option<OpenMenu>>>);

struct OpenMenu {
    menu: Entity<Menu>,
    /// What had focus before any menu opened here; it gets focus back when the menu closes.
    return_to: Option<FocusHandle>,
    _dismissed: Subscription,
}

impl PopoverMenuHandle {
    pub fn is_open(&self) -> bool {
        self.0.borrow().is_some()
    }

    pub fn menu(&self) -> Option<Entity<Menu>> {
        self.0.borrow().as_ref().map(|open| open.menu.clone())
    }

    /// Shows `menu`, giving it the keyboard. Replacing a menu that's already open (a second
    /// right-click) keeps the original place to return focus to.
    pub fn open(&self, menu: Entity<Menu>, window: &mut Window, cx: &mut App) {
        let replaced = self.0.borrow_mut().take();
        let return_to = match replaced {
            Some(open) => open.return_to,
            None => window.focused(cx),
        };
        let menu_focus = menu.focus_handle(cx);
        let dismissed = {
            let slot = self.0.clone();
            let menu_focus = menu_focus.clone();
            let return_to = return_to.clone();
            window.subscribe(&menu, cx, move |_, _: &DismissEvent, window, cx| {
                slot.borrow_mut().take();
                // If the chosen entry moved focus somewhere on purpose (a rename field), or a
                // click outside focused something else, leave it there.
                let menu_kept_focus = menu_focus.contains_focused(window, cx) || window.focused(cx).is_none();
                if let (true, Some(target)) = (menu_kept_focus, &return_to) {
                    window.focus(target, cx);
                }
                window.refresh();
            })
        };
        *self.0.borrow_mut() = Some(OpenMenu { menu, return_to, _dismissed: dismissed });
        // A menu draws in a deferred layer, which only joins the focus tree once drawn; take
        // the keyboard after this frame.
        window.defer(cx, move |window, cx| window.focus(&menu_focus, cx));
        window.refresh();
    }

    /// Closes the menu without choosing, giving focus back if the menu had it.
    pub fn close(&self, window: &mut Window, cx: &mut App) {
        let open = self.0.borrow_mut().take();
        if let Some(open) = open {
            if open.menu.focus_handle(cx).contains_focused(window, cx) {
                if let Some(target) = &open.return_to {
                    window.focus(target, cx);
                }
            }
        }
        window.refresh();
    }
}

type MenuBuilder = Rc<dyn Fn(&mut Window, &mut App) -> Entity<Menu>>;

/// A dropdown: a trigger (usually a button) and the menu it opens below itself.
#[derive(IntoElement)]
pub struct PopoverMenu {
    id: ElementId,
    trigger: AnyElement,
    menu: MenuBuilder,
    handle: Option<PopoverMenuHandle>,
    align_right: bool,
}

impl PopoverMenu {
    pub fn new(
        id: impl Into<ElementId>,
        trigger: impl IntoElement,
        menu: impl Fn(&mut Window, &mut App) -> Entity<Menu> + 'static,
    ) -> Self {
        Self { id: id.into(), trigger: trigger.into_any_element(), menu: Rc::new(menu), handle: None, align_right: false }
    }

    pub fn with_handle(mut self, handle: PopoverMenuHandle) -> Self {
        self.handle = Some(handle);
        self
    }

    /// Lines the menu up with the trigger's right edge rather than its left.
    pub fn align_right(mut self) -> Self {
        self.align_right = true;
        self
    }
}

impl RenderOnce for PopoverMenu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let handle = self.handle.unwrap_or_else(|| {
            window.use_keyed_state(self.id.clone(), cx, |_, _| PopoverMenuHandle::default()).read(cx).clone()
        });
        let open = handle.menu();
        let builder = self.menu.clone();
        let toggle = handle.clone();
        let anchor = if self.align_right { gpui::Anchor::TopRight } else { gpui::Anchor::TopLeft };
        div()
            .id(self.id)
            .relative()
            .flex()
            .flex_none()
            .self_start()
            // A press on the trigger while the menu is open closes it, rather than closing on
            // the press and opening again on the release.
            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                // The press mustn't move focus: the menu is about to take it.
                window.prevent_default();
                if toggle.is_open() {
                    toggle.close(window, cx);
                    cx.stop_propagation();
                } else {
                    let menu = builder(window, cx);
                    toggle.open(menu, window, cx);
                }
            })
            .child(self.trigger)
            .children(open.map(|menu| {
                div()
                    .absolute()
                    .top_full()
                    .when(self.align_right, |d| d.right_0())
                    .when(!self.align_right, |d| d.left_0())
                    .child(deferred(anchored().anchor(anchor).offset(point(px(0.), space::S1)).child(menu)).with_priority(1))
            }))
    }
}

/// An area that opens a menu where it's right-clicked.
#[derive(IntoElement)]
pub struct ContextMenuArea {
    id: ElementId,
    child: AnyElement,
    menu: MenuBuilder,
}

#[derive(Clone, Default)]
struct ContextState(Rc<RefCell<Option<Point<Pixels>>>>, PopoverMenuHandle);

impl ContextMenuArea {
    pub fn new(
        id: impl Into<ElementId>,
        child: impl IntoElement,
        menu: impl Fn(&mut Window, &mut App) -> Entity<Menu> + 'static,
    ) -> Self {
        Self { id: id.into(), child: child.into_any_element(), menu: Rc::new(menu) }
    }
}

impl RenderOnce for ContextMenuArea {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| ContextState::default()).read(cx).clone();
        let builder = self.menu.clone();
        let opener = state.clone();
        let at = *state.0.borrow();
        let open = state.1.menu();
        div()
            .id(self.id)
            .on_mouse_down(MouseButton::Right, move |event, window, cx| {
                window.prevent_default();
                *opener.0.borrow_mut() = Some(event.position);
                let menu = builder(window, cx);
                opener.1.open(menu, window, cx);
                cx.stop_propagation();
            })
            .child(self.child)
            .children(open.zip(at).map(|(menu, at)| {
                deferred(anchored().position(at).snap_to_window_with_margin(px(8.)).child(menu)).with_priority(1)
            }))
    }
}

/// A hover card: richer than a tooltip (a person, a session, a file), shown after the pointer
/// rests on its trigger, and kept open while the pointer moves onto it.
pub struct HoverCard {
    build: Box<dyn Fn(&mut Window, &mut App) -> AnyElement>,
}

impl HoverCard {
    pub fn new(build: impl Fn(&mut Window, &mut App) -> AnyElement + 'static) -> Self {
        Self { build: Box::new(build) }
    }

    /// The view GPUI's hoverable tooltip shows.
    pub fn build(self, cx: &mut App) -> AnyView {
        cx.new(|_| self).into()
    }
}

impl Render for HoverCard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = (self.build)(window, cx);
        hover_card_frame(content, cx)
    }
}

/// The card a hover card's content sits in.
pub fn hover_card_frame(content: impl IntoElement, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    div().pt(space::S1_5).child(
        div()
            .w(px(280.))
            .p(space::S4)
            .rounded(radius::CARD)
            .bg(theme.colors.elevated)
            .border_1()
            .border_color(theme.colors.border)
            .shadow(theme.elevated_shadow())
            .child(content),
    )
}

/// A tooltip: a short label (and an optional shortcut) in a small capsule, shown after the
/// pointer rests.
pub struct Tooltip {
    text: SharedString,
    shortcut: Option<SharedString>,
}

impl Tooltip {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self { text: text.into(), shortcut: None }
    }

    pub fn shortcut(mut self, keys: impl Into<SharedString>) -> Self {
        self.shortcut = Some(keys.into());
        self
    }

    pub fn build(self, cx: &mut App) -> AnyView {
        cx.new(|_| self).into()
    }
}

impl Render for Tooltip {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        tooltip_frame(self.text.clone(), self.shortcut.clone(), cx)
    }
}

/// How a tooltip looks; also used to draw one in place (the gallery).
pub fn tooltip_frame(text: SharedString, shortcut: Option<SharedString>, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let c = &theme.colors;
    div().pl(px(4.)).pt(px(6.)).child(
        div()
            .flex()
            .items_center()
            .gap(space::S2)
            .px(space::S2)
            .py(space::S1)
            .rounded(radius::NAV)
            .bg(c.elevated)
            .border_1()
            .border_color(c.border)
            .shadow(theme.elevated_shadow())
            .text_ui(TypeSize::Caption)
            .text_color(c.text)
            .child(text)
            .children(shortcut.map(|k| keycap(k, c.border_strong, c.text_muted))),
    )
}
