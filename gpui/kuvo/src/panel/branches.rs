//! Branches: the folder's repository's branches as its box lists them, the one checked out marked;
//! switching to another, or to a new one. A worktree's session shows its own branch, with Merge
//! into… (where the box says it goes); any branch of its own can go up as a pull request, whose
//! title and description the box drafts and you can change. What each does, and why one can't, is
//! the box's to say.

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::BoxClient;
use kuvo_box::git::{Branches, PullRequest, PullRequestDraft};
use kuvo_ui::{ActiveTheme, Button, ButtonSize, Icon, IconName, IconSize, StyledType, TextField, TextFieldEvent, TypeSize, theme::{radius, space}};

use super::changes::empty;
use super::{Load, Place, run};

/// What the last thing done said.
#[derive(Clone, Debug, PartialEq)]
pub enum Said {
    Done(String),
    Failed(String),
    /// A pull request made, or its page opened: where it is.
    PullRequest { words: String, url: Option<String> },
}

/// A pull request being written: the box's draft, then your title and description.
pub struct Writing {
    pub draft: Load<PullRequestDraft>,
    pub title: Entity<TextField>,
    pub body: Entity<TextField>,
    pub sending: bool,
}

pub struct BranchesView {
    client: BoxClient,
    live: bool,
    place: Option<Place>,
    shown: bool,
    branches: Load<Branches>,
    /// What's on its way: a branch switched to, a merge, a new branch.
    busy: Option<String>,
    said: Option<Said>,
    naming: bool,
    name: Entity<TextField>,
    writing: Option<Writing>,
    focus: FocusHandle,
    _name: Subscription,
}

impl BranchesView {
    pub fn new(client: BoxClient, live: bool, cx: &mut Context<Self>) -> BranchesView {
        let name = cx.new(|cx| TextField::new(cx).placeholder("New branch name"));
        let subscription = cx.subscribe(&name, |this: &mut BranchesView, _, event: &TextFieldEvent, cx| match event {
            TextFieldEvent::Submit(text) => this.create(text.trim().to_owned(), cx),
            TextFieldEvent::Cancel => {
                this.naming = false;
                cx.notify();
            }
            TextFieldEvent::Changed => {}
        });
        BranchesView {
            client,
            live,
            place: None,
            shown: false,
            branches: Load::Loading,
            busy: None,
            said: None,
            naming: false,
            name,
            writing: None,
            focus: cx.focus_handle(),
            _name: subscription,
        }
    }

    pub fn branches(&self) -> &Load<Branches> {
        &self.branches
    }

    pub fn said(&self) -> Option<&Said> {
        self.said.as_ref()
    }

    pub fn name_field(&self) -> &Entity<TextField> {
        &self.name
    }

    pub fn writing(&self) -> Option<&Writing> {
        self.writing.as_ref()
    }

    pub fn set_place(&mut self, place: Option<Place>, shown: bool, cx: &mut Context<Self>) {
        let moved = self.place.as_ref().map(|place| &place.directory) != place.as_ref().map(|place| &place.directory);
        let showing = shown && !self.shown;
        self.place = place;
        self.shown = shown;
        if moved {
            self.branches = Load::Loading;
            self.said = None;
            self.writing = None;
            self.naming = false;
        }
        if (moved || showing) && shown {
            self.read_again(cx);
        }
        cx.notify();
    }

    pub fn read_again(&mut self, cx: &mut Context<Self>) {
        let Some(place) = self.place.clone() else { return };
        let client = self.client.clone();
        let directory = place.directory.clone();
        let asked = directory.clone();
        run(self, self.live, cx, move || client.branches(&asked), move |this, read, cx| {
            if this.place.as_ref().map(|place| &place.directory) != Some(&directory) {
                return;
            }
            this.branches = match read {
                Ok(branches) => Load::Ready(branches),
                Err(error) => Load::Failed(error.to_string()),
            };
            cx.notify();
        });
    }

    /// Switches the folder's repository to `branch`, or (`create`) to a new one of that name.
    fn switch(&mut self, branch: String, create: bool, cx: &mut Context<Self>) {
        let Some(place) = self.place.clone() else { return };
        if branch.is_empty() || self.busy.is_some() {
            return;
        }
        self.busy = Some(branch.clone());
        self.said = None;
        let client = self.client.clone();
        let asked = branch.clone();
        run(self, self.live, cx, move || client.switch_branch(&place.directory, &asked, create), move |this, done, cx| {
            this.busy = None;
            match done {
                Ok(()) => {
                    this.said = Some(Said::Done(if create { format!("On a new branch, {branch}.") } else { format!("Switched to {branch}.") }));
                    if create {
                        this.naming = false;
                        this.name.update(cx, |field, cx| field.set_text("", cx));
                    }
                }
                Err(error) => this.said = Some(Said::Failed(error.to_string())),
            }
            this.read_again(cx);
            cx.notify();
        });
        cx.notify();
    }

    pub fn switch_to(&mut self, branch: &str, cx: &mut Context<Self>) {
        self.switch(branch.to_owned(), false, cx);
    }

    pub fn create(&mut self, name: String, cx: &mut Context<Self>) {
        self.switch(name, true, cx);
    }

    pub fn start_naming(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.naming = true;
        window.focus(&self.name.focus_handle(cx), cx);
        cx.notify();
    }

    /// Merge into…: the worktree's branch, where the box takes it.
    pub fn merge(&mut self, cx: &mut Context<Self>) {
        let Some(place) = self.place.clone() else { return };
        self.busy = Some("merge".into());
        self.said = None;
        let client = self.client.clone();
        run(self, self.live, cx, move || client.merge(&place.directory), move |this, done, cx| {
            this.busy = None;
            this.said = Some(match done {
                Ok(into) => Said::Done(format!("Merged into {into}.")),
                Err(error) => Said::Failed(error.to_string()),
            });
            cx.notify();
        });
        cx.notify();
    }

    /// Create Pull Request…: the box's draft, to read and change before it's made.
    pub fn write_pull_request(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(place) = self.place.clone() else { return };
        let title = cx.new(|cx| TextField::new(cx).placeholder("Title"));
        let body = cx.new(|cx| TextField::new(cx).placeholder("Description (optional)").multi_line(3, 8).submits_on_enter(false));
        window.focus(&title.focus_handle(cx), cx);
        self.writing = Some(Writing { draft: Load::Loading, title, body, sending: false });
        self.said = None;
        let client = self.client.clone();
        run(self, self.live, cx, move || client.pull_request_draft(&place.directory), move |this, draft, cx| {
            let Some(writing) = this.writing.as_mut() else { return };
            match draft {
                Ok(draft) => {
                    writing.title.update(cx, |field, cx| field.set_text(draft.title.clone(), cx));
                    writing.body.update(cx, |field, cx| field.set_text(draft.body.clone(), cx));
                    writing.draft = Load::Ready(draft);
                }
                // Refused as Create would be (the base itself, changes not committed): said instead.
                Err(error) => {
                    this.writing = None;
                    this.said = Some(Said::Failed(error.to_string()));
                }
            }
            cx.notify();
        });
        cx.notify();
    }

    pub fn cancel_pull_request(&mut self, cx: &mut Context<Self>) {
        self.writing = None;
        cx.notify();
    }

    /// Makes the pull request with the title and description written, from the session in view.
    pub fn create_pull_request(&mut self, cx: &mut Context<Self>) {
        let Some(place) = self.place.clone() else { return };
        let Some(writing) = self.writing.as_mut() else { return };
        let title = writing.title.read(cx).text().trim().to_owned();
        let body = writing.body.read(cx).text().trim().to_owned();
        if title.is_empty() || writing.sending {
            return;
        }
        writing.sending = true;
        let client = self.client.clone();
        let live = self.live;
        run(self, live, cx, move || client.create_pull_request(&place.directory, &title, &body, place.session.as_deref()), move |this, made, cx| {
            this.writing = None;
            this.said = Some(match made {
                Ok(PullRequest { url: Some(url), .. }) => Said::PullRequest { words: "Pull request made.".into(), url: Some(url) },
                Ok(PullRequest { compare_url: Some(page), .. }) => {
                    // Its page finishes it: opened, as Create does.
                    if live {
                        cx.open_url(&page);
                    }
                    Said::PullRequest { words: "Pushed. Its page opened to finish it.".into(), url: Some(page) }
                }
                Ok(PullRequest { .. }) => Said::Done("Pushed. Open the pull request where the repository is kept.".into()),
                Err(error) => Said::Failed(error.to_string()),
            });
            cx.notify();
        });
        cx.notify();
    }

    // MARK: Drawing

    /// The branch checked out, and what can be done with it.
    fn current(&self, branches: &Branches, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let current = branches.current.clone();
        let busy = self.busy.as_deref() == Some("merge");
        let worktree = branches.worktree.clone();
        let (title, detail) = match (&worktree, &current) {
            (Some(tree), Some(_)) => ("This session works on its own branch".to_owned(), match &tree.into {
                Some(into) => format!("A worktree of the project. Merge brings what’s committed back into {into}."),
                None => "A worktree of the project.".to_owned(),
            }),
            (_, Some(_)) => ("Checked out here".to_owned(), String::new()),
            (_, None) => ("No branch checked out".to_owned(), "This folder is on a commit, not a branch.".to_owned()),
        };
        let merge_into = worktree.as_ref().map(|tree| match &tree.into {
            Some(into) => format!("Merge into {into}"),
            None => "Merge into the Project’s Branch".to_owned(),
        });
        div()
            .id("branch-current")
            .debug_selector(|| "branch-current".into())
            .flex()
            .flex_col()
            .gap(space::S2)
            .m(space::S3)
            .p(space::S3)
            .rounded(radius::NAV)
            .border_1()
            .border_color(c.border)
            .bg(c.sunken)
            .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(title))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .child(Icon::new(IconName::Branch).size(IconSize::Nav).color(c.text_muted))
                    .child(div().min_w_0().truncate().text_mono(TypeSize::Small).child(current.clone().unwrap_or_else(|| "—".into()))),
            )
            .when(!detail.is_empty(), |d| d.child(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(detail)))
            .when(current.is_some(), |d| {
                d.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap(space::S2)
                        .children(merge_into.map(|label| {
                            Button::new("branch-merge", label).size(ButtonSize::Small).primary().loading(busy).disabled(self.busy.is_some()).on_click(cx.listener(|this, _, _, cx| this.merge(cx)))
                        }))
                        .child(Button::new("branch-pull-request", "Create Pull Request…").size(ButtonSize::Small).disabled(self.busy.is_some()).on_click(cx.listener(|this, _, window, cx| this.write_pull_request(window, cx)))),
                )
            })
            .into_any_element()
    }

    fn said_line(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let c = cx.theme().colors.clone();
        let said = self.said.clone()?;
        let (text, color, url) = match said {
            Said::Done(words) => (words, c.text_muted, None),
            Said::Failed(why) => (why, c.danger, None),
            Said::PullRequest { words, url } => (words, c.text_muted, url),
        };
        Some(
            div()
                .id("branches-said")
                .debug_selector(|| "branches-said".into())
                .flex()
                .flex_col()
                .gap(space::S1)
                .mx(space::S3)
                .px(space::S3)
                .py(space::S2)
                .rounded(radius::NAV)
                .bg(c.sunken)
                .text_ui(TypeSize::Caption)
                .text_color(color)
                .child(text)
                .children(url.map(|url| {
                    let shown = url.clone();
                    div().child(Button::new("branches-open-url", "Open").ghost().size(ButtonSize::Small).icon_after(IconName::External).tooltip(shown).on_click(move |_, _, cx| cx.open_url(&url)))
                }))
                .into_any_element(),
        )
    }

    fn list(&self, branches: &Branches, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let rows: Vec<AnyElement> = branches
            .branches
            .iter()
            .map(|branch| {
                let current = branches.current.as_deref() == Some(branch.as_str());
                let busy = self.busy.as_deref() == Some(branch.as_str());
                let switched = branch.clone();
                let selector = format!("branch-{branch}");
                div()
                    .id(SharedString::from(format!("branch-{branch}")))
                    .debug_selector(move || selector)
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .h(px(28.))
                    .px(space::S2)
                    .rounded(radius::NAV)
                    .when(!current, |d| d.cursor_pointer().hover(move |s| s.bg(c.hover)).on_click(cx.listener(move |this, _, _, cx| this.switch_to(&switched, cx))))
                    .when(busy, |d| d.opacity(0.5))
                    .child(div().w(px(14.)).flex_none().when(current, |d| d.child(Icon::new(IconName::Check).size(IconSize::Nav).color(c.accent))))
                    .child(div().flex_1().min_w_0().truncate().when(current, |d| d.medium()).child(branch.clone()))
                    .when(!current, |d| d.child(div().flex_none().text_ui(TypeSize::Caption).text_color(c.text_faint).child(if busy { "Switching…" } else { "" })))
                    .into_any_element()
            })
            .collect();
        let new_branch: AnyElement = if self.naming {
            div()
                .flex()
                .items_center()
                .gap(space::S2)
                .px(space::S2)
                .py(space::S1)
                .child(div().flex_1().min_w_0().child(self.name.clone()))
                .child(Button::new("branch-create", "Create").size(ButtonSize::Small).primary().on_click(cx.listener(|this, _, _, cx| {
                    let name = this.name.read(cx).text().trim().to_owned();
                    this.create(name, cx);
                })))
                .into_any_element()
        } else {
            div()
                .id("branch-new")
                .debug_selector(|| "branch-new".into())
                .flex()
                .items_center()
                .gap(space::S2)
                .h(px(28.))
                .px(space::S2)
                .rounded(radius::NAV)
                .cursor_pointer()
                .text_color(c.text_muted)
                .hover(move |s| s.bg(c.hover))
                .on_click(cx.listener(|this, _, window, cx| this.start_naming(window, cx)))
                .child(div().w(px(14.)).flex_none().child(Icon::new(IconName::Plus).size(IconSize::Nav).color(c.text_muted)))
                .child("New Branch…")
                .into_any_element()
        };
        div()
            .flex()
            .flex_col()
            .px(space::S2)
            .pb(space::S3)
            .child(div().h(px(28.)).pt(space::S2).px(space::S2).text_ui(TypeSize::Caption).text_color(c.text_faint).child("Branches"))
            .children(rows)
            .child(new_branch)
            .into_any_element()
    }

    /// Create Pull Request's form: what goes where, the title and description, and what Create does.
    fn pull_request(&self, writing: &Writing, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let (route, does) = match &writing.draft {
            Load::Ready(draft) => {
                let route = match &draft.base {
                    Some(base) => format!("{} into {base}", draft.branch),
                    None => draft.branch.clone(),
                };
                let does = match (draft.host.as_str(), draft.creates, draft.gh.as_deref()) {
                    (_, true, _) => "Pushes the branch and makes the pull request on GitHub.",
                    ("github", false, Some("missing")) => "Pushes the branch and opens GitHub to finish it: GitHub’s gh isn’t on that computer.",
                    ("github", false, _) => "Pushes the branch and opens GitHub to finish it: gh isn’t signed in on that computer.",
                    ("gitlab", _, _) => "Pushes the branch and opens GitLab to finish the merge request.",
                    _ => "Pushes the branch: open the pull request where the repository is kept.",
                };
                (route, does)
            }
            _ => ("Reading the branch…".to_owned(), ""),
        };
        let ready = matches!(writing.draft, Load::Ready(_));
        div()
            .id("pull-request")
            .debug_selector(|| "pull-request".into())
            .flex()
            .flex_col()
            .gap(space::S2)
            .m(space::S3)
            .p(space::S3)
            .rounded(radius::NAV)
            .border_1()
            .border_color(c.border)
            .bg(c.elevated)
            .child(div().medium().child("Create Pull Request"))
            .child(div().flex().items_center().gap(space::S1).text_ui(TypeSize::Caption).text_color(c.text_muted).child(Icon::new(IconName::Branch).size(IconSize::Nav).color(c.text_faint)).child(route))
            .child(writing.title.clone())
            .child(writing.body.clone())
            .when(!does.is_empty(), |d| d.child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(does)))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(space::S2)
                    .child(Button::new("pull-request-cancel", "Cancel").size(ButtonSize::Small).on_click(cx.listener(|this, _, _, cx| this.cancel_pull_request(cx))))
                    .child(
                        Button::new("pull-request-create", "Create Pull Request")
                            .size(ButtonSize::Small)
                            .primary()
                            .disabled(!ready || writing.sending)
                            .loading(writing.sending)
                            .on_click(cx.listener(|this, _, _, cx| this.create_pull_request(cx))),
                    ),
            )
            .into_any_element()
    }
}

impl Focusable for BranchesView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for BranchesView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content: AnyElement = match &self.branches {
            Load::Loading => empty("Reading branches…", "", None, cx),
            Load::Failed(why) => empty(
                "Couldn’t Read the Branches",
                why.clone(),
                Some(Button::new("branches-again", "Try Again").size(ButtonSize::Small).on_click(cx.listener(|this, _, _, cx| this.read_again(cx))).into_any_element()),
                cx,
            ),
            Load::Ready(branches) if !branches.repository => empty("Not a Git Repository", "This folder isn’t in one, so it has no branches.", None, cx),
            Load::Ready(branches) => {
                let branches = branches.clone();
                let current = self.current(&branches, cx);
                let said = self.said_line(cx);
                let middle = match &self.writing {
                    Some(writing) => self.pull_request(writing, cx),
                    None => self.list(&branches, cx),
                };
                div().id("branches").flex().flex_col().size_full().overflow_y_scroll().child(current).children(said).child(middle).into_any_element()
            }
        };
        div().key_context("Branches").track_focus(&self.focus).flex().flex_col().size_full().child(content)
    }
}
