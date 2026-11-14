//! What a conversation waits on you for, as a card in the composer's place (as the Mac and the
//! phone show it): a permission with what it would run or change and its numbered answers, or the
//! agent's questions one at a time with their choices and a line for your own words. Each is drawn
//! as the box words it (`sessions.asks`), and answered through the box. Where more than one waits,
//! "2 of 3" pages through them; the one shown stays while others come and go (KuvoClient's
//! `AskPlace`).

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyDownEvent,
    ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Task, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::BoxClient;
use kuvo_box::asks::{Answer, Ask, Asks, Permission, Question};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, Icon, IconName, IconSize, StyledType, TextField, TextFieldEvent, TypeSize,
    button::keycap,
    output::{DiffView, OutputWell, parse_patch},
    theme::{radius, space},
};

/// How long the card shown stays still before its keys answer.
pub const QUIET: std::time::Duration = std::time::Duration::from_millis(600);

/// Which ask shows, one at a time, and where it is among them: it stays while it waits, whatever
/// comes meanwhile; once it's answered, the next after it shows (or, after the last, the one
/// before). As KuvoClient's `AskPlace`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AskPlace {
    shown: Option<String>,
    waiting: Vec<String>,
}

impl AskPlace {
    /// The asks waiting now, in their order.
    pub fn update(&mut self, now: Vec<String>) {
        let was = std::mem::replace(&mut self.waiting, now);
        let now = &self.waiting;
        if now.is_empty() {
            self.shown = None;
            return;
        }
        if self.shown.as_ref().is_some_and(|shown| now.contains(shown)) {
            return;
        }
        let at = self.shown.as_ref().and_then(|shown| was.iter().position(|id| id == shown));
        self.shown = match at {
            Some(at) => was[at + 1..].iter().find(|id| now.contains(id)).or_else(|| was[..at].iter().rev().find(|id| now.contains(id))).cloned().or_else(|| now.first().cloned()),
            None => now.first().cloned(),
        };
    }

    pub fn show(&mut self, index: usize) {
        if let Some(id) = self.waiting.get(index) {
            self.shown = Some(id.clone());
        }
    }

    pub fn shown(&self) -> Option<&str> {
        self.shown.as_deref()
    }

    pub fn index(&self) -> Option<usize> {
        self.shown.as_ref().and_then(|shown| self.waiting.iter().position(|id| id == shown))
    }

    pub fn count(&self) -> usize {
        self.waiting.len()
    }

    /// "2 of 3", where more than one waits.
    pub fn words(&self) -> Option<String> {
        let index = self.index()?;
        (self.waiting.len() > 1).then(|| format!("{} of {}", index + 1, self.waiting.len()))
    }
}

/// One numbered answer on a card: its number, its words, what Always names (as code), and for a
/// question that takes several, whether it's picked.
struct AnswerRow {
    id: SharedString,
    number: usize,
    title: String,
    named: Option<String>,
    checked: Option<bool>,
}

pub struct AskCard {
    client: BoxClient,
    session: String,
    asks: Vec<Ask>,
    place: AskPlace,
    /// A question's: which of its questions shows, and what's picked for each (by its key).
    question: usize,
    picked: HashMap<String, Vec<String>>,
    /// The line for your own words: a permission's "Tell It What to Do Instead…", or a question's
    /// own answer. Open while it shows.
    words: Entity<TextField>,
    instead: bool,
    /// An answer on its way, by its ask.
    answering: Option<String>,
    /// Why the last answer didn't go, and which ask it was for (said only on that one).
    failed: Option<String>,
    failed_for: Option<String>,
    /// Since when the card shown has been still: its keys answer only once it's been a moment
    /// ([`QUIET`]), so a key meant for the one before it (or for the composer it took the place of)
    /// never answers it, as the Mac's `KeysTyped` holds them.
    quiet_since: Option<std::time::Instant>,
    focus: FocusHandle,
    tasks: Vec<Task<()>>,
    _words: Subscription,
}

impl Focusable for AskCard {
    /// The card itself as it comes (its line takes the keyboard only once it's clicked, or Instead
    /// opens it), so what you were typing elsewhere never lands in it.
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        if self.instead { self.words.focus_handle(cx) } else { self.focus.clone() }
    }
}

impl AskCard {
    pub fn new(client: BoxClient, session: String, cx: &mut Context<Self>) -> AskCard {
        let words = cx.new(|cx| TextField::new(cx).bare().submits_on_enter(true));
        let subscription = cx.subscribe(&words, |this: &mut AskCard, _, event: &TextFieldEvent, cx| match event {
            TextFieldEvent::Submit(_) => this.submit_words(cx),
            TextFieldEvent::Cancel => {
                if this.instead {
                    this.instead = false;
                    cx.notify();
                }
            }
            // (Typing in its own line, which takes the keyboard only once it's clicked or Instead
            // opens it, isn't counted: as the Mac's `KeysTyped` leaves out the card's own line.)
            TextFieldEvent::Changed => cx.notify(),
        });
        AskCard {
            client,
            session,
            asks: Vec::new(),
            place: AskPlace::default(),
            question: 0,
            picked: HashMap::new(),
            words,
            instead: false,
            answering: None,
            failed: None,
            failed_for: None,
            quiet_since: None,
            focus: cx.focus_handle(),
            tasks: Vec::new(),
            _words: subscription,
        }
    }

    /// What the box says waits now.
    pub fn take(&mut self, asks: Asks, cx: &mut Context<Self>) {
        let before = self.place.shown().map(str::to_owned);
        self.asks = asks.asks.into_iter().filter(|ask| *ask != Ask::Unknown).collect();
        self.place.update(self.asks.iter().map(|ask| ask.id().to_owned()).collect());
        if self.place.shown() != before.as_deref() {
            self.reset(cx);
        }
        cx.notify();
    }

    /// Whether its keys answer now: it's been still a moment since the card shown changed.
    pub fn takes_keys(&self, cx: &App) -> bool {
        self.quiet_since.is_none_or(|since| cx.background_executor().now().saturating_duration_since(since) >= QUIET)
    }

    /// Whether anything waits (the card shows in the composer's place).
    pub fn is_asking(&self) -> bool {
        self.place.shown().is_some()
    }

    pub fn place(&self) -> &AskPlace {
        &self.place
    }

    pub fn shown(&self) -> Option<&Ask> {
        let shown = self.place.shown()?;
        self.asks.iter().find(|ask| ask.id() == shown)
    }

    fn shown_question(&self) -> Option<&kuvo_box::asks::Asked> {
        match self.shown()? {
            Ask::Question(question) => question.questions.get(self.question),
            _ => None,
        }
    }

    pub fn failed(&self) -> Option<&str> {
        self.failed.as_deref()
    }

    /// A new ask shows: nothing picked, nothing written.
    fn reset(&mut self, cx: &mut Context<Self>) {
        self.quiet_since = Some(cx.background_executor().now());
        self.question = 0;
        self.picked.clear();
        self.instead = false;
        self.failed = None;
        self.words.update(cx, |field, cx| field.set_text("", cx));
    }

    /// Pages to the ask at `index`.
    pub fn show(&mut self, index: usize, cx: &mut Context<Self>) {
        self.place.show(index);
        self.reset(cx);
        cx.notify();
    }

    /// Sends `answer` for the ask shown; once the box has it, it's gone from here (the box's next
    /// word says what waits).
    fn answer(&mut self, answer: Answer, cx: &mut Context<Self>) {
        let Some(ask) = self.place.shown().map(str::to_owned) else { return };
        if self.answering.is_some() {
            return;
        }
        self.answering = Some(ask.clone());
        self.failed = None;
        cx.notify();
        let (client, session, id) = (self.client.clone(), self.session.clone(), ask.clone());
        let task = cx.background_executor().spawn(async move { client.answer_ask(&session, &id, &answer) });
        self.tasks.retain(|task| !task.is_ready());
        self.tasks.push(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| this.answered(&ask, result, cx)).ok();
        }));
    }

    fn answered(&mut self, ask: &str, result: kuvo_box::Result<()>, cx: &mut Context<Self>) {
        self.answering = None;
        match result {
            // (Answered meanwhile elsewhere: gone all the same.)
            Ok(()) => self.drop_ask(ask, cx),
            Err(kuvo_box::Error::Refused(refusal)) if refusal.status == 404 => self.drop_ask(ask, cx),
            Err(error) => {
                self.failed = Some(format!("The answer didn’t go: {error}"));
                self.failed_for = Some(ask.to_owned());
            }
        }
        cx.notify();
    }

    fn drop_ask(&mut self, ask: &str, cx: &mut Context<Self>) {
        self.asks.retain(|each| each.id() != ask);
        let before = self.place.shown().map(str::to_owned);
        self.place.update(self.asks.iter().map(|ask| ask.id().to_owned()).collect());
        if self.place.shown() != before.as_deref() {
            self.reset(cx);
        }
    }

    /// A permission's answer picked: Instead opens the line for your words first.
    pub fn choose(&mut self, at: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(Ask::Permission(permission)) = self.shown() else { return };
        let Some(choice) = permission.choices.get(at) else { return };
        if choice.answer == "instead" {
            self.instead = true;
            self.words.update(cx, |field, cx| field.set_text("", cx));
            window.focus(&self.words.focus_handle(cx), cx);
            cx.notify();
            return;
        }
        let answer = Answer::permission(&choice.answer, None);
        self.answer(answer, cx);
    }

    /// A question's choice picked: one that takes several toggles it; one that takes one moves on.
    pub fn pick(&mut self, at: usize, cx: &mut Context<Self>) {
        let Some(asked) = self.shown_question().cloned() else { return };
        let Some(option) = asked.options.get(at) else { return };
        let picked = self.picked.entry(asked.key.clone()).or_default();
        if asked.multiple {
            if let Some(was) = picked.iter().position(|value| value == &option.value) {
                picked.remove(was);
            } else {
                picked.push(option.value.clone());
            }
            cx.notify();
        } else {
            *picked = vec![option.value.clone()];
            self.words.update(cx, |field, cx| field.set_text("", cx));
            self.next_question(cx);
        }
    }

    /// The next question, or (after the last) the answers sent.
    pub fn next_question(&mut self, cx: &mut Context<Self>) {
        let Some(Ask::Question(question)) = self.shown().cloned() else { return };
        // Your own words take a single answer's place, and join a list of several.
        if let Some(asked) = question.questions.get(self.question) {
            let written = self.words.read(cx).text().trim().to_owned();
            if !written.is_empty() {
                let picked = self.picked.entry(asked.key.clone()).or_default();
                if asked.multiple {
                    picked.push(written);
                } else {
                    *picked = vec![written];
                }
            }
        }
        self.words.update(cx, |field, cx| field.set_text("", cx));
        if self.question + 1 < question.questions.len() {
            self.question += 1;
            cx.notify();
            return;
        }
        self.send_questions(&question, cx);
    }

    /// Skips the question shown; skipping them all puts the ask away unanswered.
    pub fn skip(&mut self, cx: &mut Context<Self>) {
        let Some(Ask::Question(question)) = self.shown().cloned() else { return };
        if let Some(asked) = question.questions.get(self.question) {
            self.picked.remove(&asked.key);
        }
        self.words.update(cx, |field, cx| field.set_text("", cx));
        if self.question + 1 < question.questions.len() {
            self.question += 1;
            cx.notify();
        } else {
            self.send_questions(&question, cx);
        }
    }

    fn send_questions(&mut self, question: &Question, cx: &mut Context<Self>) {
        let answers: Vec<(String, Vec<String>, bool)> = question
            .questions
            .iter()
            .filter_map(|asked| self.picked.get(&asked.key).filter(|picked| !picked.is_empty()).map(|picked| (asked.key.clone(), picked.clone(), asked.multiple)))
            .collect();
        let answer = if answers.is_empty() { Answer::dismiss() } else { Answer::questions(answers) };
        self.answer(answer, cx);
    }

    /// Whether the question shown has an answer to send: something picked or written.
    fn can_go(&self, cx: &App) -> bool {
        let Some(asked) = self.shown_question() else { return false };
        self.picked.get(&asked.key).is_some_and(|picked| !picked.is_empty()) || !self.words.read(cx).text().trim().is_empty()
    }

    /// The card's own focus, its line's included: where the keyboard is while it's on the card.
    pub fn focus_handle_any(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }

    /// Whether the card leaves the composer usable below it: an ask this app can't answer (the
    /// box's own, a form it can't take) doesn't hold the conversation up.
    pub fn leaves_composer(&self) -> bool {
        matches!(self.shown(), Some(Ask::Other { .. }))
    }

    /// Puts the ask away unanswered (×).
    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        self.answer(Answer::dismiss(), cx);
    }

    fn submit_words(&mut self, cx: &mut Context<Self>) {
        // Return in its line answers as the button would, and no sooner than its keys.
        if !self.takes_keys(cx) {
            return;
        }
        if self.instead {
            let words = self.words.read(cx).text().trim().to_owned();
            if !words.is_empty() {
                self.answer(Answer::permission("instead", Some(words)), cx);
            }
        } else if self.shown_question().is_some() && self.can_go(cx) {
            self.next_question(cx);
        }
    }

    /// Number keys pick, Return takes the first answer (Allow Once), Escape opens Instead's line.
    fn key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        let modified = event.keystroke.modifiers.modified();
        // What's typed in the card's line is words, never an answer.
        if modified || self.words.focus_handle(cx).is_focused(window) {
            return;
        }
        let answers = key == "enter" || key == "escape" || (key.len() == 1 && key.as_bytes()[0].is_ascii_digit());
        // Any other key is typing, as the Mac's `KeysTyped` counts it: the answers wait again.
        if !answers {
            self.quiet_since = Some(cx.background_executor().now());
            return;
        }
        // A key held down, or pressed before the card has been still a moment, answers nothing.
        if answers && (event.is_held || !self.takes_keys(cx)) {
            cx.stop_propagation();
            return;
        }
        match (self.shown().cloned(), key) {
            (Some(Ask::Permission(_)), "enter") => self.choose(0, window, cx),
            (Some(Ask::Permission(permission)), "escape") => {
                if let Some(at) = permission.choices.iter().position(|choice| choice.answer == "instead") {
                    self.choose(at, window, cx);
                }
            }
            (Some(Ask::Permission(_)), digit) if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() && digit != "0" => {
                self.choose(digit.parse::<usize>().unwrap_or(1) - 1, window, cx);
            }
            (Some(Ask::Question(_)), digit) if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() && digit != "0" => {
                self.pick(digit.parse::<usize>().unwrap_or(1) - 1, cx);
            }
            // (Only as the button would: something picked or written.)
            (Some(Ask::Question(_)), "enter") if self.can_go(cx) => self.next_question(cx),
            _ => return,
        }
        cx.stop_propagation();
    }

    // MARK: Drawing

    fn header(&self, icon: IconName, title: SharedString, dismiss: bool, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let count = self.place.count();
        let index = self.place.index().unwrap_or(0);
        let pager = self.place.words().map(|words| {
            div()
                .flex()
                .items_center()
                .gap(space::S0_5)
                .text_ui(TypeSize::Caption)
                .text_color(c.text_faint)
                .child(Button::icon_only("ask-before", IconName::ChevronLeft, "Ask Before").size(ButtonSize::Small).disabled(index == 0).on_click(cx.listener(move |this, _, _, cx| this.show(index.saturating_sub(1), cx))))
                .child(div().debug_selector(|| "ask-pager".into()).child(words))
                .child(Button::icon_only("ask-after", IconName::ChevronRight, "Ask After").size(ButtonSize::Small).disabled(index + 1 >= count).on_click(cx.listener(move |this, _, _, cx| this.show(index + 1, cx))))
        });
        div()
            .flex()
            .items_start()
            .gap(space::S2)
            .child(div().pt(px(2.)).child(Icon::new(icon).size(IconSize::Nav).color(c.warning)))
            .child(div().flex_1().min_w_0().text_ui(TypeSize::Body).medium().text_color(c.text).child(title))
            .children(pager)
            .when(dismiss, |d| d.child(div().debug_selector(|| "ask-dismiss".into()).child(Button::icon_only("ask-dismiss", IconName::Close, "Don’t Answer").size(ButtonSize::Small).on_click(cx.listener(|this, _, _, cx| this.dismiss(cx))))))
            .into_any_element()
    }

    /// A numbered answer: its keycap, its words (and what Always names, as code), picked or not.
    fn answer_row(&self, row: AnswerRow, on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static, cx: &mut Context<Self>) -> AnyElement {
        let AnswerRow { id, number, title, named, checked } = row;
        let c = cx.theme().colors.clone();
        let busy = self.answering.is_some();
        let (hover, pressed) = (c.hover, c.pressed);
        let selector = id.to_string();
        let on_click = Rc::new(on_click);
        div()
            .id(id)
            .debug_selector(move || selector)
            .flex()
            .items_center()
            .gap(space::S2)
            .min_h(px(32.))
            .px(space::S2)
            .rounded(radius::NAV)
            .text_ui(TypeSize::Small)
            .text_color(if busy { c.text_faint } else { c.text })
            .when(!busy, |d| {
                d.cursor_pointer().hover(move |s| s.bg(hover)).active(move |s| s.bg(pressed)).on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
            })
            .child(keycap(number.to_string().into(), c.border_strong, c.text_muted))
            .children(checked.map(|checked| Icon::new(if checked { IconName::Check } else { IconName::Minus }).size(IconSize::Nav).color(if checked { c.accent } else { c.text_faint })))
            .child(div().flex_none().child(title))
            .children(named.map(|named| div().min_w_0().truncate().px(space::S1).rounded(radius::SMALL).bg(c.inline_code).text_mono(TypeSize::Small).child(named)))
            .into_any_element()
    }

    fn permission(&self, permission: &Permission, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let icon = if permission.command.is_some() {
            IconName::Terminal
        } else if !permission.files.is_empty() {
            IconName::Pencil
        } else {
            IconName::Shield
        };
        let mut parts = vec![self.header(icon, permission.title.clone().into(), false, cx)];
        if let Some(message) = permission.message.as_ref().filter(|message| !message.trim().is_empty()) {
            parts.push(div().text_ui(TypeSize::Small).text_color(c.text_muted).child(message.clone()).into_any_element());
        }
        // What it would run, change or reach.
        if let Some(command) = &permission.command {
            parts.push(OutputWell::new(SharedString::from(format!("ask-command-{}", permission.id)), command.clone()).into_any_element());
        } else if !permission.files.is_empty() {
            for (n, file) in permission.files.iter().enumerate() {
                let view = DiffView::new(SharedString::from(format!("ask-diff-{}-{n}", permission.id)), Rc::new(parse_patch(&file.patch))).title(file.file.clone()).counts(file.additions as usize, file.deletions as usize);
                parts.push(view.into_any_element());
            }
        } else if !permission.resources.is_empty() {
            parts.push(OutputWell::new(SharedString::from(format!("ask-resources-{}", permission.id)), permission.resources.join("\n")).into_any_element());
        }
        let mut choices: Vec<AnyElement> = Vec::new();
        for (at, choice) in permission.choices.iter().enumerate() {
            if choice.answer == "instead" && self.instead {
                let placeholder = choice.placeholder.clone().unwrap_or_default();
                self.words.update(cx, |field, _| field.set_placeholder(placeholder));
                choices.push(
                    div()
                        .debug_selector(|| "ask-instead".into())
                        .flex()
                        .items_center()
                        .gap(space::S2)
                        .px(space::S2)
                        .py(space::S1_5)
                        .rounded(radius::NAV)
                        .border_1()
                        .border_color(c.border_strong)
                        .child(keycap((at + 1).to_string().into(), c.border_strong, c.text_muted))
                        .child(div().flex_1().child(self.words.clone()))
                        .child(Button::new("ask-instead-send", "Send").size(ButtonSize::Small).accent().disabled(self.words.read(cx).text().trim().is_empty()).on_click(cx.listener(|this, _, _, cx| this.submit_words(cx))))
                        .into_any_element(),
                );
                continue;
            }
            let row = AnswerRow { id: SharedString::from(format!("ask-choice-{}", choice.answer)), number: at + 1, title: choice.title.clone(), named: choice.named.clone(), checked: None };
            choices.push(self.answer_row(row, move |this, window, cx| this.choose(at, window, cx), cx));
        }
        parts.push(div().flex().flex_col().gap(space::S0_5).children(choices).into_any_element());
        parts
    }

    fn question(&self, question: &Question, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let Some(asked) = question.questions.get(self.question).cloned() else { return Vec::new() };
        let title = asked.title.clone().unwrap_or_else(|| question.title.clone());
        let mut parts = vec![self.header(IconName::Question, title.into(), true, cx)];
        if question.questions.len() > 1 {
            parts.push(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(format!("Question {} of {}", self.question + 1, question.questions.len())).into_any_element());
        }
        parts.push(div().text_ui(TypeSize::Body).text_color(c.text).child(asked.question.clone()).into_any_element());
        let picked = self.picked.get(&asked.key).cloned().unwrap_or_default();
        let rows: Vec<AnyElement> = asked
            .options
            .iter()
            .enumerate()
            .map(|(at, option)| {
                let title = match &option.description {
                    Some(description) if !description.is_empty() => format!("{} · {description}", option.label),
                    _ => option.label.clone(),
                };
                let checked = asked.multiple.then(|| picked.contains(&option.value));
                let row = AnswerRow { id: SharedString::from(format!("ask-option-{at}")), number: at + 1, title, named: None, checked };
                self.answer_row(row, move |this, _, cx| this.pick(at, cx), cx)
            })
            .collect();
        parts.push(div().flex().flex_col().gap(space::S0_5).children(rows).into_any_element());
        if asked.custom {
            let placeholder = if asked.options.is_empty() { "Write your answer" } else { "Or write your own response" };
            self.words.update(cx, |field, _| field.set_placeholder(placeholder));
            parts.push(div().debug_selector(|| "ask-words".into()).px(space::S2).py(space::S1_5).rounded(radius::NAV).border_1().border_color(c.border_strong).child(self.words.clone()).into_any_element());
        }
        let last = self.question + 1 >= question.questions.len();
        let can_go = self.can_go(cx);
        parts.push(
            div()
                .flex()
                .justify_end()
                .gap(space::S2)
                // (A question that needs an answer can't be skipped: × puts it away.)
                .child(div().debug_selector(|| "ask-skip".into()).child(Button::new("ask-skip", "Skip").size(ButtonSize::Small).disabled(asked.required || self.answering.is_some()).on_click(cx.listener(|this, _, _, cx| this.skip(cx)))))
                .child(Button::new("ask-next", if last { "Answer" } else { "Next" }).size(ButtonSize::Small).accent().disabled(!can_go || self.answering.is_some()).on_click(cx.listener(|this, _, _, cx| this.next_question(cx))))
                .into_any_element(),
        );
        parts
    }
}

impl Render for AskCard {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let c = &theme.colors;
        let parts: Vec<AnyElement> = match self.shown().cloned() {
            Some(Ask::Permission(permission)) => self.permission(&permission, cx),
            Some(Ask::Question(question)) => self.question(&question, cx),
            Some(Ask::Other { title, message, dismiss, .. }) => vec![
                self.header(IconName::Question, title.into(), dismiss, cx),
                div().text_ui(TypeSize::Small).text_color(c.text_muted).child(message).into_any_element(),
                div().text_ui(TypeSize::Caption).text_color(c.text_faint).child("This app can’t answer this kind yet: answer it in Kuvo Code on your Mac or iPhone.").into_any_element(),
            ],
            Some(Ask::Unknown) | None => Vec::new(),
        };
        let failed = self.failed.clone().filter(|_| self.failed_for.as_deref() == self.place.shown()).map(|why| div().text_ui(TypeSize::Caption).text_color(c.warning).child(why));
        div()
            .id("ask-card")
            .debug_selector(|| "ask-card".into())
            .key_context("AskCard")
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| this.key_down(event, window, cx)))
            .flex()
            .flex_col()
            .gap(space::S3)
            .p(space::S4)
            .rounded(radius::CARD)
            .bg(c.surface)
            .border_1()
            .border_color(c.border_strong)
            .shadow(theme.card_shadow())
            .children(parts)
            .children(failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn the_ask_shown_stays_while_others_come_and_the_next_shows_once_its_answered() {
        let mut place = AskPlace::default();
        place.update(ids(&["a", "b"]));
        assert_eq!((place.shown(), place.words().as_deref()), (Some("a"), Some("1 of 2")));
        place.show(1);
        place.update(ids(&["c", "a", "b"]));
        assert_eq!(place.shown(), Some("b"), "a new one doesn't take its place");
        place.update(ids(&["c", "a"]));
        assert_eq!(place.shown(), Some("a"), "the last answered: the one before it");
        place.update(ids(&["c", "a", "d"]));
        place.update(ids(&["c", "d"]));
        assert_eq!(place.shown(), Some("d"), "the next after it");
        place.update(Vec::new());
        assert_eq!((place.shown(), place.words()), (None, None));
    }
}
