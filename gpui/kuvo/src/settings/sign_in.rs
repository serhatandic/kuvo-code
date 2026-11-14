//! Signing in to an account: a sheet over Settings that offers the box's ways in, in its order and
//! its words (`kuvo/sign-in/methods`), and takes each as the engine (or the coding agents' bridge)
//! does it: a sign-in in the browser, followed through the box (`kuvo/sign-in/status`, about once
//! a second) until it ends, with a device code to enter or a code to paste back where it has one;
//! a key; or credentials the computer has already, with what their form asks. What went wrong is
//! said in the box's words.
//!
//! The steps are the Mac's (`ConnectView`): its words where it has them.

use std::time::Duration;

use gpui::{
    AnyElement, AppContext as _, ClipboardItem, Focusable as _, Context, Entity, EventEmitter, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Task, Window, div, prelude::FluentBuilder as _, px,
};
use kuvo_box::BoxClient;
use kuvo_box::accounts::{Attempt, FormField, Method, Side, Status, Ways, said};
use kuvo_ui::{
    ActiveTheme, Icon, IconName, IconSize, StyledType, TextField, TextFieldEvent, TypeSize,
    button::{Button, ButtonSize},
    small::{Switch, spinner},
    theme::{radius, space},
};
use serde_json::{Map, Value};

/// How often a sign-in under way is asked about.
pub const POLL: Duration = Duration::from_secs(1);
/// Asks in a row with no answer before it's given up on (the engine started over meanwhile).
const MISSES: u32 = 10;

/// The sheet closed (`signed_in`: by a sign-in that went through).
pub struct Closed {
    pub signed_in: bool,
}

/// Where a sign-in stands.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Reading the ways in.
    Loading,
    /// The ways in, to pick one.
    Choose,
    /// What a way asks for before it starts (Amazon Bedrock's region).
    Form(Method),
    /// A key to paste, with what its way's form asks.
    Key(Method),
    /// Waiting on the box, in these words.
    Working(String),
    /// In the browser: the page, and how it's going.
    Waiting { attempt: Attempt, status: Option<Status> },
    Done,
    Failed(String),
}

/// One field of a way's form, as drawn.
struct Field {
    spec: FormField,
    text: Option<Entity<TextField>>,
    on: bool,
}

pub struct SignIn {
    client: BoxClient,
    live: bool,
    side: Side,
    account: String,
    name: String,
    ways: Ways,
    step: Step,
    /// "Other ways to sign in" opened.
    others: bool,
    key: Entity<TextField>,
    code: Entity<TextField>,
    /// "Paste a Code" opened, for a sign-in that may end on one.
    pasting: bool,
    /// The code under way to the engine, and why it wasn't taken.
    code_error: Option<String>,
    copied: bool,
    fields: Vec<Field>,
    misses: u32,
    wants_focus: bool,
    poll: Option<Task<()>>,
    work: Option<Task<()>>,
}

impl EventEmitter<Closed> for SignIn {}

impl SignIn {
    pub fn new(client: BoxClient, live: bool, side: Side, account: &str, name: &str, cx: &mut Context<Self>) -> SignIn {
        let key = cx.new(|cx| TextField::new(cx).masked().placeholder("Paste your key"));
        let code = cx.new(|cx| TextField::new(cx).placeholder("Paste the code"));
        cx.subscribe(&key, |this: &mut SignIn, _, event: &TextFieldEvent, cx| {
            if let TextFieldEvent::Submit(_) = event {
                this.connect_key(cx);
            }
        })
        .detach();
        cx.subscribe(&code, |this: &mut SignIn, _, event: &TextFieldEvent, cx| {
            if let TextFieldEvent::Submit(_) = event {
                this.send_code(cx);
            }
        })
        .detach();
        SignIn {
            client,
            live,
            side,
            account: account.to_owned(),
            name: name.to_owned(),
            ways: Ways::default(),
            step: Step::Loading,
            others: false,
            key,
            code,
            pasting: false,
            code_error: None,
            copied: false,
            fields: Vec::new(),
            misses: 0,
            wants_focus: false,
            poll: None,
            work: None,
        }
    }

    pub fn step(&self) -> &Step {
        &self.step
    }

    pub fn ways(&self) -> &Ways {
        &self.ways
    }

    pub fn key_field(&self) -> &Entity<TextField> {
        &self.key
    }

    pub fn code_field(&self) -> &Entity<TextField> {
        &self.code
    }

    /// Runs `work` against the box (in the app off this thread; in tests and shots at once).
    fn run<T: Send + 'static>(&mut self, work: impl FnOnce(&BoxClient) -> T + Send + 'static, then: impl FnOnce(&mut SignIn, T, &mut Context<SignIn>) + 'static, cx: &mut Context<Self>) {
        let client = self.client.clone();
        if !self.live {
            let done = work(&client);
            then(self, done, cx);
            cx.notify();
            return;
        }
        self.work = Some(cx.spawn(async move |this, cx| {
            let done = cx.background_executor().spawn(async move { work(&client) }).await;
            this.update(cx, |this, cx| {
                then(this, done, cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// Reads the ways in; with one alone, it starts at once (the Mac's).
    pub fn start(&mut self, cx: &mut Context<Self>) {
        self.step = Step::Loading;
        let (side, account) = (self.side, self.account.clone());
        self.run(
            move |client| client.sign_in_methods(side, &account),
            |this, ways, cx| match ways {
                Ok(ways) => {
                    this.ways = ways;
                    this.step = Step::Choose;
                    let primary: Vec<Method> = this.ways.primary().cloned().collect();
                    if let ([only], 0) = (primary.as_slice(), this.ways.legacy().count()) {
                        this.pick(only.clone(), cx);
                    }
                }
                Err(error) => this.step = Step::Failed(said(&error)),
            },
            cx,
        );
    }

    /// A way picked: its form first where it asks for anything this app can draw.
    pub fn pick(&mut self, method: Method, cx: &mut Context<Self>) {
        self.fields = method
            .form
            .iter()
            .filter(|field| !field.hidden)
            .map(|spec| {
                let default = spec.default.as_ref();
                let text = (!spec.is_switch()).then(|| {
                    let start = default.and_then(Value::as_str).unwrap_or_default().to_owned();
                    let placeholder = spec.placeholder.clone().unwrap_or_default();
                    cx.new(|cx| {
                        let mut field = TextField::new(cx).placeholder(placeholder);
                        field.set_text(start, cx);
                        field
                    })
                });
                Field { spec: spec.clone(), text, on: default.and_then(Value::as_bool).unwrap_or(false) }
            })
            .collect();
        if self.fields.iter().any(|field| !field.spec.drawable()) {
            self.step = Step::Failed(format!("This way of signing in to {} asks for something this app can’t show yet. Sign in from Kuvo Code on your Mac or iPhone.", self.name));
            return;
        }
        self.wants_focus = true;
        match method.kind.as_str() {
            "key" => {
                self.key.update(cx, |key, cx| key.set_text("", cx));
                self.step = Step::Key(method);
            }
            _ if !self.fields.is_empty() => self.step = Step::Form(method),
            _ => self.go(method, cx),
        }
        cx.notify();
    }

    /// What the form says, as the engine takes it.
    fn answer(&self, cx: &Context<Self>) -> Map<String, Value> {
        self.fields
            .iter()
            .filter_map(|field| {
                let value = match &field.text {
                    Some(text) => {
                        let text = text.read(cx).text().trim().to_owned();
                        if text.is_empty() {
                            return None;
                        }
                        Value::String(text)
                    }
                    None => Value::Bool(field.on),
                };
                Some((field.spec.key.clone(), value))
            })
            .collect()
    }

    /// Starts a way that isn't a key: credentials the computer has, or a sign-in in the browser.
    pub fn go(&mut self, method: Method, cx: &mut Context<Self>) {
        let answer = self.answer(cx);
        let (side, account) = (self.side, self.account.clone());
        let id = method.id.clone().unwrap_or_default();
        if method.kind == "external" {
            self.step = Step::Working("Connecting…".into());
            self.run(move |client| client.use_external(side, &account, &id, Some(&answer)), |this, done, _| this.finished(done), cx);
            return;
        }
        self.step = Step::Working("Starting the sign-in…".into());
        self.run(
            move |client| client.start_sign_in(side, &account, &id, Some(&answer)),
            |this, started, cx| match started {
                Ok(attempt) => {
                    if let Some(code) = &attempt.user_code {
                        cx.write_to_clipboard(ClipboardItem::new_string(code.clone()));
                        this.copied = true;
                    }
                    if is_page(&attempt.url) {
                        cx.open_url(&attempt.url);
                    }
                    this.pasting = attempt.mode == "code";
                    this.step = Step::Waiting { attempt, status: None };
                    this.follow(cx);
                }
                Err(error) => this.step = Step::Failed(said(&error)),
            },
            cx,
        );
    }

    /// Asks the box how the sign-in goes, about once a second, until it ends.
    fn follow(&mut self, cx: &mut Context<Self>) {
        self.misses = 0;
        let live = self.live;
        self.poll = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(POLL).await;
                let Ok(Some((client, side, account, attempt))) = this.update(cx, |this, _| match &this.step {
                    Step::Waiting { attempt, .. } => Some((this.client.clone(), this.side, this.account.clone(), attempt.id.clone())),
                    _ => None,
                }) else {
                    break;
                };
                let status = if live { cx.background_executor().spawn(async move { client.sign_in_status(side, &account, &attempt) }).await } else { client.sign_in_status(side, &account, &attempt) };
                let going = this.update(cx, |this, cx| this.heard(status, cx)).unwrap_or(false);
                if !going {
                    break;
                }
            }
        }));
    }

    /// What the box said of the sign-in: whether to keep asking.
    fn heard(&mut self, status: kuvo_box::Result<Status>, cx: &mut Context<Self>) -> bool {
        let Step::Waiting { attempt, status: shown } = &mut self.step else { return false };
        cx.notify();
        let status = match status {
            Ok(status) => status,
            Err(_) => {
                // Not heard (the engine started over, or didn't answer in time): a while of those
                // and it's given up on, as the box says to.
                self.misses += 1;
                if self.misses >= MISSES {
                    let who = if self.side == Side::Agents { "The coding agents" } else { "The engine" };
                    self.step = Step::Failed(format!("{who} started over while you were signing in. Try again."));
                    return false;
                }
                return true;
            }
        };
        self.misses = 0;
        if status.is_complete() {
            self.step = Step::Done;
            return false;
        }
        if let Some(failure) = status.failure_words() {
            self.step = Step::Failed(failure);
            return false;
        }
        // A page that came after it started (an agent downloaded first): opened as it comes.
        if let Some(url) = status.url.as_ref().filter(|url| **url != attempt.url && is_page(url)) {
            attempt.url = url.clone();
            cx.open_url(url);
        }
        if let Some(code) = status.user_code.as_ref().filter(|code| attempt.user_code.as_ref() != Some(*code)) {
            attempt.user_code = Some(code.clone());
            cx.write_to_clipboard(ClipboardItem::new_string(code.clone()));
            self.copied = true;
        }
        *shown = Some(status);
        true
    }

    /// Asks how the sign-in goes once, now, on this thread (shots, which run no clock).
    pub fn ask_now(&mut self, cx: &mut Context<Self>) {
        let Step::Waiting { attempt, .. } = &self.step else { return };
        let status = self.client.sign_in_status(self.side, &self.account, &attempt.id);
        self.heard(status, cx);
    }

    /// Types a code into the field for one, opening it (shots).
    pub fn paste_code(&mut self, code: &str, cx: &mut Context<Self>) {
        self.pasting = true;
        self.code.update(cx, |field, cx| field.set_text(code, cx));
        cx.notify();
    }

    /// Connects with the key in its field.
    pub fn submit_key(&mut self, cx: &mut Context<Self>) {
        self.connect_key(cx);
    }

    /// Sends the code in its field.
    pub fn submit_code(&mut self, cx: &mut Context<Self>) {
        self.send_code(cx);
    }

    /// What a change came to: signed in, or why not.
    fn finished(&mut self, done: kuvo_box::Result<()>) {
        self.step = match done {
            Ok(()) => Step::Done,
            Err(error) => Step::Failed(said(&error)),
        };
    }

    fn connect_key(&mut self, cx: &mut Context<Self>) {
        let Step::Key(_) = &self.step else { return };
        let key = self.key.read(cx).text().trim().to_owned();
        if key.is_empty() {
            return;
        }
        let answer = self.answer(cx);
        let (side, account) = (self.side, self.account.clone());
        self.key.update(cx, |field, cx| {
            field.set_error(None, cx);
            field.set_disabled(true, cx);
        });
        self.run(
            move |client| client.add_key(side, &account, &key, Some(&answer)),
            |this, done, cx| {
                this.key.update(cx, |field, cx| field.set_disabled(false, cx));
                match done {
                    Ok(()) => this.step = Step::Done,
                    // Turned down: it stays, saying why under the field.
                    Err(error) => this.key.update(cx, |field, cx| field.set_error(Some(said(&error).into()), cx)),
                }
            },
            cx,
        );
    }

    fn send_code(&mut self, cx: &mut Context<Self>) {
        let Step::Waiting { attempt, .. } = &self.step else { return };
        let code = self.code.read(cx).text().trim().to_owned();
        if code.is_empty() {
            return;
        }
        let (side, account, id) = (self.side, self.account.clone(), attempt.id.clone());
        self.code_error = None;
        self.run(
            move |client| client.complete_sign_in(side, &account, &id, &code),
            |this, done, _| match done {
                Ok(()) => {
                    this.poll = None;
                    this.step = Step::Done;
                }
                Err(error) => this.code_error = Some(said(&error)),
            },
            cx,
        );
    }

    /// Back to the ways in.
    fn back(&mut self, cx: &mut Context<Self>) {
        self.cancel_attempt();
        self.step = Step::Choose;
        cx.notify();
    }

    /// Gives a sign-in under way up, on the engine too.
    fn cancel_attempt(&mut self) {
        self.poll = None;
        if let Step::Waiting { attempt, .. } = &self.step {
            let (client, side, account, id) = (self.client.clone(), self.side, self.account.clone(), attempt.id.clone());
            // Nothing waits on its answer: given up either way.
            if self.live {
                std::thread::spawn(move || client.cancel_sign_in(side, &account, &id).ok());
            } else {
                client.cancel_sign_in(side, &account, &id).ok();
            }
        }
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        self.cancel_attempt();
        let signed_in = self.step == Step::Done;
        cx.emit(Closed { signed_in });
    }
}

/// Only a web page is opened in the browser.
fn is_page(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// The symbol drawn beside a way, by its kind.
fn kind_icon(kind: &str) -> IconName {
    match kind {
        "key" => IconName::Pin,
        "external" => IconName::Computer,
        _ => IconName::External,
    }
}

impl Render for SignIn {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = cx.theme().colors.clone();
        if std::mem::take(&mut self.wants_focus) {
            match &self.step {
                Step::Key(_) => window.focus(&self.key.focus_handle(cx), cx),
                Step::Form(_) => {
                    if let Some(text) = self.fields.iter().find_map(|field| field.text.clone()) {
                        window.focus(&text.focus_handle(cx), cx);
                    }
                }
                _ => {}
            }
        }
        let title = match &self.step {
            Step::Done => format!("{} is connected", self.name),
            _ => format!("Sign In to {}", self.name),
        };
        let body: Vec<AnyElement> = match self.step.clone() {
            Step::Loading => vec![working("Getting the ways to sign in…", cx)],
            Step::Choose => self.choose(cx),
            Step::Form(method) => self.form(method, cx),
            Step::Key(method) => self.key_step(method, cx),
            Step::Working(words) => vec![working(&words, cx)],
            Step::Waiting { attempt, status } => self.waiting(&attempt, status.as_ref(), cx),
            Step::Done => vec![
                words("Its models are now in the model picker.", cx),
                footer(vec![Button::new("sign-in-done", "Done").primary().on_click(cx.listener(|this, _, _, cx| this.close(cx))).into_any_element()]),
            ],
            Step::Failed(why) => vec![
                div().debug_selector(|| "sign-in-failure".into()).text_ui(TypeSize::Body).text_color(c.danger).child(why).into_any_element(),
                footer(vec![
                    Button::new("sign-in-close", "Close").on_click(cx.listener(|this, _, _, cx| this.close(cx))).into_any_element(),
                    Button::new("sign-in-again", "Try Again").primary().on_click(cx.listener(|this, _, _, cx| this.start(cx))).into_any_element(),
                ]),
            ],
        };
        div()
            .id("sign-in")
            .debug_selector(|| "sign-in".into())
            .w(px(440.))
            .max_w_full()
            .flex()
            .flex_col()
            .gap(space::S4)
            .p(space::S6)
            .rounded(radius::CARD)
            .bg(c.elevated)
            .border_1()
            .border_color(c.border)
            .shadow(cx.theme().elevated_shadow())
            .occlude()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .when(self.step == Step::Done, |d| d.child(Icon::new(IconName::Check).size(IconSize::Card).color(c.success)))
                    .child(div().flex_1().min_w_0().text_ui(TypeSize::Body).medium().text_color(c.text).child(title))
                    .child(Button::icon_only("sign-in-x", IconName::Close, "Close").ghost().size(ButtonSize::Small).on_click(cx.listener(|this, _, _, cx| this.close(cx)))),
            )
            .children(body)
    }
}

impl SignIn {
    fn choose(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let mut out = Vec::new();
        if self.ways.methods.is_empty() {
            out.push(words(&format!("There’s no way to sign in to {} from here.", self.name), cx));
        }
        let method_button = |ix: usize, method: &Method, primary: bool, cx: &mut Context<Self>| {
            let picked = method.clone();
            let button = Button::new(SharedString::from(format!("sign-in-way-{ix}")), method.label.clone()).icon(kind_icon(&method.kind)).full_width().on_click(cx.listener(move |this, _, _, cx| this.pick(picked.clone(), cx)));
            if primary { button.primary() } else { button }.into_any_element()
        };
        let primary: Vec<Method> = self.ways.primary().cloned().collect();
        for (ix, method) in primary.iter().enumerate() {
            out.push(method_button(ix, method, ix == 0, cx));
        }
        let legacy: Vec<Method> = self.ways.legacy().cloned().collect();
        if !legacy.is_empty() {
            let open = self.others;
            out.push(
                div()
                    .id("sign-in-others")
                    .debug_selector(|| "sign-in-others".into())
                    .flex()
                    .items_center()
                    .gap(space::S1)
                    .cursor_pointer()
                    .text_ui(TypeSize::Small)
                    .text_color(c.text_muted)
                    .child(Icon::new(if open { IconName::ChevronDown } else { IconName::ChevronRight }).size(IconSize::Nav))
                    .child("Other ways to sign in")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.others = !this.others;
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            if open {
                for (ix, method) in legacy.iter().enumerate() {
                    out.push(method_button(primary.len() + ix, method, false, cx));
                }
            }
        }
        if !self.ways.environment.is_empty() {
            out.push(quiet(&format!("Or set {} in your shell profile.", self.ways.environment.join(" or ")), cx));
        }
        out
    }

    fn fields(&mut self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        self.fields
            .iter()
            .enumerate()
            .map(|(ix, field)| {
                let name = field.spec.name();
                let control: AnyElement = match &field.text {
                    Some(text) => text.clone().into_any_element(),
                    None => Switch::new(SharedString::from(format!("sign-in-field-{ix}")), field.on)
                        .on_change({
                            let this = cx.entity().downgrade();
                            move |on, _, cx| {
                                this.update(cx, |this, cx| {
                                    if let Some(field) = this.fields.get_mut(ix) {
                                        field.on = on;
                                    }
                                    cx.notify();
                                })
                                .ok();
                            }
                        })
                        .into_any_element(),
                };
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S1)
                    .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child(name))
                    .child(control)
                    .children(field.spec.description.clone().map(|description| div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(description)))
                    .into_any_element()
            })
            .collect()
    }

    fn form(&mut self, method: Method, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = self.fields(cx);
        let several = self.ways.methods.len() > 1;
        let picked = method.clone();
        out.push(footer(
            several
                .then(|| Button::new("sign-in-back", "Back").on_click(cx.listener(|this, _, _, cx| this.back(cx))).into_any_element())
                .into_iter()
                .chain([Button::new("sign-in-continue", "Continue").primary().on_click(cx.listener(move |this, _, _, cx| this.go(picked.clone(), cx))).into_any_element()])
                .collect(),
        ));
        out
    }

    fn key_step(&mut self, method: Method, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let mut out = vec![
            div()
                .flex()
                .flex_col()
                .gap(space::S1)
                .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child(method.label.clone()))
                .child(div().debug_selector(|| "sign-in-key".into()).child(self.key.clone()))
                .into_any_element(),
        ];
        out.extend(self.fields(cx));
        let several = self.ways.methods.len() > 1;
        let empty = self.key.read(cx).text().trim().is_empty();
        out.push(footer(
            several
                .then(|| Button::new("sign-in-back", "Back").on_click(cx.listener(|this, _, _, cx| this.back(cx))).into_any_element())
                .into_iter()
                .chain([Button::new("sign-in-connect", "Connect").primary().disabled(empty).on_click(cx.listener(|this, _, _, cx| this.connect_key(cx))).into_any_element()])
                .collect(),
        ));
        out
    }

    fn waiting(&mut self, attempt: &Attempt, status: Option<&Status>, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let mut out = Vec::new();
        // BOX-NEEDED: a device sign-in's code as `userCode`, for the engine's plans too (Copilot, OpenCode, SuperGrok), on `POST …/connect/oauth`'s answer or `GET kuvo/sign-in/status`: the bridge says it for the agents, but the engine leaves it in its `url` or `instructions` (the Mac reads it out of them, KuvoClient's `OAuthAttempt.userCode`); until the box says it, such a sign-in shows its page and instructions without the code apart.
        let user_code = status.and_then(|status| status.user_code.clone()).or_else(|| attempt.user_code.clone());
        let instructions = status.and_then(|status| status.instructions.clone()).unwrap_or_else(|| attempt.instructions.clone());
        if attempt.mode == "code" {
            if !instructions.is_empty() {
                out.push(words(&instructions, cx));
            }
        } else if let Some(code) = user_code {
            out.push(words("Enter this code on the page that opened.", cx));
            let copying = code.clone();
            out.push(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S3)
                    .child(div().debug_selector(|| "sign-in-user-code".into()).font_family(kuvo_ui::theme::MONO_FONT).text_size(px(24.)).medium().text_color(c.text).child(code))
                    .child(
                        Button::new("sign-in-copy-code", if self.copied { "Copied" } else { "Copy Code" }).icon(IconName::Copy).size(ButtonSize::Small).on_click(cx.listener(move |this, _, _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copying.clone()));
                            this.copied = true;
                            cx.notify();
                        })),
                    )
                    .into_any_element(),
            );
        } else {
            out.push(words("Finish signing in with your browser. This updates on its own.", cx));
            if !instructions.trim().is_empty() {
                out.push(quiet(&instructions, cx));
            }
        }
        // How it's going, in the engine's words (an agent being downloaded first).
        let going = status.and_then(|status| status.message.clone()).filter(|message| !message.trim().is_empty()).unwrap_or_else(|| "Waiting for you to finish…".into());
        if attempt.mode != "code" {
            out.push(div().debug_selector(|| "sign-in-waiting".into()).child(working(&going, cx)).into_any_element());
        }
        // A code to paste back: one that ends on it (`mode: code`), or one that may (`acceptsCode`).
        if self.pasting {
            if attempt.mode != "code" {
                out.push(quiet("If the page gave you a code, paste it here.", cx));
            }
            out.push(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .child(div().flex_1().min_w_0().debug_selector(|| "sign-in-code".into()).child(self.code.clone()))
                    .child(Button::new("sign-in-send-code", "Continue").primary().on_click(cx.listener(|this, _, _, cx| this.send_code(cx))))
                    .into_any_element(),
            );
            if let Some(error) = &self.code_error {
                out.push(div().debug_selector(|| "sign-in-code-error".into()).text_ui(TypeSize::Small).text_color(c.danger).child(error.clone()).into_any_element());
            }
        } else if attempt.accepts_code {
            out.push(
                div()
                    .id("sign-in-paste")
                    .debug_selector(|| "sign-in-paste".into())
                    .cursor_pointer()
                    .text_ui(TypeSize::Small)
                    .text_color(c.accent)
                    .child("Paste a Code")
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.pasting = true;
                        window.focus(&this.code.focus_handle(cx), cx);
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        let url = attempt.url.clone();
        let copy = attempt.url.clone();
        out.push(footer(vec![
            Button::new("sign-in-cancel", "Cancel").ghost().on_click(cx.listener(|this, _, _, cx| this.back(cx))).into_any_element(),
            Button::new("sign-in-copy-link", "Copy Link").ghost().on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()))).into_any_element(),
            Button::new("sign-in-open", "Open the Page Again").icon_after(IconName::External).on_click(move |_, _, cx| cx.open_url(&url)).into_any_element(),
        ]));
        out
    }
}

fn words(text: &str, cx: &Context<SignIn>) -> AnyElement {
    div().text_ui(TypeSize::Body).text_color(cx.theme().colors.text).child(text.to_owned()).into_any_element()
}

fn quiet(text: &str, cx: &Context<SignIn>) -> AnyElement {
    div().text_ui(TypeSize::Small).text_color(cx.theme().colors.text_muted).child(text.to_owned()).into_any_element()
}

fn working(text: &str, cx: &Context<SignIn>) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .items_center()
        .gap(space::S2)
        .text_ui(TypeSize::Small)
        .text_color(c.text_muted)
        .child(spinner("sign-in-spin", IconSize::Nav, c.text_muted))
        .child(text.to_owned())
        .into_any_element()
}

fn footer(buttons: Vec<AnyElement>) -> AnyElement {
    div().flex().justify_end().gap(space::S2).pt(space::S1).children(buttons).into_any_element()
}
