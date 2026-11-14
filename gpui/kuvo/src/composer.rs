//! The composer: the text field, the model and effort chips, and Send (Stop while a run is under
//! way and nothing's written). What's written goes through `kuvo_box`'s typed send: a plain message
//! straight to the box as fields, "/" and "!" to the box first, which says what they mean. "/"
//! offers what the box says it offers there, as you type.
//!
//! In a new conversation (the landing view) Send starts it on the box, in the project picked, then
//! sends the same way.

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement, IntoElement,
    KeyBinding, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Subscription, Task, Window, actions,
    div, prelude::FluentBuilder as _, px,
};
use kuvo_box::models::{ModelState, OfferedModel, StartIn, effort_title};
use kuvo_box::typed::{self, Answer, ModelRef, Offers};
use kuvo_box::{BoxClient, Draft, Sent, Where};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, IconName, StyledType, TextField, TextFieldEvent, TypeSize,
    menu::{Menu, MenuEntry, PopoverMenu},
    small::{Chip, ChipTone},
    theme::{radius, space},
};

actions!(composer, [SlashNext, SlashPrevious, SlashPick, SlashDismiss]);

const CONTEXT: &str = "Composer";
const SLASH: &str = "SlashMenu";
/// Where a model's accounts are, as a refusal names it.
const ACCOUNTS: &str = "Settings › Accounts";
/// How many of "/"'s offers show at once.
const SLASH_MOST: usize = 8;

/// The keys "/"'s list takes while it shows, ahead of the field's own.
pub fn bind_keys(cx: &mut App) {
    let context = format!("{SLASH} > {}", kuvo_ui::text_field::CONTEXT);
    let context = Some(context.as_str());
    cx.bind_keys([
        KeyBinding::new("down", SlashNext, context),
        KeyBinding::new("up", SlashPrevious, context),
        KeyBinding::new("tab", SlashPick, context),
        KeyBinding::new("enter", SlashPick, context),
        KeyBinding::new("escape", SlashDismiss, context),
    ]);
}

/// Where what's written goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A conversation on the box.
    Session { id: String, place: Where },
    /// A new one, started in a project (or as a chat) when it's sent.
    New(StartIn),
}

/// What the composer tells its owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComposerEvent {
    /// A new conversation was started on the box, and what was written sent to it.
    Started { session: String },
}

/// A line under the composer: what the box did with a typed text, or what this app can't do yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub text: SharedString,
    pub warning: bool,
}

/// One of "/"'s offers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub name: String,
    pub summary: String,
}

pub struct Composer {
    client: BoxClient,
    target: Target,
    field: Entity<TextField>,
    /// Whether the conversation has a run under way (Send turns to Stop with nothing written).
    running: bool,
    sending: bool,
    model: Option<ModelState>,
    /// The model a new conversation starts on, as picked here (the box's `starting` until then).
    picked: Option<ModelRef>,
    offered: Vec<OfferedModel>,
    efforts: Vec<String>,
    offers: Option<Offers>,
    slash_at: usize,
    /// The text "/"'s list was put away for (with Escape): it shows again once that changes.
    slash_dismissed: Option<String>,
    note: Option<Note>,
    tasks: Vec<Task<()>>,
    _field: Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.field.focus_handle(cx)
    }
}

impl Composer {
    /// A composer for `target`. `read`: whether to read what it shows (the model, the efforts,
    /// "/"'s offers) from the box now.
    pub fn new(client: BoxClient, target: Target, read: bool, cx: &mut Context<Self>) -> Composer {
        let placeholder = match &target {
            Target::Session { .. } => "Ask anything, / for commands",
            Target::New(_) => "What should we work on?",
        };
        let field = cx.new(|cx| TextField::new(cx).multi_line(1, 10).bare().submits_on_enter(true).placeholder(placeholder));
        let subscription = cx.subscribe(&field, |this: &mut Composer, _, event: &TextFieldEvent, cx| match event {
            TextFieldEvent::Submit(_) => this.send(cx),
            TextFieldEvent::Cancel => {
                if this.running && this.text(cx).trim().is_empty() {
                    this.stop(cx);
                }
            }
            TextFieldEvent::Changed => {
                this.slash_at = 0;
                if this.note.is_some() {
                    this.note = None;
                }
                cx.notify();
            }
        });
        let mut composer = Composer {
            client,
            target,
            field,
            running: false,
            sending: false,
            model: None,
            picked: None,
            offered: Vec::new(),
            efforts: Vec::new(),
            offers: None,
            slash_at: 0,
            slash_dismissed: None,
            note: None,
            tasks: Vec::new(),
            _field: subscription,
        };
        if read {
            composer.read_models(cx);
            composer.read_offers(cx);
        }
        composer
    }

    pub fn field(&self) -> &Entity<TextField> {
        &self.field
    }

    pub fn target(&self) -> &Target {
        &self.target
    }

    pub fn note(&self) -> Option<&Note> {
        self.note.as_ref()
    }

    fn text(&self, cx: &App) -> String {
        self.field.read(cx).text().to_owned()
    }

    /// Where a new conversation starts (the landing view's project chip).
    pub fn set_start(&mut self, place: StartIn, cx: &mut Context<Self>) {
        if let Target::New(_) = self.target {
            self.target = Target::New(place);
            cx.notify();
        }
    }

    pub fn set_running(&mut self, running: bool, cx: &mut Context<Self>) {
        if self.running != running {
            self.running = running;
            cx.notify();
        }
    }

    /// The model the chip names: the conversation's as its box says, else the one picked here.
    pub fn model(&self) -> Option<ModelRef> {
        match &self.target {
            Target::Session { .. } => self.model.as_ref().and_then(|state| state.model.clone()),
            Target::New(_) => self.picked.clone(),
        }
    }

    /// Takes what the box says of the models, as a read brings it (tests and shots hand it in).
    pub fn take_models(&mut self, state: Option<ModelState>, offered: Vec<OfferedModel>, starting: Option<ModelRef>, efforts: Vec<String>, cx: &mut Context<Self>) {
        self.model = state;
        self.offered = offered;
        if self.picked.is_none() {
            self.picked = starting;
        }
        self.efforts = efforts;
        cx.notify();
    }

    pub fn take_offers(&mut self, offers: Offers, cx: &mut Context<Self>) {
        self.offers = Some(offers);
        cx.notify();
    }

    /// Runs `work` off the UI thread, then `then` with what it gave.
    fn spawn<T: Send + 'static>(&mut self, cx: &mut Context<Self>, work: impl FnOnce() -> T + Send + 'static, then: impl FnOnce(&mut Composer, T, &mut Context<Self>) + 'static) {
        let task = cx.background_executor().spawn(async move { work() });
        self.tasks.retain(|task| !task.is_ready());
        self.tasks.push(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| then(this, result, cx)).ok();
        }));
    }

    /// Reads the conversation's model (or where a new one starts), what's offered, and its efforts.
    pub fn read_models(&mut self, cx: &mut Context<Self>) {
        let (client, target, picked) = (self.client.clone(), self.target.clone(), self.picked.clone());
        self.spawn(cx, move || models_of(&client, &target, picked.as_ref()), |this, (state, offered, starting, efforts), cx| {
            this.take_models(state, offered, starting, efforts, cx)
        });
    }

    /// Reads what the chips and "/" show at once, on this thread (shots and tests, against a stand-in).
    pub fn read_at_once(&mut self, cx: &mut Context<Self>) {
        let (state, offered, starting, efforts) = models_of(&self.client, &self.target, self.picked.as_ref());
        self.take_models(state, offered, starting, efforts, cx);
        if let Target::Session { id, .. } = &self.target
            && let Ok(offers) = self.client.typed_offers(id)
        {
            self.take_offers(offers, cx);
        }
    }

    /// Where the conversation lives on its box, once its follow has found it.
    pub fn set_place(&mut self, place: Where, cx: &mut Context<Self>) {
        if let Target::Session { place: was, .. } = &mut self.target
            && *was != place
        {
            *was = place;
            self.read_models(cx);
        }
    }

    fn read_offers(&mut self, cx: &mut Context<Self>) {
        let Target::Session { id, .. } = &self.target else { return };
        let (client, id) = (self.client.clone(), id.clone());
        self.spawn(cx, move || client.typed_offers(&id).ok(), |this, offers, cx| {
            if let Some(offers) = offers {
                this.take_offers(offers, cx);
            }
        });
    }

    /// Picks a model (and effort) for the conversation, or for the new one.
    fn pick(&mut self, model: ModelRef, cx: &mut Context<Self>) {
        match self.target.clone() {
            Target::New(_) => {
                self.picked = Some(model);
                self.read_models(cx);
            }
            Target::Session { id, place } => {
                // Shown at once; what its box says of it comes with the next read.
                if let Some(state) = self.model.as_mut() {
                    state.model = Some(model.clone());
                    state.name = self.offered.iter().find(|offered| offered.provider_id == model.provider_id && offered.id == model.id).map(|offered| offered.name.clone()).or(state.name.take());
                    state.runs = None;
                }
                cx.notify();
                let client = self.client.clone();
                self.spawn(cx, move || client.select_model(&id, place, &model), |this, result, cx| {
                    if let Err(error) = result {
                        this.note = Some(Note { text: format!("The model wasn’t changed: {error}").into(), warning: true });
                    }
                    this.read_models(cx);
                });
            }
        }
    }

    /// Sends what's written (or, in a new conversation, starts it on the box and sends it there).
    pub fn send(&mut self, cx: &mut Context<Self>) {
        let text = self.text(cx);
        if text.trim().is_empty() || self.sending {
            return;
        }
        let mut draft = Draft::new(BoxClient::new_id(), text.clone());
        draft.refusal = self.model.as_ref().and_then(|state| state.refusal(ACCOUNTS));
        if self.model.as_ref().is_some_and(ModelState::needs_choosing) {
            self.note = Some(Note { text: "Choose a model to send it.".into(), warning: true });
            cx.notify();
            return;
        }
        self.sending = true;
        self.note = None;
        self.slash_dismissed = None;
        self.field.update(cx, |field, cx| {
            field.set_text("", cx);
            field.set_error(None, cx);
        });
        cx.notify();
        let client = self.client.clone();
        match self.target.clone() {
            Target::Session { id, .. } => {
                self.spawn(cx, move || client.send_draft(&id, &draft, None), move |this, result, cx| {
                    this.sending = false;
                    match result {
                        Ok(sent) => this.sent(sent, cx),
                        Err(error) => this.put_back(&text, Some(error.to_string()), cx),
                    }
                    cx.notify();
                });
            }
            Target::New(place) => {
                let model = self.picked.clone();
                self.spawn(
                    cx,
                    move || {
                        let started = client.start_session(&place, model.as_ref())?;
                        let sent = client.send_draft(&started.session, &draft, None);
                        Ok::<_, kuvo_box::Error>((started.session, sent))
                    },
                    move |this, result, cx| {
                        this.sending = false;
                        match result {
                            Ok((session, sent)) => {
                                match sent {
                                    Ok(sent) => this.sent(sent, cx),
                                    Err(error) => this.put_back(&text, Some(error.to_string()), cx),
                                }
                                cx.emit(ComposerEvent::Started { session });
                            }
                            Err(error) => this.put_back(&text, Some(error.to_string()), cx),
                        }
                        cx.notify();
                    },
                );
            }
        }
    }

    /// What the box did with a typed text, shown; what goes back to the composer, put back.
    fn sent(&mut self, sent: Sent, cx: &mut Context<Self>) {
        let Sent::Typed { answer, .. } = sent else { return };
        let Answer { restore, error, .. } = (*answer).clone();
        if let Some(note) = said(&answer) {
            self.note = Some(note);
        }
        if let Some(restore) = restore {
            let now = self.text(cx);
            let back = restore.text_beside(&now).to_owned();
            let joined = if now.is_empty() { back } else if back.is_empty() { now } else { format!("{back} {now}") };
            self.field.update(cx, |field, cx| field.set_text(joined, cx));
        }
        self.field.update(cx, |field, cx| field.set_error(error.map(SharedString::from), cx));
    }

    /// What was written, back in the field (ahead of anything written since), with why.
    fn put_back(&mut self, text: &str, error: Option<String>, cx: &mut Context<Self>) {
        let now = self.text(cx);
        let joined = if now.is_empty() { text.to_owned() } else { format!("{text}\n{now}") };
        self.field.update(cx, |field, cx| {
            field.set_text(joined, cx);
            field.set_error(error.map(SharedString::from), cx);
        });
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        let Target::Session { id, .. } = self.target.clone() else { return };
        let client = self.client.clone();
        self.spawn(cx, move || client.stop_session(&id), |this, result, cx| {
            if let Err(error) = result {
                this.note = Some(Note { text: format!("It didn’t stop: {error}").into(), warning: true });
                cx.notify();
            }
        });
    }

    /// "/"'s offers for what's written: shown while it's "/" and a name being typed.
    pub fn slash_offers(&self, cx: &App) -> Vec<Offer> {
        let text = self.text(cx);
        let Some(typed) = text.strip_prefix('/') else { return Vec::new() };
        if typed.contains(char::is_whitespace) || self.slash_dismissed.as_deref() == Some(text.as_str()) {
            return Vec::new();
        }
        let Some(offers) = &self.offers else { return Vec::new() };
        let typed = typed.to_lowercase();
        let keywords = offers.keywords.iter().map(|keyword| Offer { name: keyword.name.clone(), summary: keyword.summary.clone() });
        let commands = offers.commands.iter().map(|command| Offer { name: command.name.clone(), summary: command.description.clone().unwrap_or_default() });
        keywords.chain(commands).filter(|offer| offer.name.to_lowercase().starts_with(&typed)).take(SLASH_MOST).collect()
    }

    fn slash_step(&mut self, by: isize, cx: &mut Context<Self>) {
        let count = self.slash_offers(cx).len() as isize;
        if count > 0 {
            self.slash_at = (self.slash_at as isize + by).rem_euclid(count) as usize;
            cx.notify();
        }
    }

    /// Puts offer `at` in the field, ready for what follows it.
    fn slash_pick(&mut self, at: usize, window: &mut Window, cx: &mut Context<Self>) {
        let offers = self.slash_offers(cx);
        let Some(offer) = offers.get(at.min(offers.len().saturating_sub(1))) else { return };
        let text = format!("/{} ", offer.name);
        self.field.update(cx, |field, cx| field.set_text(text, cx));
        window.focus(&self.field.focus_handle(cx), cx);
        cx.notify();
    }

    fn slash_list(&self, offers: &[Offer], cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let c = &theme.colors;
        let rows = offers.iter().enumerate().map(|(ix, offer)| {
            let selected = ix == self.slash_at;
            div()
                .id(("slash", ix))
                .flex()
                .items_center()
                .gap(space::S3)
                .h(px(30.))
                .px(space::S2)
                .rounded(radius::SMALL)
                .cursor_pointer()
                .when(selected, |d| d.bg(c.selected))
                .hover(|s| s.bg(c.hover))
                .on_click(cx.listener(move |this, _, window, cx| this.slash_pick(ix, window, cx)))
                .child(div().flex_none().text_ui(TypeSize::Small).medium().text_color(c.text).child(format!("/{}", offer.name)))
                .child(div().min_w_0().truncate().text_ui(TypeSize::Small).text_color(c.text_muted).child(offer.summary.clone()))
        });
        div()
            .absolute()
            .bottom_full()
            .left_0()
            .right_0()
            .mb(space::S2)
            .p(space::S1)
            .rounded(radius::POPOVER)
            .bg(c.elevated)
            .border_1()
            .border_color(c.border)
            .shadow(theme.elevated_shadow())
            .children(rows)
            .into_any_element()
    }

    fn model_chip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let model = self.model();
        let needs = self.model.as_ref().is_some_and(ModelState::needs_choosing);
        let name = if needs {
            "Choose a Model".to_owned()
        } else {
            let named = self.model.as_ref().and_then(|state| state.name.clone());
            let listed = model.as_ref().and_then(|model| self.offered.iter().find(|offered| offered.provider_id == model.provider_id && offered.id == model.id)).map(|offered| offered.name.clone());
            named.or(listed).or_else(|| model.as_ref().map(|model| model.id.clone()))?
        };
        let offered: Vec<OfferedModel> = self.offered.iter().filter(|offered| offered.is_offered()).cloned().collect();
        let this = cx.entity().downgrade();
        let current = model.clone();
        let trigger = Button::new("model-chip", name).ghost().size(ButtonSize::Small).icon_after(IconName::ChevronDown);
        Some(
            PopoverMenu::new("model-menu", trigger, move |_, cx| {
                let (offered, current, this) = (offered.clone(), current.clone(), this.clone());
                cx.new(|cx| {
                    let mut menu = Menu::new(cx).width(px(260.));
                    if offered.is_empty() {
                        menu = menu.entry(MenuEntry::new("No models to offer yet").disabled(true));
                    }
                    for model in offered {
                        let reference = model.reference();
                        let checked = current.as_ref().is_some_and(|current| current.provider_id == reference.provider_id && current.id == reference.id);
                        let this = this.clone();
                        menu = menu.entry(MenuEntry::new(model.name.clone()).checked(checked).on_select(move |_, cx| {
                            this.update(cx, |this, cx| this.pick(reference.clone(), cx)).ok();
                        }));
                    }
                    menu
                })
            })
            .into_any_element(),
        )
    }

    fn effort_chip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let model = self.model()?;
        if self.efforts.is_empty() {
            return None;
        }
        let label = model.variant.as_deref().map(effort_title).unwrap_or_else(|| "Default".into());
        let efforts = self.efforts.clone();
        let this = cx.entity().downgrade();
        let trigger = Button::new("effort-chip", label).ghost().size(ButtonSize::Small).icon_after(IconName::ChevronDown);
        Some(
            PopoverMenu::new("effort-menu", trigger, move |_, cx| {
                let (efforts, model, this) = (efforts.clone(), model.clone(), this.clone());
                cx.new(|cx| {
                    let mut menu = Menu::new(cx).width(px(180.)).header("Effort");
                    for effort in efforts {
                        let checked = model.variant.as_deref() == Some(effort.as_str());
                        let picked = ModelRef { variant: Some(effort.clone()), ..model.clone() };
                        let this = this.clone();
                        menu = menu.entry(MenuEntry::new(effort_title(&effort)).checked(checked).on_select(move |_, cx| {
                            this.update(cx, |this, cx| this.pick(picked.clone(), cx)).ok();
                        }));
                    }
                    menu
                })
            })
            .into_any_element(),
        )
    }
}

type Models = (Option<ModelState>, Vec<OfferedModel>, Option<ModelRef>, Vec<String>);

/// What the chips show, as the box says it: the conversation's model, what's offered, where a new
/// one starts, and the model's efforts.
fn models_of(client: &BoxClient, target: &Target, picked: Option<&ModelRef>) -> Models {
    let offered = client.offered_models(picked).ok();
    let state = match target {
        Target::Session { id, .. } => client.session_models(&[id.as_str()]).ok().and_then(|mut all| all.remove(id)),
        Target::New(_) => None,
    };
    let starting = offered.as_ref().and_then(|offered| offered.starting.clone().flatten());
    let model = state.as_ref().and_then(|state| state.model.clone()).or_else(|| picked.cloned()).or_else(|| starting.clone());
    let place = match target {
        Target::Session { place, .. } => *place,
        Target::New(_) => Where::Engine,
    };
    let efforts = model.as_ref().and_then(|model| client.efforts(place, None, model).ok()).unwrap_or_default();
    (state, offered.map(|offered| offered.models).unwrap_or_default(), starting, efforts)
}

/// What the box did with a typed text, as a line under the composer; and, for what's this
/// client's to do that it can't yet, that plainly (what was written is put back by the box's
/// `restore`, or kept here).
fn said(answer: &Answer) -> Option<Note> {
    let note = |text: &str, warning: bool| Some(Note { text: text.to_owned().into(), warning });
    if let Some(agent) = &answer.agent {
        let mode = match agent.as_str() {
            "plan" => "Plan".to_owned(),
            "build" => "Build".to_owned(),
            other => other.to_owned(),
        };
        return note(&format!("Switched to {mode}."), false);
    }
    if answer.shell.is_some() {
        return note("Running a “!” command isn’t in this app yet: use Kuvo Code on your Mac or iPhone.", true);
    }
    if answer.compact == Some(true) {
        return note("Compacting isn’t in this app yet: use Kuvo Code on your Mac or iPhone.", true);
    }
    if answer.toggle_autopilot == Some(true) || answer.autopilot.is_some() {
        return note("Autopilot isn’t shown in this app yet.", true);
    }
    if answer.side_thread == Some(true) {
        return note("Side threads aren’t in this app yet.", true);
    }
    if answer.show_goal == Some(true) || answer.goal.is_some() {
        return note("Goals aren’t shown in this app yet.", true);
    }
    if answer.wake_up.is_some() {
        return note("Set to come back on its schedule.", false);
    }
    if answer.review.is_some() {
        return note("Review started.", false);
    }
    None
}

impl Render for Composer {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let c = &theme.colors;
        let text = self.text(cx);
        let empty = text.trim().is_empty();
        let offers = self.slash_offers(cx);
        self.slash_at = self.slash_at.min(offers.len().saturating_sub(1));
        let keyword = typed::keyword(&text).map(|(keyword, _)| {
            let title = self
                .offers
                .as_ref()
                .and_then(|offers| offers.keywords.iter().find(|offered| offered.name == keyword).map(|offered| offered.title.clone()))
                .unwrap_or_else(|| format!("/{keyword}"));
            Chip::new("typed-keyword", title).icon(IconName::Sparkle).tone(ChipTone::Accent)
        });
        let stop = self.running && empty && matches!(self.target, Target::Session { .. });
        let send = if stop {
            Button::icon_only("stop", IconName::Stop, "Stop").style(kuvo_ui::ButtonStyle::Secondary).pill().on_click(cx.listener(|this, _, _, cx| this.stop(cx)))
        } else {
            Button::icon_only("send", IconName::ArrowUp, if empty { "Type to send" } else { "Send" })
                .accent()
                .pill()
                .disabled(empty || self.sending)
                .loading(self.sending)
                .on_click(cx.listener(|this, _, _, cx| this.send(cx)))
        };
        let note = self.note.clone().map(|note| {
            div()
                .px(space::S2)
                .pt(space::S2)
                .text_ui(TypeSize::Caption)
                .text_color(if note.warning { c.warning } else { c.text_muted })
                .child(note.text)
        });
        let context = if offers.is_empty() { CONTEXT.to_owned() } else { format!("{CONTEXT} {SLASH}") };
        let card = div()
            .relative()
            .flex()
            .flex_col()
            .gap(space::S2)
            .p(space::S3)
            .pl(space::S4)
            .rounded(radius::CARD)
            .bg(c.surface)
            .border_1()
            .border_color(c.border_strong)
            .shadow(theme.card_shadow())
            .when(!offers.is_empty(), |d| d.child(self.slash_list(&offers, cx)))
            .children(keyword.map(|chip| div().flex().child(chip)))
            .child(div().pt(space::S1).pr(space::S1).child(self.field.clone()))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S1)
                    .ml(-space::S2)
                    .children(self.model_chip(cx))
                    .children(self.effort_chip(cx))
                    .child(div().flex_1())
                    .child(send),
            );
        div()
            .id("composer")
            .key_context(context.as_str())
            .on_action(cx.listener(|this, _: &SlashNext, _, cx| this.slash_step(1, cx)))
            .on_action(cx.listener(|this, _: &SlashPrevious, _, cx| this.slash_step(-1, cx)))
            .on_action(cx.listener(|this, _: &SlashPick, window, cx| this.slash_pick(this.slash_at, window, cx)))
            .on_action(cx.listener(|this, _: &SlashDismiss, _, cx| {
                this.slash_dismissed = Some(this.text(cx));
                cx.notify();
            }))
            .w_full()
            .flex()
            .flex_col()
            .child(div().debug_selector(|| "composer-card".into()).child(card))
            .children(note)
    }
}
