//! A conversation: its messages in the chat list, newest at the bottom, following a run live and
//! reading earlier messages as you scroll back to them, with the composer under it.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, Styled, Task, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::follow::{ConversationUpdate, Follow, Timing};
use kuvo_box::BoxClient;
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, IconSize, StyledType, TypeSize,
    chat_list::{ChatListState, chat_list},
    small::{spinner, status_dot},
    theme::space,
};

use crate::composer::Composer;
use crate::entries::{self, Block, COLUMN, Entry};

/// What's wrong, said over the conversation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    /// Reading it failed; it's tried again.
    Failed(String),
    /// It isn't on the box (any more).
    Gone(String),
}

pub struct ConversationView {
    session: String,
    /// Whether its box has answered yet.
    read: bool,
    /// The way back to messages before those shown, while there may be some.
    earlier: Option<String>,
    /// How often its box's models were heard to change, as last seen: the composer reads the
    /// conversation's model again as it goes up.
    models_changed: Option<u64>,
    /// Whether it waits on you (its box's list says so).
    asking: bool,
    entries: Vec<Entry>,
    /// Each row's revision: a row is drawn again only once it's changed.
    revisions: Vec<u64>,
    list: ChatListState,
    problem: Option<Problem>,
    earlier_failed: Option<String>,
    /// The way back already asked for, so it's asked once.
    asked_earlier: Rc<RefCell<Option<String>>>,
    /// Thinking blocks opened.
    expanded: HashSet<Block>,
    /// Its composer, which the workspace keeps (with its draft) while you're elsewhere.
    composer: Entity<Composer>,
    follow: Option<Rc<Follow<ConversationUpdate>>>,
    _follow_task: Option<Task<()>>,
}

impl Focusable for ConversationView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.composer.focus_handle(cx)
    }
}

impl ConversationView {
    /// A conversation of `client`'s box. `live`: follow it there (the app); else it shows what
    /// it's handed ([`ConversationView::take`]), for tests and shots.
    pub fn new(client: BoxClient, session: String, composer: Entity<Composer>, live: bool, cx: &mut Context<Self>) -> ConversationView {
        let mut view = ConversationView {
            session: session.clone(),
            read: false,
            earlier: None,
            models_changed: None,
            asking: false,
            entries: Vec::new(),
            revisions: Vec::new(),
            list: ChatListState::new(0, cx),
            problem: None,
            earlier_failed: None,
            asked_earlier: Rc::default(),
            expanded: HashSet::new(),
            composer,
            follow: None,
            _follow_task: None,
        };
        if live {
            let follow = Rc::new(client.follow_conversation(&session, Timing::default()));
            let updates = follow.updates().clone();
            view.follow = Some(follow);
            view._follow_task = Some(cx.spawn(async move |this, cx| {
                while let Ok(update) = updates.recv().await {
                    if this.update(cx, |this, cx| this.take(update, cx)).is_err() {
                        break;
                    }
                }
            }));
        }
        view
    }

    pub fn session(&self) -> &str {
        &self.session
    }

    pub fn composer(&self) -> &Entity<Composer> {
        &self.composer
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn list(&self) -> &ChatListState {
        &self.list
    }

    /// Why the page before couldn't be read, while that's said.
    pub fn earlier_failed(&self) -> Option<&str> {
        self.earlier_failed.as_deref()
    }

    pub fn problem(&self) -> Option<&Problem> {
        self.problem.as_ref()
    }

    /// Whether it waits on you, as its box's list says: this app can't answer yet, and says so.
    pub fn set_asking(&mut self, asking: bool, cx: &mut Context<Self>) {
        if self.asking != asking {
            self.asking = asking;
            cx.notify();
        }
    }

    pub fn is_asking(&self) -> bool {
        self.asking
    }

    /// What the box's follow says, shown.
    pub fn take(&mut self, update: ConversationUpdate, cx: &mut Context<Self>) {
        match update {
            ConversationUpdate::Conversation(conversation) => {
                self.problem = None;
                // A page that couldn't be read is said until Try Again, or until there's another
                // way back (another page came), so a run streaming meanwhile doesn't ask again.
                if self.earlier != conversation.earlier {
                    self.earlier_failed = None;
                }
                let (running, place) = (conversation.running, conversation.place);
                // The box's models (or this conversation's model) changed since: read again.
                let models_changed = conversation.models_changed;
                let read_models = self.models_changed.is_some_and(|seen| seen != models_changed);
                self.models_changed = Some(models_changed);
                self.earlier = conversation.earlier.clone();
                self.read = true;
                let (rows, revisions) = entries::entries(conversation);
                self.show(rows, revisions);
                self.composer.update(cx, |composer, cx| {
                    composer.set_running(running, cx);
                    composer.set_place(place, cx);
                    if read_models {
                        composer.read_models(cx);
                    }
                });
            }
            ConversationUpdate::Failed(error) => self.problem = Some(Problem::Failed(error.to_string())),
            ConversationUpdate::Gone(refusal) => {
                self.problem = Some(Problem::Gone(refusal.message));
                self.composer.update(cx, |composer, cx| composer.set_running(false, cx));
            }
            ConversationUpdate::EarlierFailed(error) => {
                self.earlier_failed = Some(error.to_string());
                if let Some(ix) = self.entries.iter().position(|entry| matches!(entry, Entry::Earlier)) {
                    self.list.changed(ix);
                }
            }
        }
        cx.notify();
    }

    /// The list made to show `new`, keeping the reader's place: rows put ahead (an earlier page)
    /// go above where they are, rows that changed are measured again, and new ones added at the
    /// end, which the list follows while the reader's at the bottom.
    fn show(&mut self, new: Vec<Entry>, revisions: Vec<u64>) {
        let old = std::mem::replace(&mut self.entries, new);
        let old_revisions = std::mem::replace(&mut self.revisions, revisions);
        let new = &self.entries;
        if old.is_empty() {
            self.list.reset(new.len());
            return;
        }
        let state = self.list.list_state().clone();
        let is_earlier = |entries: &[Entry]| matches!(entries.first(), Some(Entry::Earlier));
        let is_working = |entries: &[Entry]| matches!(entries.last(), Some(Entry::Working));
        // Each message's row by its key and revision: nothing is compared deeper.
        fn messages<'a>(entries: &'a [Entry], revisions: &[u64]) -> Vec<(&'a str, u64)> {
            entries.iter().zip(revisions).filter(|(entry, _)| !matches!(entry, Entry::Earlier | Entry::Working)).map(|(entry, revision)| (entry.key(), *revision)).collect()
        }
        let (old_messages, new_messages) = (messages(&old, &old_revisions), messages(new, &self.revisions));
        // Where what was shown sits among what's shown now.
        let ahead = match old_messages.first() {
            None => 0,
            Some(first) => match new_messages.iter().position(|(key, _)| *key == first.0) {
                Some(ahead) => ahead,
                None => {
                    self.list.reset(new.len());
                    return;
                }
            },
        };
        let kept_in_order = new_messages.len() >= ahead + old_messages.len()
            && old_messages.iter().zip(&new_messages[ahead..]).all(|(was, now)| was.0 == now.0);
        if !kept_in_order {
            self.list.reset(new.len());
            return;
        }
        let added = new_messages.len() - ahead - old_messages.len();
        let mut had_earlier = is_earlier(&old);
        let mut had_working = is_working(&old);
        let mut count = old.len();
        // An earlier page: the way back goes from where it was and comes again above the page, so
        // what the reader had under it stays where it was (the anchor moves with it).
        if had_earlier && (!is_earlier(new) || ahead > 0) {
            state.splice(0..1, 0);
            had_earlier = false;
            count -= 1;
        }
        if had_working && (!is_working(new) || added > 0) {
            state.splice(count - 1..count, 0);
            had_working = false;
        }
        let offset = usize::from(had_earlier);
        if ahead > 0 {
            state.splice(offset..offset, ahead);
        }
        for (n, (was, now)) in old_messages.iter().zip(&new_messages[ahead..]).enumerate() {
            if was.1 != now.1 {
                self.list.changed(offset + ahead + n);
            }
        }
        if added > 0 {
            self.list.push(added);
        }
        if !had_earlier && is_earlier(new) {
            state.splice(0..0, 1);
        }
        if !had_working && is_working(new) {
            self.list.push(1);
        }
        debug_assert_eq!(state.item_count(), self.entries.len());
    }

    fn toggle(&mut self, block: Block, cx: &mut Context<Self>) {
        let step = block.0.clone();
        if !self.expanded.remove(&block) {
            self.expanded.insert(block);
        }
        if let Some(ix) = self.entries.iter().position(|entry| entry.key() == step) {
            self.list.changed(ix);
        }
        cx.notify();
    }

    /// Asks for the page that couldn't be read, again.
    fn try_earlier_again(&mut self, cx: &mut Context<Self>) {
        self.earlier_failed = None;
        if let Some(follow) = &self.follow {
            follow.load_earlier();
        }
        if let Some(ix) = self.entries.iter().position(|entry| matches!(entry, Entry::Earlier)) {
            self.list.changed(ix);
        }
        cx.notify();
    }

    /// The top row, while there are earlier messages: they're read as it comes into view.
    fn earlier_row(&self, cx_view: &Entity<ConversationView>, cx: &App) -> AnyElement {
        let c = &cx.theme().colors;
        if let Some(error) = &self.earlier_failed {
            let view = cx_view.clone();
            return div()
                .flex()
                .flex_col()
                .items_center()
                .gap(space::S2)
                .text_ui(TypeSize::Caption)
                .text_color(c.text_muted)
                .child(SharedString::from(format!("Earlier messages couldn’t be read. {error}")))
                .child(Button::new("earlier-again", "Try Again").size(ButtonSize::Small).on_click(move |_, _, cx| {
                    view.update(cx, |this, cx| this.try_earlier_again(cx));
                }))
                .into_any_element();
        }
        // Asked once for each way back, as the row first shows.
        let cursor = self.earlier.clone();
        if let (Some(follow), Some(cursor)) = (&self.follow, cursor) {
            let mut asked = self.asked_earlier.borrow_mut();
            if asked.as_deref() != Some(cursor.as_str()) {
                *asked = Some(cursor);
                follow.load_earlier();
            }
        }
        div()
            .flex()
            .justify_center()
            .items_center()
            .gap(space::S1_5)
            .text_ui(TypeSize::Caption)
            .text_color(c.text_faint)
            .child(spinner("earlier", IconSize::Nav, c.text_faint))
            .child("Loading earlier messages…")
            .into_any_element()
    }
}

/// `session`'s conversation as its box has it now, read at once (no follow): for shots and tests,
/// handed to [`ConversationView::take`] as a follow would hand it.
#[cfg(feature = "stand-in")]
pub fn read_now(client: &BoxClient, session: &str) -> kuvo_box::Result<kuvo_box::Conversation> {
    use kuvo_box::Conversation;
    use kuvo_box::messages::{self, Page};
    let place = client.where_is(session)?;
    let page: Page = client.get(&messages::newest_route(place, session, 100))?;
    let running: Option<bool> = client.get::<serde_json::Value>(&format!("{}api/session/active", place.prefix())).ok().map(|active| active["data"].get(session).is_some());
    let earlier = page.earlier(100);
    let mut conversation = Conversation::new(session, place);
    conversation.catch_up(page.data, earlier, &[], running);
    Ok(conversation)
}

impl Render for ConversationView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let c = &theme.colors;
        let view = cx.entity();
        let body: AnyElement = if !self.read {
            match &self.problem {
                Some(Problem::Gone(why)) | Some(Problem::Failed(why)) => centred(SharedString::from(why.clone()), false, cx),
                None => centred("Loading the conversation…".into(), true, cx),
            }
        } else if self.entries.is_empty() {
            centred("Nothing here yet. Write below to start.".into(), false, cx)
        } else {
            chat_list(&self.list, move |ix, _window, cx| {
                let cx: &App = cx;
                let this = view.read(cx);
                let Some(entry) = this.entries.get(ix) else { return div().into_any_element() };
                let earlier = if matches!(entry, Entry::Earlier) { this.earlier_row(&view, cx) } else { div().into_any_element() };
                let toggle_view = view.clone();
                let toggle = move |block: Block, cx: &mut App| toggle_view.update(cx, |this, cx| this.toggle(block, cx));
                entries::render(ix, entry, &this.expanded, toggle, earlier, cx)
            })
            .into_any_element()
        };
        // A problem while it's shown: said above the composer; it's tried again meanwhile.
        let banner = match (&self.problem, self.read) {
            (Some(Problem::Failed(why)), true) => Some((why.clone(), c.warning)),
            (Some(Problem::Gone(why)), true) => Some((why.clone(), c.danger)),
            _ => None,
        };
        // Waiting on you for something this app can't answer yet: said plainly, above the composer.
        let asking = (self.asking && !matches!(self.problem, Some(Problem::Gone(_)))).then(|| {
            div()
                .debug_selector(|| "asking".into())
                .w_full()
                .max_w(px(COLUMN))
                .pb(space::S2)
                .flex()
                .items_center()
                .gap(space::S2)
                .text_ui(TypeSize::Caption)
                .text_color(c.text_muted)
                .child(status_dot(c.accent))
                .child("It’s waiting on you for an answer this app can’t give yet: answer it in Kuvo Code on your Mac or iPhone.")
        });
        let gone = matches!(self.problem, Some(Problem::Gone(_)));
        div()
            .size_full()
            .flex()
            .flex_col()
            .child(div().relative().flex_1().min_h_0().child(body))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .px(space::S6)
                    .pb(space::S5)
                    .children(asking)
                    .children(banner.map(|(why, color)| {
                        div().w_full().max_w(px(COLUMN)).pb(space::S2).text_ui(TypeSize::Caption).text_color(color).child(why)
                    }))
                    .when(!gone, |d| d.child(div().w_full().max_w(px(COLUMN)).child(self.composer.clone()))),
            )
    }
}

/// Centred words in the conversation's place (loading, nothing yet, gone).
fn centred(words: SharedString, busy: bool, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .gap(space::S2)
        .text_ui(TypeSize::Small)
        .text_color(c.text_muted)
        .children(busy.then(|| spinner("loading", IconSize::Nav, c.text_muted)))
        .child(words)
        .into_any_element()
}
