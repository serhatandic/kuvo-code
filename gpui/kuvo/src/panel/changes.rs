//! Changes: the folder's changed files as the box groups them (conflicts, staged, unstaged, new),
//! followed live; each opens to its diff. Stage, unstage and discard (with a confirm) send back what
//! the box listed; a commit takes what's staged, or everything when nothing is, as the box says.

use std::collections::HashSet;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyBinding, ParentElement,
    Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Task, Window, actions, div, prelude::FluentBuilder as _, px,
    uniform_list,
};
use kuvo_box::follow::{Follow, Followed, Timing};
use kuvo_box::git::{ChangedFile, Committed, FileDiff, GitFiles, Group};
use kuvo_box::BoxClient;
use kuvo_ui::output::{DiffLine, DiffView, parse_patch};
use kuvo_ui::small::Checkbox;
use kuvo_ui::{ActiveTheme, Button, ButtonSize, Icon, IconName, IconSize, StyledType, TextField, TextFieldEvent, TypeSize, theme::{radius, space}};

use super::{Load, Place, run};

actions!(changes, [Commit, Back]);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("cmd-enter", Commit, Some("Changes")), KeyBinding::new("escape", Back, Some("Changes"))]);
}

/// A file opened to its diff.
pub struct Opened {
    pub file: ChangedFile,
    pub diff: Load<Rc<Vec<DiffLine>>>,
    /// Too big to show, or binary: said instead of its lines.
    pub unshown: Option<&'static str>,
    /// The unchanged stretches opened, by where they start.
    pub expanded: Rc<HashSet<usize>>,
}

/// What the last commit said, when it didn't simply go.
#[derive(Clone, Debug, PartialEq)]
pub enum CommitSaid {
    Failed(String),
    /// It landed, but its push didn't: Push is offered, never the commit again.
    NotPushed(String),
    Pushed,
}

pub struct ChangesView {
    client: BoxClient,
    live: bool,
    place: Option<Place>,
    shown: bool,
    files: Load<GitFiles>,
    /// The list's rows, worked out as the files change (a header for each group, then its files).
    lines: Rc<Vec<Line>>,
    /// Reading again failed after a first read: what was read stays, with this.
    stale: Option<String>,
    opened: Option<Opened>,
    /// The file whose discard waits for its confirm.
    confirming: Option<ChangedFile>,
    /// Files with an action on its way, by their keys.
    busy: HashSet<String>,
    /// What the box said of the last action that didn't go.
    failed: Option<String>,
    message: Entity<TextField>,
    push: bool,
    committing: bool,
    said: Option<CommitSaid>,
    focus: FocusHandle,
    _follow: Option<Follow<Followed<GitFiles>>>,
    _follow_task: Option<Task<()>>,
    _message: Subscription,
}

impl ChangesView {
    pub fn new(client: BoxClient, live: bool, cx: &mut Context<Self>) -> ChangesView {
        let message = cx.new(|cx| TextField::new(cx).placeholder("Commit message").multi_line(1, 5).submits_on_enter(false));
        let subscription = cx.subscribe(&message, |this: &mut ChangesView, _, event: &TextFieldEvent, cx| {
            if matches!(event, TextFieldEvent::Changed) {
                if matches!(this.said, Some(CommitSaid::Failed(_))) {
                    this.said = None;
                }
                cx.notify();
            }
        });
        ChangesView {
            client,
            live,
            place: None,
            shown: false,
            files: Load::Loading,
            lines: Rc::default(),
            stale: None,
            opened: None,
            confirming: None,
            busy: HashSet::new(),
            failed: None,
            message,
            push: false,
            committing: false,
            said: None,
            focus: cx.focus_handle(),
            _follow: None,
            _follow_task: None,
            _message: subscription,
        }
    }

    pub fn files(&self) -> &Load<GitFiles> {
        &self.files
    }

    pub fn opened(&self) -> Option<&Opened> {
        self.opened.as_ref()
    }

    pub fn message(&self) -> &Entity<TextField> {
        &self.message
    }

    pub fn said(&self) -> Option<&CommitSaid> {
        self.said.as_ref()
    }

    pub fn failed(&self) -> Option<&str> {
        self.failed.as_deref()
    }

    /// The folder, and whether the view is on screen: followed while it is, let go when it isn't.
    pub fn set_place(&mut self, place: Option<Place>, shown: bool, cx: &mut Context<Self>) {
        let moved = self.place.as_ref().map(|place| &place.directory) != place.as_ref().map(|place| &place.directory);
        if moved {
            self.files = Load::Loading;
            self.lines = Rc::default();
            self.opened = None;
            self.confirming = None;
            self.failed = None;
            self.said = None;
            self.busy.clear();
        }
        let again = moved || shown != self.shown;
        self.place = place;
        self.shown = shown;
        if again {
            self.follow(cx);
        }
        cx.notify();
    }

    /// Follows the folder's files while on screen (the app), or reads them once (tests and shots).
    fn follow(&mut self, cx: &mut Context<Self>) {
        self._follow = None;
        self._follow_task = None;
        let Some(place) = self.place.clone().filter(|_| self.shown) else { return };
        if !self.live {
            self.read_again(cx);
            return;
        }
        let follow = self.client.follow_git_files(&place.directory, Timing::default());
        let updates = follow.updates().clone();
        self._follow = Some(follow);
        self._follow_task = Some(cx.spawn(async move |this, cx| {
            while let Ok(update) = updates.recv().await {
                let taken = this.update(cx, |this, cx| match update {
                    Followed::Now(files) => this.take(Ok(files), cx),
                    Followed::Failed(error) => this.take(Err(error), cx),
                });
                if taken.is_err() {
                    break;
                }
            }
        }));
    }

    /// Reads the folder's files again now (after an action, so it shows at once).
    pub fn read_again(&mut self, cx: &mut Context<Self>) {
        let Some(place) = self.place.clone() else { return };
        let client = self.client.clone();
        let directory = place.directory.clone();
        let asked = directory.clone();
        run(self, self.live, cx, move || client.git_files(&asked), move |this, read, cx| {
            if this.place.as_ref().map(|place| &place.directory) == Some(&directory) {
                this.take(read, cx);
            }
        });
    }

    /// What the box said of the folder's files.
    pub fn take(&mut self, read: kuvo_box::Result<GitFiles>, cx: &mut Context<Self>) {
        match read {
            Ok(files) => {
                let changed = self.files.ready() != Some(&files);
                // The file open, as the list has it now: the same row, else the same file in another
                // group (staged, unstaged); read again as the list changes (an agent's edit), its
                // lines kept meanwhile. Gone from the list (committed, discarded): back to it.
                if let Some(opened) = &self.opened {
                    let same = files
                        .files
                        .iter()
                        .find(|file| file.key() == opened.file.key())
                        .or_else(|| files.files.iter().find(|file| file.path == opened.file.path))
                        .cloned();
                    match same {
                        Some(file) if changed => self.reload(file, cx),
                        Some(_) => {}
                        None => self.opened = None,
                    }
                }
                if changed {
                    self.lines = Rc::new(lines_of(&files));
                }
                // A discard waiting for its confirm is for the file as it was shown: changed or gone
                // since, it's put away (the box would refuse it too).
                if let Some(confirming) = &self.confirming
                    && !files.files.contains(confirming)
                {
                    self.confirming = None;
                }
                self.files = Load::Ready(files);
                self.stale = None;
            }
            Err(error) => match self.files {
                Load::Ready(_) => self.stale = Some(error.to_string()),
                _ => self.files = Load::Failed(error.to_string()),
            },
        }
        cx.notify();
    }

    fn root(&self) -> Option<String> {
        self.files.ready().and_then(|files| files.root.clone())
    }

    /// Opens `file` to its diff, as the box sends it.
    pub fn open(&mut self, file: ChangedFile, cx: &mut Context<Self>) {
        self.confirming = None;
        self.opened = Some(Opened { file: file.clone(), diff: Load::Loading, unshown: None, expanded: Rc::default() });
        self.reload(file, cx);
        cx.notify();
    }

    /// Reads the open file's diff again, as the box lists it now: what showed stays until it's in,
    /// and the stretches opened stay open.
    fn reload(&mut self, file: ChangedFile, cx: &mut Context<Self>) {
        let Some(root) = self.root().or_else(|| self.files.ready().and_then(|files| files.root.clone())) else { return };
        if let Some(opened) = self.opened.as_mut() {
            opened.file = file.clone();
        }
        let client = self.client.clone();
        let key = file.key();
        run(self, self.live, cx, move || client.file_diff(&root, &file), move |this, diff, cx| {
            let Some(opened) = this.opened.as_mut().filter(|opened| opened.file.key() == key) else { return };
            match diff {
                Ok(FileDiff { big: true, .. }) => {
                    opened.diff = Load::Ready(Rc::default());
                    opened.unshown = Some("Too big to show here.");
                }
                Ok(FileDiff { patch, .. }) => {
                    opened.unshown = None;
                    let lines = parse_patch(&patch);
                    opened.unshown = (lines.is_empty() && patch.lines().any(|line| line.starts_with("Binary files "))).then_some("A binary file: no lines to show.");
                    opened.diff = Load::Ready(Rc::new(lines));
                }
                Err(error) => opened.diff = Load::Failed(error.to_string()),
            }
            cx.notify();
        });
    }

    pub fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.opened = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Opens an unchanged stretch of the file shown.
    pub fn expand(&mut self, start: usize, cx: &mut Context<Self>) {
        if let Some(opened) = self.opened.as_mut() {
            let mut expanded = (*opened.expanded).clone();
            expanded.insert(start);
            opened.expanded = Rc::new(expanded);
            cx.notify();
        }
    }

    /// Stages, unstages or discards `file`, as the box listed it, then reads the list again.
    pub fn act(&mut self, action: Action, file: ChangedFile, cx: &mut Context<Self>) {
        let Some(root) = self.root() else { return };
        if action == Action::Discard {
            self.confirming = None;
        }
        let key = file.key();
        self.busy.insert(key.clone());
        self.failed = None;
        let client = self.client.clone();
        run(self, self.live, cx, move || match action {
            Action::Stage => client.stage(&root, &file),
            Action::Unstage => client.unstage(&root, &file),
            Action::Discard => client.discard(&root, &file),
        }, move |this, done, cx| {
            this.busy.remove(&key);
            if let Err(error) = done {
                this.failed = Some(error.to_string());
            }
            this.read_again(cx);
            cx.notify();
        });
        cx.notify();
    }

    /// Asks before discarding `file`.
    pub fn confirm_discard(&mut self, file: ChangedFile, cx: &mut Context<Self>) {
        self.confirming = Some(file);
        cx.notify();
    }

    pub fn cancel_discard(&mut self, cx: &mut Context<Self>) {
        self.confirming = None;
        cx.notify();
    }

    pub fn set_push(&mut self, push: bool, cx: &mut Context<Self>) {
        self.push = push;
        cx.notify();
    }

    /// Commits with the message written (and pushes, when asked), on the folder's box.
    pub fn commit(&mut self, cx: &mut Context<Self>) {
        let message = self.message.read(cx).text().trim().to_owned();
        let Some(place) = self.place.clone() else { return };
        if message.is_empty() || self.committing || !self.has_changes() {
            return;
        }
        self.committing = true;
        self.said = None;
        let (client, push) = (self.client.clone(), self.push);
        run(self, self.live, cx, move || client.commit(&place.directory, &message, push), move |this, done, cx| {
            this.committing = false;
            match done {
                Ok(Committed::Done) => {
                    this.message.update(cx, |field, cx| field.set_text("", cx));
                    this.said = None;
                }
                Ok(Committed::NotPushed(why)) => {
                    this.message.update(cx, |field, cx| field.set_text("", cx));
                    this.said = Some(CommitSaid::NotPushed(why));
                }
                Err(error) => this.said = Some(CommitSaid::Failed(error.to_string())),
            }
            this.read_again(cx);
            cx.notify();
        });
        cx.notify();
    }

    /// Pushes what's committed, after a commit whose push didn't go through.
    pub fn push(&mut self, cx: &mut Context<Self>) {
        let Some(place) = self.place.clone() else { return };
        self.committing = true;
        let client = self.client.clone();
        run(self, self.live, cx, move || client.push(&place.directory), move |this, done, cx| {
            this.committing = false;
            this.said = Some(match done {
                Ok(()) => CommitSaid::Pushed,
                Err(error) => CommitSaid::NotPushed(error.to_string()),
            });
            cx.notify();
        });
        cx.notify();
    }

    fn has_changes(&self) -> bool {
        self.files.ready().is_some_and(|files| !files.files.is_empty())
    }

    // MARK: Drawing

    fn header(&self, files: &GitFiles, cx: &App) -> AnyElement {
        let c = &cx.theme().colors;
        let (added, removed) = files.files.iter().fold((0, 0), |(a, r), file| (a + file.additions.unwrap_or(0), r + file.deletions.unwrap_or(0)));
        div()
            .flex()
            .flex_none()
            .items_center()
            .gap(space::S2)
            .h(px(36.))
            .px(space::S4)
            .text_ui(TypeSize::Caption)
            .child(Icon::new(IconName::Branch).size(IconSize::Nav).color(c.text_muted))
            .child(div().min_w_0().truncate().text_color(c.text_muted).child(files.branch.clone().unwrap_or_else(|| "No branch".into())))
            .child(div().flex_1())
            .when(added + removed > 0, |d| {
                d.child(div().flex().flex_none().gap(space::S1).child(div().text_color(c.diff_added).child(format!("+{added}"))).child(div().text_color(c.diff_removed).child(format!("−{removed}"))))
            })
            .into_any_element()
    }

    fn row(&self, file: &ChangedFile, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let key = file.key();
        let group: SharedString = format!("change-{key}").into();
        let busy = self.busy.contains(&key);
        let (letter, color) = mark(file, &c);
        let lines = match (file.additions, file.deletions) {
            (Some(added), Some(removed)) if added + removed > 0 => Some(
                div()
                    .flex()
                    .flex_none()
                    .gap(space::S1)
                    .text_ui(TypeSize::Caption)
                    .when(added > 0, |d| d.child(div().text_color(c.diff_added).child(format!("+{added}"))))
                    .when(removed > 0, |d| d.child(div().text_color(c.diff_removed).child(format!("−{removed}")))),
            ),
            _ => None,
        };
        let actions = self.actions(file, cx);
        let open = file.clone();
        let selector = format!("change-{key}");
        div()
            .id(SharedString::from(format!("change-{key}")))
            .debug_selector(move || selector)
            .group(group.clone())
            .flex()
            .w_full()
            .items_center()
            .gap(space::S2)
            .h(px(28.))
            .px(space::S2)
            .rounded(radius::NAV)
            .cursor_pointer()
            .hover(move |s| s.bg(c.hover))
            .when(busy, |d| d.opacity(0.5))
            .on_click(cx.listener(move |this, _, window, cx| {
                // The keyboard comes along, so Escape goes back.
                window.focus(&this.focus, cx);
                this.open(open.clone(), cx);
            }))
            .child(div().w(px(14.)).flex_none().text_center().text_mono(TypeSize::Caption).text_color(color).child(letter))
            .child(div().flex_none().max_w(px(220.)).truncate().text_color(c.text).when(file.status == "deleted", |d| d.line_through()).child(file.name().to_owned()))
            .child(div().flex_1().min_w_0().truncate().text_ui(TypeSize::Caption).text_color(c.text_faint).child(file.folder().to_owned()))
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_end()
                    .min_w(px(52.))
                    .h_full()
                    .children(lines.map(|lines| div().flex().items_center().group_hover(group.clone(), |s| s.opacity(0.)).child(lines)))
                    .child(div().absolute().top_0().bottom_0().right_0().flex().items_center().gap(space::S0_5).opacity(0.).group_hover(group, |s| s.opacity(1.)).children(actions)),
            )
            .into_any_element()
    }

    /// A file's actions, as its group takes them: stage what isn't staged, unstage what is, mark a
    /// conflict resolved; discard any but a conflict.
    fn actions(&self, file: &ChangedFile, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let key = file.key();
        let mut actions = Vec::new();
        if file.discard.is_some() {
            let discard = file.clone();
            actions.push(
                Button::icon_only(SharedString::from(format!("discard-{key}")), IconName::Undo, "Discard Changes")
                    .ghost()
                    .size(ButtonSize::Small)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.confirm_discard(discard.clone(), cx);
                    }))
                    .into_any_element(),
            );
        }
        let (action, icon, label) = match file.group {
            Group::Staged => (Action::Unstage, IconName::Minus, "Unstage"),
            Group::Conflicted => (Action::Stage, IconName::Check, "Mark as Resolved"),
            _ => (Action::Stage, IconName::Plus, "Stage"),
        };
        let acted = file.clone();
        actions.push(
            Button::icon_only(SharedString::from(format!("{}-{key}", action.word())), icon, label)
                .ghost()
                .size(ButtonSize::Small)
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.act(action, acted.clone(), cx);
                }))
                .into_any_element(),
        );
        actions
    }

    /// One of the list's rows: a group's header, or a file.
    fn line(&self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let file = match self.lines.get(ix) {
            Some(Line::Header(group, count)) => {
                let title = match group {
                    Group::Conflicted => "Conflicts",
                    Group::Staged => "Staged",
                    Group::Unstaged => "Unstaged",
                    Group::Untracked => "New Files",
                };
                return div()
                    .flex()
                    .items_end()
                    .gap(space::S1)
                    .h(px(28.))
                    .pb(space::S1)
                    .px(space::S2)
                    .text_ui(TypeSize::Caption)
                    .text_color(if *group == Group::Conflicted { c.warning } else { c.text_faint })
                    .child(title)
                    .child(div().text_color(c.text_faint).child(count.to_string()))
                    .into_any_element();
            }
            Some(Line::More(more)) => {
                let said = if *more == 1 { "and 1 more new file".to_owned() } else { format!("and {more} more new files") };
                return div().flex().items_center().h(px(28.)).pl(space::S2 + px(22.)).text_ui(TypeSize::Caption).text_color(c.text_faint).child(said).into_any_element();
            }
            Some(Line::File(at)) => self.files.ready().and_then(|files| files.files.get(*at)).cloned(),
            None => None,
        };
        match file {
            Some(file) => self.row(&file, cx),
            None => div().h(px(28.)).into_any_element(),
        }
    }

    fn list(&self, cx: &mut Context<Self>) -> AnyElement {
        uniform_list("changes-list", self.lines.len(), cx.processor(|this, range: std::ops::Range<usize>, _, cx| range.map(|ix| this.line(ix, cx)).collect::<Vec<_>>()))
            .flex_1()
            .min_h_0()
            .px(space::S2)
            .pb(space::S3)
            .into_any_element()
    }

    /// The commit's place at the foot: the message, what it takes, Push, and Commit.
    fn foot(&self, files: &GitFiles, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        if let Some(file) = &self.confirming {
            return self.confirm(file, cx);
        }
        let takes = commit_takes(files);
        let written = !self.message.read(cx).text().trim().is_empty();
        let said = self.said.clone().map(|said| {
            let (text, color, push) = match said {
                CommitSaid::Failed(why) => (why, c.danger, false),
                CommitSaid::NotPushed(why) => (why, c.warning, true),
                CommitSaid::Pushed => ("Pushed.".to_owned(), c.text_muted, false),
            };
            div()
                .id("commit-said")
                .debug_selector(|| "commit-said".into())
                .flex()
                .flex_col()
                .gap(space::S1)
                .max_h(px(120.))
                .overflow_y_scroll()
                .text_ui(TypeSize::Caption)
                .text_color(color)
                .child(text)
                .when(push, |d| {
                    d.child(div().child(Button::new("push-again", "Push").size(ButtonSize::Small).loading(self.committing).on_click(cx.listener(|this, _, _, cx| this.push(cx)))))
                })
        });
        let push = self.push;
        div()
            .flex()
            .flex_col()
            .flex_none()
            .gap(space::S2)
            .p(space::S3)
            .border_t_1()
            .border_color(c.border)
            .child(self.message.clone())
            .children(said)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .child(div().flex_1().min_w_0().truncate().text_ui(TypeSize::Caption).text_color(c.text_faint).child(takes))
                    .child({
                        let this = cx.entity().downgrade();
                        Checkbox::new("commit-push", push).label("Push").on_change(move |on, _, cx| {
                            this.update(cx, |this, cx| this.set_push(on, cx)).ok();
                        })
                    })
                    .child(
                        Button::new("commit", if push { "Commit and Push" } else { "Commit" })
                            .primary()
                            .size(ButtonSize::Small)
                            .disabled(!written || self.committing)
                            .loading(self.committing)
                            .tooltip("⌘↩")
                            .on_click(cx.listener(|this, _, _, cx| this.commit(cx))),
                    ),
            )
            .into_any_element()
    }

    /// The discard's confirm, in the foot's place.
    fn confirm(&self, file: &ChangedFile, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let name = file.name().to_owned();
        // Worded by what the box says the discard does.
        let (title, detail, button) = match (file.discard.as_deref(), file.repository, file.status.as_str()) {
            (Some("trash"), true, _) => (format!("Move the repository {name} to the Trash?"), "It’s a repository of its own: its commits go with it, pushed or not.".to_owned(), "Move to Trash"),
            (Some("trash"), false, _) => (format!("Move {name} to the Trash?"), "It’s a new file, so git keeps nothing of it.".to_owned(), "Move to Trash"),
            (_, _, "deleted") => (format!("Restore {name}?"), "It comes back as it was last staged or committed.".to_owned(), "Restore"),
            (Some("head"), _, _) => (format!("Discard every change to {name}?"), "It goes back to the last commit, what’s staged too. This can’t be undone.".to_owned(), "Discard"),
            _ => (format!("Discard the changes to {name}?"), "What isn’t staged is thrown away. This can’t be undone.".to_owned(), "Discard"),
        };
        let file = file.clone();
        div()
            .id("discard-confirm")
            .debug_selector(|| "discard-confirm".into())
            .flex()
            .flex_col()
            .flex_none()
            .gap(space::S2)
            .p(space::S4)
            .border_t_1()
            .border_color(c.border)
            .bg(c.elevated)
            .child(div().flex().items_center().gap(space::S2).child(Icon::new(IconName::Warning).size(IconSize::Nav).color(c.warning)).child(div().medium().child(title)))
            .child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(detail))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(space::S2)
                    .child(Button::new("discard-cancel", "Cancel").size(ButtonSize::Small).on_click(cx.listener(|this, _, _, cx| this.cancel_discard(cx))))
                    .child(Button::new("discard-confirmed", button).destructive().size(ButtonSize::Small).on_click(cx.listener(move |this, _, _, cx| this.act(Action::Discard, file.clone(), cx)))),
            )
            .into_any_element()
    }

    /// A file opened to its diff, with its actions.
    fn file_page(&self, opened: &Opened, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let file = &opened.file;
        let group = match file.group {
            Group::Conflicted => "In conflict",
            Group::Staged => "Staged",
            Group::Unstaged => "Unstaged",
            Group::Untracked => "New file",
        };
        let actions = self.actions(file, cx);
        let body: AnyElement = match &opened.diff {
            Load::Loading => note("Reading its changes…", &c).into_any_element(),
            Load::Failed(why) => note(format!("Its changes couldn’t be read: {why}"), &c).into_any_element(),
            Load::Ready(_) if opened.unshown.is_some() => note(opened.unshown.unwrap_or_default(), &c).into_any_element(),
            Load::Ready(lines) if lines.is_empty() => note("Nothing to show.", &c).into_any_element(),
            Load::Ready(lines) => {
                let this = cx.entity().downgrade();
                DiffView::new("file-diff", lines.clone())
                    .folding(opened.expanded.clone(), move |start, _, cx| {
                        this.update(cx, |this, cx| this.expand(start, cx)).ok();
                    })
                    .into_any_element()
            }
        };
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(space::S1)
                    .h(px(40.))
                    .pl(space::S2)
                    .pr(space::S3)
                    .border_b_1()
                    .border_color(c.border)
                    .child(Button::icon_only("changes-back", IconName::ChevronLeft, "Back to Changes").ghost().size(ButtonSize::Small).on_click(cx.listener(|this, _, window, cx| this.back(window, cx))))
                    .child(div().flex().flex_col().flex_1().min_w_0().child(div().truncate().medium().child(file.name().to_owned())).child(
                        div().truncate().text_ui(TypeSize::Caption).text_color(c.text_faint).child(match &file.old_path {
                            Some(old) => format!("{group} · from {old}"),
                            None if file.folder().is_empty() => group.to_owned(),
                            None => format!("{group} · {}", file.folder()),
                        }),
                    ))
                    .children(actions),
            )
            .child(div().id("file-diff-scroll").flex_1().min_h_0().overflow_y_scroll().p(space::S3).child(body))
            .into_any_element()
    }
}

/// What a commit takes, as the box says it (`commits`, `stagedElsewhere`), counted: staged files
/// outside this folder too.
pub fn commit_takes(files: &GitFiles) -> String {
    if files.commits_staged() {
        let here = files.files.iter().filter(|file| file.group == Group::Staged).count();
        match (here, files.staged_elsewhere) {
            (1, 0) => "Commits the staged file.".to_owned(),
            (here, 0) => format!("Commits the {here} staged files."),
            (0, 1) => "Commits the file staged outside this folder.".to_owned(),
            (0, elsewhere) => format!("Commits the {elsewhere} files staged outside this folder."),
            (here, elsewhere) => format!("Commits the {} staged files, {elsewhere} of them outside this folder.", here + elsewhere),
        }
    } else {
        // (New files past the most the box lists go too.)
        match files.files.iter().map(|file| file.path.as_str()).collect::<HashSet<_>>().len() + files.more {
            1 => "Commits the one changed file.".to_owned(),
            all => format!("Commits all {all} changed files."),
        }
    }
}

/// A row of the list.
#[derive(Clone, Debug, PartialEq)]
pub enum Line {
    /// A group's header, with how many it has.
    Header(Group, usize),
    /// A file, by where it is in the box's list.
    File(usize),
    /// New files past the most the box lists, counted.
    More(usize),
}

/// The list's rows: each group's header, then its files, in the box's order.
fn lines_of(files: &GitFiles) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut at = 0;
    while at < files.files.len() {
        let group = files.files[at].group;
        let count = files.files[at..].iter().take_while(|file| file.group == group).count();
        lines.push(Line::Header(group, count));
        lines.extend((at..at + count).map(Line::File));
        at += count;
    }
    if files.more > 0 {
        lines.push(Line::More(files.more));
    }
    lines
}

/// What can be done to a file from its row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Stage,
    Unstage,
    Discard,
}

impl Action {
    fn word(self) -> &'static str {
        match self {
            Action::Stage => "stage",
            Action::Unstage => "unstage",
            Action::Discard => "discard",
        }
    }
}

/// A file's mark: what happened to it, as a letter in its colour.
fn mark(file: &ChangedFile, c: &kuvo_ui::theme::Colors) -> (&'static str, gpui::Hsla) {
    if file.group == Group::Conflicted {
        return ("!", c.warning);
    }
    match file.status.as_str() {
        "added" => ("A", c.diff_added),
        "deleted" => ("D", c.diff_removed),
        "renamed" => ("R", c.accent),
        _ => ("M", c.text_muted),
    }
}

/// A quiet line in a view's place.
fn note(text: impl Into<SharedString>, c: &kuvo_ui::theme::Colors) -> impl IntoElement {
    div().p(space::S4).text_ui(TypeSize::Small).text_color(c.text_faint).child(text.into())
}

/// A view's whole room saying something: a title and a line under it, and an action.
pub(crate) fn empty(title: impl Into<SharedString>, detail: impl Into<SharedString>, action: Option<AnyElement>, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .flex_col()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(space::S1)
        .px(space::S5)
        .text_center()
        .child(div().text_ui(TypeSize::Small).medium().text_color(c.text_muted).child(title.into()))
        .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(detail.into()))
        .children(action.map(|action| div().pt(space::S2).child(action)))
        .into_any_element()
}

impl Focusable for ChangesView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ChangesView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = cx.theme().colors.clone();
        let content: AnyElement = if let Some(opened) = &self.opened {
            self.file_page(opened, cx)
        } else {
            match &self.files {
                Load::Loading => empty("Reading changes…", "", None, cx),
                Load::Failed(why) => empty(
                    "Couldn’t Read the Changes",
                    why.clone(),
                    Some(Button::new("changes-again", "Try Again").size(ButtonSize::Small).on_click(cx.listener(|this, _, _, cx| this.read_again(cx))).into_any_element()),
                    cx,
                ),
                Load::Ready(files) if !files.repository => empty("Not a Git Repository", "This folder isn’t in one, so there are no changes to show.", None, cx),
                Load::Ready(files) => {
                    let files = files.clone();
                    let failed = self.failed.clone().or_else(|| self.stale.clone().map(|why| format!("The list couldn’t be read again: {why}")));
                    let body = if files.files.is_empty() {
                        empty("No Changes", "Everything in this folder is committed.", None, cx)
                    } else {
                        self.list(cx)
                    };
                    div()
                        .flex()
                        .flex_col()
                        .size_full()
                        .child(self.header(&files, cx))
                        .children(files.underway.as_deref().map(|underway| {
                            let said = match underway {
                                "rebasing" => "A rebase is under way here: finish it, or stop it, in a terminal.",
                                "cherry-picking" => "A cherry-pick is under way here: finish it, or stop it, in a terminal.",
                                "reverting" => "A revert is under way here: finish it, or stop it, in a terminal.",
                                _ => "A merge is under way here: resolve its conflicts, then commit.",
                            };
                            div()
                                .id("changes-underway")
                                .debug_selector(|| "changes-underway".into())
                                .flex()
                                .items_center()
                                .gap(space::S2)
                                .mx(space::S3)
                                .mb(space::S1)
                                .px(space::S3)
                                .py(space::S2)
                                .rounded(radius::NAV)
                                .bg(c.sunken)
                                .text_ui(TypeSize::Caption)
                                .text_color(c.text_muted)
                                .child(Icon::new(IconName::Warning).size(IconSize::Nav).color(c.warning))
                                .child(said)
                        }))
                        .children(failed.map(|why| {
                            div().id("changes-failed").debug_selector(|| "changes-failed".into()).mx(space::S3).mb(space::S1).px(space::S3).py(space::S2).rounded(radius::NAV).bg(c.sunken).text_ui(TypeSize::Caption).text_color(c.danger).child(why)
                        }))
                        .child(body)
                        .when(!files.files.is_empty() || self.said.is_some(), |d| d.child(self.foot(&files, cx)))
                        .into_any_element()
                }
            }
        };
        div()
            .key_context("Changes")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &Commit, _, cx| this.commit(cx)))
            .on_action(cx.listener(|this, _: &Back, window, cx| {
                if this.confirming.take().is_some() {
                    cx.notify();
                } else if this.opened.is_some() {
                    this.back(window, cx);
                } else {
                    cx.propagate();
                }
            }))
            .flex()
            .flex_col()
            .size_full()
            .child(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(json: &str) -> GitFiles {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_commit_is_said_to_take_what_the_box_says_staged_files_elsewhere_counted() {
        let file = |group: &str| format!(r#"{{"path":"app/{group}.ts","group":"{group}","status":"modified","scope":"unstaged"}}"#);
        // Only the folder's own file changed, another folder's staged: it takes that one.
        let elsewhere = listed(&format!(r#"{{"repository":true,"commits":"staged","stagedElsewhere":1,"files":[{}]}}"#, file("unstaged")));
        assert_eq!(commit_takes(&elsewhere), "Commits the file staged outside this folder.");
        let both = listed(&format!(r#"{{"repository":true,"commits":"staged","stagedElsewhere":2,"files":[{}]}}"#, file("staged")));
        assert_eq!(commit_takes(&both), "Commits the 3 staged files, 2 of them outside this folder.");
        let here = listed(&format!(r#"{{"repository":true,"commits":"staged","stagedElsewhere":0,"files":[{}]}}"#, file("staged")));
        assert_eq!(commit_takes(&here), "Commits the staged file.");
        let all = listed(&format!(r#"{{"repository":true,"commits":"all","stagedElsewhere":0,"more":4,"files":[{}]}}"#, file("unstaged")));
        assert_eq!(commit_takes(&all), "Commits all 5 changed files.");
    }
}
