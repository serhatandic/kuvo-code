//! Markdown: headings, paragraphs, bold, italic, strikethrough, links, inline code, lists (with
//! task items), quotes, rules, tables and code blocks, drawn in Kuvo's type.
//!
//! Text is parsed with pulldown-cmark (MIT) into a small tree of blocks, then drawn. A message
//! that's still streaming can simply be drawn again with more text: an unfinished `**` or
//! fence shows as written until it closes.

use std::ops::Range;

use gpui::{
    AnyElement, App, ElementId, FontStyle, FontWeight, Hsla, InteractiveText, IntoElement,
    ParentElement, RenderOnce, SharedString, StrikethroughStyle, Styled, StyledText, TextRun,
    Window, div, prelude::FluentBuilder as _, px,
};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::{
    code_block::CodeBlock,
    icon::{Icon, IconName},
    theme::{ActiveTheme, Colors, MEDIUM, MONO_FONT, REGULAR, StyledType, TypeSize, UI_FONT, radius, space},
};

/// A run of inline text with its styles and links.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Inline {
    pub text: String,
    pub spans: Vec<(Range<usize>, Style)>,
    /// Link targets, by the range of text that links.
    pub links: Vec<(Range<usize>, String)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    pub link: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    Heading(u8, Inline),
    Paragraph(Inline),
    List { start: Option<u64>, items: Vec<Item> },
    Quote(Vec<Block>),
    Code { language: String, code: String },
    Table { header: Vec<Inline>, rows: Vec<Vec<Inline>> },
    Rule,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Item {
    /// `Some(done)` for a task item.
    pub task: Option<bool>,
    pub blocks: Vec<Block>,
}

enum Container {
    Root(Vec<Block>),
    Quote(Vec<Block>),
    List { start: Option<u64>, items: Vec<Item> },
    Item(Item),
    Table { header: Vec<Inline>, rows: Vec<Vec<Inline>>, in_head: bool, row: Vec<Inline> },
}

impl Container {
    fn push(&mut self, block: Block) {
        match self {
            Container::Root(blocks) | Container::Quote(blocks) => blocks.push(block),
            Container::Item(item) => item.blocks.push(block),
            // Blocks can't sit directly in a list or a table; pulldown-cmark never sends them.
            Container::List { .. } | Container::Table { .. } => {}
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum InlineKind {
    Paragraph,
    Heading(u8),
    /// Text in a tight list item, with no paragraph around it.
    Loose,
    Cell,
}

/// Parses markdown into blocks.
pub fn parse(source: &str) -> Vec<Block> {
    let options = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES;
    let mut stack = vec![Container::Root(Vec::new())];
    let mut inline: Option<(InlineKind, Inline)> = None;
    let mut style = Style::default();
    let (mut bold, mut italic, mut strike) = (0, 0, 0);
    let mut link: Option<(usize, String)> = None;
    let mut code: Option<(String, String)> = None;

    fn flush(stack: &mut [Container], inline: &mut Option<(InlineKind, Inline)>) {
        if let Some((kind, text)) = inline.take() {
            let block = match kind {
                InlineKind::Heading(level) => Block::Heading(level, text),
                InlineKind::Cell => return,
                _ => Block::Paragraph(text),
            };
            if let Some(top) = stack.last_mut() {
                top.push(block);
            }
        }
    }

    for event in Parser::new_ext(source, options) {
        match event {
            Event::Start(Tag::Paragraph) => {
                flush(&mut stack, &mut inline);
                inline = Some((InlineKind::Paragraph, Inline::default()));
            }
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut stack, &mut inline);
                let level = match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                };
                inline = Some((InlineKind::Heading(level), Inline::default()));
            }
            Event::End(TagEnd::Paragraph) | Event::End(TagEnd::Heading(_)) => flush(&mut stack, &mut inline),
            Event::Start(Tag::BlockQuote(_)) => {
                flush(&mut stack, &mut inline);
                stack.push(Container::Quote(Vec::new()));
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush(&mut stack, &mut inline);
                if let Some(Container::Quote(blocks)) = stack.pop() {
                    if let Some(top) = stack.last_mut() {
                        top.push(Block::Quote(blocks));
                    }
                }
            }
            Event::Start(Tag::List(start)) => {
                flush(&mut stack, &mut inline);
                stack.push(Container::List { start, items: Vec::new() });
            }
            Event::End(TagEnd::List(_)) => {
                if let Some(Container::List { start, items }) = stack.pop() {
                    if let Some(top) = stack.last_mut() {
                        top.push(Block::List { start, items });
                    }
                }
            }
            Event::Start(Tag::Item) => stack.push(Container::Item(Item::default())),
            Event::End(TagEnd::Item) => {
                flush(&mut stack, &mut inline);
                if let Some(Container::Item(item)) = stack.pop() {
                    if let Some(Container::List { items, .. }) = stack.last_mut() {
                        items.push(item);
                    }
                }
            }
            Event::TaskListMarker(done) => {
                if let Some(Container::Item(item)) = stack.last_mut() {
                    item.task = Some(done);
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                flush(&mut stack, &mut inline);
                let language = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().unwrap_or("").to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                code = Some((language, String::new()));
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((language, text)) = code.take() {
                    if let Some(top) = stack.last_mut() {
                        top.push(Block::Code { language, code: text });
                    }
                }
            }
            Event::Start(Tag::Table(_)) => {
                flush(&mut stack, &mut inline);
                stack.push(Container::Table { header: Vec::new(), rows: Vec::new(), in_head: false, row: Vec::new() });
            }
            Event::Start(Tag::TableHead) => {
                if let Some(Container::Table { in_head, .. }) = stack.last_mut() {
                    *in_head = true;
                }
            }
            Event::End(TagEnd::TableHead) => {
                if let Some(Container::Table { in_head, row, header, .. }) = stack.last_mut() {
                    *in_head = false;
                    *header = std::mem::take(row);
                }
            }
            Event::Start(Tag::TableCell) => inline = Some((InlineKind::Cell, Inline::default())),
            Event::End(TagEnd::TableCell) => {
                if let (Some((_, cell)), Some(Container::Table { row, .. })) = (inline.take(), stack.last_mut()) {
                    row.push(cell);
                }
            }
            Event::End(TagEnd::TableRow) => {
                if let Some(Container::Table { row, rows, .. }) = stack.last_mut() {
                    rows.push(std::mem::take(row));
                }
            }
            Event::End(TagEnd::Table) => {
                if let Some(Container::Table { header, rows, .. }) = stack.pop() {
                    if let Some(top) = stack.last_mut() {
                        top.push(Block::Table { header, rows });
                    }
                }
            }
            Event::Start(Tag::Strong) => bold += 1,
            Event::End(TagEnd::Strong) => bold -= 1,
            Event::Start(Tag::Emphasis) => italic += 1,
            Event::End(TagEnd::Emphasis) => italic -= 1,
            Event::Start(Tag::Strikethrough) => strike += 1,
            Event::End(TagEnd::Strikethrough) => strike -= 1,
            Event::Start(Tag::Link { dest_url, .. }) => {
                let at = inline.as_ref().map_or(0, |(_, i)| i.text.len());
                link = Some((at, dest_url.to_string()));
            }
            Event::End(TagEnd::Link) => {
                if let (Some((start, url)), Some((_, text))) = (link.take(), inline.as_mut()) {
                    text.links.push((start..text.text.len(), url));
                }
            }
            Event::Rule => {
                flush(&mut stack, &mut inline);
                if let Some(top) = stack.last_mut() {
                    top.push(Block::Rule);
                }
            }
            Event::Text(text) | Event::Code(text) | Event::Html(text) | Event::InlineHtml(text)
                if code.is_some() =>
            {
                if let Some((_, buffer)) = code.as_mut() {
                    buffer.push_str(&text);
                }
            }
            Event::Text(_) | Event::Code(_) | Event::SoftBreak | Event::HardBreak | Event::InlineHtml(_) | Event::Html(_) => {
                let (text, is_code) = match &event {
                    Event::Text(t) | Event::InlineHtml(t) | Event::Html(t) => (t.to_string(), false),
                    Event::Code(t) => (t.to_string(), true),
                    Event::SoftBreak => (" ".to_string(), false),
                    _ => ("\n".to_string(), false),
                };
                let current = inline.get_or_insert_with(|| (InlineKind::Loose, Inline::default()));
                style.bold = bold > 0;
                style.italic = italic > 0;
                style.strike = strike > 0;
                style.link = link.is_some();
                style.code = is_code;
                let start = current.1.text.len();
                current.1.text.push_str(&text);
                if style != Style::default() {
                    current.1.spans.push((start..current.1.text.len(), style));
                }
            }
            _ => {}
        }
    }
    flush(&mut stack, &mut inline);
    match stack.into_iter().next() {
        Some(Container::Root(blocks)) => blocks,
        _ => Vec::new(),
    }
}

/// Markdown, drawn.
#[derive(IntoElement)]
pub struct Markdown {
    id: ElementId,
    blocks: Vec<Block>,
}

impl Markdown {
    pub fn new(id: impl Into<ElementId>, source: &str) -> Self {
        Self { id: id.into(), blocks: parse(source) }
    }
}

impl RenderOnce for Markdown {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let colors = cx.theme().colors.clone();
        let mut path = Vec::new();
        blocks(&self.id, &mut path, &self.blocks, &colors, TextLevel::Normal)
            .text_ui(TypeSize::Body)
            .text_color(colors.text)
    }
}

#[derive(Clone, Copy)]
enum TextLevel {
    Normal,
    Quoted,
}

fn blocks(id: &ElementId, path: &mut Vec<usize>, blocks: &[Block], c: &Colors, level: TextLevel) -> gpui::Div {
    let mut column = div().flex().flex_col().gap(space::S3).min_w_0();
    for (ix, block) in blocks.iter().enumerate() {
        path.push(ix);
        let first = ix == 0;
        column = column.child(self::block(id, path, block, c, level, first));
        path.pop();
    }
    column
}

fn element_id(id: &ElementId, path: &[usize]) -> ElementId {
    let key: SharedString = path.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(".").into();
    ElementId::NamedChild(std::sync::Arc::new(id.clone()), key)
}

fn block(id: &ElementId, path: &mut Vec<usize>, block: &Block, c: &Colors, level: TextLevel, first: bool) -> AnyElement {
    let text_color = match level {
        TextLevel::Normal => c.text,
        TextLevel::Quoted => c.text_muted,
    };
    match block {
        Block::Paragraph(inline) => text(id, path, inline, c, text_color, REGULAR).into_any_element(),
        Block::Heading(n, inline) => {
            let (size, color) = match n {
                1 => (TypeSize::Title, c.text),
                2 | 3 => (TypeSize::Body, c.text),
                _ => (TypeSize::Small, c.text_muted),
            };
            div()
                .when(!first, |d| d.pt(if *n <= 2 { space::S3 } else { space::S1 }))
                .text_ui(size)
                .child(text(id, path, inline, c, color, MEDIUM))
                .into_any_element()
        }
        Block::List { start, items } => {
            let mut list = div().flex().flex_col().gap(space::S1_5);
            for (ix, item) in items.iter().enumerate() {
                path.push(ix);
                let marker: AnyElement = match (item.task, start) {
                    (Some(done), _) => checkbox(done, c).into_any_element(),
                    (None, Some(n)) => div().text_color(c.text_muted).child(format!("{}.", n + ix as u64)).into_any_element(),
                    (None, None) => div().text_color(c.text_muted).child("•").into_any_element(),
                };
                list = list.child(
                    div()
                        .flex()
                        .child(div().flex().flex_none().w(px(22.)).child(marker))
                        .child(div().flex_1().min_w_0().child(blocks(id, path, &item.blocks, c, level).gap(space::S1_5))),
                );
                path.pop();
            }
            list.into_any_element()
        }
        Block::Quote(inner) => div()
            .flex()
            .gap(space::S3)
            .child(div().w(px(2.)).flex_none().rounded(px(1.)).bg(c.border_strong))
            .child(div().flex_1().min_w_0().child(blocks(id, path, inner, c, TextLevel::Quoted)))
            .into_any_element(),
        Block::Code { language, code } => {
            CodeBlock::new(element_id(id, path), code.clone()).language(language.clone()).into_any_element()
        }
        Block::Rule => div().h(px(1.)).my(space::S1).bg(c.border).into_any_element(),
        Block::Table { header, rows } => {
            let cell = |path: &mut Vec<usize>, inline: &Inline, weight: FontWeight| {
                div().flex_1().min_w_0().px(space::S3).py(space::S1_5).child(text(id, path, inline, c, c.text, weight))
            };
            let mut table = div()
                .flex()
                .flex_col()
                .rounded(radius::NAV)
                .border_1()
                .border_color(c.border)
                .overflow_hidden()
                .text_ui(TypeSize::Small);
            path.push(0);
            let mut head = div().flex().bg(c.sunken).border_b_1().border_color(c.border);
            for (ix, inline) in header.iter().enumerate() {
                path.push(ix);
                head = head.child(cell(path, inline, MEDIUM));
                path.pop();
            }
            path.pop();
            table = table.child(head);
            for (r, row) in rows.iter().enumerate() {
                path.push(r + 1);
                let mut line = div().flex().when(r + 1 != rows.len(), |d| d.border_b_1().border_color(c.border));
                for (ix, inline) in row.iter().enumerate() {
                    path.push(ix);
                    line = line.child(cell(path, inline, REGULAR));
                    path.pop();
                }
                path.pop();
                table = table.child(line);
            }
            table.into_any_element()
        }
    }
}

fn checkbox(done: bool, c: &Colors) -> impl IntoElement {
    let bx = div()
        .mt(px(3.))
        .size(px(14.))
        .rounded(px(4.))
        .flex()
        .items_center()
        .justify_center();
    if done {
        bx.bg(c.accent).child(Icon::new(IconName::Check).color(c.text_on_accent).size(crate::icon::IconSize::Nav))
    } else {
        bx.border_1().border_color(c.border_strong)
    }
}

/// Runs for an inline: the UI font, with bold, italic, struck, linked and code stretches.
pub fn inline_runs(inline: &Inline, c: &Colors, color: Hsla, weight: FontWeight) -> Vec<TextRun> {
    let base = gpui::Font { family: UI_FONT.into(), weight, ..gpui::font(UI_FONT) };
    let mut runs = Vec::new();
    let mut at = 0;
    let plain = |len: usize| TextRun {
        len,
        font: base.clone(),
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    for (range, style) in &inline.spans {
        if range.start < at {
            continue;
        }
        if range.start > at {
            runs.push(plain(range.start - at));
        }
        let mut font = base.clone();
        if style.bold {
            // Kuvo's type has two weights; strong text takes the heavier.
            font.weight = MEDIUM;
        }
        if style.italic {
            font.style = FontStyle::Italic;
        }
        if style.code {
            font.family = MONO_FONT.into();
            font.weight = REGULAR;
        }
        runs.push(TextRun {
            len: range.end - range.start,
            font,
            color: if style.link { c.accent } else { color },
            background_color: style.code.then_some(c.inline_code),
            underline: None,
            strikethrough: style.strike.then(|| StrikethroughStyle { thickness: px(1.), color: Some(color) }),
        });
        at = range.end;
    }
    if at < inline.text.len() {
        runs.push(plain(inline.text.len() - at));
    }
    runs
}

fn text(id: &ElementId, path: &[usize], inline: &Inline, c: &Colors, color: Hsla, weight: FontWeight) -> AnyElement {
    let runs = inline_runs(inline, c, color, weight);
    let styled = StyledText::new(inline.text.clone()).with_runs(runs);
    if inline.links.is_empty() {
        return styled.into_any_element();
    }
    let ranges: Vec<Range<usize>> = inline.links.iter().map(|(r, _)| r.clone()).collect();
    let urls: Vec<String> = inline.links.iter().map(|(_, u)| u.clone()).collect();
    InteractiveText::new(element_id(id, path), styled)
        .on_click(ranges, move |ix, _, cx| cx.open_url(&urls[ix]))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(blocks: &[Block], ix: usize) -> &Inline {
        match &blocks[ix] {
            Block::Paragraph(inline) => inline,
            other => panic!("expected a paragraph, got {other:?}"),
        }
    }

    #[test]
    fn inline_styles_and_links_land_on_the_right_words() {
        let blocks = parse("Run **the tests** with `cargo test`, see [the docs](https://kuvo.run) or ~~not~~.");
        let p = para(&blocks, 0);
        assert_eq!(p.text, "Run the tests with cargo test, see the docs or not.");
        let styled = |word: &str| {
            let start = p.text.find(word).unwrap();
            p.spans.iter().find(|(r, _)| r.start == start).map(|(_, s)| *s).unwrap_or_default()
        };
        assert!(styled("the tests").bold);
        assert!(styled("cargo test").code);
        assert!(styled("the docs").link);
        assert!(styled("not").strike);
        assert_eq!(p.links, vec![(35..43, "https://kuvo.run".to_string())]);
    }

    #[test]
    fn lists_nest_and_carry_tasks() {
        let blocks = parse("1. First\n2. Second\n   - inner\n\n- [x] done\n- [ ] to do\n");
        let Block::List { start: Some(1), items } = &blocks[0] else { panic!("{blocks:?}") };
        assert_eq!(items.len(), 2);
        assert!(matches!(&items[1].blocks[1], Block::List { start: None, .. }));
        let Block::List { items: tasks, .. } = &blocks[1] else { panic!() };
        assert_eq!(tasks.iter().map(|i| i.task).collect::<Vec<_>>(), vec![Some(true), Some(false)]);
    }

    #[test]
    fn quotes_code_tables_and_headings() {
        let blocks = parse("# Plan\n\n> Keep what was typed.\n\n```rust\nfn main() {}\n```\n\n| File | Change |\n|---|---|\n| Form.tsx | +17 −35 |\n");
        assert!(matches!(&blocks[0], Block::Heading(1, i) if i.text == "Plan"));
        assert!(matches!(&blocks[1], Block::Quote(inner) if matches!(&inner[0], Block::Paragraph(i) if i.text == "Keep what was typed.")));
        assert!(matches!(&blocks[2], Block::Code { language, code } if language == "rust" && code == "fn main() {}\n"));
        let Block::Table { header, rows } = &blocks[3] else { panic!() };
        assert_eq!(header.iter().map(|i| i.text.as_str()).collect::<Vec<_>>(), vec!["File", "Change"]);
        assert_eq!(rows[0][1].text, "+17 −35");
    }

    /// Half a message, as it arrives while streaming, still parses and shows what's there.
    #[test]
    fn unfinished_markdown_shows_as_written() {
        let blocks = parse("Here is **the fix and\n\n```ts\nconst a");
        assert_eq!(para(&blocks, 0).text, "Here is **the fix and");
        assert!(matches!(&blocks[1], Block::Code { code, .. } if code == "const a"));
    }
}
