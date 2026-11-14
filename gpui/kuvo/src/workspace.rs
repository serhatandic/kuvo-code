//! The window: the sidebar on the window's background, and beside it a card holding either the
//! conversation open or, for a new one, the landing view.

use std::collections::{HashMap, HashSet};

use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, MouseButton,
    ParentElement, Render, ScrollHandle, SharedString, Styled, Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::follow::{Follow, ListUpdate, Timing};
use kuvo_box::models::StartIn;
use kuvo_box::search::{Found, SEARCHED_FROM};
use kuvo_box::sessions::project_name;
use kuvo_box::{BoxClient, BoxInfo, Listing, Where};
use kuvo_ui::{ActiveTheme, StyledType, TextField, TextFieldEvent, Theme, TypeSize, theme::{radius, space}};

use crate::composer::{Composer, ComposerEvent, Target};
use crate::conversation::ConversationView;
use crate::sidebar::{FocusSearch, Line};
use crate::{NewSession, ToggleAppearance, landing, sidebar, time};

/// How long typing pauses before the box is asked to search conversations.
const SEARCH_PAUSE: Duration = Duration::from_millis(300);
/// How many conversations a search shows.
const SEARCH_MOST: usize = 20;

/// How the session lists stand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lists {
    Loading,
    /// The box can't read its engine yet.
    Waiting(String),
    /// The box waits for its update.
    Held,
    Failed(String),
    Ready,
}

/// How the box stands with this app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoxState {
    Connecting,
    Connected,
    Updating,
    Unreachable(String),
}

enum Open {
    Landing,
    Conversation { view: Entity<ConversationView>, session: String },
}

pub struct Workspace {
    client: BoxClient,
    /// Whether it follows the box (the app), or shows what it's handed (tests and shots).
    live: bool,
    info: Option<BoxInfo>,
    box_state: BoxState,
    listing: Listing,
    lists: Lists,
    open: Open,
    landing: Entity<Composer>,
    /// Each conversation's composer, kept with its draft (and any send on its way) while you're
    /// in another.
    composers: HashMap<String, (Entity<Composer>, Subscription)>,
    /// Where the landing view starts a new session: the newest project's, set as the list is first
    /// read and again as the landing view opens (so it doesn't move while you write), unless one's
    /// been picked.
    landing_place: Option<StartIn>,
    landing_picked: bool,
    /// What the box said of sessions started here, until its list has them: their projects.
    started: HashMap<String, Option<String>>,
    /// Sessions started here whose first message didn't go (or came back with why), while you were
    /// elsewhere: marked in the sidebar until opened.
    unsent: HashSet<String>,
    collapsed: HashSet<String>,
    showing_all: HashSet<String>,
    /// Now, as the sidebar's times count from it (fixed for shots).
    now: Option<f64>,
    focus: FocusHandle,
    /// The sidebar's search, and what the box found in conversations for it (`finds_for`).
    search: Entity<TextField>,
    finds: Vec<Found>,
    finds_for: String,
    finding: bool,
    find_failed: Option<String>,
    find_task: Option<Task<()>>,
    /// The sidebar's list while the keyboard walks it: where it is (a line's key), its focus, and
    /// its scrolling.
    walked: Option<String>,
    list_focus: FocusHandle,
    list_scroll: ScrollHandle,
    _sessions: Option<Follow<ListUpdate>>,
    tasks: Vec<Task<()>>,
    _landing: Subscription,
    _search: Subscription,
}

impl Workspace {
    pub fn new(client: BoxClient, live: bool, window: &mut Window, cx: &mut Context<Self>) -> Workspace {
        let landing = cx.new(|cx| Composer::new(client.clone(), Target::New(StartIn::Chat), live, cx));
        let subscription = cx.subscribe_in(&landing, window, |this, _, event: &ComposerEvent, window, cx| this.composer_event(event, window, cx));
        let search = cx.new(|cx| TextField::new(cx).bare().placeholder("Search"));
        let search_subscription = cx.subscribe(&search, |this: &mut Workspace, _, event: &TextFieldEvent, cx| {
            if matches!(event, TextFieldEvent::Changed) {
                this.search_changed(cx);
            }
        });
        let mut workspace = Workspace {
            client: client.clone(),
            live,
            info: None,
            box_state: BoxState::Connecting,
            listing: Listing::new(),
            lists: Lists::Loading,
            open: Open::Landing,
            landing,
            composers: HashMap::new(),
            landing_place: None,
            landing_picked: false,
            started: HashMap::new(),
            unsent: HashSet::new(),
            collapsed: HashSet::new(),
            showing_all: HashSet::new(),
            now: None,
            focus: cx.focus_handle(),
            search,
            finds: Vec::new(),
            finds_for: String::new(),
            finding: false,
            find_failed: None,
            find_task: None,
            walked: None,
            list_focus: cx.focus_handle(),
            list_scroll: ScrollHandle::new(),
            _sessions: None,
            tasks: Vec::new(),
            _landing: subscription,
            _search: search_subscription,
        };
        if live {
            let connecting = client.clone();
            let task = cx.background_executor().spawn(async move { connecting.connect() });
            workspace.tasks.push(cx.spawn(async move |this, cx| {
                let result = task.await;
                this.update(cx, |this, cx| this.connected(result, cx)).ok();
            }));
            let follow = client.follow_sessions(Timing::default());
            let updates = follow.updates().clone();
            workspace._sessions = Some(follow);
            workspace.tasks.push(cx.spawn(async move |this, cx| {
                while let Ok(update) = updates.recv().await {
                    if this.update(cx, |this, cx| this.take_list(update, cx)).is_err() {
                        break;
                    }
                }
            }));
        }
        workspace
    }

    /// Reads the box at once, on this thread, as the follows would hand it: what it is, its lists,
    /// and the landing composer's chips (shots and tests, against a stand-in).
    #[cfg(feature = "stand-in")]
    pub fn read_at_once(&mut self, cx: &mut Context<Self>) {
        let info = self.client.connect();
        self.connected(info, cx);
        let update = match self.client.session_list(None) {
            Ok(line) => {
                let mut listing = Listing::new();
                listing.take(line);
                ListUpdate::Listing(listing)
            }
            Err(error) => ListUpdate::Failed(error),
        };
        self.take_list(update, cx);
        self.landing.update(cx, |composer, cx| composer.read_at_once(cx));
    }

    /// Opens `session` and reads it at once, on this thread (shots and tests, against a stand-in).
    #[cfg(feature = "stand-in")]
    pub fn open_read_at_once(&mut self, session: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_session(session, window, cx);
        let client = self.client.clone();
        if let Some(view) = self.conversation().cloned() {
            let update = match crate::conversation::read_now(&client, session) {
                Ok(conversation) => kuvo_box::ConversationUpdate::Conversation(conversation),
                Err(kuvo_box::Error::Refused(refusal)) if refusal.status == 404 => kuvo_box::ConversationUpdate::Gone(refusal),
                Err(error) => kuvo_box::ConversationUpdate::Failed(error),
            };
            let asks = client.asks(session).unwrap_or_default();
            view.update(cx, |view, cx| {
                view.take(update, cx);
                view.take_asks(asks, cx);
                view.composer().clone().update(cx, |composer, cx| composer.read_at_once(cx));
            });
        }
    }

    /// What `kuvo/info` said, or why it couldn't be read.
    pub fn connected(&mut self, result: kuvo_box::Result<BoxInfo>, cx: &mut Context<Self>) {
        match result {
            Ok(info) => {
                self.info = Some(info);
                self.box_state = BoxState::Connected;
            }
            Err(kuvo_box::Error::NeedsUpdating { .. }) => self.box_state = BoxState::Updating,
            Err(error) => self.box_state = BoxState::Unreachable(error.to_string()),
        }
        cx.notify();
    }

    /// What the box's session lists say, shown.
    pub fn take_list(&mut self, update: ListUpdate, cx: &mut Context<Self>) {
        match update {
            ListUpdate::Listing(listing) => {
                self.listing = listing;
                self.lists = Lists::Ready;
                if matches!(self.box_state, BoxState::Connecting | BoxState::Unreachable(_) | BoxState::Updating) {
                    self.box_state = BoxState::Connected;
                }
                // Where a new one starts: set once, as the list is first read.
                if self.landing_place.is_none() {
                    let place = self.default_place();
                    self.landing_place = Some(place.clone());
                    self.landing.update(cx, |composer, cx| composer.set_start(place, cx));
                }
                // Sessions started here are in the list now: what their box said of them goes.
                let listing = &self.listing;
                self.started.retain(|session, _| listing.facts(session).is_none());
            }
            ListUpdate::Waiting(why) => self.lists = Lists::Waiting(why),
            ListUpdate::Held { .. } => {
                self.lists = Lists::Held;
                self.box_state = BoxState::Updating;
            }
            ListUpdate::Failed(error) => {
                if !self.listing.is_read() {
                    self.box_state = BoxState::Unreachable(error.to_string());
                }
                self.lists = Lists::Failed(error.to_string());
            }
        }
        cx.notify();
    }

    pub fn client(&self) -> &BoxClient {
        &self.client
    }

    pub fn listing(&self) -> &Listing {
        &self.listing
    }

    pub fn lists(&self) -> &Lists {
        &self.lists
    }

    pub fn box_state(&self) -> &BoxState {
        &self.box_state
    }

    /// The box's name as the sidebar's foot says it: "This Mac" for this Mac's own.
    pub fn box_name(&self) -> SharedString {
        match &self.info {
            Some(info) if !info.is_mac() => info.name.clone().into(),
            _ => "This Mac".into(),
        }
    }

    pub fn now(&self) -> f64 {
        self.now.unwrap_or_else(time::now_ms)
    }

    /// Counts the sidebar's times from `now` (shots, so they read the same each time).
    pub fn set_now(&mut self, now: f64) {
        self.now = Some(now);
    }

    pub fn is_landing(&self) -> bool {
        matches!(self.open, Open::Landing)
    }

    pub fn landing(&self) -> &Entity<Composer> {
        &self.landing
    }

    /// The session open, if one is.
    pub fn opened(&self) -> Option<&str> {
        match &self.open {
            Open::Conversation { session, .. } => Some(session),
            Open::Landing => None,
        }
    }

    pub fn conversation(&self) -> Option<&Entity<ConversationView>> {
        match &self.open {
            Open::Conversation { view, .. } => Some(view),
            Open::Landing => None,
        }
    }

    pub fn is_collapsed(&self, project: &str) -> bool {
        self.collapsed.contains(project)
    }

    pub fn toggle_project(&mut self, project: &str, cx: &mut Context<Self>) {
        if !self.collapsed.remove(project) {
            self.collapsed.insert(project.to_owned());
        }
        cx.notify();
    }

    pub fn shows_all(&self, project: &str) -> bool {
        self.showing_all.contains(project)
    }

    pub fn toggle_all(&mut self, project: &str, cx: &mut Context<Self>) {
        if !self.showing_all.remove(project) {
            self.showing_all.insert(project.to_owned());
        }
        cx.notify();
    }

    /// Whether `session` was started here and what was written didn't go while you were elsewhere.
    pub fn is_unsent(&self, session: &str) -> bool {
        self.unsent.contains(session)
    }

    /// Opens a session's conversation.
    pub fn open_session(&mut self, session: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.opened() == Some(session) {
            return;
        }
        self.unsent.remove(session);
        let (client, live) = (self.client.clone(), self.live);
        let composer = self.composer_for(session, window, cx);
        // Only the composer on screen asks again for what the box couldn't say.
        self.show_composer(Some(&composer), cx);
        let view = cx.new(|cx| ConversationView::new(client, session.to_owned(), composer, live, cx));
        window.focus(&view.focus_handle(cx), cx);
        self.open = Open::Conversation { view, session: session.to_owned() };
        cx.notify();
    }

    /// `session`'s composer: the one it had, with its draft (its model read again, as it may have
    /// changed meanwhile), or a new one.
    fn composer_for(&mut self, session: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<Composer> {
        if let Some((composer, _)) = self.composers.get(session) {
            let composer = composer.clone();
            if self.live {
                composer.update(cx, |composer, cx| composer.read_models(cx));
            }
            return composer;
        }
        let (client, live) = (self.client.clone(), self.live);
        let composer = cx.new(|cx| Composer::new(client, Target::Session { id: session.to_owned(), place: Where::Engine }, live, cx));
        let subscription = cx.subscribe_in(&composer, window, |this, _, event: &ComposerEvent, window, cx| this.composer_event(event, window, cx));
        // Not on screen until its conversation opens.
        composer.update(cx, |composer, cx| composer.set_shown(false, cx));
        self.composers.insert(session.to_owned(), (composer.clone(), subscription));
        composer
    }

    /// The landing view, for a new conversation in `project` (or the one picked last).
    pub fn new_session(&mut self, project: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(project) = project {
            self.landing_place = Some(StartIn::Project(project));
            self.landing_picked = true;
        } else if !self.landing_picked {
            // The newest project's, as it opens; it stays put while you write.
            self.landing_place = Some(self.default_place());
        }
        let place = self.landing_place();
        self.landing.update(cx, |composer, cx| composer.set_start(place, cx));
        let landing = self.landing.clone();
        self.show_composer(Some(&landing), cx);
        // What's offered may have changed since it was last open (an account signed in elsewhere),
        // or (another project) a new one there starts on another: read again, once.
        landing.update(cx, |composer, cx| composer.read_models(cx));
        self.open = Open::Landing;
        window.focus(&self.landing.focus_handle(cx), cx);
        cx.notify();
    }

    /// Marks `shown` as the composer on screen, and every other as not.
    fn show_composer(&mut self, shown: Option<&Entity<Composer>>, cx: &mut Context<Self>) {
        let all: Vec<Entity<Composer>> = self.composers.values().map(|(composer, _)| composer.clone()).chain([self.landing.clone()]).collect();
        for composer in all {
            let on = shown == Some(&composer);
            composer.update(cx, |composer, cx| composer.set_shown(on, cx));
        }
    }

    /// Where a new conversation starts before one's picked: the newest project's, else a chat.
    fn default_place(&self) -> StartIn {
        self.listing.sidebar().projects.first().map_or(StartIn::Chat, |group| StartIn::Project(group.directory.clone()))
    }

    pub fn landing_place(&self) -> StartIn {
        self.landing_place.clone().unwrap_or_else(|| self.default_place())
    }

    pub fn pick_place(&mut self, place: StartIn, cx: &mut Context<Self>) {
        self.landing_place = Some(place.clone());
        self.landing_picked = true;
        self.landing.update(cx, |composer, cx| {
            composer.set_start(place, cx);
            composer.read_models(cx);
        });
        cx.notify();
    }

    /// A project's name, as the lists name it.
    pub fn project_name(&self, directory: &str) -> String {
        project_name(directory, self.listing.projects())
    }

    fn composer_event(&mut self, event: &ComposerEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            ComposerEvent::Started { session, project, written, sent, .. } => {
                // What the box said of what was written (or why it didn't go) goes to the new
                // conversation's own composer; the landing one is left empty.
                self.started.insert(session.clone(), project.clone());
                let composer = self.composer_for(session, window, cx);
                composer.update(cx, |composer, cx| composer.take_sent(written, sent.clone(), cx));
                // Opened, unless you've gone to another conversation meanwhile, or started
                // writing the next one.
                let writing_next = !self.landing.read(cx).field().read(cx).text().trim().is_empty();
                if self.is_landing() && !writing_next {
                    self.open_session(session, window, cx);
                } else if self.opened() != Some(session.as_str())
                    && (composer.read(cx).field().read(cx).error().is_some() || !composer.read(cx).field().read(cx).text().is_empty())
                {
                    // You're elsewhere: what didn't go waits there, marked in the sidebar.
                    self.unsent.insert(session.clone());
                }
            }
        }
    }

    // MARK: Search and walking the sidebar

    pub fn search(&self) -> &Entity<TextField> {
        &self.search
    }

    pub fn search_text(&self, cx: &App) -> String {
        self.search.read(cx).text().to_owned()
    }

    /// What the box found in conversations for the search as it is now.
    pub fn finds(&self) -> &[Found] {
        &self.finds
    }

    pub fn is_finding(&self) -> bool {
        self.finding
    }

    pub fn find_failed(&self) -> Option<&str> {
        self.find_failed.as_deref()
    }

    /// Where the keyboard is in the sidebar's list: a line's key.
    pub fn walked(&self) -> Option<&str> {
        self.walked.as_deref()
    }

    pub fn list_focus(&self) -> &FocusHandle {
        &self.list_focus
    }

    pub fn list_scroll(&self) -> &ScrollHandle {
        &self.list_scroll
    }

    /// The search changed: names match at once; conversations once typing pauses, from three
    /// characters (the box searches them).
    fn search_changed(&mut self, cx: &mut Context<Self>) {
        self.walked = None;
        let query = self.search_text(cx).trim().to_owned();
        if query == self.finds_for {
            cx.notify();
            return;
        }
        self.finds.clear();
        self.find_failed = None;
        self.finds_for = query.clone();
        self.find_task = None;
        self.finding = query.chars().count() >= SEARCHED_FROM;
        if self.finding {
            let client = self.client.clone();
            if self.live {
                self.find_task = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(SEARCH_PAUSE).await;
                    let asked = query.clone();
                    let found = cx.background_executor().spawn(async move { client.search(&asked, SEARCH_MOST) }).await;
                    this.update(cx, |this, cx| this.found(&query, found, cx)).ok();
                }));
            } else {
                // (Tests and shots: at once, as the box would answer.)
                let found = client.search(&query, SEARCH_MOST);
                self.found(&query, found, cx);
            }
        }
        cx.notify();
    }

    /// What the box found for `query`, unless the search has changed since.
    fn found(&mut self, query: &str, found: kuvo_box::Result<Vec<Found>>, cx: &mut Context<Self>) {
        if query != self.finds_for {
            return;
        }
        self.finding = false;
        match found {
            Ok(finds) => self.finds = finds,
            Err(error) => self.find_failed = Some(error.to_string()),
        }
        cx.notify();
    }

    pub fn clear_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.update(cx, |field, cx| field.set_text("", cx));
        self.walked = None;
        window.focus(&self.search.focus_handle(cx), cx);
        cx.notify();
    }

    /// Puts the keyboard in the sidebar's search.
    pub fn focus_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.walked = None;
        window.focus(&self.search.focus_handle(cx), cx);
        cx.notify();
    }

    /// Steps the keyboard through the sidebar's list, `by` one down or up. Up from its first row
    /// goes back to the search.
    pub fn walk(&mut self, by: isize, window: &mut Window, cx: &mut Context<Self>) {
        let lines = sidebar::lines(self, cx);
        let walkable: Vec<usize> = lines.iter().enumerate().filter(|(_, line)| line.walkable()).map(|(ix, _)| ix).collect();
        if walkable.is_empty() {
            return;
        }
        let at = self.walked.as_ref().and_then(|key| walkable.iter().position(|ix| &lines[*ix].key() == key));
        let next = match (at, by > 0) {
            (None, true) => Some(0),
            (None, false) => Some(walkable.len() - 1),
            (Some(at), true) => Some((at + 1).min(walkable.len() - 1)),
            (Some(0), false) => None,
            (Some(at), false) => Some(at - 1),
        };
        match next {
            Some(next) => {
                let ix = walkable[next];
                self.walked = Some(lines[ix].key());
                self.list_scroll.scroll_to_item(ix);
                window.focus(&self.list_focus, cx);
            }
            None => {
                self.walked = None;
                window.focus(&self.search.focus_handle(cx), cx);
            }
        }
        cx.notify();
    }

    /// Return: opens the session under the keyboard (from the search, the first one found), folds
    /// a project, or shows more of one.
    pub fn open_walked(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let lines = sidebar::lines(self, cx);
        let line = match &self.walked {
            Some(key) => lines.iter().find(|line| &line.key() == key),
            None => lines.iter().find(|line| line.walkable()),
        };
        match line.cloned() {
            Some(Line::Project(directory)) => {
                self.walked = Some(Line::Project(directory.clone()).key());
                self.toggle_project(&directory, cx);
            }
            Some(Line::More(directory)) => self.toggle_all(&directory, cx),
            Some(Line::Session { id, .. }) | Some(Line::Found { id, .. }) => {
                self.walked = None;
                self.open_session(&id, window, cx);
                // (One already open: the keyboard goes back to it all the same.)
                if let Some(view) = self.conversation() {
                    window.focus(&view.focus_handle(cx), cx);
                }
            }
            _ => {}
        }
        cx.notify();
    }

    /// Escape: out of the list, to the search; in the search, its words cleared, or (with none) back
    /// to the conversation or the landing view.
    pub fn leave_walk(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.walked.take().is_some() {
            window.focus(&self.search.focus_handle(cx), cx);
        } else if !self.search_text(cx).is_empty() {
            self.search.update(cx, |field, cx| field.set_text("", cx));
        } else {
            match self.conversation() {
                Some(view) => window.focus(&view.focus_handle(cx), cx),
                None => window.focus(&self.landing.focus_handle(cx), cx),
            }
        }
        cx.notify();
    }

    fn header(&self, cx: &App) -> AnyElement {
        let c = &cx.theme().colors;
        let (title, project) = match self.opened() {
            Some(session) => {
                let facts = self.listing.facts(session);
                let title = facts.and_then(|facts| facts.title.clone()).filter(|title| !title.trim().is_empty()).unwrap_or_else(|| "New Session".into());
                // (One started here, before the list has it: the project its box said.)
                let project = facts.and_then(|facts| facts.project.clone()).or_else(|| self.started.get(session).cloned().flatten()).map(|project| self.project_name(&project));
                (Some(title), project)
            }
            None => (None, None),
        };
        div()
            .id("content-header")
            .flex()
            .flex_none()
            .items_center()
            .gap(space::S2)
            .h(px(44.))
            .px(space::S5)
            .when(self.opened().is_some(), |d| d.border_b_1().border_color(c.border))
            .on_mouse_down(MouseButton::Left, |event, window, _| {
                if event.click_count == 1 {
                    window.start_window_move();
                }
            })
            .children(title.map(|title| div().min_w_0().truncate().text_ui(TypeSize::Small).medium().text_color(c.text).child(title)))
            .children(project.map(|project| div().flex_none().text_ui(TypeSize::Small).text_color(c.text_faint).child(project)))
            .into_any_element()
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let c = &theme.colors;
        let content: AnyElement = match &self.open {
            Open::Landing => landing::render(self, window, cx),
            Open::Conversation { view, .. } => view.clone().into_any_element(),
        };
        let header = self.header(cx);
        div()
            .key_context("Workspace")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &NewSession, window, cx| this.new_session(None, window, cx)))
            .on_action(cx.listener(|this, _: &FocusSearch, window, cx| this.focus_search(window, cx)))
            .on_action(cx.listener(|_, _: &ToggleAppearance, _, cx| {
                let next = cx.theme().appearance.toggled();
                Theme::set_appearance(next, cx);
            }))
            .flex()
            .size_full()
            .bg(c.background)
            .text_ui(TypeSize::Small)
            .text_color(c.text)
            .child(sidebar::render(self, window, cx))
            .child(
                div().flex_1().min_w_0().h_full().py(space::S2).pr(space::S2).child(
                    div()
                        .size_full()
                        .flex()
                        .flex_col()
                        .rounded(radius::CARD - px(4.))
                        .overflow_hidden()
                        .border_1()
                        .border_color(c.border)
                        .bg(c.surface)
                        .child(header)
                        .child(div().relative().flex_1().min_h_0().child(content)),
                ),
            )
    }
}
