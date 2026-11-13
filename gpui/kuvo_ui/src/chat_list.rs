//! The chat list: a conversation's messages, newest at the bottom.
//!
//! - Anchored to the bottom: a short conversation sits just above the composer.
//! - Follows new text while it streams, as long as you're at the bottom.
//! - Scroll up and it stays exactly where you left it while text keeps arriving.
//! - While you're away from the bottom, a button jumps back to the latest; it says "New
//!   messages" if something arrived since you scrolled up.
//! - Messages can be any height and change height; only those near the view are laid out.
//!
//! The list itself is GPUI's `list` (Apache-2.0), which keeps the scroll anchored to an item and
//! can follow its tail; this block adds the conversation's behaviour and look around it.

use std::{cell::Cell, rc::Rc};

use gpui::{
    AnyElement, App, Context, FollowMode, InteractiveElement, IntoElement, ListAlignment,
    ListState, ParentElement, RenderOnce, Styled, Window, div, list, px,
};

use crate::{
    button::{Button, ButtonSize},
    icon::IconName,
    theme::{ActiveTheme, space},
};

/// The state of a chat list. Cheap to clone; clones share the same list.
#[derive(Clone)]
pub struct ChatListState {
    list: ListState,
    unseen: Rc<Cell<bool>>,
    /// Whether the reader was last seen away from the bottom. The list can't say while a new
    /// message is still unmeasured, so the last answer stands until it can.
    away: Rc<Cell<bool>>,
}

impl ChatListState {
    /// A list of `count` messages, scrolled to the latest and following it. The view that owns
    /// it is redrawn when the reader scrolls, so the jump button comes and goes.
    pub fn new<V: 'static>(count: usize, cx: &mut Context<V>) -> Self {
        let list = ListState::new(count, ListAlignment::Bottom, px(1200.));
        list.set_follow_mode(FollowMode::Tail);
        let unseen = Rc::new(Cell::new(false));
        let view = cx.entity().downgrade();
        let seen = unseen.clone();
        list.set_scroll_handler(move |event, _window, cx| {
            if event.is_following_tail {
                seen.set(false);
            }
            view.update(cx, |_, cx| cx.notify()).ok();
        });
        Self { list, unseen, away: Rc::new(Cell::new(false)) }
    }

    /// Messages were added at the end.
    pub fn push(&self, count: usize) {
        let end = self.list.item_count();
        self.list.splice(end..end, count);
        self.note_arrival();
    }

    /// A message changed (text streamed into it, a tool result came back): measure it again.
    /// The reader's place is kept, unless they're following the latest.
    pub fn changed(&self, ix: usize) {
        self.list.remeasure_items(ix..ix + 1);
        self.note_arrival();
    }

    /// Everything was replaced (another conversation opened): show its latest.
    pub fn reset(&self, count: usize) {
        self.list.reset(count);
        self.jump_to_latest();
    }

    pub fn jump_to_latest(&self) {
        self.unseen.set(false);
        self.away.set(false);
        self.list.set_follow_mode(FollowMode::Tail);
    }

    /// Whether the list is at the latest message and following it.
    pub fn is_following(&self) -> bool {
        self.list.is_following_tail()
    }

    /// Whether something arrived since the reader scrolled away from the bottom.
    pub fn has_unseen(&self) -> bool {
        self.unseen.get()
    }

    /// Scrolls by a distance (negative goes back in time), as the keyboard does.
    pub fn scroll_by(&self, distance: gpui::Pixels) {
        let mut distance = distance;
        if self.list.logical_scroll_top().item_ix >= self.list.item_count() {
            if distance >= px(0.) {
                return; // Already at the latest.
            }
            // While following, GPUI anchors the list past its last message, so offsets count
            // from the bottom of the content; count from the top of the view instead.
            distance -= self.list.viewport_bounds().size.height;
        }
        if distance < px(0.) {
            // Leaving the bottom: stop following first, or the list snaps back to the end on
            // its next layout.
            self.list.pause_following_tail();
        }
        self.list.scroll_by(distance);
    }

    pub fn item_count(&self) -> usize {
        self.list.item_count()
    }

    /// GPUI's list state, for things this block doesn't cover yet (bounds of a message).
    pub fn list_state(&self) -> &ListState {
        &self.list
    }

    fn note_arrival(&self) {
        if !self.list.is_following_tail() {
            self.unseen.set(true);
        }
    }

    fn away_from_latest(&self) -> bool {
        if self.list.is_following_tail() {
            self.away.set(false);
        } else if let Some(at_end) = self.list.is_scrolled_to_end() {
            self.away.set(!at_end);
        }
        self.away.get()
    }
}

type RenderItem = Box<dyn FnMut(usize, &mut Window, &mut App) -> AnyElement>;

/// Draws a chat list; `render` draws message `ix`.
pub fn chat_list(
    state: &ChatListState,
    render: impl FnMut(usize, &mut Window, &mut App) -> AnyElement + 'static,
) -> ChatList {
    ChatList { state: state.clone(), render: Box::new(render) }
}

#[derive(IntoElement)]
pub struct ChatList {
    state: ChatListState,
    render: RenderItem,
}

impl RenderOnce for ChatList {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let away = self.state.away_from_latest();
        let unseen = self.state.has_unseen();
        let state = self.state.clone();
        let surface = cx.theme().colors.surface;
        let shadow = cx.theme().elevated_shadow();
        let jump = away.then(|| {
            let button = if unseen {
                Button::new("jump-to-latest", "New messages")
                    .icon(IconName::ArrowDown)
                    .pill()
                    .size(ButtonSize::Small)
            } else {
                Button::icon_only("jump-to-latest", IconName::ArrowDown, "Jump to latest")
                    .style(crate::button::ButtonStyle::Secondary)
                    .pill()
            };
            div()
                .absolute()
                .bottom(space::S4)
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    div()
                        .id("jump-holder")
                        .rounded_full()
                        .bg(surface)
                        .shadow(shadow)
                        .child(button.on_click(move |_, window, _| {
                            state.jump_to_latest();
                            window.refresh();
                        })),
                )
        });
        div()
            .relative()
            .size_full()
            .child(list(self.state.list.clone(), self.render).size_full())
            .children(jump)
    }
}
