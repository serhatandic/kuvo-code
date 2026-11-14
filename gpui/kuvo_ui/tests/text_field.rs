//! The text field, driven the way people use it: keystrokes through the window's key
//! bindings, typed text through the input path, and the input-method calls macOS makes for
//! Japanese and Chinese.

use std::{cell::Cell, rc::Rc};

use gpui::{
    AppContext as _, Bounds, ClipboardItem, Context, Entity, EntityInputHandler, Focusable,
    IntoElement, ParentElement, Pixels, Render, Styled, TestAppContext, VisualTestContext, Window,
    div, px,
};
use kuvo_ui::{Appearance, TextField, TextFieldEvent, Theme};

/// A window holding one field, 400 px wide, that notes where the field was drawn.
struct Host {
    field: Entity<TextField>,
    drawn: Rc<Cell<Option<Bounds<Pixels>>>>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let drawn = self.drawn.clone();
        div()
            .w(px(400.))
            .child(self.field.clone())
            .on_children_prepainted(move |bounds, _, _| drawn.set(bounds.first().copied()))
    }
}

/// Where the field was last drawn.
type Shown = Rc<Cell<Option<Bounds<Pixels>>>>;

fn field(
    cx: &mut TestAppContext,
    build: impl FnOnce(TextField) -> TextField + 'static,
) -> (Entity<TextField>, Shown, &mut VisualTestContext) {
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        kuvo_ui::bind_keys(cx);
    });
    let drawn = Rc::new(Cell::new(None));
    let host_drawn = drawn.clone();
    let (host, cx) = cx.add_window_view(move |_, cx| Host {
        field: cx.new(|cx| build(TextField::new(cx))),
        drawn: host_drawn,
    });
    let field = cx.read(|cx| host.read(cx).field.clone());
    cx.update(|window, cx| window.focus(&field.focus_handle(cx), cx));
    cx.run_until_parked();
    (field, drawn, cx)
}

fn text(field: &Entity<TextField>, cx: &mut VisualTestContext) -> String {
    cx.read(|cx| field.read(cx).text().to_string())
}

#[gpui::test]
fn typing_editing_and_deleting_words(cx: &mut TestAppContext) {
    let (field, _, cx) = field(cx, |f| f);
    cx.simulate_input("Fix the sign-up form");
    assert_eq!(text(&field, cx), "Fix the sign-up form");

    // Option-Backspace takes the word before the caret, as on a Mac.
    cx.simulate_keystrokes("alt-backspace");
    assert_eq!(text(&field, cx), "Fix the sign-up ");

    // Moving left by word and typing inserts in the middle.
    cx.simulate_keystrokes("alt-left alt-left");
    cx.simulate_input("whole ");
    assert_eq!(text(&field, cx), "Fix the whole sign-up ");

    // Backspace takes one character, a whole emoji included.
    cx.simulate_keystrokes("cmd-right");
    cx.simulate_input("👍🏽");
    cx.simulate_keystrokes("backspace");
    assert_eq!(text(&field, cx), "Fix the whole sign-up ");
}

#[gpui::test]
fn selecting_replacing_and_the_clipboard(cx: &mut TestAppContext) {
    let (field, _, cx) = field(cx, |f| f);
    cx.simulate_input("merge the branch");

    // Shift-Option-Left selects the last word; typing replaces it.
    cx.simulate_keystrokes("alt-shift-left");
    cx.simulate_input("pull request");
    assert_eq!(text(&field, cx), "merge the pull request");

    // Select all, copy, and paste at the end.
    cx.simulate_keystrokes("cmd-a cmd-c right");
    cx.simulate_input(" ");
    cx.simulate_keystrokes("cmd-v");
    assert_eq!(text(&field, cx), "merge the pull request merge the pull request");

    // Cut takes the selection to the clipboard.
    cx.simulate_keystrokes("cmd-a cmd-x");
    assert_eq!(text(&field, cx), "");
    assert_eq!(
        cx.read_from_clipboard().and_then(|c| c.text()).as_deref(),
        Some("merge the pull request merge the pull request")
    );

    // A one-line field turns pasted lines into spaces.
    cx.write_to_clipboard(ClipboardItem::new_string("first\nsecond".into()));
    cx.simulate_keystrokes("cmd-v");
    assert_eq!(text(&field, cx), "first second");
}

#[gpui::test]
fn undo_and_redo_go_a_word_at_a_time(cx: &mut TestAppContext) {
    let (field, _, cx) = field(cx, |f| f);
    cx.simulate_input("ship it today");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&field, cx), "ship it");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&field, cx), "ship");
    cx.simulate_keystrokes("cmd-shift-z");
    assert_eq!(text(&field, cx), "ship it");
}

#[gpui::test]
fn return_submits_and_shift_return_adds_a_line(cx: &mut TestAppContext) {
    let (field, _, cx) = field(cx, |f| f.multi_line(1, 6));
    let submitted = cx.new(|_| Vec::<String>::new());
    let log = submitted.clone();
    cx.update(|_, cx| {
        cx.subscribe(&field, move |_, event, cx| {
            if let TextFieldEvent::Submit(text) = event {
                log.update(cx, |log, _| log.push(text.clone()));
            }
        })
        .detach();
    });

    cx.simulate_input("First line");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("second line");
    assert_eq!(text(&field, cx), "First line\nsecond line");

    cx.simulate_keystrokes("enter");
    assert_eq!(cx.read(|cx| submitted.read(cx).clone()), vec!["First line\nsecond line".to_string()]);
}

#[gpui::test]
fn a_composer_grows_with_its_lines_up_to_its_limit(cx: &mut TestAppContext) {
    let (field, drawn, cx) = field(cx, |f| f.multi_line(1, 4).bare());
    let height = |cx: &mut VisualTestContext| {
        cx.run_until_parked();
        drawn.get().map(|b| b.size.height)
    };
    let one = height(cx).expect("the field's text is laid out");
    cx.simulate_input("one");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("two");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("three");
    let three = height(cx).unwrap();
    assert_eq!(three, one * 3.);

    for _ in 0..4 {
        cx.simulate_keystrokes("shift-enter");
        cx.simulate_input("more");
    }
    // Seven lines of text, but the field stops at four and scrolls.
    assert_eq!(height(cx).unwrap(), one * 4.);
    let _ = field;
}

#[gpui::test]
fn up_and_down_move_between_lines(cx: &mut TestAppContext) {
    let (field, _, cx) = field(cx, |f| f.multi_line(1, 6));
    cx.simulate_input("abcdef");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("ab");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("abcdef");
    // From the end of the last line, Up lands at the end of the short middle line.
    cx.simulate_keystrokes("up");
    cx.simulate_input("X");
    assert_eq!(text(&field, cx), "abcdef\nabX\nabcdef");

    // Moving through the short line keeps the column it started from.
    cx.simulate_keystrokes("backspace cmd-down up up");
    cx.simulate_input("Y");
    assert_eq!(text(&field, cx), "abcdefY\nab\nabcdef");
}

/// Japanese typed with an input method: the composition is marked, replaced as the person
/// types, then committed; the whole composition undoes in one step.
#[gpui::test]
fn input_methods_mark_compose_and_commit(cx: &mut TestAppContext) {
    let (field, _, cx) = field(cx, |f| f);
    cx.simulate_input("Hello ");
    cx.update(|window, cx| {
        field.update(cx, |f, cx| {
            f.replace_and_mark_text_in_range(None, "に", Some(1..1), window, cx);
            f.replace_and_mark_text_in_range(None, "にほ", Some(2..2), window, cx);
            f.replace_and_mark_text_in_range(None, "日本", Some(2..2), window, cx);
            assert_eq!(f.marked_text_range(window, cx), Some(6..8));
            f.replace_text_in_range(None, "日本", window, cx);
            assert_eq!(f.marked_text_range(window, cx), None);
        })
    });
    assert_eq!(text(&field, cx), "Hello 日本");
    // The OS asks where the text is, in UTF-16, to place its candidate window.
    let bounds = cx.update(|window, cx| field.update(cx, |f, cx| f.bounds_for_range(6..8, Default::default(), window, cx)));
    assert!(bounds.is_some_and(|b| b.size.width > gpui::px(0.)));

    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&field, cx), "Hello ");
}

#[gpui::test]
fn arrows_and_input_methods_in_an_empty_field_dont_crash(cx: &mut TestAppContext) {
    for multi in [false, true] {
        let (field, _, cx) = field(cx, move |f| if multi { f.multi_line(1, 4) } else { f });
        cx.simulate_keystrokes("up down shift-up shift-down");
        let bounds = cx.update(|window, cx| field.update(cx, |f, cx| f.bounds_for_range(0..0, Default::default(), window, cx)));
        assert!(bounds.is_some(), "the input method is told where the caret is");
        cx.simulate_input("ok");
        assert_eq!(text(&field, cx), "ok");
    }
}

#[gpui::test]
fn moving_the_caret_starts_a_new_undo_step(cx: &mut TestAppContext) {
    let (field, _, cx) = field(cx, |f| f);
    cx.simulate_input("hello");
    cx.simulate_keystrokes("cmd-left");
    cx.simulate_input("X");
    cx.simulate_keystrokes("cmd-z");
    assert_eq!(text(&field, cx), "hello");
}

/// An input method asks where text is right after it changes, before the field draws again.
#[gpui::test]
fn the_input_method_gets_bounds_for_text_not_yet_drawn(cx: &mut TestAppContext) {
    let (field, _, cx) = field(cx, |f| f.multi_line(1, 4));
    cx.simulate_input("Hello");
    cx.update(|window, cx| {
        field.update(cx, |f, cx| {
            f.replace_and_mark_text_in_range(None, " にほん", Some(4..4), window, cx);
            // UTF-16 offsets 6..9 are the composition, which hasn't been drawn yet.
            let marked = f.bounds_for_range(6..9, Default::default(), window, cx).expect("bounds for new text");
            let start = f.bounds_for_range(0..0, Default::default(), window, cx).unwrap();
            assert!(marked.left() > start.left());
            // And Shift-Return's new line is below, before any draw.
            f.replace_text_in_range(None, "\n", window, cx);
            let below = f.bounds_for_range(10..10, Default::default(), window, cx).expect("bounds on the new line");
            assert!(below.top() > start.top());
            assert!(f.character_index_for_point(below.origin, window, cx).is_some());
        })
    });
}

#[gpui::test]
fn text_set_from_code_follows_the_same_rules_as_typing(cx: &mut TestAppContext) {
    let (one_line, _, cx) = field(cx, |f| f);
    one_line.update(cx, |f, cx| f.set_text("first\nsecond\r\nthird", cx));
    assert_eq!(text(&one_line, cx), "first second  third");
}

/// A key's field: typed and edited as any, drawn as dots, and never copied or cut out of it.
#[gpui::test]
fn a_masked_field_takes_a_key_but_never_gives_it_back(cx: &mut TestAppContext) {
    let (field, drawn, cx) = field(cx, |f| f.masked());
    cx.simulate_input("sk-stand-in-0123");
    cx.simulate_keystrokes("backspace");
    assert_eq!(text(&field, cx), "sk-stand-in-012");
    cx.write_to_clipboard(ClipboardItem::new_string("before".into()));
    cx.simulate_keystrokes("cmd-a cmd-c");
    cx.simulate_keystrokes("cmd-x");
    assert_eq!(cx.read_from_clipboard().and_then(|c| c.text()).as_deref(), Some("before"), "nothing copied or cut");
    assert_eq!(text(&field, cx), "sk-stand-in-012", "cut leaves the key");
    // Clicking at the end of the dots puts the caret after the last character, not part way.
    let bounds = drawn.get().expect("drawn");
    cx.simulate_click(gpui::point(bounds.right() - px(4.), bounds.center().y), gpui::Modifiers::default());
    cx.simulate_input("3");
    assert_eq!(text(&field, cx), "sk-stand-in-0123");
}
