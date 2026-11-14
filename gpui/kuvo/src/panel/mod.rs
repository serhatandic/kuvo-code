//! The side panel beside the conversation: the session's folder's Changes, Files and Branches, as
//! its box says them. It opens and closes (⌘⌥0, or the button at the conversation's top right),
//! keeps its width while it's closed and as conversations change, and is resized by its edge.
//!
//! Each view reads its folder's facts from the box and changes them through its routes; nothing
//! here decides what git does.

pub mod branches;
pub mod changes;
pub mod files;

use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, ParentElement, Pixels, Render, Styled,
    Window, div, px,
};
use kuvo_box::BoxClient;
use kuvo_ui::{ActiveTheme, Button, ButtonSize, StyledType, TypeSize, theme::space};

pub use branches::BranchesView;
pub use changes::ChangesView;
pub use files::FilesView;

/// The panel's width when it first opens, and the narrowest and widest it's dragged to.
pub const WIDTH: Pixels = px(380.);
pub const NARROWEST: Pixels = px(280.);
pub const WIDEST: Pixels = px(720.);
/// The conversation's narrowest beside it: dragging the panel wider stops there.
pub const CONVERSATION_NARROWEST: Pixels = px(360.);

/// The panel's views.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tab {
    Changes,
    Files,
    Branches,
}

impl Tab {
    pub const ALL: [Tab; 3] = [Tab::Changes, Tab::Files, Tab::Branches];

    pub fn title(self) -> &'static str {
        match self {
            Tab::Changes => "Changes",
            Tab::Files => "Files",
            Tab::Branches => "Branches",
        }
    }
}

/// The folder the panel shows: the session's own (a worktree's, for a session in one), and the
/// session in view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub directory: String,
    pub session: Option<String>,
}

/// What a view has of the box: on its way, read, or why it couldn't be.
#[derive(Clone, Debug, PartialEq)]
pub enum Load<T> {
    Loading,
    Ready(T),
    Failed(String),
}

impl<T> Load<T> {
    pub fn ready(&self) -> Option<&T> {
        match self {
            Load::Ready(value) => Some(value),
            _ => None,
        }
    }
}

/// Runs `work` (a request to the box) off the window's thread in the app, or at once (tests and
/// shots, against the stand-in, so nothing waits on a clock), and hands what it gave to `then`.
pub(crate) fn run<V: 'static, T: Send + 'static>(
    view: &mut V,
    live: bool,
    cx: &mut Context<V>,
    work: impl FnOnce() -> T + Send + 'static,
    then: impl FnOnce(&mut V, T, &mut Context<V>) + 'static,
) {
    if live {
        let task = cx.background_executor().spawn(async move { work() });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| then(this, result, cx)).ok();
        })
        .detach();
    } else {
        let result = work();
        then(view, result, cx);
    }
}

pub struct SidePanel {
    tab: Tab,
    place: Option<Place>,
    shown: bool,
    changes: Entity<ChangesView>,
    files: Entity<FilesView>,
    branches: Entity<BranchesView>,
    focus: FocusHandle,
}

impl SidePanel {
    pub fn new(client: BoxClient, live: bool, cx: &mut Context<Self>) -> SidePanel {
        SidePanel {
            tab: Tab::Changes,
            place: None,
            shown: false,
            changes: cx.new(|cx| ChangesView::new(client.clone(), live, cx)),
            files: cx.new(|cx| FilesView::new(client.clone(), live, cx)),
            branches: cx.new(|cx| BranchesView::new(client, live, cx)),
            focus: cx.focus_handle(),
        }
    }

    pub fn tab(&self) -> Tab {
        self.tab
    }

    pub fn place(&self) -> Option<&Place> {
        self.place.as_ref()
    }

    pub fn changes(&self) -> &Entity<ChangesView> {
        &self.changes
    }

    pub fn files(&self) -> &Entity<FilesView> {
        &self.files
    }

    pub fn branches(&self) -> &Entity<BranchesView> {
        &self.branches
    }

    /// Shows `tab`.
    pub fn show(&mut self, tab: Tab, cx: &mut Context<Self>) {
        self.tab = tab;
        self.tell(cx);
        cx.notify();
    }

    /// The folder it shows from now on (none: no conversation open, or one with no folder).
    pub fn set_place(&mut self, place: Option<Place>, cx: &mut Context<Self>) {
        if self.place == place {
            return;
        }
        self.place = place;
        self.tell(cx);
        cx.notify();
    }

    /// Whether it's on screen: what's hidden asks the box nothing.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        self.shown = shown;
        self.tell(cx);
        cx.notify();
    }

    /// Hands each view the folder, and whether it's the one on screen.
    fn tell(&mut self, cx: &mut Context<Self>) {
        let (place, shown, tab) = (self.place.clone(), self.shown, self.tab);
        self.changes.update(cx, |view, cx| view.set_place(place.clone(), shown && tab == Tab::Changes, cx));
        self.files.update(cx, |view, cx| view.set_place(place.clone(), shown && tab == Tab::Files, cx));
        self.branches.update(cx, |view, cx| view.set_place(place.clone(), shown && tab == Tab::Branches, cx));
    }

    fn tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let c = &cx.theme().colors;
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(space::S1)
            .h(px(44.))
            .px(space::S3)
            .border_b_1()
            .border_color(c.border)
            .children(Tab::ALL.map(|tab| {
                Button::new(format!("panel-tab-{}", tab.title()), tab.title())
                    .ghost()
                    .size(ButtonSize::Small)
                    .selected(self.tab == tab)
                    .on_click(cx.listener(move |this, _, _, cx| this.show(tab, cx)))
            }))
    }
}

impl Focusable for SidePanel {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for SidePanel {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = cx.theme().colors.clone();
        let body = match (&self.place, self.tab) {
            (None, _) => div()
                .flex()
                .flex_col()
                .flex_1()
                .items_center()
                .justify_center()
                .gap(space::S1)
                .px(space::S5)
                .text_center()
                .child(div().text_ui(TypeSize::Small).medium().text_color(c.text_muted).child("No folder to show"))
                .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child("Open a project’s session to see its changes, files and branches."))
                .into_any_element(),
            (Some(_), Tab::Changes) => self.changes.clone().into_any_element(),
            (Some(_), Tab::Files) => self.files.clone().into_any_element(),
            (Some(_), Tab::Branches) => self.branches.clone().into_any_element(),
        };
        div()
            .id("side-panel")
            .debug_selector(|| "side-panel".into())
            .key_context("SidePanel")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .text_ui(TypeSize::Small)
            .text_color(c.text)
            .child(self.tabs(cx))
            .child(div().flex().flex_col().flex_1().min_h_0().child(body))
    }
}
