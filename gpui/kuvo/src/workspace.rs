//! The window: the title bar across the top; under it the rail, and beside the rail one raised
//! panel holding the open area's sidebar and its main view (OpenBot's layout). In Sessions the main
//! view is the conversation open or, for a new one, the landing view, with the side panel beside it;
//! the other areas' pages aren't in the app yet. In a narrow window the area's sidebar folds away.

use std::collections::{HashMap, HashSet};

use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, MouseButton,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Render, ScrollHandle, SharedString, Styled,
    Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::follow::{Follow, ListUpdate, Timing};
use kuvo_box::models::StartIn;
use kuvo_box::search::{Found, SEARCHED_FROM};
use kuvo_box::sessions::project_name;
use kuvo_box::areas::Waiting;
use kuvo_box::{BoxClient, BoxInfo, Listing, Where};
use kuvo_ui::{ActiveTheme, StyledType, TextField, TextFieldEvent, Theme, TypeSize, theme::radius};

use crate::area::{Area, Back, Forward, OpenHelp, ShowAccounts, ShowBots, ShowComputers, ShowQueue, ShowSessions, ShowSettings, ShowUsage};
use crate::areas::{AreaView, Picked};
use crate::composer::{Composer, ComposerEvent, Target};
use crate::conversation::ConversationView;
use crate::rail::{self, Rings};
use crate::sidebar::{FocusSearch, Line};
use crate::panel::{self, Place, SidePanel, Tab};
use crate::{NewSession, ShowChanges, ShowFiles, ToggleAppearance, TogglePanel, areas, landing, sidebar, time, title_bar};

/// How long typing pauses before the box is asked to search conversations.
const SEARCH_PAUSE: Duration = Duration::from_millis(300);
/// How many conversations a search shows.
const SEARCH_MOST: usize = 20;
/// Narrower than this, the area's sidebar folds away (the rail stays).
pub const NARROW: Pixels = px(820.);
/// How far back the window remembers where it's been.
const HISTORY: usize = 100;

/// Where the window was: a place back and forward go to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Nav {
    Landing,
    Session(String),
    /// Another area, and the row picked in it (none: its own page).
    Area(Area, Option<String>),
}

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
    /// The side panel beside the conversation, whether it's open, its width (kept while it's
    /// closed), and where a drag of its edge started (the pointer's x and the width then).
    panel: Entity<SidePanel>,
    panel_open: bool,
    panel_width: Pixels,
    resizing: Option<(Pixels, Pixels)>,
    /// The area open, the other areas' sidebars (kept while hidden), and the accounts' rings.
    area: Area,
    areas: Vec<(Area, Entity<AreaView>)>,
    rings: Entity<Rings>,
    /// What waits on you in each area, as the box says it; `waiting_said` turns false once a box
    /// says it doesn't say (one from before #711), so it isn't asked again.
    waiting: Option<Waiting>,
    waiting_said: bool,
    waiting_task: Option<Task<()>>,
    /// The list changed while a read of what waits was on its way: read once more after it.
    waiting_again: bool,
    /// The area's sidebar folded away by its button (a wide window), or brought out (a narrow
    /// one, where it starts folded); and whether the window was narrow when last drawn.
    folded: bool,
    shown_narrow: bool,
    narrow: bool,
    /// Where the window has been, and where in that it is now.
    history: Vec<Nav>,
    at: usize,
    _sessions: Option<Follow<ListUpdate>>,
    tasks: Vec<Task<()>>,
    _landing: Subscription,
    _search: Subscription,
    _areas: Vec<Subscription>,
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
        let areas = areas::views(&client, live, cx);
        let area_subscriptions = areas.iter().map(|(_, view)| cx.subscribe(view, |this: &mut Workspace, view, _: &Picked, cx| this.area_picked(&view, cx))).collect();
        let rings = cx.new(|cx| Rings::new(client.clone(), live, cx));
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
            panel: cx.new(|cx| SidePanel::new(client.clone(), live, cx)),
            panel_open: false,
            panel_width: panel::WIDTH,
            resizing: None,
            area: Area::Sessions,
            areas,
            rings,
            waiting: None,
            waiting_said: true,
            waiting_task: None,
            waiting_again: false,
            folded: false,
            shown_narrow: false,
            narrow: false,
            history: vec![Nav::Landing],
            at: 0,
            _sessions: None,
            tasks: Vec::new(),
            _landing: subscription,
            _search: search_subscription,
            _areas: area_subscriptions,
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
        self.rings.update(cx, |rings, cx| rings.read_at_once(cx));
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
            let queue = client.queue(session).unwrap_or_default();
            view.update(cx, |view, cx| {
                view.take(update, cx);
                view.take_asks(asks, cx);
                view.take_queue(queue, cx);
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
                let name = self.box_name();
                for (_, view) in self.areas.clone() {
                    view.update(cx, |view, cx| view.set_this_box(name.clone(), cx));
                }
                // Reached (perhaps updated since): what it says of waits and accounts is asked again.
                self.waiting_said = true;
                if self.live {
                    self.rings.update(cx, |rings, cx| rings.read_again(cx));
                }
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
                // A composer opened before the list knew its conversation's folder (or since it
                // moved): what's offered is read there now.
                let moved: Vec<_> = self
                    .composers
                    .iter()
                    .filter_map(|(session, (composer, _))| {
                        let folder = self.listing.facts(session)?.directory.clone();
                        (composer.read(cx).folder() != Some(folder.as_str())).then(|| (composer.clone(), folder))
                    })
                    .collect();
                for (composer, folder) in moved {
                    composer.update(cx, |composer, cx| composer.set_folder(Some(folder), cx));
                }
                // The panel's folder, as the list says it now (a session opened before the list had
                // it, a worktree's folder said later).
                self.place_panel(cx);
                // What waits on you may have changed with it.
                self.read_waiting(cx);
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
    pub fn set_now(&mut self, now: f64, cx: &mut Context<Self>) {
        self.now = Some(now);
        self.rings.update(cx, |rings, _| rings.set_now(now));
        for (_, view) in self.areas.clone() {
            view.update(cx, |view, cx| view.set_now(now, cx));
        }
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
        self.area = Area::Sessions;
        self.record(Nav::Session(session.to_owned()));
        if self.opened() == Some(session) {
            // Already open (back to it from another area): the keyboard goes back to it.
            if let Some(view) = self.conversation() {
                window.focus(&view.focus_handle(cx), cx);
            }
            cx.notify();
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
        self.place_panel(cx);
        cx.notify();
    }

    /// `session`'s composer: the one it had, with its draft (its model read again, as it may have
    /// changed meanwhile), or a new one.
    fn composer_for(&mut self, session: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<Composer> {
        // Its folder, where its project's own settings may add models to what's offered.
        let folder = self.listing.facts(session).map(|facts| facts.directory.clone());
        if let Some((composer, _)) = self.composers.get(session) {
            let composer = composer.clone();
            if self.live {
                composer.update(cx, |composer, cx| {
                    if !composer.set_folder(folder, cx) {
                        composer.read_models(cx);
                    }
                });
            }
            return composer;
        }
        let (client, live) = (self.client.clone(), self.live);
        let composer = cx.new(|cx| Composer::in_folder(client, Target::Session { id: session.to_owned(), place: Where::Engine }, folder, live, cx));
        let subscription = cx.subscribe_in(&composer, window, |this, _, event: &ComposerEvent, window, cx| this.composer_event(event, window, cx));
        // Not on screen until its conversation opens.
        composer.update(cx, |composer, cx| composer.set_shown(false, cx));
        self.composers.insert(session.to_owned(), (composer.clone(), subscription));
        composer
    }

    /// The landing view, for a new conversation in `project` (or the one picked last).
    pub fn new_session(&mut self, project: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.area = Area::Sessions;
        self.record(Nav::Landing);
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
        self.place_panel(cx);
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
        self.place_panel(cx);
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

    // MARK: The side panel

    pub fn panel(&self) -> &Entity<SidePanel> {
        &self.panel
    }

    pub fn is_panel_open(&self) -> bool {
        self.panel_open
    }

    pub fn panel_width(&self) -> Pixels {
        self.panel_width
    }

    /// Opens or closes the side panel; its width stays as it was.
    pub fn toggle_panel(&mut self, cx: &mut Context<Self>) {
        self.panel_open = !self.panel_open;
        let open = self.panel_open;
        self.place_panel(cx);
        self.panel.update(cx, |panel, cx| panel.set_shown(open, cx));
        cx.notify();
    }

    /// Opens the side panel on `tab`.
    pub fn show_panel(&mut self, tab: Tab, cx: &mut Context<Self>) {
        self.panel.update(cx, |panel, cx| panel.show(tab, cx));
        if !self.panel_open {
            self.toggle_panel(cx);
        }
    }

    /// The folder the panel shows: the open session's (its worktree's, for one in a worktree), or on
    /// the landing view the project a new one starts in.
    fn place_panel(&mut self, cx: &mut Context<Self>) {
        let place = match self.opened() {
            Some(session) => self.listing.facts(session).filter(|facts| !facts.kind.is_chat()).map(|facts| Place { directory: facts.directory.clone(), session: Some(session.to_owned()) }),
            None => match self.landing_place() {
                StartIn::Project(directory) => Some(Place { directory, session: None }),
                _ => None,
            },
        };
        self.panel.update(cx, |panel, cx| panel.set_place(place, cx));
    }

    /// A drag of the panel's edge started at `x`.
    pub fn start_resize(&mut self, x: Pixels, cx: &mut Context<Self>) {
        self.resizing = Some((x, self.panel_width));
        cx.notify();
    }

    /// The panel's edge dragged to `x` in a window `wide`: wider as it goes left, within its
    /// bounds, never leaving the conversation narrower than its narrowest.
    pub fn resize_to(&mut self, x: Pixels, wide: Pixels, cx: &mut Context<Self>) {
        let Some((from, width)) = self.resizing else { return };
        self.panel_width = (width + (from - x)).clamp(panel::NARROWEST, self.widest_panel(wide));
        cx.notify();
    }

    pub fn end_resize(&mut self, cx: &mut Context<Self>) {
        if self.resizing.take().is_some() {
            cx.notify();
        }
    }

    /// Its width as it first opened.
    pub fn reset_panel_width(&mut self, cx: &mut Context<Self>) {
        self.panel_width = panel::WIDTH;
        cx.notify();
    }

    /// The side panel, in the raised panel beside the conversation, with its edge to drag.
    fn panel_card(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        // In a window narrower than it was made for, the panel gives way before the conversation
        // does; its width is kept for a wider one.
        let width = self.panel_width.min(self.widest_panel(window.viewport_size().width));
        let resizing = self.resizing.is_some();
        div()
            .relative()
            .flex()
            .flex_none()
            .h_full()
            .border_l_1()
            .border_color(c.border)
            .child(div().w(width).h_full().flex().flex_col().overflow_hidden().child(self.panel.clone()))
            .child(
                // The edge to drag: wider than it looks, over the line between the two.
                div()
                    .id("panel-edge")
                    .debug_selector(|| "panel-edge".into())
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px(-5.))
                    .w(px(8.))
                    .flex()
                    .justify_center()
                    .cursor_col_resize()
                    .on_mouse_down(MouseButton::Left, cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                        if event.click_count >= 2 {
                            this.reset_panel_width(cx);
                        } else {
                            this.start_resize(event.position.x, cx);
                        }
                    }))
                    .child(div().w(px(2.)).h_full().when(resizing, |d| d.bg(c.accent)).hover(|s| s.bg(c.border_strong))),
            )
            .into_any_element()
    }

    // MARK: Search and walking the sidebar

    pub fn search(&self) -> &Entity<TextField> {
        &self.search
    }

    /// Whether nothing's typed in the search (cheaply, as the sidebar's rows ask while drawn).
    pub fn search_is_empty(&self) -> bool {
        self.finds_for.is_empty()
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
        if self.area != Area::Sessions {
            self.show_area(Area::Sessions, window, cx);
        }
        self.bring_out_sidebar(window);
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
            // From the search: the first found, once something's searched for.
            None if !self.search_text(cx).trim().is_empty() => lines.iter().find(|line| line.walkable()),
            None => None,
        };
        match line.cloned() {
            Some(Line::Project(directory)) => {
                self.walked = Some(Line::Project(directory.clone()).key());
                self.toggle_project(&directory, cx);
            }
            Some(Line::More(directory)) => self.toggle_all(&directory, cx),
            Some(Line::Session { id, .. }) | Some(Line::Found { id, .. }) | Some(Line::Needs { id, .. }) => {
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

    // MARK: The rail and its areas

    pub fn area(&self) -> Area {
        self.area
    }

    pub fn rings(&self) -> &Entity<Rings> {
        &self.rings
    }

    /// What waits on you in each area, once the box says it.
    pub fn waiting(&self) -> Option<&Waiting> {
        self.waiting.as_ref()
    }

    /// An area's sidebar view (none for Sessions, which the workspace draws itself).
    pub fn area_view(&self, area: Area) -> Option<&Entity<AreaView>> {
        self.areas.iter().find(|(of, _)| *of == area).map(|(_, view)| view)
    }

    /// Whether the area's sidebar shows now: in a wide window unless folded by its button, in a
    /// narrow one only once brought out.
    pub fn sidebar_shown(&self) -> bool {
        if self.narrow { self.shown_narrow } else { !self.folded }
    }

    pub fn is_narrow(&self) -> bool {
        self.narrow
    }

    /// Opens `area`, its sidebar shown; Sessions comes back to the conversation (or landing view)
    /// it showed.
    pub fn show_area(&mut self, area: Area, window: &mut Window, cx: &mut Context<Self>) {
        self.area = area;
        self.bring_out_sidebar(window);
        match area {
            Area::Sessions => {
                let nav = self.opened().map_or(Nav::Landing, |session| Nav::Session(session.to_owned()));
                self.record(nav);
                match self.conversation() {
                    Some(view) => window.focus(&view.focus_handle(cx), cx),
                    None => window.focus(&self.landing.focus_handle(cx), cx),
                }
            }
            _ => {
                if let Some(view) = self.area_view(area).cloned() {
                    let picked = view.read(cx).selected().map(str::to_owned);
                    self.record(Nav::Area(area, picked));
                    view.update(cx, |view, cx| view.shown(cx));
                }
                // The keyboard stays in the window, where the areas' keys are.
                window.focus(&self.focus, cx);
            }
        }
        cx.notify();
    }

    /// Shows the area's sidebar: unfolded in a wide window, brought out in a narrow one (where it
    /// folds again once the window changes width class).
    fn bring_out_sidebar(&mut self, window: &Window) {
        self.narrow = window.viewport_size().width < NARROW;
        if self.narrow {
            self.shown_narrow = true;
        } else {
            self.folded = false;
        }
    }

    /// A press on an area's rail button: the area open folds its sidebar away (or brings it back);
    /// another opens.
    pub fn rail_pressed(&mut self, area: Area, window: &mut Window, cx: &mut Context<Self>) {
        if area != self.area {
            self.show_area(area, window, cx);
            return;
        }
        // (The window as it is now, should it have changed since it was last drawn.)
        self.narrow = window.viewport_size().width < NARROW;
        if self.narrow {
            self.shown_narrow = !self.shown_narrow;
        } else {
            self.folded = !self.folded;
        }
        // Folded with the keyboard in it (its search, its list): the keyboard goes to the main view.
        if !self.sidebar_shown() && (self.search.focus_handle(cx).is_focused(window) || self.list_focus.is_focused(window)) {
            self.walked = None;
            match self.conversation() {
                Some(view) if self.area == Area::Sessions => window.focus(&view.focus_handle(cx), cx),
                None if self.area == Area::Sessions => window.focus(&self.landing.focus_handle(cx), cx),
                _ => window.focus(&self.focus, cx),
            }
        }
        cx.notify();
    }

    /// Settings, on `section`.
    pub fn show_setting(&mut self, section: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(view) = self.area_view(Area::Settings).cloned() {
            view.update(cx, |view, cx| view.select(Some(section.to_owned()), cx));
        }
        self.show_area(Area::Settings, window, cx);
    }

    fn area_picked(&mut self, view: &Entity<AreaView>, cx: &mut Context<Self>) {
        let (area, picked) = view.read_with(cx, |view, _| (view.area(), view.selected().map(str::to_owned)));
        self.record(Nav::Area(area, picked));
        cx.notify();
    }

    /// Asks the box what waits on you (unless it's said it doesn't say).
    fn read_waiting(&mut self, cx: &mut Context<Self>) {
        if !self.waiting_said {
            return;
        }
        let client = self.client.clone();
        if !self.live {
            let read = client.waiting();
            self.take_waiting(read, cx);
            return;
        }
        // One read at a time: changes meanwhile make one more once it's back.
        if self.waiting_task.is_some() {
            self.waiting_again = true;
            return;
        }
        self.waiting_task = Some(cx.spawn(async move |this, cx| {
            let read = cx.background_executor().spawn(async move { client.waiting() }).await;
            this.update(cx, |this, cx| {
                this.waiting_task = None;
                this.take_waiting(read, cx);
                if std::mem::take(&mut this.waiting_again) {
                    this.read_waiting(cx);
                }
            })
            .ok();
        }));
    }

    fn take_waiting(&mut self, read: kuvo_box::Result<Option<Waiting>>, cx: &mut Context<Self>) {
        match read {
            Ok(Some(waiting)) => self.waiting = Some(waiting),
            Ok(None) => {
                self.waiting = None;
                self.waiting_said = false;
            }
            // Couldn't be read now: what was said stands until it can.
            Err(_) => {}
        }
        cx.notify();
    }

    // MARK: Back and forward

    /// Notes going to `nav`, unless that's where the window is (or it's going back or forward).
    fn record(&mut self, nav: Nav) {
        if self.history.get(self.at) == Some(&nav) {
            return;
        }
        self.history.truncate(self.at + 1);
        self.history.push(nav);
        if self.history.len() > HISTORY {
            self.history.remove(0);
        }
        self.at = self.history.len() - 1;
    }

    pub fn can_go_back(&self) -> bool {
        self.at > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.at + 1 < self.history.len()
    }

    pub fn go_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.can_go_back() {
            self.go(self.at - 1, window, cx);
        }
    }

    pub fn go_forward(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.can_go_forward() {
            self.go(self.at + 1, window, cx);
        }
    }

    /// Goes to the place noted at `at` without noting it again. A session gone from the list
    /// since is passed over, as a way back to nothing.
    fn go(&mut self, at: usize, window: &mut Window, cx: &mut Context<Self>) {
        // Sessions gone from the list since are dropped from the history (and the places that
        // then repeat), so the press goes on to the next place there still is.
        let forward = at > self.at;
        let here = self.history[self.at].clone();
        // (Gone: deleted, or no longer shown, as an archived one.)
        let gone = |nav: &Nav, this: &Self| matches!(nav, Nav::Session(session) if this.listing.is_read() && kuvo_box::sessions::place(this.listing.facts(session)).is_none() && !this.started.contains_key(session));
        let mut kept: Vec<Nav> = Vec::with_capacity(self.history.len());
        let mut target = None;
        let mut current = 0;
        for (ix, nav) in self.history.iter().enumerate() {
            if ix != self.at && gone(nav, self) {
                continue;
            }
            if kept.last() == Some(nav) {
                if ix == self.at {
                    current = kept.len() - 1;
                }
                continue;
            }
            if ix == self.at {
                current = kept.len();
            }
            if ix == at {
                target = Some(kept.len());
            }
            kept.push(nav.clone());
        }
        self.history = kept;
        self.at = current;
        let at = match target {
            Some(at) if at != current => at,
            // The place asked for went: the next one on that side, if any.
            _ if forward && current + 1 < self.history.len() => current + 1,
            _ if !forward && current > 0 => current - 1,
            _ => {
                cx.notify();
                return;
            }
        };
        debug_assert!(self.history[current] == here);
        let nav = self.history[at].clone();
        let history = std::mem::take(&mut self.history);
        match &nav {
            Nav::Landing => self.new_session(None, window, cx),
            Nav::Session(session) => self.open_session(session, window, cx),
            Nav::Area(area, picked) => {
                if let Some(view) = self.area_view(*area).cloned() {
                    view.update(cx, |view, cx| view.select(picked.clone(), cx));
                }
                self.show_area(*area, window, cx);
            }
        }
        self.history = history;
        self.at = at;
        cx.notify();
    }

    /// The main view's title and what's beside it, as the title bar shows them: a conversation's
    /// title and its project, or the page an area shows.
    pub fn title(&self, cx: &App) -> (Option<SharedString>, Option<SharedString>) {
        if self.area != Area::Sessions {
            let Some(view) = self.area_view(self.area) else { return (None, None) };
            let title = view.read(cx).title();
            let area = self.area.name();
            let beside = (title.as_ref() != area).then(|| SharedString::from(area));
            return (Some(title), beside);
        }
        match self.opened() {
            Some(session) => {
                let facts = self.listing.facts(session);
                let title = facts.and_then(|facts| facts.title.clone()).filter(|title| !title.trim().is_empty()).unwrap_or_else(|| "New Session".into());
                // (One started here, before the list has it: the project its box said.)
                let project = facts.and_then(|facts| facts.project.clone()).or_else(|| self.started.get(session).cloned().flatten()).map(|project| self.project_name(&project));
                (Some(title.into()), project.map(SharedString::from))
            }
            None => (None, None),
        }
    }

    /// How wide the area's sidebar and the rail are now, together.
    fn sidebars_width(&self) -> Pixels {
        rail::WIDTH + if self.sidebar_shown() { px(sidebar::WIDTH) } else { px(0.) }
    }

    /// The widest the side panel goes in a window `wide`: never leaving the conversation narrower
    /// than its narrowest (the rail, the area's sidebar and the panel's edge apart).
    fn widest_panel(&self, wide: Pixels) -> Pixels {
        let room = wide - self.sidebars_width() - panel::CONVERSATION_NARROWEST - px(8.);
        panel::WIDEST.min(room).max(panel::NARROWEST)
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
        // A narrow window folds the area's sidebar away; brought out there, it folds again once
        // the window has been wide and narrows again.
        let narrow = window.viewport_size().width < NARROW;
        if self.narrow != narrow {
            self.shown_narrow = false;
        }
        self.narrow = narrow;

        let sessions = self.area == Area::Sessions;
        let content: AnyElement = match (&self.open, self.area_view(self.area)) {
            (_, Some(view)) if !sessions => match view.read(cx).settings() {
                Some(settings) => settings.clone().into_any_element(),
                None => areas::placeholder(self.area, view.read(cx).title(), cx),
            },
            (Open::Conversation { view, .. }, _) => view.clone().into_any_element(),
            _ => landing::render(self, window, cx),
        };
        let sidebar: Option<AnyElement> = self.sidebar_shown().then(|| match self.area_view(self.area) {
            Some(view) if !sessions => view.clone().into_any_element(),
            _ => sidebar::render(self, window, cx),
        });
        let panel = (sessions && self.panel_open).then(|| self.panel_card(window, cx));
        div()
            .key_context("Workspace")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &NewSession, window, cx| this.new_session(None, window, cx)))
            .on_action(cx.listener(|this, _: &FocusSearch, window, cx| this.focus_search(window, cx)))
            .on_action(cx.listener(|this, _: &TogglePanel, window, cx| {
                if this.area != Area::Sessions {
                    this.show_area(Area::Sessions, window, cx);
                }
                this.toggle_panel(cx);
            }))
            .on_action(cx.listener(|this, _: &ShowChanges, window, cx| {
                if this.area != Area::Sessions {
                    this.show_area(Area::Sessions, window, cx);
                }
                this.show_panel(Tab::Changes, cx);
            }))
            .on_action(cx.listener(|this, _: &ShowFiles, window, cx| {
                if this.area != Area::Sessions {
                    this.show_area(Area::Sessions, window, cx);
                }
                this.show_panel(Tab::Files, cx);
            }))
            .on_action(cx.listener(|this, _: &ShowSessions, window, cx| this.show_area(Area::Sessions, window, cx)))
            .on_action(cx.listener(|this, _: &ShowBots, window, cx| this.show_area(Area::Bots, window, cx)))
            .on_action(cx.listener(|this, _: &ShowQueue, window, cx| this.show_area(Area::Queue, window, cx)))
            .on_action(cx.listener(|this, _: &ShowComputers, window, cx| this.show_area(Area::Computers, window, cx)))
            .on_action(cx.listener(|this, _: &ShowSettings, window, cx| this.show_area(Area::Settings, window, cx)))
            .on_action(cx.listener(|this, _: &ShowUsage, window, cx| this.show_setting("Usage", window, cx)))
            .on_action(cx.listener(|this, _: &ShowAccounts, window, cx| this.show_setting("Accounts", window, cx)))
            .on_action(cx.listener(|this, _: &Back, window, cx| this.go_back(window, cx)))
            .on_action(cx.listener(|this, _: &Forward, window, cx| this.go_forward(window, cx)))
            .on_action(|_: &OpenHelp, _, cx| cx.open_url(crate::area::HELP))
            // A drag of the panel's edge, wherever the pointer goes meanwhile.
            .when(self.resizing.is_some(), |d| {
                d.cursor_col_resize()
                    .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        // Let go outside the window: the drag ends as the pointer comes back.
                        if event.pressed_button != Some(MouseButton::Left) {
                            this.end_resize(cx);
                        } else {
                            this.resize_to(event.position.x, window.viewport_size().width, cx);
                        }
                    }))
                    .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, cx| this.end_resize(cx)))
            })
            .on_action(cx.listener(|_, _: &ToggleAppearance, _, cx| {
                let next = cx.theme().appearance.toggled();
                Theme::set_appearance(next, cx);
            }))
            .flex()
            .flex_col()
            .size_full()
            .bg(c.background)
            .text_ui(TypeSize::Small)
            .text_color(c.text)
            .child(title_bar::render(self, cx))
            .child(
                div().flex_1().min_h_0().flex().child(rail::render(self, cx)).child(
                    // The area's sidebar and its main view share one raised panel, its corner
                    // rounded against the rail.
                    div()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .flex()
                        .bg(c.surface)
                        .rounded_tl(radius::CARD)
                        .border_t_1()
                        .border_l_1()
                        .border_color(c.border)
                        .overflow_hidden()
                        .children(sidebar.map(|sidebar| {
                            div().id("area-sidebar").debug_selector(|| "area-sidebar".into()).w(px(sidebar::WIDTH)).h_full().flex_none().bg(c.sidebar).border_r_1().border_color(c.border).child(sidebar)
                        }))
                        .child(div().relative().flex_1().min_w_0().h_full().child(content))
                        .children(panel),
                ),
            )
    }
}
