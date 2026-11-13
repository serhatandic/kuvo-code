//! The chat list as a reader meets it: following a reply as it streams, keeping their place
//! when they scroll back, and getting back to the latest with the button.

use std::{cell::RefCell, collections::HashMap, rc::Rc};

use gpui::{
    AnyElement, Bounds, Context, Entity, IntoElement, ParentElement, Pixels, Render, ScrollDelta,
    ScrollEvent, Styled, TestAppContext, VisualTestContext, Window, canvas, div, point, px, size,
};
use kuvo_ui::{
    Appearance, Theme,
    chat_list::{ChatListState, chat_list},
};

/// A conversation whose messages are blocks of a given height, in a 600 × 400 window.
struct Conversation {
    heights: Vec<f32>,
    list: ChatListState,
    /// Where each message was last painted, in window coordinates.
    painted: Rc<RefCell<HashMap<usize, Bounds<Pixels>>>>,
}

impl Conversation {
    fn grow(&mut self, ix: usize, by: f32, cx: &mut Context<Self>) {
        self.heights[ix] += by;
        self.list.changed(ix);
        cx.notify();
    }

    fn grow_last(&mut self, by: f32, cx: &mut Context<Self>) {
        let last = self.heights.len() - 1;
        self.heights[last] += by;
        self.list.changed(last);
        cx.notify();
    }

    fn add(&mut self, height: f32, cx: &mut Context<Self>) {
        self.heights.push(height);
        self.list.push(1);
        cx.notify();
    }
}

impl Render for Conversation {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        self.painted.borrow_mut().clear();
        let painted = self.painted.clone();
        div().size_full().child(chat_list(&self.list, move |ix, _, cx| -> AnyElement {
            let height = view.read(cx).heights[ix];
            let painted = painted.clone();
            div()
                .relative()
                .h(px(height))
                .w_full()
                .child(
                    canvas(move |bounds, _, _| painted.borrow_mut().insert(ix, bounds), |_, _, _, _| {})
                        .absolute()
                        .size_full(),
                )
                .into_any_element()
        }))
    }
}

fn conversation(cx: &mut TestAppContext, heights: Vec<f32>) -> (Entity<Conversation>, &mut VisualTestContext) {
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        kuvo_ui::bind_keys(cx);
    });
    let window = cx.add_window(move |_, cx| {
        let list = ChatListState::new(heights.len(), cx);
        Conversation { heights, list, painted: Default::default() }
    });
    let view = window.root(cx).unwrap();
    let cx = VisualTestContext::from_window(window.into(), cx).into_mut();
    cx.simulate_resize(size(px(600.), px(400.)));
    cx.run_until_parked();
    (view, cx)
}

fn painted(view: &Entity<Conversation>, ix: usize, cx: &mut VisualTestContext) -> Option<Bounds<Pixels>> {
    cx.read(|cx| view.read(cx).painted.borrow().get(&ix).copied())
}

fn item_top(view: &Entity<Conversation>, ix: usize, cx: &mut VisualTestContext) -> Option<Pixels> {
    painted(view, ix, cx).map(|b| b.top())
}

fn item_bottom(view: &Entity<Conversation>, ix: usize, cx: &mut VisualTestContext) -> Option<Pixels> {
    painted(view, ix, cx).map(|b| b.bottom())
}

fn wheel(cx: &mut VisualTestContext, dy: f32) {
    cx.simulate_event(ScrollEvent {
        position: point(px(300.), px(200.)),
        delta: ScrollDelta::Pixels(point(px(0.), px(dy))),
        ..Default::default()
    });
    cx.run_until_parked();
}

#[gpui::test]
fn a_short_conversation_sits_at_the_bottom(cx: &mut TestAppContext) {
    let (view, cx) = conversation(cx, vec![60., 80.]);
    assert_eq!(item_bottom(&view, 1, cx), Some(px(400.)));
    assert_eq!(item_top(&view, 0, cx), Some(px(400. - 140.)));
}

#[gpui::test]
fn a_streaming_reply_is_followed_while_you_are_at_the_bottom(cx: &mut TestAppContext) {
    let (view, cx) = conversation(cx, vec![300., 300., 300., 40.]);
    for _ in 0..10 {
        view.update(cx, |c, cx| c.grow_last(37., cx));
        cx.run_until_parked();
        assert_eq!(item_bottom(&view, 3, cx), Some(px(400.)));
    }
    view.update(cx, |c, cx| c.add(120., cx));
    cx.run_until_parked();
    assert_eq!(item_bottom(&view, 4, cx), Some(px(400.)));
}

#[gpui::test]
fn scrolling_up_keeps_your_place_while_the_reply_streams(cx: &mut TestAppContext) {
    let (view, cx) = conversation(cx, vec![300., 300., 300., 300., 40.]);
    wheel(cx, 450.);
    let reading = item_top(&view, 2, cx).expect("the third message is on screen");
    assert!(!cx.read(|cx| view.read(cx).list.is_following()));

    for _ in 0..5 {
        view.update(cx, |c, cx| c.grow_last(80., cx));
        cx.run_until_parked();
    }
    view.update(cx, |c, cx| c.add(200., cx));
    cx.run_until_parked();

    assert_eq!(item_top(&view, 2, cx), Some(reading), "the message being read hasn't moved");
    assert!(cx.read(|cx| view.read(cx).list.has_unseen()));
}

#[gpui::test]
fn the_jump_button_takes_you_back_to_the_latest(cx: &mut TestAppContext) {
    let (view, cx) = conversation(cx, vec![300., 300., 300., 300., 40.]);
    wheel(cx, 500.);
    view.update(cx, |c, cx| c.add(200., cx));
    cx.run_until_parked();

    // The button floats at the bottom centre of the list.
    cx.simulate_click(point(px(300.), px(400. - 16. - 12.)), Default::default());
    cx.run_until_parked();
    assert_eq!(item_bottom(&view, 5, cx), Some(px(400.)));
    assert!(cx.read(|cx| view.read(cx).list.is_following()));
    assert!(!cx.read(|cx| view.read(cx).list.has_unseen()));

    // And it follows again from there.
    view.update(cx, |c, cx| c.grow_last(90., cx));
    cx.run_until_parked();
    assert_eq!(item_bottom(&view, 5, cx), Some(px(400.)));
}

#[gpui::test]
fn scrolling_back_down_to_the_bottom_follows_again(cx: &mut TestAppContext) {
    let (view, cx) = conversation(cx, vec![300., 300., 300., 300., 40.]);
    wheel(cx, 300.);
    wheel(cx, -1000.);
    view.update(cx, |c, cx| c.grow_last(60., cx));
    cx.run_until_parked();
    assert_eq!(item_bottom(&view, 4, cx), Some(px(400.)));
}

#[gpui::test]
fn scrolling_back_from_the_keyboard_moves_by_what_was_asked(cx: &mut TestAppContext) {
    let (view, cx) = conversation(cx, vec![300., 300., 300., 300., 40.]);
    let before = item_top(&view, 3, cx).expect("the fourth message is on screen");
    view.update(cx, |c, _| c.list.scroll_by(px(-100.)));
    cx.update(|window, _| window.refresh());
    cx.run_until_parked();
    assert_eq!(item_top(&view, 3, cx), Some(before + px(100.)));
    assert!(!cx.read(|cx| view.read(cx).list.is_following()));

    // And the place holds while the reply goes on.
    view.update(cx, |c, cx| c.grow_last(200., cx));
    cx.run_until_parked();
    assert_eq!(item_top(&view, 3, cx), Some(before + px(100.)));
}

#[gpui::test]
fn only_changes_below_the_view_count_as_new(cx: &mut TestAppContext) {
    let (view, cx) = conversation(cx, vec![300., 300., 300., 300., 300., 40.]);
    wheel(cx, 900.);
    assert!(item_top(&view, 2, cx).is_some(), "reading the third message");

    // A message above the view changing (a tool result arriving late) isn't news.
    view.update(cx, |c, cx| c.grow(0, 20., cx));
    cx.run_until_parked();
    assert!(!cx.read(|cx| view.read(cx).list.has_unseen()));

    // The reply at the bottom growing is.
    view.update(cx, |c, cx| c.grow_last(80., cx));
    cx.run_until_parked();
    assert!(cx.read(|cx| view.read(cx).list.has_unseen()));
}
