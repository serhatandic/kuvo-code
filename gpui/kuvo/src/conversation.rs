//! A conversation: its messages in the chat list, newest at the bottom, following a run live and
//! reading earlier messages as you scroll back to them, with the composer under it.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Task, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::asks::Asks;
use kuvo_box::queue::{Item, Queue};
use kuvo_box::follow::{ConversationUpdate, Follow, Followed, Timing};
use kuvo_box::BoxClient;
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, Icon, IconName, IconSize, StyledType, TypeSize,
    chat_list::{ChatListState, chat_list},
    small::spinner,
    theme::{radius, space},
};

use crate::ask_card::AskCard;
use crate::composer::Composer;
use crate::entries::{self, COLUMN, Entry, Fold};

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
    entries: Vec<Entry>,
    /// Each row's revision: a row is drawn again only once it's changed.
    revisions: Vec<u64>,
    list: ChatListState,
    problem: Option<Problem>,
    earlier_failed: Option<String>,
    /// The way back already asked for, so it's asked once.
    asked_earlier: Rc<RefCell<Option<String>>>,
    /// Thinking blocks and tool steps opened, and outputs shown whole.
    open: HashSet<Fold>,
    /// Its composer, which the workspace keeps (with its draft) while you're elsewhere.
    composer: Entity<Composer>,
    /// What it waits on you for, in the composer's place while anything does.
    asks: Entity<AskCard>,
    follow: Option<Rc<Follow<ConversationUpdate>>>,
    _follow_task: Option<Task<()>>,
    _asks_follow: Option<Follow<Followed<Asks>>>,
    _asks_task: Option<Task<()>>,
    /// What waits its turn, as the box orders it, over the composer.
    queue: Queue,
    queue_failed: Option<String>,
    /// Why what it asks couldn't be read (what was shown stays meanwhile).
    asks_failed: Option<String>,
    client: BoxClient,
    live: bool,
    _queue_follow: Option<Follow<Followed<Queue>>>,
    tasks: Vec<Task<()>>,
}

impl Focusable for ConversationView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        let asks = self.asks.read(cx);
        if asks.is_asking() { asks.focus_handle(cx) } else { self.composer.focus_handle(cx) }
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
            // (From the box's first word: a change heard before the first update counts too.)
            models_changed: Some(0),
            entries: Vec::new(),
            revisions: Vec::new(),
            list: ChatListState::new(0, cx),
            problem: None,
            earlier_failed: None,
            asked_earlier: Rc::default(),
            open: HashSet::new(),
            asks: cx.new(|cx| AskCard::new(client.clone(), session.clone(), cx)),
            composer,
            follow: None,
            _follow_task: None,
            _asks_follow: None,
            _asks_task: None,
            queue: Queue::default(),
            queue_failed: None,
            asks_failed: None,
            client: client.clone(),
            live,
            _queue_follow: None,
            tasks: Vec::new(),
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
            // What it asks, as the box words it, now and as it changes.
            let asks = client.follow_asks(&session, Timing::default());
            let updates = asks.updates().clone();
            view._asks_follow = Some(asks);
            // What waits its turn, now and as it changes.
            let queue = client.follow_queue(&session, Timing::default());
            let queued = queue.updates().clone();
            view._queue_follow = Some(queue);
            view.tasks.push(cx.spawn(async move |this, cx| {
                while let Ok(update) = queued.recv().await {
                    let taken = match update {
                        Followed::Now(queue) => this.update(cx, |this, cx| this.take_queue(queue, cx)),
                        // What it said last stays, saying it couldn't be read now.
                        Followed::Failed(error) => this.update(cx, |this, cx| {
                            this.queue_failed = Some(format!("The queue couldn’t be read: {error}"));
                            cx.notify();
                        }),
                    };
                    if taken.is_err() {
                        break;
                    }
                }
            }));
            view._asks_task = Some(cx.spawn(async move |this, cx| {
                while let Ok(update) = updates.recv().await {
                    let taken = match update {
                        Followed::Now(asks) => this.update(cx, |this, cx| this.take_asks(asks, cx)),
                        Followed::Failed(error) => this.update(cx, |this, cx| {
                            this.asks_failed = Some(format!("What it asks you couldn’t be read: {error}"));
                            cx.notify();
                        }),
                    };
                    if taken.is_err() {
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

    /// What waits its turn, as the box says it.
    pub fn take_queue(&mut self, queue: Queue, cx: &mut Context<Self>) {
        self.queue = queue;
        self.queue_failed = None;
        cx.notify();
    }

    pub fn queued(&self) -> &[Item] {
        self.queue.items.as_deref().unwrap_or_default()
    }

    /// Takes `item` out of the queue; `edit`: its words and files back in the composer, to change
    /// and send again.
    pub fn unqueue(&mut self, item: String, edit: bool, cx: &mut Context<Self>) {
        let (client, session) = (self.client.clone(), self.session.clone());
        let task = cx.background_executor().spawn(async move { client.remove_queued(&session, &item).map(|removed| (item, removed)) });
        self.tasks.retain(|task| !task.is_ready());
        self.tasks.push(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok((item, removed)) => {
                        this.queue_failed = None;
                        if let Some(items) = this.queue.items.as_mut() {
                            items.retain(|each| each.id != item);
                        }
                        if let (true, Some(removed)) = (edit, removed) {
                            this.composer.update(cx, |composer, cx| composer.restore(&removed.words, &removed.files, cx));
                        }
                    }
                    Err(error) => this.queue_failed = Some(format!("It couldn’t be taken out of the queue: {error}")),
                }
                // (Read again at once where nothing follows it: tests and shots.)
                if !this.live
                    && let Ok(queue) = this.client.queue(&this.session)
                {
                    this.queue = queue;
                }
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn asks(&self) -> &Entity<AskCard> {
        &self.asks
    }

    /// What the box says it waits on you for: a card in the composer's place while anything does,
    /// with the keyboard on it as it comes.
    pub fn take_asks(&mut self, asks: Asks, cx: &mut Context<Self>) {
        self.asks_failed = None;
        self.asks.update(cx, |card, cx| card.take(asks, cx));
        cx.notify();
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

    /// Opens or closes a thinking block or a tool step, or folds an output again.
    pub fn toggle(&mut self, fold: Fold, cx: &mut Context<Self>) {
        let step = fold.step().to_owned();
        if !self.open.remove(&fold) {
            self.open.insert(fold);
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

impl ConversationView {
    /// What waits its turn, over the composer: each message as you wrote it (who it's from, when
    /// it isn't yours), with Edit (yours) and Remove under the pointer.
    fn queue_view(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let items = self.queued();
        if items.is_empty() {
            return None;
        }
        let c = cx.theme().colors.clone();
        let count = items.len();
        let said = if self.queue.paused { format!("{count} waiting · paused") } else if count == 1 { "1 waiting".to_owned() } else { format!("{count} waiting") };
        let rows = items.iter().enumerate().map(|(ix, item)| {
            let group = SharedString::from(format!("queued-{ix}"));
            let (edit_id, remove_id) = (item.id.clone(), item.id.clone());
            let selector = format!("queued-{}", item.id);
            let lead: AnyElement = match &item.from {
                Some(from) => div().flex_none().text_ui(TypeSize::Caption).medium().text_color(c.text_muted).child(from.clone()).into_any_element(),
                None => Icon::new(IconName::Clock).size(IconSize::Nav).color(if ix == 0 { c.accent } else { c.text_faint }).into_any_element(),
            };
            div()
                .id(SharedString::from(format!("queued-{}", item.id)))
                .debug_selector(move || selector)
                .group(group.clone())
                .flex()
                .items_center()
                .gap(space::S2)
                .h(px(30.))
                .px(space::S2)
                .rounded(radius::NAV)
                .hover(|s| s.bg(c.hover))
                .child(lead)
                .children(item.keyword.clone().map(|keyword| div().flex_none().text_ui(TypeSize::Caption).text_color(c.accent).child(keyword)))
                .child(div().flex_1().min_w_0().truncate().text_ui(TypeSize::Small).text_color(c.text).child(item.words.lines().next().unwrap_or("").to_owned()))
                .children((!item.files.is_empty()).then(|| {
                    let files = if item.files.len() == 1 { item.files[0].clone() } else { format!("{} files", item.files.len()) };
                    div().flex().flex_none().items_center().gap(space::S1).text_ui(TypeSize::Caption).text_color(c.text_muted).child(Icon::new(IconName::Paperclip).size(IconSize::Nav).color(c.text_faint)).child(files)
                }))
                .child(
                    div()
                        .flex()
                        .flex_none()
                        .gap(space::S0_5)
                        .opacity(0.)
                        .group_hover(group, |s| s.opacity(1.))
                        .when(item.is_yours(), |d| {
                            let selector = format!("edit-{}", item.id);
                            d.child(div().debug_selector(move || selector).child(Button::icon_only(SharedString::from(format!("edit-{}", item.id)), IconName::Pencil, "Edit").size(ButtonSize::Small).on_click(cx.listener(move |this, _, _, cx| this.unqueue(edit_id.clone(), true, cx)))))
                        })
                        .child({
                            let selector = format!("remove-{}", item.id);
                            div().debug_selector(move || selector).child(Button::icon_only(SharedString::from(format!("remove-{}", item.id)), IconName::Trash, "Remove").size(ButtonSize::Small).on_click(cx.listener(move |this, _, _, cx| this.unqueue(remove_id.clone(), false, cx))))
                        }),
                )
        });
        Some(
            div()
                .debug_selector(|| "queue".into())
                .w_full()
                .max_w(px(COLUMN))
                .mb(space::S2)
                .flex()
                .flex_col()
                .p(space::S1)
                .rounded(radius::CARD - px(4.))
                .bg(c.sunken)
                .border_1()
                .border_color(c.border)
                .child(div().px(space::S2).pt(space::S1).pb(space::S0_5).text_ui(TypeSize::Caption).text_color(c.text_faint).child(said))
                .child(div().id("queue-rows").max_h(px(30. * 4.)).overflow_y_scroll().children(rows))
                .children(self.queue_failed.clone().map(|why| div().px(space::S2).pb(space::S1).text_ui(TypeSize::Caption).text_color(c.warning).child(why)))
                .into_any_element(),
        )
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
            let asking = self.asks.read(cx).is_asking();
            centred(if asking { "Nothing here yet.".into() } else { "Nothing here yet. Write below to start.".into() }, false, cx)
        } else {
            chat_list(&self.list, move |ix, _window, cx| {
                let cx: &App = cx;
                let this = view.read(cx);
                let Some(entry) = this.entries.get(ix) else { return div().into_any_element() };
                let earlier = if matches!(entry, Entry::Earlier) { this.earlier_row(&view, cx) } else { div().into_any_element() };
                let toggle_view = view.clone();
                let toggle = move |fold: Fold, cx: &mut App| toggle_view.update(cx, |this, cx| this.toggle(fold, cx));
                entries::render(ix, entry, &this.open, toggle, earlier, cx)
            })
            .into_any_element()
        };
        // A problem while it's shown: said above the composer; it's tried again meanwhile.
        let banner = match (&self.problem, self.read) {
            (Some(Problem::Failed(why)), true) => Some((why.clone(), c.warning)),
            (Some(Problem::Gone(why)), true) => Some((why.clone(), c.danger)),
            _ => None,
        };
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
                    .children(banner.map(|(why, color)| {
                        div().w_full().max_w(px(COLUMN)).pb(space::S2).text_ui(TypeSize::Caption).text_color(color).child(why)
                    }))
                    .children(self.asks_failed.clone().filter(|_| !gone).map(|why| {
                        div().w_full().max_w(px(COLUMN)).pb(space::S2).text_ui(TypeSize::Caption).text_color(c.warning).child(why)
                    }))
                    .when(!gone, |d| d.children(self.queue_view(cx)))
                    // What it waits on you for takes the composer's place, as on the Mac and the phone.
                    .when(!gone, |d| {
                        let asking = self.asks.read(cx).is_asking();
                        d.child(div().w_full().max_w(px(COLUMN)).child(if asking { self.asks.clone().into_any_element() } else { self.composer.clone().into_any_element() }))
                    }),
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
