//! The window: the sidebar on the window's background, and beside it a card holding either the
//! conversation open or, for a new one, the landing view.

use std::collections::{HashMap, HashSet};

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, MouseButton,
    ParentElement, Render, SharedString, Styled, Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::follow::{Follow, ListUpdate, Timing};
use kuvo_box::models::StartIn;
use kuvo_box::sessions::project_name;
use kuvo_box::{BoxClient, BoxInfo, Listing, Where};
use kuvo_ui::{ActiveTheme, StyledType, Theme, TypeSize, theme::{radius, space}};

use crate::composer::{Composer, ComposerEvent, Target};
use crate::conversation::ConversationView;
use crate::{NewSession, ToggleAppearance, landing, sidebar, time};

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
    collapsed: HashSet<String>,
    showing_all: HashSet<String>,
    /// Now, as the sidebar's times count from it (fixed for shots).
    now: Option<f64>,
    focus: FocusHandle,
    _sessions: Option<Follow<ListUpdate>>,
    tasks: Vec<Task<()>>,
    _landing: Subscription,
}

impl Workspace {
    pub fn new(client: BoxClient, live: bool, window: &mut Window, cx: &mut Context<Self>) -> Workspace {
        let landing = cx.new(|cx| Composer::new(client.clone(), Target::New(StartIn::Chat), live, cx));
        let subscription = cx.subscribe_in(&landing, window, |this, _, event: &ComposerEvent, window, cx| this.composer_event(event, window, cx));
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
            collapsed: HashSet::new(),
            showing_all: HashSet::new(),
            now: None,
            focus: cx.focus_handle(),
            _sessions: None,
            tasks: Vec::new(),
            _landing: subscription,
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
            view.update(cx, |view, cx| {
                view.take(update, cx);
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
                // Whether the conversation open waits on you.
                if let Open::Conversation { view, session } = &self.open {
                    let asking = self.listing.facts(session).is_some_and(|facts| facts.asked.is_some());
                    view.update(cx, |view, cx| view.set_asking(asking, cx));
                }
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

    /// Opens a session's conversation.
    pub fn open_session(&mut self, session: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.opened() == Some(session) {
            return;
        }
        let (client, live) = (self.client.clone(), self.live);
        let composer = self.composer_for(session, window, cx);
        let view = cx.new(|cx| ConversationView::new(client, session.to_owned(), composer, live, cx));
        let asking = self.listing.facts(session).is_some_and(|facts| facts.asked.is_some());
        view.update(cx, |view, cx| view.set_asking(asking, cx));
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
        self.open = Open::Landing;
        window.focus(&self.landing.focus_handle(cx), cx);
        cx.notify();
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
        self.landing.update(cx, |composer, cx| composer.set_start(place, cx));
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
                // Opened, unless you've gone to another conversation meanwhile.
                if self.is_landing() {
                    self.open_session(session, window, cx);
                }
            }
        }
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
