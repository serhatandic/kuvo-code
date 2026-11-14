//! Files: the session's folder as its box lists it, one folder at a time as each opens (`kuvo/folders`
//! with `files=1`), folders first; a folder the box can't read says why, with Try Again. A file opens
//! read-only, highlighted as the conversation's code blocks are.

use std::collections::{HashMap, HashSet};

use gpui::{
    AnyElement, App, Context, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyBinding, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Window, actions, div, prelude::FluentBuilder as _, px, uniform_list,
};
use kuvo_box::BoxClient;
use kuvo_box::folders::{Folder, Unreadable};
use kuvo_ui::code_block::CodeBlock;
use kuvo_ui::{ActiveTheme, Button, ButtonSize, Icon, IconName, IconSize, StyledType, TypeSize, theme::{radius, space}};

use super::changes::empty;
use super::{Load, Place, run};

actions!(files, [CloseFile]);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", CloseFile, Some("Files"))]);
}

/// The most lines a file shows: past it, the rest is counted.
pub const LINES_MOST: usize = 3_000;

/// What a folder's read gave.
#[derive(Clone, Debug, PartialEq)]
pub enum Read {
    Loading,
    Listed(Folder),
    Unreadable(Unreadable),
    Failed(String),
}

/// A file opened to read.
#[derive(Clone, Debug, PartialEq)]
pub enum Shown {
    Text { text: String, lines: usize },
    /// Not text (a picture, a binary), or too big: said instead.
    Unshown(String),
}

/// One line of the tree.
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Folder { path: String, name: String, depth: usize, open: bool },
    File { path: String, name: String, depth: usize },
    /// An open folder's state in its files' place: reading, why it can't be read, or empty.
    Note { folder: String, depth: usize, read: Read },
}

pub struct FilesView {
    client: BoxClient,
    live: bool,
    place: Option<Place>,
    shown: bool,
    folders: HashMap<String, Read>,
    open: HashSet<String>,
    opened: Option<(String, Load<Shown>)>,
    /// The tree's rows, worked out as folders are read, opened or closed (not on each frame).
    rows: std::rc::Rc<Vec<Row>>,
    focus: FocusHandle,
}

impl FilesView {
    pub fn new(client: BoxClient, live: bool, cx: &mut Context<Self>) -> FilesView {
        FilesView { client, live, place: None, shown: false, folders: HashMap::new(), open: HashSet::new(), opened: None, rows: Default::default(), focus: cx.focus_handle() }
    }

    pub fn opened(&self) -> Option<&(String, Load<Shown>)> {
        self.opened.as_ref()
    }

    pub fn set_place(&mut self, place: Option<Place>, shown: bool, cx: &mut Context<Self>) {
        let moved = self.place.as_ref().map(|place| &place.directory) != place.as_ref().map(|place| &place.directory);
        let showing = shown && !self.shown;
        self.place = place;
        self.shown = shown;
        if moved {
            self.folders.clear();
            self.open.clear();
            self.opened = None;
            self.rebuild();
        }
        // As it shows (again): its open folders read again, so what the agent made since is there.
        if (moved || showing) && shown {
            self.reload(cx);
        }
        cx.notify();
    }

    /// Reads the top folder, and each open one, again.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let Some(place) = self.place.clone() else { return };
        let mut folders: Vec<String> = self.open.iter().cloned().collect();
        folders.sort();
        for folder in std::iter::once(place.directory).chain(folders) {
            self.read(folder, cx);
        }
    }

    fn read(&mut self, folder: String, cx: &mut Context<Self>) {
        // What showed stays while it's read again.
        self.folders.entry(folder.clone()).or_insert(Read::Loading);
        self.rebuild();
        let client = self.client.clone();
        let asked = folder.clone();
        run(self, self.live, cx, move || client.folder(&asked), move |this, read, cx| {
            let read = match read {
                Ok(listed) => Read::Listed(listed),
                Err(Ok(unreadable)) => Read::Unreadable(unreadable),
                Err(Err(error)) => Read::Failed(error.to_string()),
            };
            this.folders.insert(folder, read);
            this.rebuild();
            cx.notify();
        });
    }

    /// Opens or closes a folder; opened the first time, it's read.
    pub fn toggle(&mut self, folder: &str, cx: &mut Context<Self>) {
        if !self.open.remove(folder) {
            self.open.insert(folder.to_owned());
            if !matches!(self.folders.get(folder), Some(Read::Listed(_))) {
                self.read(folder.to_owned(), cx);
            }
        }
        self.rebuild();
        cx.notify();
    }

    /// Reads a folder that couldn't be read again.
    pub fn retry(&mut self, folder: &str, cx: &mut Context<Self>) {
        self.folders.insert(folder.to_owned(), Read::Loading);
        self.read(folder.to_owned(), cx);
        cx.notify();
    }

    /// Opens a file to read, as its box sends it.
    pub fn open_file(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.opened = Some((path.to_owned(), Load::Loading));
        window.focus(&self.focus, cx);
        let client = self.client.clone();
        let asked = path.to_owned();
        let path = path.to_owned();
        run(self, self.live, cx, move || client.read_file(&asked), move |this, read, cx| {
            if this.opened.as_ref().map(|(at, _)| at) != Some(&path) {
                return;
            }
            let shown = match read {
                Ok(bytes) => Load::Ready(shown(bytes)),
                Err(error) if error.status() == Some(413) => Load::Ready(Shown::Unshown("Too big to show here.".into())),
                Err(error) => Load::Failed(error.to_string()),
            };
            this.opened = Some((path, shown));
            cx.notify();
        });
        cx.notify();
    }

    pub fn close_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.opened = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// The tree as rows: each open folder's folders, then its files, under it.
    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    fn rebuild(&mut self) {
        let mut rows = Vec::new();
        if let Some(place) = &self.place {
            self.walk(&place.directory, 0, &mut rows);
        }
        self.rows = std::rc::Rc::new(rows);
    }

    fn walk(&self, folder: &str, depth: usize, rows: &mut Vec<Row>) {
        match self.folders.get(folder) {
            Some(Read::Listed(listed)) => {
                if listed.folders.is_empty() && listed.files.is_empty() {
                    rows.push(Row::Note { folder: folder.to_owned(), depth, read: Read::Listed(listed.clone()) });
                }
                for named in &listed.folders {
                    let path = join(folder, &named.name);
                    let open = self.open.contains(&path);
                    rows.push(Row::Folder { path: path.clone(), name: named.name.clone(), depth, open });
                    if open {
                        self.walk(&path, depth + 1, rows);
                    }
                }
                for name in &listed.files {
                    rows.push(Row::File { path: join(folder, name), name: name.clone(), depth });
                }
            }
            Some(read) => rows.push(Row::Note { folder: folder.to_owned(), depth, read: read.clone() }),
            None => rows.push(Row::Note { folder: folder.to_owned(), depth, read: Read::Loading }),
        }
    }

    fn row(&self, row: &Row, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let indent = |depth: usize| space::S2 + px(14. * depth as f32);
        let line = |id: String| {
            let selector = id.clone();
            div()
                .id(SharedString::from(id))
                .debug_selector(move || selector)
                .flex()
                .w_full()
                .items_center()
                .gap(space::S1_5)
                .h(px(26.))
                .pr(space::S2)
                .rounded(radius::NAV)
        };
        match row {
            Row::Folder { path, name, depth, open } => {
                let toggled = path.clone();
                line(format!("tree-{path}"))
                    .pl(indent(*depth))
                    .cursor_pointer()
                    .hover(move |s| s.bg(c.hover))
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle(&toggled, cx)))
                    .child(Icon::new(if *open { IconName::ChevronDown } else { IconName::ChevronRight }).size(IconSize::Nav).color(c.text_faint))
                    .child(Icon::new(IconName::Folder).size(IconSize::Nav).color(c.text_muted))
                    .child(div().min_w_0().truncate().child(name.clone()))
                    .into_any_element()
            }
            Row::File { path, name, depth } => {
                let opened = path.clone();
                let selected = self.opened.as_ref().is_some_and(|(at, _)| at == path);
                line(format!("tree-{path}"))
                    .pl(indent(*depth) + px(18.))
                    .cursor_pointer()
                    .when(selected, |d| d.bg(c.selected))
                    .hover(move |s| s.bg(c.hover))
                    .on_click(cx.listener(move |this, _, window, cx| this.open_file(&opened, window, cx)))
                    .child(Icon::new(IconName::File).size(IconSize::Nav).color(c.text_faint))
                    .child(div().min_w_0().truncate().child(name.clone()))
                    .into_any_element()
            }
            Row::Note { folder, depth, read } => {
                let note = |text: String| line(format!("note-{folder}")).pl(indent(*depth) + px(18.)).text_ui(TypeSize::Caption).text_color(c.text_faint).child(text);
                match read {
                    Read::Loading => note("Reading…".into()).into_any_element(),
                    Read::Listed(_) => note("Empty".into()).into_any_element(),
                    Read::Unreadable(Unreadable { reason, message }) => self.unreadable(folder, *depth, reason.clone().unwrap_or_else(|| message.clone()), cx),
                    Read::Failed(why) => self.unreadable(folder, *depth, why.clone(), cx),
                }
            }
        }
    }

    /// An open folder the box couldn't read, in its files' place: why, as the computer says it, and
    /// Try Again, so it never looks empty (one line, as every row of the tree is; the whole reason
    /// on hover).
    fn unreadable(&self, folder: &str, depth: usize, why: String, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let again = folder.to_owned();
        let selector = format!("unreadable-{folder}");
        div()
            .id(SharedString::from(format!("unreadable-{folder}")))
            .debug_selector(move || selector)
            .flex()
            .w_full()
            .items_center()
            .gap(space::S1_5)
            .h(px(26.))
            .pl(space::S2 + px(14. * depth as f32) + px(18.))
            .pr(space::S1)
            .text_ui(TypeSize::Caption)
            .tooltip({
                let said: SharedString = format!("Couldn’t read this folder: {why}").into();
                move |_, cx| kuvo_ui::menu::Tooltip::new(said.clone()).build(cx)
            })
            .child(Icon::new(IconName::Warning).size(IconSize::Nav).color(c.text_faint))
            .child(div().flex_1().min_w_0().truncate().text_color(c.text_muted).child(format!("Couldn’t read it: {why}")))
            .child(Button::new(SharedString::from(format!("retry-{folder}")), "Try Again").ghost().size(ButtonSize::Small).on_click(cx.listener(move |this, _, _, cx| this.retry(&again, cx))))
            .into_any_element()
    }

    fn viewer(&self, path: &str, shown: &Load<Shown>, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let place = self.place.as_ref().map(|place| place.directory.clone()).unwrap_or_default();
        let relative = path.strip_prefix(&format!("{place}/")).unwrap_or(path).to_owned();
        let name = relative.rsplit('/').next().unwrap_or(&relative).to_owned();
        let folder = relative.rsplit_once('/').map(|(folder, _)| folder.to_owned()).unwrap_or_default();
        let body: AnyElement = match shown {
            Load::Loading => div().p(space::S4).text_color(c.text_faint).child("Reading…").into_any_element(),
            Load::Failed(why) => div().p(space::S4).text_color(c.text_faint).child(format!("It couldn’t be read: {why}")).into_any_element(),
            Load::Ready(Shown::Unshown(why)) => div().p(space::S4).text_color(c.text_faint).child(why.clone()).into_any_element(),
            Load::Ready(Shown::Text { text, lines }) => {
                let cut = text.split_inclusive('\n').take(LINES_MOST).collect::<String>();
                let language = name.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase()).unwrap_or_default();
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S2)
                    .child(CodeBlock::new("file-code", cut).language(language).line_numbers(true))
                    .when(*lines > LINES_MOST, |d| d.child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(format!("The first {LINES_MOST} of {lines} lines."))))
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
                    .child(Button::icon_only("files-back", IconName::ChevronLeft, "Back to Files").ghost().size(ButtonSize::Small).on_click(cx.listener(|this, _, window, cx| this.close_file(window, cx))))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .child(div().truncate().medium().child(name))
                            .child(div().truncate().text_ui(TypeSize::Caption).text_color(c.text_faint).child(if folder.is_empty() { "Read only".to_owned() } else { format!("{folder} · Read only") })),
                    ),
            )
            .child(div().id("file-scroll").debug_selector(|| "file-viewer".into()).flex_1().min_h_0().overflow_y_scroll().p(space::S3).child(body))
            .into_any_element()
    }
}

/// `folder/name`.
fn join(folder: &str, name: &str) -> String {
    format!("{}/{name}", folder.trim_end_matches('/'))
}

/// A file's bytes as shown: text when it's text, else why it isn't.
pub fn shown(bytes: Vec<u8>) -> Shown {
    if bytes.contains(&0) {
        return Shown::Unshown("Not a text file: nothing to show here.".into());
    }
    match String::from_utf8(bytes) {
        Ok(text) => {
            let lines = text.lines().count();
            Shown::Text { text, lines }
        }
        Err(_) => Shown::Unshown("Not a text file: nothing to show here.".into()),
    }
}

impl Focusable for FilesView {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for FilesView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let content = if let Some((path, shown)) = self.opened.clone() {
            self.viewer(&path, &shown, cx)
        } else {
            let top = self.place.as_ref().map(|place| place.directory.clone()).unwrap_or_default();
            match self.folders.get(&top) {
                // The top folder unreadable: the whole room says so.
                Some(Read::Unreadable(Unreadable { message, reason })) => empty(
                    "Couldn’t Read This Folder",
                    reason.clone().unwrap_or_else(|| message.clone()),
                    Some(Button::new("files-again", "Try Again").size(ButtonSize::Small).on_click(cx.listener(move |this, _, _, cx| this.retry(&top, cx))).into_any_element()),
                    cx,
                ),
                _ => uniform_list("files-tree", self.rows.len(), cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                    let rows = this.rows.clone();
                    range.filter_map(|ix| rows.get(ix)).map(|row| this.row(row, cx)).collect::<Vec<_>>()
                }))
                .size_full()
                .p(space::S2)
                .into_any_element(),
            }
        };
        div()
            .key_context("Files")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &CloseFile, window, cx| {
                if this.opened.is_some() {
                    this.close_file(window, cx);
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

    #[test]
    fn text_shows_and_anything_else_says_why() {
        assert_eq!(shown(b"one\ntwo\n".to_vec()), Shown::Text { text: "one\ntwo\n".into(), lines: 2 });
        assert!(matches!(shown(vec![0x89, b'P', 0, 1]), Shown::Unshown(_)));
        assert!(matches!(shown(vec![0xff, 0xfe, b'a']), Shown::Unshown(_)));
    }
}
