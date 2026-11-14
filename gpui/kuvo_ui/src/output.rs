//! What a step printed or changed, under its row: a command's output or a search's results in a
//! sunken well of monospaced lines, and a file's changes as a diff. Long ones are folded to their
//! first lines, with a button that shows them whole (and folds them again).
//!
//! The view that draws them owns whether each is shown whole, as it owns a thinking block's being
//! open: these hold no state.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
};

use crate::theme::{ActiveTheme, StyledType, TypeSize, radius, space};

/// How many lines show before the rest is folded away.
pub const FOLDED: usize = 12;
/// The most lines shown whole: past this, the rest is counted, not drawn.
pub const MOST: usize = 400;

type Toggle = Rc<dyn Fn(&mut Window, &mut App)>;

/// A command's output, or any step's text, in a sunken well.
#[derive(IntoElement)]
pub struct OutputWell {
    id: ElementId,
    text: SharedString,
    /// The command that printed it, shown first ("$ npm test").
    command: Option<SharedString>,
    whole: bool,
    on_toggle: Option<Toggle>,
}

impl OutputWell {
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        Self { id: id.into(), text: text.into(), command: None, whole: false, on_toggle: None }
    }

    pub fn command(mut self, command: impl Into<SharedString>) -> Self {
        self.command = Some(command.into());
        self
    }

    /// Whether it's shown whole, rather than folded to its first lines.
    pub fn whole(mut self, whole: bool) -> Self {
        self.whole = whole;
        self
    }

    /// Shows it whole, or folds it again (the fold's button).
    pub fn on_toggle(mut self, toggle: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(toggle));
        self
    }
}

/// The lines that show of `count`, and what the fold's button says (none where all of them show).
pub fn fold(count: usize, whole: bool) -> (usize, Option<String>) {
    if count <= FOLDED + 2 {
        // Folding away a line or two hides nothing worth a button.
        return (count, None);
    }
    if whole {
        (count.min(MOST), Some("Show less".to_owned()))
    } else {
        (FOLDED, Some(if count > MOST { format!("Show the first {MOST} of {count} lines") } else { format!("Show all {count} lines") }))
    }
}

impl RenderOnce for OutputWell {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        let text = self.text.trim_matches('\n');
        let lines: Vec<&str> = if text.is_empty() { Vec::new() } else { text.split('\n').collect() };
        let (shown, button) = fold(lines.len(), self.whole);
        let unshown = lines.len().saturating_sub(MOST);
        let command = self.command.map(|command| div().text_color(c.text_muted).child(format!("$ {command}")));
        let body = (!lines.is_empty()).then(|| div().text_color(c.text).child(lines[..shown].join("\n")));
        let empty = lines.is_empty().then(|| div().text_color(c.text_faint).child("No output"));
        let more = (self.whole && unshown > 0).then(|| div().text_color(c.text_faint).child(format!("… and {unshown} more lines")));
        let selector = self.id.to_string();
        well(self.id.clone(), cx)
            .debug_selector(move || selector)
            .child(
                div()
                    .id(self.id.clone())
                    .w_full()
                    .overflow_x_scroll()
                    .text_mono(TypeSize::Small)
                    .whitespace_nowrap()
                    .child(div().flex().flex_col().flex_none().gap(space::S0_5).px(space::S3).py(space::S2).children(command).children(body).children(empty).children(more)),
            )
            .children(fold_button(self.id, button, self.on_toggle, cx))
    }
}

/// The sunken well every output sits in.
fn well(_id: ElementId, cx: &App) -> gpui::Div {
    let c = &cx.theme().colors;
    div().flex().flex_col().w_full().rounded(radius::NAV).border_1().border_color(c.border).bg(c.sunken).overflow_hidden()
}

/// The fold's button, along the well's foot.
fn fold_button(id: ElementId, label: Option<String>, toggle: Option<Toggle>, cx: &App) -> Option<AnyElement> {
    let c = &cx.theme().colors;
    let label = label?;
    let hover = c.hover;
    Some(
        div()
            .id((id.clone(), "fold"))
            .debug_selector(move || format!("{id}-fold"))
            .flex()
            .items_center()
            .h(px(26.))
            .px(space::S3)
            .border_t_1()
            .border_color(c.border)
            .text_ui(TypeSize::Caption)
            .text_color(c.text_muted)
            .cursor_pointer()
            .hover(move |s| s.bg(hover))
            .when_some(toggle, |d, toggle| d.on_click(move |_, window, cx| toggle(window, cx)))
            .child(label)
            .into_any_element(),
    )
}

/// One line of a diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
    /// Its number before the change and after it, where it has one.
    pub old: Option<u32>,
    pub new: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
    /// Where a hunk starts (`@@ -12,4 +12,6 @@`): shown as a quiet gap.
    Hunk,
    Context,
    Added,
    Removed,
}

/// A unified patch's lines, numbered: its file headers (`diff --git`, `---`, `+++`, `index`) left
/// out, each hunk starting where its header says.
pub fn parse_patch(patch: &str) -> Vec<DiffLine> {
    let mut lines = Vec::new();
    let (mut old, mut new) = (0u32, 0u32);
    let mut in_hunk = false;
    for line in patch.lines() {
        if let Some(header) = line.strip_prefix("@@") {
            // `@@ -a[,b] +c[,d] @@ …`
            let mut numbers = header.split_whitespace();
            let start = |part: Option<&str>, sign: char| part.and_then(|p| p.strip_prefix(sign)).and_then(|p| p.split(',').next()).and_then(|n| n.parse::<u32>().ok()).unwrap_or(1);
            old = start(numbers.next(), '-');
            new = start(numbers.next(), '+');
            in_hunk = true;
            lines.push(DiffLine { kind: LineKind::Hunk, text: String::new(), old: None, new: None });
            continue;
        }
        if !in_hunk {
            continue;
        }
        let (kind, text) = match line.chars().next() {
            Some('+') => (LineKind::Added, &line[1..]),
            Some('-') => (LineKind::Removed, &line[1..]),
            Some(' ') => (LineKind::Context, &line[1..]),
            // "\ No newline at end of file", and anything else a hunk doesn't number.
            Some('\\') => continue,
            None => (LineKind::Context, ""),
            Some(_) => {
                in_hunk = false;
                continue;
            }
        };
        let (at_old, at_new) = match kind {
            LineKind::Added => (None, Some(new)),
            LineKind::Removed => (Some(old), None),
            _ => (Some(old), Some(new)),
        };
        if at_old.is_some() {
            old += 1;
        }
        if at_new.is_some() {
            new += 1;
        }
        lines.push(DiffLine { kind, text: text.to_owned(), old: at_old, new: at_new });
    }
    // A hunk's start before the first lines says nothing: it's dropped there.
    if matches!(lines.first(), Some(DiffLine { kind: LineKind::Hunk, .. })) {
        lines.remove(0);
    }
    lines
}

/// A file's changes, as a diff: an optional title with what was added and removed, then its
/// lines, numbered, each added or removed one on its wash.
#[derive(IntoElement)]
pub struct DiffView {
    id: ElementId,
    lines: Rc<Vec<DiffLine>>,
    title: Option<SharedString>,
    counts: Option<(usize, usize)>,
    whole: bool,
    on_toggle: Option<Toggle>,
}

impl DiffView {
    pub fn new(id: impl Into<ElementId>, lines: Rc<Vec<DiffLine>>) -> Self {
        Self { id: id.into(), lines, title: None, counts: None, whole: false, on_toggle: None }
    }

    /// The file's name over its lines (several files, or one that was added or deleted).
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Lines added and removed, beside the title.
    pub fn counts(mut self, added: usize, removed: usize) -> Self {
        self.counts = Some((added, removed));
        self
    }

    pub fn whole(mut self, whole: bool) -> Self {
        self.whole = whole;
        self
    }

    pub fn on_toggle(mut self, toggle: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(toggle));
        self
    }
}

impl RenderOnce for DiffView {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = cx.theme().colors.clone();
        let (shown, button) = fold(self.lines.len(), self.whole);
        let unshown = self.lines.len().saturating_sub(MOST);
        // The gutter's width: the widest number shown.
        let widest = self.lines[..shown].iter().filter_map(|line| line.new.max(line.old)).max().unwrap_or(1).to_string().len();
        let gutter = px(8. * widest as f32 + 8.);
        let number = |n: Option<u32>| div().w(gutter).flex_none().text_right().pr(space::S1).text_color(c.syntax.line_number).child(n.map(|n| n.to_string()).unwrap_or_default());
        let rows = self.lines[..shown].iter().map(|line| {
            let (wash, sign, sign_color) = match line.kind {
                LineKind::Added => (Some(c.diff_added_wash), "+", c.diff_added),
                LineKind::Removed => (Some(c.diff_removed_wash), "-", c.diff_removed),
                _ => (None, " ", c.text_faint),
            };
            if line.kind == LineKind::Hunk {
                return div().w_full().h(px(10.)).bg(c.hover).into_any_element();
            }
            div()
                .flex()
                .w_full()
                .when_some(wash, |d, wash| d.bg(wash))
                .child(number(line.old))
                .child(number(line.new))
                .child(div().w(px(16.)).flex_none().text_center().text_color(sign_color).child(sign))
                .child(div().flex_none().pr(space::S3).text_color(c.syntax.plain).child(if line.text.is_empty() { " ".to_owned() } else { line.text.clone() }))
                .into_any_element()
        });
        let header = self.title.clone().map(|title| {
            div()
                .flex()
                .items_center()
                .gap(space::S2)
                .h(px(28.))
                .px(space::S3)
                .border_b_1()
                .border_color(c.border)
                .text_ui(TypeSize::Caption)
                .child(div().min_w_0().truncate().text_color(c.text).child(title))
                .children(self.counts.map(|(added, removed)| {
                    div().flex().flex_none().gap(space::S1).child(div().text_color(c.diff_added).child(format!("+{added}"))).child(div().text_color(c.diff_removed).child(format!("−{removed}")))
                }))
        });
        let more = (self.whole && unshown > 0).then(|| div().px(space::S3).text_color(c.text_faint).child(format!("… and {unshown} more lines")));
        let selector = self.id.to_string();
        well(self.id.clone(), cx)
            .debug_selector(move || selector)
            .children(header)
            .child(
                div()
                    .id(self.id.clone())
                    .w_full()
                    .overflow_x_scroll()
                    .text_mono(TypeSize::Small)
                    .whitespace_nowrap()
                    .child(div().flex().flex_col().flex_none().min_w_full().py(space::S1).children(rows).children(more)),
            )
            .children(fold_button(self.id, button, self.on_toggle, cx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_patch_reads_as_numbered_lines_without_its_headers() {
        let patch = "diff --git a/Form.tsx b/Form.tsx\nindex 1..2 100644\n--- a/Form.tsx\n+++ b/Form.tsx\n@@ -10,3 +10,4 @@ function save()\n   try {\n-    reset();\n+    await post();\n+    reset();\n   }\n\\ No newline at end of file\n@@ -40,1 +41,1 @@\n-a\n+b\n";
        let lines = parse_patch(patch);
        let kinds: Vec<LineKind> = lines.iter().map(|line| line.kind).collect();
        use LineKind::*;
        assert_eq!(kinds, [Context, Removed, Added, Added, Context, Hunk, Removed, Added]);
        assert_eq!((lines[0].old, lines[0].new), (Some(10), Some(10)));
        assert_eq!((lines[1].old, lines[1].new), (Some(11), None));
        assert_eq!((lines[3].old, lines[3].new), (None, Some(12)));
        assert_eq!((lines[4].old, lines[4].new), (Some(12), Some(13)));
        assert_eq!((lines[6].old, lines[7].new), (Some(40), Some(41)));
        assert_eq!(lines[2].text, "    await post();");
    }

    #[test]
    fn long_output_folds_to_its_first_lines_and_a_short_one_never_does() {
        assert_eq!(fold(5, false), (5, None));
        // Two more than the fold: shown whole, not behind a button.
        assert_eq!(fold(FOLDED + 2, false), (FOLDED + 2, None));
        assert_eq!(fold(240, false), (FOLDED, Some("Show all 240 lines".into())));
        assert_eq!(fold(240, true), (240, Some("Show less".into())));
        assert_eq!(fold(5000, true), (MOST, Some("Show less".into())));
        assert_eq!(fold(5000, false).1.as_deref(), Some("Show the first 400 of 5000 lines"));
    }
}
