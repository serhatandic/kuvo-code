//! The composer: the text field, the model and effort chips, and Send (Stop while a run is under
//! way and nothing's written). What's written goes through `kuvo_box`'s typed send: a plain message
//! straight to the box as fields, "/" and "!" to the box first, which says what they mean. "/"
//! offers what the box says it offers there, as you type.
//!
//! In a new conversation (the landing view) Send starts it on the box, in the project picked, then
//! sends the same way.

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, InteractiveElement, IntoElement,
    KeyBinding, ParentElement, Render, ScrollHandle, SharedString, StatefulInteractiveElement, Styled, Subscription, Task, Window, actions,
    div, prelude::FluentBuilder as _, px,
};
use std::time::Duration;

use kuvo_box::models::{ModelState, Offered, OfferedModel, Side, StartIn, effort_title};
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
/// How long before what the box couldn't say of its models is asked again, at first and at most.
const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MOST: Duration = Duration::from_secs(30);
/// How many of "/"'s offers show at once (the rest scroll).
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
#[derive(Clone, Debug, PartialEq)]
pub enum ComposerEvent {
    /// A new conversation was started on the box (in `folder`, filed under `project`), and what
    /// was written (`written`) sent to it: what the box said of it, or why it couldn't go, is for
    /// the conversation's own composer.
    Started { session: String, folder: Option<String>, project: Option<String>, written: String, sent: Result<Sent, String> },
}

/// What the chips show, as the box says it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Models {
    /// What its box says of the conversation's model.
    pub state: Option<ModelState>,
    /// What the box offers (`kuvo/models/offered`): each model with its side and efforts, and where
    /// a new conversation starts.
    pub offered: Option<Offered>,
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
    /// Whether it reads the box by itself (the app), or shows what it's handed (tests and shots).
    live: bool,
    models: Models,
    /// The model a new conversation starts on, as picked here (the box's `starting` until then).
    picked: Option<ModelRef>,
    /// The conversation's folder, where its project's own settings may add models (`set_folder`).
    folder: Option<String>,
    /// Which read of the models is the latest: an older one coming back late is left.
    reads: u64,
    /// How long before what the box couldn't say is asked again (longer each time).
    retry: Duration,
    retrying: Option<Task<()>>,
    /// Whether the box couldn't say all of it last time: asked again in a while, while it's shown.
    unsaid: bool,
    /// A model picked whose change hasn't come back yet: what's said of another meanwhile is left
    /// (as KuvoClient's `SessionModelState.isAbout`).
    picking: Option<ModelRef>,
    /// Whether it's known where the conversation runs (its engine, or its coding agents' bridge):
    /// its model can't be changed in place until then.
    place_known: bool,
    /// Whether it's on screen (a kept conversation's isn't): only then is it asked again.
    shown: bool,
    offers: Option<Offers>,
    slash_scroll: ScrollHandle,
    slash_at: usize,
    /// The text "/"'s list was put away for (with Escape): it shows again once that changes.
    slash_dismissed: Option<String>,
    note: Option<Note>,
    /// What the field held as the note was shown: the note goes once that changes.
    noted: String,
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
        Composer::in_folder(client, target, None, read, cx)
    }

    /// The same, for a conversation in `folder` (as its box lists it): what's offered is read
    /// there from the first read (`set_folder`).
    pub fn in_folder(client: BoxClient, target: Target, folder: Option<String>, read: bool, cx: &mut Context<Self>) -> Composer {
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
                if this.note.is_some() && this.text(cx) != this.noted {
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
            live: read,
            models: Models::default(),
            picked: None,
            folder,
            reads: 0,
            retry: RETRY_FIRST,
            retrying: None,
            unsaid: false,
            picking: None,
            place_known: false,
            shown: true,
            offers: None,
            slash_scroll: ScrollHandle::new(),
            slash_at: 0,
            slash_dismissed: None,
            note: None,
            noted: String::new(),
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

    /// What the chips show, as the box last said it.
    pub fn models(&self) -> &Models {
        &self.models
    }

    pub fn note(&self) -> Option<&Note> {
        self.note.as_ref()
    }

    fn text(&self, cx: &App) -> String {
        self.field.read(cx).text().to_owned()
    }

    /// Where a new conversation starts (the landing view's project chip).
    pub fn set_start(&mut self, place: StartIn, cx: &mut Context<Self>) {
        // (Its models are read again by what moved it: opening the landing view, or a pick.)
        if let Target::New(was) = &self.target
            && *was != place
        {
            self.target = Target::New(place);
            cx.notify();
        }
    }

    /// The conversation's folder, as its box lists it: what's offered is read there, its project's
    /// own models too (`models.offered.folder`).
    /// Whether it was read again for it (a folder it didn't have, in the app).
    pub fn set_folder(&mut self, folder: Option<String>, cx: &mut Context<Self>) -> bool {
        if self.folder == folder {
            return false;
        }
        self.folder = folder;
        if self.live {
            self.read_models(cx);
        }
        self.live
    }

    /// The folder what's offered is read in: a conversation's, or the project a new one starts in.
    fn offered_in(&self) -> Option<String> {
        match &self.target {
            Target::Session { .. } => self.folder.clone(),
            // (The box reads its own lists for one that isn't a folder there.)
            Target::New(StartIn::Project(project)) => Some(project.clone()),
            Target::New(_) => None,
        }
    }

    /// What became of `written`, sent from the landing view to the conversation this composer is
    /// for: the box's answer (what goes back, its note), or, where it couldn't go, it and why.
    pub fn take_sent(&mut self, written: &str, sent: Result<Sent, String>, cx: &mut Context<Self>) {
        match sent {
            Ok(sent) => self.sent(sent, written, cx),
            Err(error) => self.put_back(written, Some(error), cx),
        }
        cx.notify();
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
            Target::Session { .. } => self.models.state.as_ref().and_then(|state| state.model.clone()),
            Target::New(_) => self.picked.clone(),
        }
    }

    /// What the box offers: for a conversation, its own side's models (it's put on one of those in
    /// place); for a new one, all of them. Those a picker leaves out (retiring, hidden) aren't here.
    pub fn menu_models(&self) -> Vec<OfferedModel> {
        let side = match &self.target {
            Target::Session { place, .. } => Some(Side::of(*place)),
            Target::New(_) => None,
        };
        let models = self.models.offered.as_ref().map(|offered| offered.models.as_slice()).unwrap_or_default();
        models.iter().filter(|model| model.is_offered() && side.is_none_or(|side| model.side == side)).cloned().collect()
    }

    /// Whether it's on screen. A kept conversation's composer isn't asked again in the background;
    /// shown again, what the box couldn't say is asked for at once.
    pub fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        if self.shown == shown {
            return;
        }
        self.shown = shown;
        if !shown {
            self.retrying = None;
        } else if self.unsaid && self.live {
            self.read_models(cx);
        }
    }

    /// What the model chip says: the model's name, "Choose a Model", or (its model not said yet, or
    /// not read) "Model", so one can still be picked; none before the box has said anything.
    pub fn chip_label(&self) -> Option<String> {
        let model = self.model();
        if self.models.offered.is_none() && model.is_none() {
            return None;
        }
        if self.needs_model() {
            return Some("Choose a Model".to_owned());
        }
        let named = self.models.state.as_ref().and_then(|state| state.name.clone());
        let listed = model.as_ref().and_then(|model| self.menu_models().into_iter().find(|offered| offered.is(model))).map(|offered| offered.name);
        Some(named.or(listed).or_else(|| model.map(|model| model.id)).unwrap_or_else(|| "Model".to_owned()))
    }

    /// Whether the box offers models of another side than the conversation's, which it can't be
    /// put on in place.
    pub fn left_out(&self) -> bool {
        let Target::Session { place, .. } = &self.target else { return false };
        let models = self.models.offered.as_ref().map(|offered| offered.models.as_slice()).unwrap_or_default();
        models.iter().any(|model| model.is_offered() && model.side != Side::of(*place))
    }

    /// The model's efforts, as the box offers it.
    pub fn efforts(&self) -> Vec<String> {
        let Some(model) = self.model() else { return Vec::new() };
        let models = self.models.offered.as_ref().map(|offered| offered.models.as_slice()).unwrap_or_default();
        models.iter().find(|offered| offered.is(&model)).map(|offered| offered.efforts.clone()).unwrap_or_default()
    }

    /// Whether Send waits for a model to be chosen: the conversation's is gone or there's none, or
    /// (a new one) the box says nothing runs and none's picked.
    pub fn needs_model(&self) -> bool {
        match &self.target {
            Target::Session { .. } => self.models.state.as_ref().is_some_and(|state| state.choose),
            Target::New(_) => self.picked.is_none() && self.models.offered.as_ref().is_some_and(|offered| offered.starting == Some(None)),
        }
    }

    /// Takes what the box says of the models, as a read brings it (tests and shots hand it in).
    pub fn take_models(&mut self, models: Models, cx: &mut Context<Self>) {
        if self.picked.is_none() {
            self.picked = models.offered.as_ref().and_then(|offered| offered.starting.clone().flatten());
        }
        self.models = models;
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

    /// Reads the conversation's model and what the box offers. What a side couldn't say is kept
    /// as it said it before, and asked again in a while (PROTOCOL.md, "The models offered"); a model
    /// whose state couldn't be read keeps what was said of it.
    pub fn read_models(&mut self, cx: &mut Context<Self>) {
        self.reads += 1;
        let read = self.reads;
        let (client, target, picked, before, folder) = (self.client.clone(), self.target.clone(), self.picked.clone(), self.models.offered.clone(), self.offered_in());
        self.spawn(cx, move || models_of(&client, &target, picked.as_ref(), folder.as_deref(), before.as_ref()), move |this, (offered, said_all, state), cx| {
            if this.reads == read {
                this.took_models(offered, said_all, state, cx);
            }
        });
    }

    /// What a read of the models said, taken: a failed part keeps what was there. `said_all`:
    /// whether the box itself could say both sides (before what it said earlier was kept).
    fn took_models(&mut self, offered: Option<Offered>, said_all: bool, state: Option<Said>, cx: &mut Context<Self>) {
        let mut said_all = said_all;
        if let Some(offered) = offered {
            if self.picked.is_none() {
                self.picked = offered.starting.clone().flatten();
            }
            self.models.offered = Some(offered);
        }
        match state {
            // While a pick is on its way, what's said of another model is of the one before.
            Some(Said::Is(state)) if self.picking.as_ref().is_some_and(|picking| state.model.as_ref() != Some(picking)) => {}
            Some(Said::Is(state)) => self.models.state = Some(*state),
            // Left out (the box can't say yet), or not read: its model and name stay, with no
            // refusal of its own (PROTOCOL.md, "A session's model"), and it's asked again.
            Some(Said::Unsaid) => {
                if let Some(state) = self.models.state.as_mut() {
                    state.unsaid();
                }
                said_all = false;
            }
            None => {}
        }
        // A side that couldn't say (or a read that failed): asked again in a while, longer each
        // time, while it's on screen.
        self.unsaid = !said_all;
        if said_all {
            self.retry = RETRY_FIRST;
            self.retrying = None;
        } else if self.live && self.shown {
            let wait = self.retry;
            self.retry = (self.retry * 2).min(RETRY_MOST);
            self.retrying = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(wait).await;
                this.update(cx, |this, cx| this.read_models(cx)).ok();
            }));
        }
        cx.notify();
    }

    /// What its box says of the conversation's model, handed in as a read would bring it (tests).
    #[cfg(feature = "stand-in")]
    pub fn take_state(&mut self, state: ModelState, cx: &mut Context<Self>) {
        self.took_models(None, true, Some(Said::Is(Box::new(state))), cx);
    }

    /// Reads what the chips and "/" show at once, on this thread (shots and tests, against a stand-in).
    #[cfg(feature = "stand-in")]
    pub fn read_at_once(&mut self, cx: &mut Context<Self>) {
        let (offered, said_all, state) = models_of(&self.client, &self.target, self.picked.as_ref(), self.offered_in().as_deref(), self.models.offered.as_ref());
        self.took_models(offered, said_all, state, cx);
        if let Target::Session { id, .. } = &self.target
            && let Ok(offers) = self.client.typed_offers(id)
        {
            self.take_offers(offers, cx);
        }
    }

    /// Where the conversation lives on its box, once its follow has found it.
    pub fn set_place(&mut self, place: Where, cx: &mut Context<Self>) {
        if !self.place_known {
            self.place_known = true;
            cx.notify();
        }
        if let Target::Session { place: was, .. } = &mut self.target
            && *was != place
        {
            *was = place;
            self.read_models(cx);
        }
    }

    /// Whether its model can be changed here now: a new one's always; a conversation's once it's
    /// known where it runs.
    pub fn can_pick(&self) -> bool {
        matches!(self.target, Target::New(_)) || self.place_known
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
    pub fn pick(&mut self, model: ModelRef, cx: &mut Context<Self>) {
        match self.target.clone() {
            Target::New(_) => {
                self.picked = Some(model);
                self.read_models(cx);
            }
            Target::Session { id, place } => {
                // A read already on its way says what was before: it's left, and so is what's said
                // of another model until the change comes back.
                self.reads += 1;
                self.picking = Some(model.clone());
                // Shown at once; what its box says of it comes with the next read.
                // As without the box's word on it, until it's asked again.
                let name = self.menu_models().into_iter().find(|offered| offered.is(&model)).map(|offered| offered.name);
                if let Some(state) = self.models.state.as_mut() {
                    state.model = Some(model.clone());
                    state.name = name.or(state.name.take());
                    state.unsaid();
                }
                cx.notify();
                let client = self.client.clone();
                let picked = model.clone();
                self.spawn(cx, move || client.select_model(&id, place, &model), move |this, result, cx| {
                    // (Only the latest pick's change ends the wait: an earlier one's coming back
                    // first leaves the latest's.)
                    if this.picking.as_ref() == Some(&picked) {
                        this.picking = None;
                    }
                    if let Err(error) = result {
                        this.set_note(Note { text: format!("The model wasn’t changed: {error}").into(), warning: true }, cx);
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
        draft.refusal = self.models.state.as_ref().and_then(|state| state.refusal.clone());
        if self.needs_model() {
            // As its box words it, for a conversation; a new one's box says only that none runs.
            let words = self.models.state.as_ref().and_then(|state| state.refusal.clone()).unwrap_or_else(|| "Choose a model to send it.".to_owned());
            self.set_note(Note { text: words.into(), warning: true }, cx);
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
                        Ok(sent) => this.sent(sent, &text, cx),
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
                        let sent = client.send_draft(&started.session, &draft, None).map_err(|error| error.to_string());
                        Ok::<_, kuvo_box::Error>((started, sent))
                    },
                    move |this, result, cx| {
                        this.sending = false;
                        match result {
                            // Started: what was written, and what the box said of it, go with the
                            // conversation; this composer is left empty for the next one.
                            Ok((started, sent)) => cx.emit(ComposerEvent::Started {
                                session: started.session,
                                folder: started.folder,
                                project: started.project,
                                written: text.clone(),
                                sent,
                            }),
                            Err(error) => this.put_back(&text, Some(error.to_string()), cx),
                        }
                        cx.notify();
                    },
                );
            }
        }
    }

    /// What the box did with a typed text, shown; what goes back to the composer, put back. What
    /// this client is to do that it can't yet keeps what was written (`written`).
    fn sent(&mut self, sent: Sent, written: &str, cx: &mut Context<Self>) {
        let Sent::Typed { answer, .. } = sent else { return };
        let Answer { restore, error, .. } = (*answer).clone();
        let note = said(&answer);
        if restore.is_none() && is_clients_to_do(&answer) {
            self.put_back(written, None, cx);
        }
        if let Some(restore) = restore {
            let now = self.text(cx);
            let joined = ahead_of(restore.text_beside(&now), &now);
            self.field.update(cx, |field, cx| field.set_text(joined, cx));
        }
        self.field.update(cx, |field, cx| field.set_error(error.map(SharedString::from), cx));
        if let Some(note) = note {
            self.set_note(note, cx);
        }
    }

    /// Shows `note` under the composer, until what's written changes.
    fn set_note(&mut self, note: Note, cx: &mut Context<Self>) {
        self.note = Some(note);
        self.noted = self.text(cx);
    }

    /// What was written, back in the field (ahead of anything written since), with why.
    fn put_back(&mut self, text: &str, error: Option<String>, cx: &mut Context<Self>) {
        let now = self.text(cx);
        let joined = ahead_of(text, &now);
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
                this.set_note(Note { text: format!("It didn’t stop: {error}").into(), warning: true }, cx);
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
        // Names starting with what's typed first, then those containing it, each by name, as
        // KuvoClient's `SlashCommands.matches` orders them.
        let mut matched: Vec<(bool, Offer)> = keywords
            .chain(commands)
            .filter_map(|offer| {
                let name = offer.name.to_lowercase();
                name.contains(&typed).then(|| (!name.starts_with(&typed), offer))
            })
            .collect();
        matched.sort_by(|(a_later, a), (b_later, b)| a_later.cmp(b_later).then_with(|| a.name.cmp(&b.name)));
        matched.into_iter().map(|(_, offer)| offer).collect()
    }

    fn slash_step(&mut self, by: isize, cx: &mut Context<Self>) {
        let count = self.slash_offers(cx).len() as isize;
        if count > 0 {
            self.slash_at = (self.slash_at as isize + by).rem_euclid(count) as usize;
            self.slash_scroll.scroll_to_item(self.slash_at);
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
            .id("slash-list")
            .track_scroll(&self.slash_scroll)
            .overflow_y_scroll()
            .max_h(px(30. * SLASH_MOST as f32 + 8.))
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
        let name = self.chip_label()?;
        let model = self.model();
        let offered = self.menu_models();
        let left_out = self.left_out();
        let can_pick = self.can_pick();
        let this = cx.entity().downgrade();
        let current = model.clone();
        let trigger = Button::new("model-chip", name).ghost().size(ButtonSize::Small).icon_after(IconName::ChevronDown);
        Some(
            PopoverMenu::new("model-menu", trigger, move |_, cx| {
                let (offered, current, this) = (offered.clone(), current.clone(), this.clone());
                let (left_out, can_pick) = (left_out, can_pick);
                cx.new(|cx| {
                    let mut menu = Menu::new(cx).width(px(260.));
                    if !can_pick {
                        menu = menu.entry(MenuEntry::new("Finding where this conversation runs…").disabled(true));
                        return menu;
                    }
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
                    // Another side's models (the engine's, or the coding agents') carry the
                    // conversation over to a new session there, which this app can't do yet.
                    if left_out {
                        menu = menu.separator().entry(MenuEntry::new("Other agents’ models").detail("not in this app yet").disabled(true));
                    }
                    menu
                })
            })
            .into_any_element(),
        )
    }

    fn effort_chip(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let model = self.model()?;
        let efforts = self.efforts();
        if efforts.is_empty() || self.needs_model() || !self.can_pick() {
            return None;
        }
        let label = model.variant.as_deref().map(effort_title).unwrap_or_else(|| "Default".into());
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

/// What a read says of a conversation's model.
enum Said {
    Is(Box<ModelState>),
    /// Left out (its box can't say yet), or not read.
    Unsaid,
}

/// What the box offers in `folder` (kept, for a side it couldn't say now, as it said before; none
/// for a read that failed), whether it could say all of it itself, and what it says of the conversation's
/// model (none for a new one).
fn models_of(client: &BoxClient, target: &Target, picked: Option<&ModelRef>, folder: Option<&str>, before: Option<&Offered>) -> (Option<Offered>, bool, Option<Said>) {
    let offered = client.offered_models(picked, folder).ok();
    let said_all = offered.as_ref().is_some_and(Offered::is_whole);
    let offered = offered.map(|offered| offered.keeping(before));
    let state = match target {
        Target::Session { id, .. } => Some(client.session_models(&[id.as_str()]).ok().and_then(|mut all| all.remove(id)).map_or(Said::Unsaid, |state| Said::Is(Box::new(state)))),
        Target::New(_) => None,
    };
    (offered, said_all, state)
}

/// `front` put back ahead of what's written since, as one text.
fn ahead_of(front: &str, now: &str) -> String {
    if now.is_empty() {
        front.to_owned()
    } else if front.is_empty() {
        now.to_owned()
    } else if front.ends_with(char::is_whitespace) {
        format!("{front}{now}")
    } else {
        format!("{front} {now}")
    }
}

/// Whether the box's answer leaves the client a step this one can't take yet: what was written is
/// kept in the field rather than lost.
fn is_clients_to_do(answer: &Answer) -> bool {
    answer.shell.is_some() || answer.compact == Some(true) || answer.toggle_autopilot == Some(true) || answer.side_thread == Some(true) || answer.show_goal == Some(true)
}

/// What the box did with a typed text, as a line under the composer; and, for what's this
/// client's to do that it can't yet, that plainly (what was written is put back by the box's
/// `restore`, else kept by [`Composer::sent`]).
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
    if answer.toggle_autopilot == Some(true) {
        return note("Turning Autopilot on or off isn’t in this app yet.", true);
    }
    if answer.autopilot.is_some() {
        return note("Autopilot changed. It isn’t shown in this app yet.", false);
    }
    if answer.side_question.is_some() {
        return note("Asked aside. The answer isn’t shown in this app yet.", false);
    }
    if answer.handoff.is_some() {
        return note("Writing a handoff note. The new session shows in the sidebar once it’s ready.", false);
    }
    if answer.asked_bot == Some(true) {
        return note("Asked the bot for a plan.", false);
    }
    if answer.goal_cleared == Some(true) {
        return note("Goal cleared.", false);
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
        // The keyword it starts with, as the box will read it (and as the sent message shows it).
        let keyword = typed::keyword(&text).map(|(keyword, _)| Chip::new("typed-keyword", format!("/{keyword}")).icon(IconName::Sparkle).tone(ChipTone::Accent));
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
