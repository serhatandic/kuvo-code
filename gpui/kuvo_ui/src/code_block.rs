//! Code blocks: highlighted code in a card, with optional line numbers and a Copy button that
//! turns into "Copied" for two seconds. Long lines scroll sideways rather than wrap.
//!
//! Highlighting uses tree-sitter's grammars and their own highlight queries (all MIT), mapped
//! onto the theme's syntax colours. Unknown languages are shown plain.

use std::{
    collections::HashMap,
    ops::Range,
    sync::{LazyLock, Mutex},
    time::Duration,
};

use gpui::{
    App, ClipboardItem, ElementId, Hsla, InteractiveElement, IntoElement,
    ParentElement, RenderOnce, SharedString, StatefulInteractiveElement, Styled, StyledText,
    TextRun, Window, div, px,
};
use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

use crate::{
    button::{Button, ButtonSize},
    icon::IconName,
    theme::{ActiveTheme, MONO_FONT, StyledType, Syntax, TypeSize, radius, space},
};

/// What a stretch of code is, as far as colour goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Comment,
    Keyword,
    String,
    Number,
    Function,
    Type,
    Constant,
    Property,
    Punctuation,
}

/// The capture names we colour, most specific first within a family. tree-sitter matches each
/// query capture (`function.method`, `string.special`) to the longest of these it starts with.
const NAMES: &[(&str, Kind)] = &[
    ("comment", Kind::Comment),
    ("keyword", Kind::Keyword),
    ("operator", Kind::Punctuation),
    ("string", Kind::String),
    ("escape", Kind::Constant),
    ("number", Kind::Number),
    ("constant.builtin", Kind::Constant),
    ("constant", Kind::Constant),
    ("boolean", Kind::Constant),
    ("function", Kind::Function),
    ("constructor", Kind::Type),
    ("type", Kind::Type),
    ("attribute", Kind::Property),
    ("property", Kind::Property),
    ("label", Kind::Property),
    ("tag", Kind::Keyword),
    ("variable.builtin", Kind::Keyword),
    ("punctuation", Kind::Punctuation),
];

fn config(
    language: tree_sitter::Language,
    name: &str,
    highlights: &str,
    injections: &str,
    locals: &str,
) -> Option<HighlightConfiguration> {
    let mut config = HighlightConfiguration::new(language, name, highlights, injections, locals).ok()?;
    let names: Vec<&str> = NAMES.iter().map(|(n, _)| *n).collect();
    config.configure(&names);
    Some(config)
}

/// The grammar a fenced block's language names, if we have it.
fn canonical(language: &str) -> Option<&'static str> {
    Some(match language {
        "rust" | "rs" => "rust",
        "typescript" | "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "javascript" | "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "python" | "py" => "python",
        "json" | "jsonc" => "json",
        "bash" | "sh" | "shell" | "zsh" | "console" => "bash",
        "go" | "golang" => "go",
        _ => return None,
    })
}

/// The grammars, built once, by canonical name.
static CONFIGS: LazyLock<HashMap<&'static str, HighlightConfiguration>> = LazyLock::new(|| {
    use tree_sitter_javascript as js;
    use tree_sitter_typescript as ts;
    let js_highlights = format!("{}\n{}", js::JSX_HIGHLIGHT_QUERY, js::HIGHLIGHT_QUERY);
    let ts_highlights = format!("{}\n{}", ts::HIGHLIGHTS_QUERY, js::HIGHLIGHT_QUERY);
    let tsx_highlights = format!("{ts_highlights}\n{}", js::JSX_HIGHLIGHT_QUERY);
    [
        ("rust", config(tree_sitter_rust::LANGUAGE.into(), "rust", tree_sitter_rust::HIGHLIGHTS_QUERY, "", "")),
        ("typescript", config(ts::LANGUAGE_TYPESCRIPT.into(), "typescript", &ts_highlights, "", ts::LOCALS_QUERY)),
        ("tsx", config(ts::LANGUAGE_TSX.into(), "tsx", &tsx_highlights, "", ts::LOCALS_QUERY)),
        ("javascript", config(js::LANGUAGE.into(), "javascript", &js_highlights, "", js::LOCALS_QUERY)),
        ("python", config(tree_sitter_python::LANGUAGE.into(), "python", tree_sitter_python::HIGHLIGHTS_QUERY, "", "")),
        ("json", config(tree_sitter_json::LANGUAGE.into(), "json", tree_sitter_json::HIGHLIGHTS_QUERY, "", "")),
        ("bash", config(tree_sitter_bash::LANGUAGE.into(), "bash", tree_sitter_bash::HIGHLIGHT_QUERY, "", "")),
        ("go", config(tree_sitter_go::LANGUAGE.into(), "go", tree_sitter_go::HIGHLIGHTS_QUERY, "", "")),
    ]
    .into_iter()
    .filter_map(|(name, config)| Some((name, config?)))
    .collect()
});

/// Highlights already worked out, by language and text, so a block drawn again unchanged isn't
/// parsed again. (A streaming block is new text each time and is parsed each time; the cache
/// is simply emptied when it grows past 256 entries.)
/// Highlighted spans, by the code's language and a hash of it.
type Spans = HashMap<(String, u64), Vec<(Range<usize>, Kind)>>;

static CACHE: LazyLock<Mutex<Spans>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The coloured stretches of `code` in `language`; empty for languages we don't know.
pub fn highlight(code: &str, language: &str) -> Vec<(Range<usize>, Kind)> {
    use std::hash::{Hash, Hasher};
    let Some(language) = canonical(&language.trim().to_ascii_lowercase()) else {
        return Vec::new();
    };
    let Some(config) = CONFIGS.get(language) else {
        return Vec::new();
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    code.hash(&mut hasher);
    let key = (language.to_string(), hasher.finish());
    if let Some(found) = CACHE.lock().ok().and_then(|cache| cache.get(&key).cloned()) {
        return found;
    }
    let mut spans = Vec::new();
    let mut highlighter = Highlighter::new();
    if let Ok(events) = highlighter.highlight(config, code.as_bytes(), None, None, |_| None) {
        let mut stack: Vec<Kind> = Vec::new();
        for event in events.flatten() {
            match event {
                HighlightEvent::HighlightStart(h) => stack.push(NAMES[h.0].1),
                HighlightEvent::HighlightEnd => {
                    stack.pop();
                }
                HighlightEvent::Source { start, end } => {
                    if let Some(kind) = stack.last() {
                        spans.push((start..end, *kind));
                    }
                }
            }
        }
    }
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() > 256 {
            cache.clear();
        }
        cache.insert(key, spans.clone());
    }
    spans
}

fn color(kind: Kind, syntax: &Syntax) -> Hsla {
    match kind {
        Kind::Comment => syntax.comment,
        Kind::Keyword => syntax.keyword,
        Kind::String => syntax.string,
        Kind::Number => syntax.number,
        Kind::Function => syntax.function,
        Kind::Type => syntax.type_name,
        Kind::Constant => syntax.constant,
        Kind::Property => syntax.property,
        Kind::Punctuation => syntax.punctuation,
    }
}

/// Text runs colouring `code`, gaps in the plain colour.
pub fn runs(code: &str, language: &str, syntax: &Syntax) -> Vec<TextRun> {
    let font = gpui::font(MONO_FONT);
    let run = |len: usize, color: Hsla| TextRun {
        len,
        font: font.clone(),
        color,
        background_color: None,
        underline: None,
        strikethrough: None,
    };
    let mut runs = Vec::new();
    let mut at = 0;
    for (range, kind) in highlight(code, language) {
        if range.start < at {
            continue;
        }
        if range.start > at {
            runs.push(run(range.start - at, syntax.plain));
        }
        runs.push(run(range.end - range.start, color(kind, syntax)));
        at = range.end;
    }
    if at < code.len() {
        runs.push(run(code.len() - at, syntax.plain));
    }
    runs
}

/// Whether a code block's Copy button has just been used. Each click counts, so only the
/// latest click's timer turns "Copied" back into "Copy".
struct Copied {
    shown: bool,
    clicks: u64,
}

/// A code block.
#[derive(IntoElement)]
pub struct CodeBlock {
    id: ElementId,
    code: SharedString,
    language: Option<SharedString>,
    line_numbers: bool,
    /// Drawn without its header (the language and Copy), for one-line snippets.
    compact: bool,
    /// Shows the Copy button as just used (for the gallery and tests).
    shown_copied: bool,
}

impl CodeBlock {
    pub fn new(id: impl Into<ElementId>, code: impl Into<SharedString>) -> Self {
        Self { id: id.into(), code: code.into(), language: None, line_numbers: false, compact: false, shown_copied: false }
    }

    pub fn language(mut self, language: impl Into<SharedString>) -> Self {
        let language: SharedString = language.into();
        self.language = (!language.is_empty()).then_some(language);
        self
    }

    pub fn line_numbers(mut self, show: bool) -> Self {
        self.line_numbers = show;
        self
    }

    pub fn compact(mut self) -> Self {
        self.compact = true;
        self
    }

    pub fn shown_copied(mut self) -> Self {
        self.shown_copied = true;
        self
    }
}

impl RenderOnce for CodeBlock {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme().clone();
        let c = &theme.colors;
        // Trailing newlines from a fence would draw an empty last line.
        let code: SharedString = self.code.trim_end_matches('\n').to_string().into();
        let language = self.language.clone().unwrap_or_default();
        let runs = runs(&code, &language, &c.syntax);
        let line_count = code.split('\n').count().max(1);

        let copied = window.use_keyed_state(self.id.clone(), cx, |_, _| Copied { shown: false, clicks: 0 });
        let is_copied = copied.read(cx).shown || self.shown_copied;
        let copy_text = code.clone();
        let copy_state = copied.clone();
        let copy = Button::new(
            (self.id.clone(), "copy"),
            if is_copied { "Copied" } else { "Copy" },
        )
        .icon(if is_copied { IconName::Check } else { IconName::Copy })
        .ghost()
        .size(ButtonSize::Small)
        .on_click(move |_, _, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(copy_text.to_string()));
            let click = copy_state.update(cx, |state, cx| {
                state.shown = true;
                state.clicks += 1;
                cx.notify();
                state.clicks
            });
            let state = copy_state.clone();
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                state.update(cx, |state, cx| {
                    if state.clicks == click {
                        state.shown = false;
                        cx.notify();
                    }
                });
            })
            .detach();
        });

        let gutter = self.line_numbers.then(|| {
            let numbers: String = (1..=line_count).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
            div()
                .flex_none()
                .pr(space::S4)
                .text_right()
                .text_color(c.syntax.line_number)
                .child(numbers)
        });

        let header = (!self.compact).then(|| {
            div()
                .flex()
                .items_center()
                .justify_between()
                .h(px(32.))
                .pl(space::S4)
                .pr(space::S1)
                .border_b_1()
                .border_color(c.border)
                .child(
                    div()
                        .text_ui(TypeSize::Caption)
                        .text_color(c.text_faint)
                        .child(self.language.clone().unwrap_or_else(|| "Text".into())),
                )
                .child(copy)
        });

        div()
            .flex()
            .flex_col()
            .w_full()
            .rounded(radius::CARD)
            .border_1()
            .border_color(c.border)
            .bg(c.sunken)
            .overflow_hidden()
            .children(header)
            .child(
                // The padding is on the content, not the scrolling area, so the last characters
                // keep their margin when scrolled to the end.
                div()
                    .id(self.id.clone())
                    .flex()
                    .w_full()
                    .overflow_x_scroll()
                    .text_mono(TypeSize::Body)
                    .whitespace_nowrap()
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .px(space::S4)
                            .py(space::S3)
                            .children(gutter)
                            .child(div().flex_none().child(StyledText::new(code).with_runs(runs))),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keywords, strings, functions and comments come out coloured, each the kind it is.
    #[test]
    fn rust_is_highlighted_by_kind() {
        let code = "// Keep what was typed\nfn keep(name: &str) -> String { name.to_string() }";
        let spans = highlight(code, "rust");
        let kind_of = |text: &str| {
            let start = code.find(text).unwrap();
            spans.iter().find(|(r, _)| r.start == start).map(|(_, k)| *k)
        };
        assert_eq!(kind_of("// Keep"), Some(Kind::Comment));
        assert_eq!(kind_of("fn "), Some(Kind::Keyword));
        assert_eq!(kind_of("keep("), Some(Kind::Function));
        assert_eq!(kind_of("String"), Some(Kind::Type));
    }

    #[test]
    fn every_alias_highlights_and_unknown_languages_are_plain() {
        for language in ["rs", "ts", "tsx", "js", "py", "json", "sh", "go", "TypeScript"] {
            assert!(!highlight("let x = \"a\" // b\n", language).is_empty() || language == "json", "{language}");
        }
        assert!(highlight("{\"a\": 1}", "json").iter().any(|(_, k)| *k == Kind::Number));
        assert!(highlight("anything", "cobol").is_empty());
    }

    /// The runs cover the code exactly, so nothing is drawn twice or left out.
    #[test]
    fn runs_cover_the_code() {
        let code = "export function save(form: Form) {\n  return api.post('/accounts', form);\n}";
        let syntax = crate::theme::Colors::light().syntax;
        let total: usize = runs(code, "ts", &syntax).iter().map(|r| r.len).sum();
        assert_eq!(total, code.len());
    }
}
