//! A text field: one line, or many lines growing with their text like a composer.
//!
//! It does what a Mac text field does: typing, selection with the mouse and keyboard (by
//! character, word, line and all), copy, cut, paste, undo and redo, and input methods (marked
//! text for Japanese and Chinese, the character palette). Multi-line fields grow from a
//! minimum to a maximum number of lines, then scroll. Return submits (or adds a line, if the
//! field is told to), Shift-Return always adds a line.
//!
//! Adapted in part from GPUI's `examples/input.rs` (Copyright 2022 - 2025 Zed Industries, Inc.,
//! Apache-2.0; the license text is in `Licenses/gpui.txt` at the repository's root), and
//! modified: the selection model, grapheme movement, clipboard actions, UTF-16 helpers and
//! the input-handler methods follow that example; words, lines, many lines, undo, the mouse
//! beyond single clicks, events and the look are ours.

mod layout;

use std::ops::Range;

use gpui::{
    App, Bounds, ClipboardItem, Context, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
    InteractiveElement, IntoElement, KeyBinding, MouseButton, MouseDownEvent, MouseMoveEvent,
    ParentElement, Pixels, Point, Render, ScrollEvent, SharedString, Styled, UTF16Selection,
    Window, actions, div, px,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::theme::{ActiveTheme, StyledType, radius, space};
use layout::{FIELD_TYPE, Layout, TextElement};

actions!(
    text_field,
    [
        Backspace,
        Delete,
        DeleteWordLeft,
        DeleteWordRight,
        DeleteToLineStart,
        Left,
        Right,
        Up,
        Down,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        WordLeft,
        WordRight,
        SelectWordLeft,
        SelectWordRight,
        LineStart,
        LineEnd,
        SelectLineStart,
        SelectLineEnd,
        DocStart,
        DocEnd,
        SelectDocStart,
        SelectDocEnd,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Undo,
        Redo,
        Enter,
        NewLine,
        Cancel,
        ShowCharacterPalette,
    ]
);

/// The key context a field sets, for bindings that apply in fields within something else.
pub const CONTEXT: &str = "KuvoTextField";

/// The keys a text field answers to. Called from [`crate::bind_keys`].
pub fn bind_keys(cx: &mut App) {
    let c = Some(CONTEXT);
    let mut bindings = vec![
        KeyBinding::new("backspace", Backspace, c),
        KeyBinding::new("shift-backspace", Backspace, c),
        KeyBinding::new("delete", Delete, c),
        KeyBinding::new("left", Left, c),
        KeyBinding::new("right", Right, c),
        KeyBinding::new("up", Up, c),
        KeyBinding::new("down", Down, c),
        KeyBinding::new("shift-left", SelectLeft, c),
        KeyBinding::new("shift-right", SelectRight, c),
        KeyBinding::new("shift-up", SelectUp, c),
        KeyBinding::new("shift-down", SelectDown, c),
        KeyBinding::new("home", LineStart, c),
        KeyBinding::new("end", LineEnd, c),
        KeyBinding::new("shift-home", SelectLineStart, c),
        KeyBinding::new("shift-end", SelectLineEnd, c),
        KeyBinding::new("enter", Enter, c),
        KeyBinding::new("shift-enter", NewLine, c),
        KeyBinding::new("escape", Cancel, c),
    ];
    // The Mac moves by word with Option and by line with Command; other systems use Control
    // for words and Home and End for lines.
    #[cfg(target_os = "macos")]
    bindings.extend([
        KeyBinding::new("cmd-a", SelectAll, c),
        KeyBinding::new("cmd-c", Copy, c),
        KeyBinding::new("cmd-x", Cut, c),
        KeyBinding::new("cmd-v", Paste, c),
        KeyBinding::new("cmd-z", Undo, c),
        KeyBinding::new("cmd-shift-z", Redo, c),
        KeyBinding::new("alt-backspace", DeleteWordLeft, c),
        KeyBinding::new("alt-delete", DeleteWordRight, c),
        KeyBinding::new("cmd-backspace", DeleteToLineStart, c),
        KeyBinding::new("alt-left", WordLeft, c),
        KeyBinding::new("alt-right", WordRight, c),
        KeyBinding::new("alt-shift-left", SelectWordLeft, c),
        KeyBinding::new("alt-shift-right", SelectWordRight, c),
        KeyBinding::new("cmd-left", LineStart, c),
        KeyBinding::new("cmd-right", LineEnd, c),
        KeyBinding::new("cmd-shift-left", SelectLineStart, c),
        KeyBinding::new("cmd-shift-right", SelectLineEnd, c),
        KeyBinding::new("cmd-up", DocStart, c),
        KeyBinding::new("cmd-down", DocEnd, c),
        KeyBinding::new("cmd-shift-up", SelectDocStart, c),
        KeyBinding::new("cmd-shift-down", SelectDocEnd, c),
        KeyBinding::new("ctrl-a", LineStart, c),
        KeyBinding::new("ctrl-e", LineEnd, c),
        KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, c),
    ]);
    #[cfg(not(target_os = "macos"))]
    bindings.extend([
        KeyBinding::new("ctrl-a", SelectAll, c),
        KeyBinding::new("ctrl-c", Copy, c),
        KeyBinding::new("ctrl-x", Cut, c),
        KeyBinding::new("ctrl-v", Paste, c),
        KeyBinding::new("ctrl-z", Undo, c),
        KeyBinding::new("ctrl-shift-z", Redo, c),
        KeyBinding::new("ctrl-backspace", DeleteWordLeft, c),
        KeyBinding::new("ctrl-delete", DeleteWordRight, c),
        KeyBinding::new("ctrl-left", WordLeft, c),
        KeyBinding::new("ctrl-right", WordRight, c),
        KeyBinding::new("ctrl-shift-left", SelectWordLeft, c),
        KeyBinding::new("ctrl-shift-right", SelectWordRight, c),
        KeyBinding::new("ctrl-home", DocStart, c),
        KeyBinding::new("ctrl-end", DocEnd, c),
        KeyBinding::new("ctrl-shift-home", SelectDocStart, c),
        KeyBinding::new("ctrl-shift-end", SelectDocEnd, c),
        KeyBinding::new("ctrl-y", Redo, c),
    ]);
    cx.bind_keys(bindings);
}

/// What a field tells its owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextFieldEvent {
    /// The text changed.
    Changed,
    /// Return was pressed in a field that submits; carries the text.
    Submit(String),
    /// Escape was pressed.
    Cancel,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Typing,
    /// An input method committing its composition: the undo step was taken when it began.
    Commit,
    Other,
}

#[derive(Clone)]
struct Snapshot {
    content: String,
    selection: Range<usize>,
}

/// A text field. Create it with `cx.new(|cx| TextField::new(cx))`, then render the entity.
pub struct TextField {
    focus: FocusHandle,
    content: String,
    placeholder: SharedString,
    selection: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    /// `None` for one line; `Some((min, max))` lines for a growing field.
    lines: Option<(usize, usize)>,
    /// Return submits rather than adding a line.
    submits: bool,
    /// Drawn without its own border and fill (inside a composer card).
    bare: bool,
    disabled: bool,
    /// What's wrong with the text, shown under the field with a red edge.
    error: Option<SharedString>,
    layout: Option<Layout>,
    /// Where Up and Down aim, so moving through short lines keeps the column.
    goal_x: Option<Pixels>,
    scroll: Pixels,
    reveal_caret: bool,
    selecting: bool,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    last_edit: EditKind,
}

impl EventEmitter<TextFieldEvent> for TextField {}

impl Focusable for TextField {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextField {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            content: String::new(),
            placeholder: SharedString::default(),
            selection: 0..0,
            reversed: false,
            marked: None,
            lines: None,
            submits: true,
            bare: false,
            disabled: false,
            error: None,
            layout: None,
            goal_x: None,
            scroll: px(0.),
            reveal_caret: false,
            selecting: false,
            undo: Vec::new(),
            redo: Vec::new(),
            last_edit: EditKind::Other,
        }
    }

    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }

    /// Grows from `min` to `max` lines with its text, then scrolls.
    pub fn multi_line(mut self, min: usize, max: usize) -> Self {
        self.lines = Some((min.max(1), max.max(min.max(1))));
        self
    }

    /// Whether Return submits (the default) or adds a line.
    pub fn submits_on_enter(mut self, submits: bool) -> Self {
        self.submits = submits;
        self
    }

    /// Drawn without its own border and fill, for use inside a card such as the composer.
    pub fn bare(mut self) -> Self {
        self.bare = true;
        self
    }

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        self.disabled = disabled;
        cx.notify();
    }

    /// Shows what's wrong with the text under the field, or clears it with `None`.
    pub fn set_error(&mut self, error: Option<SharedString>, cx: &mut Context<Self>) {
        self.error = error;
        cx.notify();
    }

    /// What's wrong with the text, as shown under the field.
    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    /// The selected range, in bytes.
    pub fn selection(&self) -> Range<usize> {
        self.selection.clone()
    }

    /// Replaces the text and puts the caret at its end.
    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.content = self.normalize(&text.into());
        self.selection = self.content.len()..self.content.len();
        self.marked = None;
        self.undo.clear();
        self.redo.clear();
        self.reveal_caret = true;
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    /// Selects a range of the text, in bytes (clamped to the text and to character bounds).
    pub fn select_range(&mut self, range: Range<usize>, cx: &mut Context<Self>) {
        let clamp = |mut ix: usize| {
            ix = ix.min(self.content.len());
            while !self.content.is_char_boundary(ix) {
                ix -= 1;
            }
            ix
        };
        self.selection = clamp(range.start)..clamp(range.end.max(range.start));
        self.reversed = false;
        self.reveal_caret = true;
        cx.notify();
    }

    /// Brings the shaped layout up to date with the text, if it changed since the last paint,
    /// so positions asked for before the next frame are right.
    fn refresh_layout(&mut self, window: &Window) {
        let marked = self.marked.clone();
        if let Some(layout) = self.layout.as_mut().filter(|l| l.text != self.content) {
            layout.reshape(&self.content, marked.as_ref(), window);
        }
    }

    fn cursor(&self) -> usize {
        if self.reversed { self.selection.start } else { self.selection.end }
    }

    // Moving and selecting.

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = offset.min(self.content.len());
        // Moving the caret ends a run of typing: the next word is its own undo step.
        self.last_edit = EditKind::Other;
        self.selection = offset..offset;
        self.reversed = false;
        self.reveal_caret = true;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = offset.min(self.content.len());
        self.last_edit = EditKind::Other;
        if self.reversed {
            self.selection.start = offset;
        } else {
            self.selection.end = offset;
        }
        if self.selection.end < self.selection.start {
            self.reversed = !self.reversed;
            self.selection = self.selection.end..self.selection.start;
        }
        self.reveal_caret = true;
        cx.notify();
    }

    fn previous_grapheme(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(ix, _)| (ix < offset).then_some(ix))
            .unwrap_or(0)
    }

    fn next_grapheme(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(ix, _)| (ix > offset).then_some(ix))
            .unwrap_or(self.content.len())
    }

    /// The start of the word before an offset, skipping spaces and punctuation, as on a Mac.
    fn previous_word(&self, offset: usize) -> usize {
        self.content
            .split_word_bound_indices()
            .filter(|(ix, word)| *ix < offset && word.chars().any(char::is_alphanumeric))
            .last()
            .map(|(ix, _)| ix)
            .unwrap_or(0)
    }

    fn next_word(&self, offset: usize) -> usize {
        self.content
            .split_word_bound_indices()
            .find(|(ix, word)| ix + word.len() > offset && word.chars().any(char::is_alphanumeric))
            .map(|(ix, word)| ix + word.len())
            .unwrap_or(self.content.len())
    }

    fn word_around(&self, offset: usize) -> Range<usize> {
        self.content
            .split_word_bound_indices()
            .find(|(ix, word)| *ix <= offset && offset < ix + word.len())
            .map(|(ix, word)| ix..ix + word.len())
            .unwrap_or(offset..offset)
    }

    /// The start and end of the line an offset is on: the visual row in a wrapped field, the
    /// paragraph otherwise.
    fn line_around(&self, offset: usize) -> Range<usize> {
        let paragraph_start = self.content[..offset].rfind('\n').map_or(0, |ix| ix + 1);
        let paragraph_end = self.content[offset..].find('\n').map_or(self.content.len(), |ix| offset + ix);
        let Some(layout) = self.layout.as_ref().filter(|l| l.text == self.content) else {
            return paragraph_start..paragraph_end;
        };
        let ix = layout.starts.partition_point(|s| *s <= offset).saturating_sub(1);
        let Some(line) = layout.lines.get(ix) else {
            return paragraph_start..paragraph_end;
        };
        let local = offset - layout.starts[ix];
        let rows = Layout::row_starts(line);
        let row = rows.partition_point(|s| *s <= local).saturating_sub(1);
        let start = layout.starts[ix] + rows[row];
        let end = rows.get(row + 1).map_or(paragraph_end, |s| layout.starts[ix] + s);
        start..end
    }

    fn vertical(&mut self, rows: f32, cx: &mut Context<Self>) -> Option<usize> {
        let layout = self.layout.as_ref().filter(|l| l.text == self.content)?;
        let at = layout.position_for(self.cursor());
        let x = *self.goal_x.get_or_insert(at.x);
        let y = at.y + layout.line_height * rows + layout.line_height / 2.;
        let target = if y < px(0.) {
            0
        } else if y >= layout.content_height {
            self.content.len()
        } else {
            layout.offset_for(gpui::point(x, y))
        };
        cx.notify();
        Some(target)
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        let to = if self.selection.is_empty() { self.previous_grapheme(self.cursor()) } else { self.selection.start };
        self.goal_x = None;
        self.move_to(to, cx);
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        let to = if self.selection.is_empty() { self.next_grapheme(self.cursor()) } else { self.selection.end };
        self.goal_x = None;
        self.move_to(to, cx);
    }

    fn up(&mut self, _: &Up, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        let to = self.vertical(-1., cx).unwrap_or(0);
        let goal = self.goal_x;
        self.move_to(to, cx);
        self.goal_x = goal;
    }

    fn down(&mut self, _: &Down, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        let to = self.vertical(1., cx).unwrap_or(self.content.len());
        let goal = self.goal_x;
        self.move_to(to, cx);
        self.goal_x = goal;
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.select_to(self.previous_grapheme(self.cursor()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.select_to(self.next_grapheme(self.cursor()), cx);
    }

    fn select_up(&mut self, _: &SelectUp, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        let to = self.vertical(-1., cx).unwrap_or(0);
        self.select_to(to, cx);
    }

    fn select_down(&mut self, _: &SelectDown, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        let to = self.vertical(1., cx).unwrap_or(self.content.len());
        self.select_to(to, cx);
    }

    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(self.previous_word(self.cursor()), cx);
    }

    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(self.next_word(self.cursor()), cx);
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_word(self.cursor()), cx);
    }

    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_word(self.cursor()), cx);
    }

    fn line_start(&mut self, _: &LineStart, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        self.goal_x = None;
        self.move_to(self.line_around(self.cursor()).start, cx);
    }

    /// Where the line the caret is on ends. At a soft wrap, the row's end is the next row's
    /// start, so stop just before it (on the space a wrap usually breaks at).
    fn line_end_offset(&self) -> usize {
        let end = self.line_around(self.cursor()).end;
        if end < self.content.len() && !self.content[end..].starts_with('\n') {
            self.previous_grapheme(end).max(self.cursor())
        } else {
            end
        }
    }

    fn line_end(&mut self, _: &LineEnd, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        self.goal_x = None;
        self.move_to(self.line_end_offset(), cx);
    }

    fn select_line_start(&mut self, _: &SelectLineStart, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        self.select_to(self.line_around(self.cursor()).start, cx);
    }

    fn select_line_end(&mut self, _: &SelectLineEnd, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        self.select_to(self.line_end_offset(), cx);
    }

    fn doc_start(&mut self, _: &DocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(0, cx);
    }

    fn doc_end(&mut self, _: &DocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(self.content.len(), cx);
    }

    fn select_doc_start(&mut self, _: &SelectDocStart, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn select_doc_end(&mut self, _: &SelectDocEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.content.len(), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.selection = 0..self.content.len();
        self.reversed = false;
        cx.notify();
    }

    // Editing.

    /// Replaces a range with text: every edit, typed, pasted or from an input method, comes
    /// through here so undo and the change event see it.
    fn edit(&mut self, range: Range<usize>, text: &str, kind: EditKind, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        let text = self.normalize(text);
        let coalesce = kind == EditKind::Typing
            && self.last_edit == EditKind::Typing
            && range.is_empty()
            && !text.contains(char::is_whitespace);
        if !coalesce && kind != EditKind::Commit {
            self.push_undo();
        }
        self.redo.clear();
        self.last_edit = if kind == EditKind::Commit { EditKind::Other } else { kind };
        self.content.replace_range(range.clone(), &text);
        let caret = range.start + text.len();
        self.selection = caret..caret;
        self.reversed = false;
        self.marked = None;
        self.goal_x = None;
        self.reveal_caret = true;
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    /// Text as this field holds it, however it arrives (typed, pasted, set, or from an input
    /// method): a one-line field turns line breaks into spaces; carriage returns are dropped.
    fn normalize(&self, text: &str) -> String {
        if self.lines.is_none() { text.replace(['\n', '\r'], " ") } else { text.replace('\r', "") }
    }

    /// Keeps the state before an edit, so it can be undone. The history is capped by the
    /// text it holds (8 MB), not by a count: a few huge pastes can't grow it without bound,
    /// and many small edits still go back a long way.
    fn push_undo(&mut self) {
        const MAX_BYTES: usize = 8 * 1024 * 1024;
        self.undo.push(Snapshot { content: self.content.clone(), selection: self.selection.clone() });
        let mut total: usize = self.undo.iter().map(|s| s.content.len()).sum();
        while total > MAX_BYTES && self.undo.len() > 1 {
            total -= self.undo.remove(0).content.len();
        }
    }

    fn delete_or(&mut self, fallback: impl FnOnce(&Self) -> Range<usize>, cx: &mut Context<Self>) {
        let range = if self.selection.is_empty() { fallback(self) } else { self.selection.clone() };
        if !range.is_empty() {
            self.edit(range, "", EditKind::Other, cx);
        }
    }

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_or(|this| this.previous_grapheme(this.cursor())..this.cursor(), cx);
    }

    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_or(|this| this.cursor()..this.next_grapheme(this.cursor()), cx);
    }

    fn delete_word_left(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_or(|this| this.previous_word(this.cursor())..this.cursor(), cx);
    }

    fn delete_word_right(&mut self, _: &DeleteWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_or(|this| this.cursor()..this.next_word(this.cursor()), cx);
    }

    fn delete_to_line_start(&mut self, _: &DeleteToLineStart, window: &mut Window, cx: &mut Context<Self>) {
        self.refresh_layout(window);
        self.delete_or(
            |this| {
                let start = this.line_around(this.cursor()).start;
                // At the very start of a line, take the newline before it, as a Mac does.
                let start = if start == this.cursor() { this.previous_grapheme(start) } else { start };
                start..this.cursor()
            },
            cx,
        );
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.content[self.selection.clone()].to_string()));
        }
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.content[self.selection.clone()].to_string()));
            self.edit(self.selection.clone(), "", EditKind::Other, cx);
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.edit(self.selection.clone(), &text, EditKind::Other, cx);
        }
    }

    fn undo(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(snapshot) = self.undo.pop() {
            self.redo.push(Snapshot { content: self.content.clone(), selection: self.selection.clone() });
            self.restore(snapshot, cx);
        }
    }

    fn redo(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(snapshot) = self.redo.pop() {
            self.undo.push(Snapshot { content: self.content.clone(), selection: self.selection.clone() });
            self.restore(snapshot, cx);
        }
    }

    fn restore(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.content = snapshot.content;
        self.selection = snapshot.selection;
        self.reversed = false;
        self.marked = None;
        self.last_edit = EditKind::Other;
        self.reveal_caret = true;
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    fn enter(&mut self, _: &Enter, window: &mut Window, cx: &mut Context<Self>) {
        if self.submits || self.lines.is_none() {
            cx.emit(TextFieldEvent::Submit(self.content.clone()));
        } else {
            self.new_line(&NewLine, window, cx);
        }
    }

    fn new_line(&mut self, _: &NewLine, _: &mut Window, cx: &mut Context<Self>) {
        if self.lines.is_some() {
            self.edit(self.selection.clone(), "\n", EditKind::Other, cx);
        }
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextFieldEvent::Cancel);
    }

    fn show_character_palette(&mut self, _: &ShowCharacterPalette, window: &mut Window, _: &mut Context<Self>) {
        window.show_character_palette();
    }

    // The mouse.

    fn offset_at(&self, position: Point<Pixels>) -> usize {
        match self.layout.as_ref().filter(|l| l.text == self.content) {
            Some(layout) => layout.offset_for(position - layout.origin),
            None => self.content.len(),
        }
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        self.refresh_layout(window);
        window.focus(&self.focus, cx);
        let offset = self.offset_at(event.position);
        self.goal_x = None;
        self.last_edit = EditKind::Other;
        match event.click_count {
            2 => {
                let word = self.word_around(offset);
                self.selection = word;
                self.reversed = false;
                cx.notify();
            }
            n if n >= 3 => {
                let line = self.line_around(offset);
                self.selection = line;
                self.reversed = false;
                cx.notify();
            }
            _ => {
                self.selecting = true;
                if event.modifiers.shift {
                    self.select_to(offset, cx);
                } else {
                    self.move_to(offset, cx);
                }
            }
        }
    }

    fn mouse_move(&mut self, event: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.selecting {
            self.refresh_layout(window);
            let offset = self.offset_at(event.position);
            self.select_to(offset, cx);
        }
    }

    fn scroll_wheel(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let delta = event.delta.pixel_delta(FIELD_TYPE.line_height());
        self.scroll -= if self.lines.is_some() { delta.y } else { delta.x };
        cx.notify();
    }

    // UTF-16, which input methods speak.

    fn offset_from_utf16(&self, utf16: usize) -> usize {
        let mut utf8 = 0;
        let mut count = 0;
        for ch in self.content.chars() {
            if count >= utf16 {
                break;
            }
            count += ch.len_utf16();
            utf8 += ch.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, utf8: usize) -> usize {
        self.content[..utf8.min(self.content.len())].encode_utf16().count()
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }
}

impl EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: self.range_to_utf16(&self.selection), reversed: self.reversed })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .map(|r| self.range_from_utf16(&r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        let kind = if self.marked.is_some() { EditKind::Commit } else { EditKind::Typing };
        self.edit(range, text, kind, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        text: &str,
        selected_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.disabled {
            return;
        }
        let range = range_utf16
            .map(|r| self.range_from_utf16(&r))
            .or(self.marked.clone())
            .unwrap_or(self.selection.clone());
        let normalized = self.normalize(text);
        let text = normalized.as_str();
        // Composition is one undo step: keep the state from before it started.
        if self.marked.is_none() {
            self.push_undo();
            self.redo.clear();
        }
        self.content.replace_range(range.clone(), text);
        self.marked = (!text.is_empty()).then(|| range.start..range.start + text.len());
        let start_utf16 = self.offset_to_utf16(range.start);
        let len_utf16 = text.encode_utf16().count();
        self.selection = selected_utf16
            .map(|s| {
                self.range_from_utf16(&(start_utf16 + s.start.min(len_utf16)..start_utf16 + s.end.min(len_utf16)))
            })
            .unwrap_or(range.start + text.len()..range.start + text.len());
        self.reversed = false;
        self.last_edit = EditKind::Other;
        self.reveal_caret = true;
        cx.emit(TextFieldEvent::Changed);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        _element_bounds: Bounds<Pixels>,
        window: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        self.refresh_layout(window);
        let range = self.range_from_utf16(&range_utf16);
        let layout = self.layout.as_ref().filter(|l| l.text == self.content)?;
        let start = layout.position_for(range.start);
        let end = layout.position_for(range.end);
        let width = if end.y == start.y && end.x > start.x { end.x - start.x } else { px(1.) };
        Some(Bounds::new(layout.origin + start, gpui::size(width, layout.line_height)))
    }

    fn character_index_for_point(&mut self, point: Point<Pixels>, window: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        self.refresh_layout(window);
        let layout = self.layout.as_ref().filter(|l| l.text == self.content)?;
        Some(self.offset_to_utf16(layout.offset_for(point - layout.origin)))
    }
}

impl Render for TextField {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let c = &theme.colors;
        let focused = self.focus.is_focused(_window);
        let mut field = div()
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .cursor_text()
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_left))
            .on_action(cx.listener(Self::delete_word_right))
            .on_action(cx.listener(Self::delete_to_line_start))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::line_start))
            .on_action(cx.listener(Self::line_end))
            .on_action(cx.listener(Self::select_line_start))
            .on_action(cx.listener(Self::select_line_end))
            .on_action(cx.listener(Self::doc_start))
            .on_action(cx.listener(Self::doc_end))
            .on_action(cx.listener(Self::select_doc_start))
            .on_action(cx.listener(Self::select_doc_end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::enter))
            .on_action(cx.listener(Self::new_line))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::show_character_palette))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _, _, _| this.selecting = false))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _, _, _| this.selecting = false))
            .on_mouse_move(cx.listener(Self::mouse_move))
            .on_scroll(cx.listener(Self::scroll_wheel))
            .w_full()
            .text_ui(FIELD_TYPE)
            .text_color(c.text);

        let edge = if self.error.is_some() {
            c.danger
        } else if focused {
            c.accent
        } else {
            c.border_strong
        };
        if !self.bare {
            field = field
                .px(space::S3)
                .py(space::S1_5)
                .rounded(radius::NAV)
                .bg(if self.disabled { c.sunken } else { c.surface })
                .border_1()
                .border_color(if self.disabled { c.border } else { edge });
            if focused {
                let ring = if self.error.is_some() { c.danger.opacity(0.3) } else { c.focus_ring };
                field = field.shadow(crate::button::focus_ring(ring));
            }
        }
        if self.disabled {
            field = field.cursor_default();
        }
        let field = field.child(TextElement { field: cx.entity() });
        match self.error.clone() {
            None => field.into_any_element(),
            Some(error) => div()
                .flex()
                .flex_col()
                .w_full()
                .gap(space::S1)
                .child(field)
                .child(div().text_ui(crate::theme::TypeSize::Caption).text_color(c.danger).child(error))
                .into_any_element(),
        }
    }
}
