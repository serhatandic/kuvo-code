//! Menus as people use them: open from a button or a right-click, move with the keyboard,
//! choose, or close without choosing.

use std::{cell::RefCell, rc::Rc};

use gpui::{
    AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement,
    Modifiers, MouseButton, ParentElement, Render, Styled, TestAppContext, VisualTestContext,
    Window, div, point, px, size,
};
use kuvo_ui::{
    Appearance, Theme,
    menu::{ContextMenuArea, Menu, MenuEntry, PopoverMenu, PopoverMenuHandle},
};

type Log = Rc<RefCell<Vec<&'static str>>>;

fn model_menu(log: Log, window: &mut Window, cx: &mut gpui::App) -> Entity<Menu> {
    let _ = window;
    let entry = |label: &'static str, log: &Log| {
        let log = log.clone();
        MenuEntry::new(label).on_select(move |_, _| log.borrow_mut().push(label))
    };
    cx.new(|cx| {
        Menu::new(cx)
            .header("Models")
            .entry(entry("Claude Opus 5.5", &log).checked(true))
            .entry(entry("Claude Sonnet 5.5", &log).disabled(true))
            .entry(entry("GPT-6", &log))
            .separator()
            .entry(entry("Add a model…", &log))
    })
}

/// The right-click menu: the model entries again, then "Rename", which moves focus to a field.
fn session_menu(log: Log, field: FocusHandle, _: &mut Window, cx: &mut gpui::App) -> Entity<Menu> {
    let entry = |label: &'static str, log: &Log| {
        let log = log.clone();
        MenuEntry::new(label).on_select(move |_, _| log.borrow_mut().push(label))
    };
    cx.new(|cx| {
        Menu::new(cx)
            .header("Models")
            .entry(entry("Claude Opus 5.5", &log).checked(true))
            .entry(entry("Claude Sonnet 5.5", &log).disabled(true))
            .entry(entry("GPT-6", &log))
            .separator()
            .entry(MenuEntry::new("Rename").on_select(move |window, cx| window.focus(&field, cx)))
    })
}

struct Host {
    log: Log,
    handle: PopoverMenuHandle,
    focus: FocusHandle,
    /// A field elsewhere that the context menu's "Rename" moves focus to.
    rename_field: FocusHandle,
}

impl Focusable for Host {
    fn focus_handle(&self, _: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let (a, b) = (self.log.clone(), self.log.clone());
        let rename_field = self.rename_field.clone();
        div()
            .track_focus(&self.focus)
            .child(div().track_focus(&self.rename_field).w(px(10.)).h(px(10.)))
            .size_full()
            .child(
                // The trigger sits at the top left, 120 × 30.
                PopoverMenu::new("model", div().w(px(120.)).h(px(30.)), move |window, cx| model_menu(a.clone(), window, cx))
                    .with_handle(self.handle.clone()),
            )
            .child(
                div().mt(px(300.)).child(ContextMenuArea::new(
                    "area",
                    div().w(px(400.)).h(px(200.)),
                    move |window, cx| session_menu(b.clone(), rename_field.clone(), window, cx),
                )),
            )
    }
}

fn host(cx: &mut TestAppContext) -> (Entity<Host>, &mut VisualTestContext) {
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        kuvo_ui::bind_keys(cx);
    });
    let (host, cx) = cx.add_window_view(|_, cx| Host {
        log: Default::default(),
        handle: Default::default(),
        focus: cx.focus_handle(),
        rename_field: cx.focus_handle(),
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| window.focus(&host.focus_handle(cx), cx));
    cx.run_until_parked();
    (host, cx)
}

fn chosen(host: &Entity<Host>, cx: &mut VisualTestContext) -> Vec<&'static str> {
    cx.read(|cx| host.read(cx).log.borrow().clone())
}

fn is_open(host: &Entity<Host>, cx: &mut VisualTestContext) -> bool {
    cx.read(|cx| host.read(cx).handle.is_open())
}

#[gpui::test]
fn the_keyboard_skips_what_cant_be_chosen_and_choosing_closes_the_menu(cx: &mut TestAppContext) {
    let (host, cx) = host(cx);
    cx.simulate_click(point(px(20.), px(15.)), Modifiers::default());
    assert!(is_open(&host, cx));

    // Down lands on the first model; again skips the disabled one; Return chooses.
    cx.simulate_keystrokes("down down enter");
    assert_eq!(chosen(&host, cx), vec!["GPT-6"]);
    assert!(!is_open(&host, cx));
    // Focus goes back to where it was.
    assert!(cx.update(|window, cx| host.focus_handle(cx).is_focused(window)));
}

#[gpui::test]
fn up_wraps_round_to_the_last_entry(cx: &mut TestAppContext) {
    let (host, cx) = host(cx);
    cx.simulate_click(point(px(20.), px(15.)), Modifiers::default());
    cx.simulate_keystrokes("up enter");
    assert_eq!(chosen(&host, cx), vec!["Add a model…"]);
}

#[gpui::test]
fn escape_or_a_click_outside_closes_without_choosing(cx: &mut TestAppContext) {
    let (host, cx) = host(cx);
    cx.simulate_click(point(px(20.), px(15.)), Modifiers::default());
    cx.simulate_keystrokes("down escape");
    assert!(!is_open(&host, cx));

    cx.simulate_click(point(px(20.), px(15.)), Modifiers::default());
    assert!(is_open(&host, cx));
    cx.simulate_click(point(px(700.), px(250.)), Modifiers::default());
    assert!(!is_open(&host, cx));

    // A second press on the trigger closes the menu rather than reopening it, and focus
    // comes back.
    cx.simulate_click(point(px(20.), px(15.)), Modifiers::default());
    cx.simulate_click(point(px(20.), px(15.)), Modifiers::default());
    assert!(!is_open(&host, cx));
    assert!(cx.update(|window, cx| host.focus_handle(cx).is_focused(window)));
    assert!(chosen(&host, cx).is_empty());
}

#[gpui::test]
fn a_right_click_opens_a_menu_where_the_pointer_is(cx: &mut TestAppContext) {
    let (host, cx) = host(cx);
    let at = point(px(100.), px(350.));
    cx.simulate_mouse_down(at, MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(at, MouseButton::Right, Modifiers::default());
    cx.run_until_parked();

    // The menu's first row (the "Models" header) starts at the pointer, inside 4 px of padding;
    // GPT-6 is the third entry, each 30 px, after a header of 28.
    let gpt = point(at.x + px(40.), at.y + px(1. + 4. + 28. + 30. + 30. + 15.));
    cx.simulate_mouse_move(gpt, None, Modifiers::default());
    cx.simulate_click(gpt, Modifiers::default());
    assert_eq!(chosen(&host, cx), vec!["GPT-6"]);
}

fn right_click(cx: &mut VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    cx.simulate_mouse_down(at, MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(at, MouseButton::Right, Modifiers::default());
    cx.run_until_parked();
}

#[gpui::test]
fn an_entry_that_moves_focus_keeps_it_there(cx: &mut TestAppContext) {
    let (host, cx) = host(cx);
    right_click(cx, point(px(100.), px(350.)));
    cx.simulate_keystrokes("up enter"); // "Rename", the last entry
    assert!(cx.update(|window, cx| host.read(cx).rename_field.is_focused(window)));
}

#[gpui::test]
fn a_second_right_click_still_gives_focus_back_when_closed(cx: &mut TestAppContext) {
    let (host, cx) = host(cx);
    right_click(cx, point(px(100.), px(350.)));
    right_click(cx, point(px(370.), px(500.))); // in the area, beside the first menu
    cx.simulate_keystrokes("escape");
    assert!(cx.update(|window, cx| host.focus_handle(cx).is_focused(window)));
}
