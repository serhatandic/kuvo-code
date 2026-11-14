//! A conversation's rows: which of the box's messages show, and how each is drawn. Your messages
//! by their parts (what you wrote, the keyword it went with, who it's from, files it names), the
//! agent's steps as their words (Markdown), thinking and tool steps as quiet rows, the end of each
//! turn as how long it worked. What's only for the agent (the box's notes, a switch of mode) shows
//! nothing.

use std::collections::HashSet;
use std::rc::Rc;

use gpui::{
    AnyElement, App, InteractiveElement, IntoElement, ParentElement, SharedString, StatefulInteractiveElement, Styled, div,
    prelude::FluentBuilder as _, px, relative,
};
use kuvo_box::messages::{Content, Message, Step};
use kuvo_box::{Conversation, Parts};
use kuvo_ui::{
    ActiveTheme, Icon, IconName, IconSize, StyledType, TypeSize,
    markdown::Markdown,
    output::{DiffView, OutputWell, parse_patch},
    small::{Chip, ChipTone, spinner},
    theme::{radius, space},
};
use serde_json::Value;

use crate::time;

/// One row of the conversation.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    /// The way back to earlier messages: they load as it comes into view.
    Earlier,
    /// One of its messages (boxed: a message is large, and most rows are one).
    Message(Box<Message>),
    /// How long a turn worked, or how it ended, at its end.
    TurnEnd { id: String, outcome: String, worked: Option<f64> },
    /// A run under way, after what it has said so far.
    Working,
}

impl Entry {
    /// What it's known by from one read to the next.
    pub fn key(&self) -> &str {
        match self {
            Entry::Earlier => "earlier",
            Entry::Working => "working",
            Entry::Message(message) => message.id(),
            Entry::TurnEnd { id, .. } => id,
        }
    }
}

/// The rows of `conversation`, oldest first, each with its revision (it goes up as its message
/// changes, so only what changed is drawn again). Its messages are moved into them, not copied.
pub fn entries(mut conversation: Conversation) -> (Vec<Entry>, Vec<u64>) {
    let mut rows = Vec::new();
    let mut revisions = Vec::new();
    if conversation.earlier.is_some() {
        rows.push(Entry::Earlier);
        revisions.push(0);
    }
    // A turn's length counts from its first message, as the Mac's does.
    let mut asked_at: Option<f64> = None;
    for message in std::mem::take(&mut conversation.messages) {
        let revision = conversation.revision(message.id());
        let row = match &message {
            Message::User(user) if user.is_box_note() => None,
            Message::User(user) => {
                asked_at.get_or_insert(user.time.created);
                Some(Entry::Message(Box::new(message)))
            }
            Message::Assistant(step) if shows(step) => Some(Entry::Message(Box::new(message))),
            Message::System(note) if !note.text.trim().is_empty() => Some(Entry::Message(Box::new(message))),
            Message::Shell(_) => Some(Entry::Message(Box::new(message))),
            Message::Idle { id, time, outcome } => {
                let worked = asked_at.take().map(|asked| time.created - asked).filter(|worked| *worked > 0.0);
                Some(Entry::TurnEnd { id: id.clone(), outcome: outcome.clone(), worked })
            }
            _ => None,
        };
        if let Some(row) = row {
            rows.push(row);
            revisions.push(revision);
        }
    }
    if conversation.running {
        rows.push(Entry::Working);
        revisions.push(0);
    }
    (rows, revisions)
}

/// Whether a step has anything to show: words, thinking, a tool step, or an error.
fn shows(step: &Step) -> bool {
    step.error.is_some()
        || step.content.iter().any(|content| match content {
            Content::Text(text) => !text.trim().is_empty(),
            Content::Reasoning { .. } | Content::Tool { .. } => true,
            Content::Other { .. } => false,
        })
}

/// The widest a conversation's column gets: it stays readable in a wide window.
pub const COLUMN: f32 = 720.;

/// What's opened in a conversation, each by its step's id and which of the step's blocks it is:
/// a thinking block, a tool step showing what it printed or changed, or that output (or one of its
/// files' changes) shown whole rather than folded.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Fold {
    Thinking(String, usize),
    Step(String, usize),
    Whole(String, usize, usize),
}

impl Fold {
    /// The step it's in, whose row is drawn again as it changes.
    pub fn step(&self) -> &str {
        match self {
            Fold::Thinking(step, _) | Fold::Step(step, _) | Fold::Whole(step, _, _) => step,
        }
    }
}

/// Draws row `ix`. `open`: what's opened; `toggle` opens or closes one.
pub fn render(
    ix: usize,
    entry: &Entry,
    open: &HashSet<Fold>,
    toggle: impl Fn(Fold, &mut App) + Clone + 'static,
    earlier: AnyElement,
    cx: &App,
) -> AnyElement {
    let body: AnyElement = match entry {
        Entry::Earlier => earlier,
        Entry::Message(message) => match message.as_ref() {
            Message::User(user) => user_message(ix, &user.parts(), cx),
            Message::Assistant(step) => agent_step(step, open, toggle, cx),
            Message::System(note) => quiet_line(note.text.lines().next().unwrap_or("").to_owned(), cx),
            Message::Shell(run) => shell_run(run, cx),
            _ => div().into_any_element(),
        },
        Entry::TurnEnd { outcome, worked, .. } => turn_end(outcome, *worked, cx),
        Entry::Working => working(cx),
    };
    // Each row is centred in a readable column and spaced from the next.
    let last_gap = if matches!(entry, Entry::Working) { space::S8 } else { space::S5 };
    let selector = format!("entry-{}", entry.key());
    div()
        .debug_selector(move || selector)
        .w_full()
        .flex()
        .justify_center()
        .px(space::S6)
        .pb(last_gap)
        .when(ix == 0, |d| d.pt(space::S6))
        .child(div().w_full().max_w(px(COLUMN)).child(body))
        .into_any_element()
}

fn user_message(ix: usize, parts: &Parts, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    // What went with it, above it: the keyword it was sent with as typed, who wrote it.
    let mut above: Vec<AnyElement> = Vec::new();
    if let Some(mail) = &parts.mail {
        above.push(div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(format!("From &{}", mail.name)).into_any_element());
    }
    if parts.phone {
        above.push(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child("From iPhone").into_any_element());
    }
    if let Some(widget) = &parts.widget {
        let said = if widget.is_empty() { "Answers a widget".to_owned() } else { format!("Answers “{widget}”") };
        above.push(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(said).into_any_element());
    }
    let keyword = parts.keyword.clone().map(|keyword| Chip::new(("keyword", ix), keyword).icon(IconName::Sparkle).tone(ChipTone::Accent));
    let mut below: Vec<AnyElement> = Vec::new();
    for (n, path) in parts.paths.iter().enumerate() {
        below.push(Chip::new(("path", ix * 1000 + n), short_path(path)).icon(IconName::File).into_any_element());
    }
    if !parts.comments.is_empty() {
        let count = parts.comments.len();
        below.push(Chip::new(("comments", ix), if count == 1 { "1 comment on the changes".to_owned() } else { format!("{count} comments on the changes") }).icon(IconName::Message).into_any_element());
    }
    for (n, agent) in parts.agents.iter().enumerate() {
        below.push(Chip::new(("named", ix * 1000 + n), format!("&{}", agent.name)).icon(IconName::Bot).into_any_element());
    }
    let words = parts.words.trim().to_owned();
    div()
        .flex()
        .flex_col()
        .items_end()
        .gap(space::S1_5)
        .children(above)
        .child(
            div()
                .max_w(relative(0.78))
                .flex()
                .flex_col()
                .items_end()
                .gap(space::S1_5)
                .children(keyword)
                .when(!words.is_empty(), |d| {
                    d.child(
                        div()
                            .px(space::S4)
                            .py(px(10.))
                            .rounded(radius::CARD)
                            .bg(c.sunken)
                            .text_ui(TypeSize::Body)
                            .text_color(c.text)
                            .child(words),
                    )
                }),
        )
        .when(!below.is_empty(), |d| d.child(div().flex().flex_wrap().justify_end().gap(space::S1).children(below)))
        .into_any_element()
}

fn agent_step(step: &Step, open: &HashSet<Fold>, toggle: impl Fn(Fold, &mut App) + Clone + 'static, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let chevron = |opened: bool| Icon::new(if opened { IconName::ChevronDown } else { IconName::ChevronRight }).size(IconSize::Nav).color(c.text_faint);
    let mut blocks: Vec<AnyElement> = Vec::new();
    for (n, content) in step.content.iter().enumerate() {
        let key = format!("{}:{n}", step.id);
        match content {
            Content::Text(text) if !text.trim().is_empty() => {
                blocks.push(div().child(Markdown::new(SharedString::from(key), text)).into_any_element());
            }
            Content::Reasoning { text, done } => {
                let fold = Fold::Thinking(step.id.clone(), n);
                let opened = open.contains(&fold);
                let toggle = toggle.clone();
                let label = if *done { "Thought" } else { "Thinking" };
                let row = step_row(SharedString::from(format!("think-{key}")), IconName::Sparkle, label.into(), None, !*done, false, cx)
                    .cursor_pointer()
                    .hover(|s| s.opacity(0.8))
                    .on_click(move |_, _, cx| toggle(fold.clone(), cx))
                    .child(chevron(opened));
                blocks.push(
                    div()
                        .flex()
                        .flex_col()
                        .gap(space::S1)
                        .child(row)
                        .when(opened && !text.trim().is_empty(), |d| {
                            d.child(
                                div()
                                    .ml(px(7.))
                                    .pl(space::S3)
                                    .border_l_1()
                                    .border_color(c.border_strong)
                                    .text_ui(TypeSize::Small)
                                    .text_color(c.text_muted)
                                    .child(text.trim().to_owned()),
                            )
                        })
                        .into_any_element(),
                );
            }
            Content::Tool { name, state, .. } => {
                let status = state.get("status").and_then(Value::as_str).unwrap_or("");
                let busy = matches!(status, "running" | "streaming" | "pending");
                let failed = status == "failed" || status == "error";
                let (icon, label, target) = tool_label(name, state, busy);
                let shown = details(name, state);
                let fold = Fold::Step(step.id.clone(), n);
                let opened = shown.is_some() && open.contains(&fold);
                let mut row = step_row(SharedString::from(format!("tool-{key}")), icon, label, target, busy, failed, cx);
                // One with something to show opens to it.
                if let Some(shown) = &shown {
                    let toggle = toggle.clone();
                    let fold = fold.clone();
                    row = row
                        .cursor_pointer()
                        .hover(|s| s.opacity(0.8))
                        .on_click(move |_, _, cx| toggle(fold.clone(), cx))
                        .children(shown.counts().map(|(added, removed)| counts(added, removed, cx)))
                        .child(chevron(opened));
                }
                blocks.push(row.into_any_element());
                if failed && let Some(error) = tool_error(state) {
                    blocks.push(div().ml(px(22.)).text_ui(TypeSize::Caption).text_color(c.danger).child(first_line(&error)).into_any_element());
                }
                if let (true, Some(shown)) = (opened, shown) {
                    blocks.push(div().ml(px(22.)).child(details_view(&key, step, n, shown, open, toggle.clone())).into_any_element());
                }
            }
            _ => {}
        }
    }
    if let Some(error) = &step.error {
        blocks.push(callout(error_words(error), cx));
    }
    div().flex().flex_col().gap(space::S2).children(blocks).into_any_element()
}

/// "+12 −3", beside a step that changed files.
fn counts(added: usize, removed: usize, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .flex_none()
        .gap(space::S1)
        .text_ui(TypeSize::Caption)
        .child(div().text_color(c.diff_added).child(format!("+{added}")))
        .child(div().text_color(c.diff_removed).child(format!("−{removed}")))
        .into_any_element()
}

/// What a tool step shows when it's opened.
#[derive(Clone, Debug, PartialEq)]
pub enum Details {
    /// What it printed or found: a command's output (with the command), a search's results.
    Output { command: Option<String>, text: String },
    /// The files it changed, each as a diff.
    Changes(Vec<Changed>),
}

/// One file a step changed, as the engine says it (`metadata.files`).
#[derive(Clone, Debug, PartialEq)]
pub struct Changed {
    pub file: String,
    /// Added or deleted (a modified file says nothing).
    pub status: Option<String>,
    pub added: usize,
    pub removed: usize,
    /// Its unified patch, read into lines only once it's shown.
    pub patch: Rc<str>,
}

impl Details {
    /// Lines added and removed, for a step that changed files.
    pub fn counts(&self) -> Option<(usize, usize)> {
        match self {
            Details::Changes(files) => Some(files.iter().fold((0, 0), |(a, r), file| (a + file.added, r + file.removed))),
            Details::Output { .. } => None,
        }
    }
}

/// What a step printed, as the engine keeps it: its text blocks (`state.content`), one after another.
fn printed(state: &Value) -> String {
    let blocks = state.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let texts: Vec<&str> = blocks.iter().filter(|block| block.get("type").and_then(Value::as_str) == Some("text")).filter_map(|block| block.get("text").and_then(Value::as_str)).collect();
    texts.join("\n")
}

/// Why a step failed, as the engine says it.
fn tool_error(state: &Value) -> Option<String> {
    let error = state.get("error")?;
    error.as_str().map(str::to_owned).or_else(|| error.get("message").and_then(Value::as_str).map(str::to_owned))
}

/// What a tool step shows when it's opened (none: it has nothing to show, and doesn't open): the
/// files it changed, as diffs; a command's output; a search's results. As the Mac's step rows show
/// them; a file read, or a step that's still running, shows nothing more.
pub fn details(name: &str, state: &Value) -> Option<Details> {
    let status = state.get("status").and_then(Value::as_str).unwrap_or("");
    if matches!(status, "running" | "streaming" | "pending") {
        return None;
    }
    let files = state.pointer("/metadata/files").and_then(Value::as_array).cloned().unwrap_or_default();
    let changed: Vec<Changed> = files
        .iter()
        .filter_map(|file| {
            let patch = file.get("patch").and_then(Value::as_str)?;
            Some(Changed {
                file: file.get("file").and_then(Value::as_str).unwrap_or("").to_owned(),
                status: file.get("status").and_then(Value::as_str).filter(|status| *status != "modified").map(str::to_owned),
                added: file.get("additions").and_then(Value::as_u64).unwrap_or(0) as usize,
                removed: file.get("deletions").and_then(Value::as_u64).unwrap_or(0) as usize,
                patch: patch.into(),
            })
        })
        .filter(|file| file.patch.lines().any(|line| line.starts_with("@@")))
        .collect();
    if !changed.is_empty() {
        return Some(Details::Changes(changed));
    }
    let text = printed(state);
    let command = state.pointer("/input/command").and_then(Value::as_str).map(|command| command.trim().to_owned());
    match name {
        // A command shows what it printed, or that it printed nothing.
        "shell" if status == "completed" || !text.trim().is_empty() => Some(Details::Output { command, text }),
        "grep" | "glob" | "list" | "ls" | "websearch" if !text.trim().is_empty() => Some(Details::Output { command: None, text }),
        _ => None,
    }
}

/// An opened step's output or changes, each folded until it's shown whole.
fn details_view(key: &str, step: &Step, n: usize, shown: Details, open: &HashSet<Fold>, toggle: impl Fn(Fold, &mut App) + Clone + 'static) -> AnyElement {
    let whole = |part: usize| Fold::Whole(step.id.clone(), n, part);
    match shown {
        Details::Output { command, text } => {
            let fold = whole(0);
            let mut well = OutputWell::new(SharedString::from(format!("output-{key}")), text).whole(open.contains(&fold)).on_toggle(move |_, cx| toggle(fold.clone(), cx));
            if let Some(command) = command {
                well = well.command(command);
            }
            well.into_any_element()
        }
        Details::Changes(files) => {
            // The step names one file already; several get a title each, and so does one that was
            // added or deleted, which only its title says.
            let titled = files.len() > 1 || files.iter().any(|file| file.status.is_some());
            let views = files.into_iter().enumerate().map(|(part, file)| {
                let fold = whole(part);
                let toggle = toggle.clone();
                let mut view = DiffView::new(SharedString::from(format!("diff-{key}-{part}")), Rc::new(parse_patch(&file.patch))).whole(open.contains(&fold)).on_toggle(move |_, cx| toggle(fold.clone(), cx));
                if titled {
                    let title = match file.status.as_deref() {
                        Some("added") => format!("{} (new)", short_path(&file.file)),
                        Some("deleted") => format!("{} (deleted)", short_path(&file.file)),
                        _ => short_path(&file.file),
                    };
                    view = view.title(title).counts(file.added, file.removed);
                }
                view.into_any_element()
            });
            div().flex().flex_col().gap(space::S2).children(views).into_any_element()
        }
    }
}

/// A tool step or thinking, as one quiet line: its icon (or a spinner while it runs), what it did,
/// and what it did it to.
fn step_row(id: SharedString, icon: IconName, label: SharedString, target: Option<SharedString>, busy: bool, failed: bool, cx: &App) -> gpui::Stateful<gpui::Div> {
    let c = &cx.theme().colors;
    let leading: AnyElement = if busy {
        spinner(SharedString::from(format!("{id}-spin")), IconSize::Nav, c.text_muted).into_any_element()
    } else if failed {
        Icon::new(IconName::Warning).size(IconSize::Nav).color(c.danger).into_any_element()
    } else {
        Icon::new(icon).size(IconSize::Nav).color(c.text_faint).into_any_element()
    };
    let selector = id.to_string();
    div()
        .id(id)
        .debug_selector(move || selector)
        .flex()
        .items_center()
        .gap(space::S1_5)
        .min_w_0()
        .text_ui(TypeSize::Small)
        .text_color(c.text_muted)
        .child(div().flex().flex_none().w(px(16.)).justify_center().child(leading))
        .child(div().flex_none().child(label))
        .children(target.map(|target| div().min_w_0().truncate().text_mono(TypeSize::Small).text_color(c.text_faint).child(target)))
}

/// What a tool step did, in words: its icon, what it did (or does, while it runs), and to what.
pub fn tool_label(name: &str, state: &Value, busy: bool) -> (IconName, SharedString, Option<SharedString>) {
    let input = state.get("input").cloned().unwrap_or(Value::Null);
    let text = |field: &str| input.get(field).and_then(Value::as_str).map(str::to_owned);
    let file = || text("filePath").or_else(|| text("path")).map(|path| short_path(&path));
    let (icon, done, doing, target) = match name {
        "shell" => (IconName::Terminal, "Ran", "Running", text("command").map(|command| first_line(&command))),
        "read" => (IconName::File, "Read", "Reading", file()),
        "edit" | "multiedit" | "patch" | "apply_patch" => (IconName::Compose, "Edited", "Editing", file()),
        "write" => (IconName::Compose, "Wrote", "Writing", file()),
        "grep" => (IconName::Search, "Searched for", "Searching for", text("pattern")),
        "glob" | "list" | "ls" => (IconName::Folder, "Listed", "Listing", text("pattern").or_else(|| text("path"))),
        "webfetch" => (IconName::Globe, "Read", "Reading", text("url")),
        "websearch" => (IconName::Globe, "Searched the web for", "Searching the web for", text("query")),
        "task" => (IconName::Bot, "Asked a subagent", "Asking a subagent", text("description")),
        "todowrite" | "todoread" => (IconName::Check, "Updated its plan", "Updating its plan", None),
        other => (IconName::Sliders, "Used", "Using", Some(other.to_owned())),
    };
    (icon, if busy { doing } else { done }.into(), target.map(SharedString::from))
}

/// A path as a row shows it: its last two parts.
fn short_path(path: &str) -> String {
    let parts: Vec<&str> = path.trim_end_matches('/').rsplit('/').take(2).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if text.trim().lines().count() > 1 { format!("{line} …") } else { line.to_owned() }
}

fn error_words(error: &Value) -> String {
    error
        .pointer("/data/message")
        .or_else(|| error.get("message"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| "The model stopped with an error.".into())
}

fn callout(words: String, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_start()
        .gap(space::S2)
        .px(space::S3)
        .py(space::S2)
        .rounded(radius::NAV)
        .bg(c.danger.opacity(0.08))
        .border_1()
        .border_color(c.danger.opacity(0.25))
        .text_ui(TypeSize::Small)
        .text_color(c.text)
        .child(div().pt(px(2.)).child(Icon::new(IconName::Warning).size(IconSize::Nav).color(c.danger)))
        .child(div().flex_1().child(words))
        .into_any_element()
}

fn shell_run(run: &kuvo_box::messages::ShellRun, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let busy = run.status == "running";
    let failed = run.exit.is_some_and(|exit| exit != 0);
    let exit = run.exit.filter(|exit| *exit != 0).map(|exit| format!("exit {exit}"));
    step_row(SharedString::from(format!("shell-{}", run.id)), IconName::Terminal, if busy { "Running".into() } else { "You ran".into() }, Some(first_line(&run.command).into()), busy, failed, cx)
        .children(exit.map(|exit| div().text_ui(TypeSize::Caption).text_color(c.danger).child(exit)))
        .into_any_element()
}

fn turn_end(outcome: &str, worked: Option<f64>, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let (words, color) = match outcome {
        "failed" => ("The turn didn’t finish".to_owned(), c.danger),
        "interrupted" => ("Stopped".to_owned(), c.text_faint),
        _ => (worked.map(time::worked_for).unwrap_or_default(), c.text_faint),
    };
    div().flex().justify_center().text_ui(TypeSize::Caption).text_color(color).child(words).into_any_element()
}

fn quiet_line(words: String, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div().flex().justify_center().text_ui(TypeSize::Caption).text_color(c.text_faint).child(words).into_any_element()
}

fn working(cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_center()
        .gap(space::S1_5)
        .text_ui(TypeSize::Small)
        .text_color(c.text_faint)
        .child(div().flex().w(px(16.)).justify_center().child(spinner("working", IconSize::Nav, c.text_muted)))
        .child("Working…")
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kuvo_box::Where;
    use serde_json::json;

    fn conversation(messages: Value, running: bool, earlier: Option<&str>) -> Conversation {
        let mut conversation = Conversation::new("ses_1", Where::Engine);
        let mut newest_first: Vec<Message> = serde_json::from_value(messages).unwrap();
        newest_first.reverse();
        conversation.catch_up(newest_first, earlier.map(str::to_owned), &[], Some(running));
        conversation
    }

    #[test]
    fn a_turn_shows_your_message_the_agents_step_and_how_long_it_worked() {
        let (rows, _) = entries(conversation(
            json!([
                { "type": "user", "id": "m1", "time": { "created": 1000 }, "text": "Fix it" },
                { "type": "user", "id": "m0", "time": { "created": 1500 }, "text": "for the agent", "metadata": { "kuvo": { "note": true } } },
                { "type": "user", "id": "m1b", "time": { "created": 1800 }, "text": "and the tests" },
                { "type": "assistant", "id": "m2", "time": { "created": 2000 }, "content": [] },
                { "type": "assistant", "id": "m3", "time": { "created": 3000 }, "content": [{ "type": "text", "text": "Done." }] },
                { "type": "agent-switched", "id": "m4", "time": { "created": 3500 } },
                { "type": "idle", "id": "m5", "time": { "created": 26000 }, "outcome": "succeeded" }
            ]),
            false,
            None,
        ));
        let keys: Vec<&str> = rows.iter().map(Entry::key).collect();
        // The box's note to the agent, an empty step and a switch of mode show nothing.
        assert_eq!(keys, ["m1", "m1b", "m3", "m5"]);
        // From the turn's first message.
        assert!(matches!(&rows[3], Entry::TurnEnd { worked: Some(worked), .. } if *worked == 25000.0));
    }

    #[test]
    fn a_run_under_way_ends_with_working_and_earlier_ones_start_with_the_way_back() {
        let (rows, _) = entries(conversation(json!([{ "type": "user", "id": "m1", "time": { "created": 1 }, "text": "Go" }]), true, Some("100")));
        let keys: Vec<&str> = rows.iter().map(Entry::key).collect();
        assert_eq!(keys, ["earlier", "m1", "working"]);
    }

    #[test]
    fn tool_steps_say_what_they_did_and_to_what() {
        let (_, label, target) = tool_label("read", &json!({ "status": "completed", "input": { "filePath": "/Users/sam/web/src/signup/Form.tsx" } }), false);
        assert_eq!((label.as_ref(), target.as_deref()), ("Read", Some("signup/Form.tsx")));
        let (_, label, target) = tool_label("shell", &json!({ "status": "running", "input": { "command": "npm test\nnpm run lint" } }), true);
        assert_eq!((label.as_ref(), target.as_deref()), ("Running", Some("npm test …")));
    }

    /// Every client's sample steps (`protocol/vectors/tool-steps.json`, PROTOCOL.md's "Tool
    /// steps"): each one's target, and what it opens to.
    #[test]
    fn every_sample_step_shows_its_target_and_opens_to_what_the_vectors_say() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/vectors/tool-steps.json");
        let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        for case in vectors["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let Content::Tool { name: tool, state, .. } = serde_json::from_value(case["step"].clone()).unwrap() else { panic!("{name}: not a tool step") };
            let busy = matches!(state["status"].as_str(), Some("running" | "streaming" | "pending"));
            let (_, _, target) = tool_label(&tool, &state, busy);
            assert_eq!(target.as_deref(), case["target"].as_str(), "{name}: its target");
            let opened = details(&tool, &state);
            match &case["opens"] {
                Value::String(nothing) if nothing == "nothing" => assert_eq!(opened, None, "{name}"),
                opens if opens.get("output").is_some() => {
                    let output = &opens["output"];
                    assert_eq!(opened, Some(Details::Output { command: output["command"].as_str().map(str::to_owned), text: output["text"].as_str().unwrap().to_owned() }), "{name}");
                }
                opens => {
                    let Some(Details::Changes(files)) = opened else { panic!("{name}: no changes") };
                    let shown: Vec<Value> = files.iter().map(|file| json!({ "file": file.file, "added": file.added, "removed": file.removed })).collect();
                    assert_eq!(Value::Array(shown), opens["changes"], "{name}");
                }
            }
        }
    }

    #[test]
    fn a_step_opens_to_its_changes_its_output_or_its_results_and_a_read_to_nothing() {
        let patch = "--- a\n+++ b\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n";
        let edit = json!({ "status": "completed", "metadata": { "files": [{ "file": "/p/a.ts", "patch": patch, "additions": 1, "deletions": 1, "status": "modified" }] } });
        let shown = details("edit", &edit).expect("its changes");
        assert_eq!(shown.counts(), Some((1, 1)));
        let shell = json!({ "status": "completed", "input": { "command": "npm test" }, "content": [{ "type": "text", "text": "ok" }, { "type": "text", "text": "done" }] });
        assert_eq!(details("shell", &shell), Some(Details::Output { command: Some("npm test".into()), text: "ok\ndone".into() }));
        // A command that printed nothing still says so; a search that found nothing doesn't open.
        assert!(details("shell", &json!({ "status": "completed", "input": { "command": "true" } })).is_some());
        assert!(details("grep", &json!({ "status": "completed", "content": [] })).is_none());
        assert!(details("read", &json!({ "status": "completed", "content": [{ "type": "text", "text": "file" }] })).is_none());
        assert!(details("shell", &json!({ "status": "running", "input": { "command": "npm test" } })).is_none());
    }
}
