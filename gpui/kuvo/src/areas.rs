//! The sidebars of the areas past Sessions, beside the rail: Bots (its bots and group chats), the
//! Work Queue (In Progress and its categories), Computers (this one and the machines it runs
//! sessions on) and Settings (its sections). Each is its own view, kept while another area shows
//! and drawn only while its own does; only the area on screen asks the box anything, as it opens.
//!
//! None of these areas' pages is in the app yet: picking a row shows a plain page saying so.

use gpui::{
    AnyElement, App, AppContext as _, Context, EventEmitter, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels, Render, SharedString,
    StatefulInteractiveElement, Styled, Task, Window, div, prelude::FluentBuilder as _, px, rgb,
};
use kuvo_box::BoxClient;
use kuvo_box::areas::{Bot, Group, Look, Machine, WorkQueue};
use kuvo_ui::{
    ActiveTheme, Icon, IconSize, StyledType, TypeSize,
    row::{NavRow, SectionHeader},
    small::{count_badge, spinner, status_dot},
    theme::{radius, space},
};

use crate::area::Area;
use crate::settings::{Pick, SettingsView};
use crate::time;


/// How an area's list stands.
#[derive(Clone, Debug, PartialEq)]
pub enum Reading<T> {
    NotYet,
    Ready(T),
    Failed(String),
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Bots {
    pub bots: Vec<Bot>,
    pub groups: Vec<Group>,
}

/// A row was picked: the window goes to its page.
pub struct Picked;

/// One area's sidebar.
pub struct AreaView {
    area: Area,
    client: BoxClient,
    live: bool,
    bots: Reading<Bots>,
    queue: Reading<WorkQueue>,
    machines: Reading<Vec<Machine>>,
    /// The box this window shows, as the Computers list names it first.
    this_box: SharedString,
    selected: Option<String>,
    now: Option<f64>,
    reading: Option<Task<()>>,
    /// Settings' own view: its sidebar drawn here, its pages as the main view.
    settings: Option<gpui::Entity<SettingsView>>,
    _settings_picks: Option<gpui::Subscription>,
}

impl EventEmitter<Picked> for AreaView {}

impl AreaView {
    pub fn new(area: Area, client: BoxClient, live: bool, cx: &mut Context<Self>) -> AreaView {
        let selected = (area == Area::Settings).then(|| "General".to_owned());
        let settings = (area == Area::Settings).then(|| cx.new(|cx| SettingsView::new(client.clone(), live, cx)));
        // A section picked in Settings' own sidebar is picked here, as any area's row is.
        let picks = settings.as_ref().map(|settings| {
            cx.subscribe(settings, |this: &mut AreaView, _, pick: &Pick, cx| {
                if pick.record {
                    this.pick(pick.section.clone(), cx);
                } else {
                    this.select(Some(pick.section.clone()), cx);
                }
            })
        });
        AreaView { area, client, live, bots: Reading::NotYet, queue: Reading::NotYet, machines: Reading::NotYet, this_box: "This Mac".into(), selected, now: None, reading: None, settings, _settings_picks: picks }
    }

    /// Settings' view, in the Settings area.
    pub fn settings(&self) -> Option<&gpui::Entity<SettingsView>> {
        self.settings.as_ref()
    }

    pub fn area(&self) -> Area {
        self.area
    }

    pub fn set_now(&mut self, now: f64, cx: &mut Context<Self>) {
        self.now = Some(now);
        if let Some(settings) = &self.settings {
            settings.update(cx, |settings, _| settings.set_now(now));
        }
    }

    pub fn set_this_box(&mut self, name: SharedString, cx: &mut Context<Self>) {
        if self.this_box != name {
            if let Some(settings) = &self.settings {
                settings.update(cx, |settings, cx| settings.set_this_box(&name, cx));
            }
            self.this_box = name;
            cx.notify();
        }
    }

    /// It's shown: its list is read from the box (in the app, on another thread; in tests and
    /// shots, at once). What was read before stays on screen meanwhile.
    pub fn shown(&mut self, cx: &mut Context<Self>) {
        let (area, client) = (self.area, self.client.clone());
        if let Some(settings) = &self.settings {
            settings.update(cx, |settings, cx| settings.shown(cx));
            return;
        }
        if !self.live {
            let read = read(area, &client);
            self.take(read, cx);
            return;
        }
        self.reading = Some(cx.spawn(async move |this, cx| {
            let read = cx.background_executor().spawn(async move { read(area, &client) }).await;
            this.update(cx, |this, cx| this.take(read, cx)).ok();
        }));
    }

    fn take(&mut self, read: Read, cx: &mut Context<Self>) {
        match read {
            Read::Bots(bots) => self.bots = reading(bots, &self.bots),
            Read::Queue(queue) => self.queue = reading(queue, &self.queue),
            Read::Machines(machines) => self.machines = reading(machines, &self.machines),
            Read::Nothing => {}
        }
        cx.notify();
    }

    pub fn bots(&self) -> &Reading<Bots> {
        &self.bots
    }

    pub fn selected(&self) -> Option<&str> {
        self.selected.as_deref()
    }

    /// Picks a row (or none: the area's own page), as going back or forward does.
    pub fn select(&mut self, key: Option<String>, cx: &mut Context<Self>) {
        self.selected = key;
        self.show_section(cx);
        cx.notify();
    }

    fn pick(&mut self, key: String, cx: &mut Context<Self>) {
        self.selected = Some(key);
        self.show_section(cx);
        cx.emit(Picked);
        cx.notify();
    }

    /// Settings shows the section picked (its first, General, for none).
    fn show_section(&mut self, cx: &mut Context<Self>) {
        let section = self.selected.clone().unwrap_or_else(|| "General".into());
        if let Some(settings) = &self.settings {
            settings.update(cx, |settings, cx| settings.set_section(&section, cx));
        }
    }

    /// The page's title: what's picked, named as its row is.
    pub fn title(&self) -> SharedString {
        let Some(key) = self.selected.as_deref() else { return self.area.name().into() };
        let (kind, id) = key.split_once(':').unwrap_or(("", key));
        let named = match kind {
            "bot" => ready(&self.bots).and_then(|bots| bots.bots.iter().find(|bot| bot.id == id).map(|bot| bot.name.clone())),
            "group" => ready(&self.bots).and_then(|bots| bots.groups.iter().find(|group| group.id == id).map(|group| group.name.clone())),
            "category" => ready(&self.queue).and_then(|queue| queue.categories.iter().find(|category| category.id == id).map(|category| category.name.clone())),
            "machine" => ready(&self.machines).and_then(|machines| machines.iter().find(|machine| machine.id == id).map(|machine| machine.name.clone())),
            "progress" => Some("In Progress".into()),
            "this" => Some(self.this_box.to_string()),
            _ => Some(key.to_owned()),
        };
        named.unwrap_or_else(|| self.area.name().to_owned()).into()
    }

    fn now(&self) -> f64 {
        self.now.unwrap_or_else(time::now_ms)
    }
}

enum Read {
    Bots(kuvo_box::Result<Bots>),
    Queue(kuvo_box::Result<WorkQueue>),
    Machines(kuvo_box::Result<Vec<Machine>>),
    Nothing,
}

fn read(area: Area, client: &BoxClient) -> Read {
    match area {
        Area::Bots => Read::Bots(client.bots().map(|bots| {
            // Group chats come from the same box; a box whose chats can't be read still lists its bots.
            let groups = client.groups().unwrap_or_default();
            Bots { bots, groups }
        })),
        Area::Queue => Read::Queue(client.work_queue()),
        Area::Computers => Read::Machines(client.machines()),
        _ => Read::Nothing,
    }
}

/// What a read makes of the list: what it read, or (failing) what was there, else why.
fn reading<T: Clone>(read: kuvo_box::Result<T>, before: &Reading<T>) -> Reading<T> {
    match (read, before) {
        (Ok(value), _) => Reading::Ready(value),
        (Err(_), Reading::Ready(value)) => Reading::Ready(value.clone()),
        (Err(error), _) => Reading::Failed(error.to_string()),
    }
}

fn ready<T>(reading: &Reading<T>) -> Option<&T> {
    match reading {
        Reading::Ready(value) => Some(value),
        _ => None,
    }
}

impl Render for AreaView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(settings) = self.settings.clone() {
            return div().id("area-settings").size_full().child(settings.update(cx, |settings, cx| settings.sidebar(cx)));
        }
        let rows = match self.area {
            Area::Bots => self.bots_rows(cx),
            Area::Queue => self.queue_rows(cx),
            Area::Computers => self.computer_rows(cx),
            Area::Settings => Vec::new(),
            Area::Sessions => Vec::new(),
        };
        div()
            .id(SharedString::from(format!("area-{}", self.area.slug())))
            .size_full()
            .overflow_y_scroll()
            .px(space::S2)
            .pt(space::S2)
            .pb(space::S4)
            .children(rows)
    }
}

impl AreaView {
    fn row_click(&self, key: String, cx: &mut Context<Self>) -> impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static {
        cx.listener(move |this, _, _, cx| this.pick(key.clone(), cx))
    }

    fn is_selected(&self, key: &str) -> bool {
        self.selected.as_deref() == Some(key)
    }

    fn bots_rows(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let bots = match &self.bots {
            Reading::NotYet => return vec![quiet("Loading bots…", true, cx)],
            Reading::Failed(why) => return vec![quiet(&format!("Bots couldn’t be read: {why}"), false, cx)],
            Reading::Ready(bots) => bots,
        };
        let mut rows = Vec::new();
        if bots.bots.is_empty() {
            rows.push(quiet("No bots on this computer yet.", false, cx));
        }
        for bot in &bots.bots {
            let key = format!("bot:{}", bot.id);
            let selected = self.is_selected(&key);
            // BOX-NEEDED: what a bot is doing now, `now: {working, asking}` on each bot in `GET kuvo/bots` (#711): until the box says it, its row shows its job.
            let (working, asking) = bot.now.as_ref().map_or((0, 0), |now| (now.working, now.asking));
            let words = doing(working, asking).unwrap_or_else(|| bot.job.clone());
            let trailing: Option<AnyElement> = if asking > 0 {
                Some(count_badge(asking, cx).into_any_element())
            } else if working > 0 {
                Some(spinner(SharedString::from(format!("bot-spin-{}", bot.id)), IconSize::Nav, c.text_muted).into_any_element())
            } else {
                None
            };
            let (hover, selected_bg) = (c.hover, c.selected_card);
            let selector = format!("bot-{}", bot.id);
            rows.push(
                div()
                    .id(SharedString::from(selector.clone()))
                    .debug_selector(move || selector)
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .px(space::S2)
                    .py(space::S1_5)
                    .mb(space::S0_5)
                    .rounded(radius::NAV)
                    .cursor_pointer()
                    .map(|r| kuvo_ui::row::selected_card(r, selected, cx))
                    .hover(move |s| s.bg(if selected { selected_bg } else { hover }))
                    .on_click(self.row_click(key, cx))
                    // Still, as the user asked: the Mac's animated faces aren't brought over yet.
                    .child(bot_face(&bot.look, px(28.)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(div().truncate().text_ui(TypeSize::Body).text_color(c.text).child(bot.name.clone()))
                            .child(div().truncate().text_ui(TypeSize::Small).text_color(if asking > 0 { c.accent } else { c.text_muted }).child(words)),
                    )
                    .children(trailing.map(|trailing| div().flex_none().child(trailing)))
                    .into_any_element(),
            );
        }
        if !bots.groups.is_empty() {
            rows.push(SectionHeader::new("groups", "Group Chats").into_any_element());
            let now = self.now();
            for group in &bots.groups {
                let key = format!("group:{}", group.id);
                let when = group.last.as_ref().map(|last| time::ago(last.time, now)).unwrap_or_default();
                let selector = format!("group-{}", group.id);
                let row = NavRow::new(SharedString::from(selector.clone()), group.name.clone())
                    .leading(if group.unread { status_dot(c.accent).into_any_element() } else { Icon::new(kuvo_ui::IconName::Message).color(c.icon).into_any_element() })
                    .trailing(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(when))
                    .selected(self.is_selected(&key))
                    .on_click(self.row_click(key, cx));
                rows.push(div().debug_selector(move || selector).pb(space::S0_5).child(row).into_any_element());
            }
        }
        rows
    }

    fn queue_rows(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        let queue = match &self.queue {
            Reading::NotYet => return vec![quiet("Loading the Work Queue…", true, cx)],
            Reading::Failed(why) => return vec![quiet(&format!("The Work Queue couldn’t be read: {why}"), false, cx)],
            Reading::Ready(queue) => queue,
        };
        // BOX-NEEDED: the Work Queue's counts, `counts: {inProgress, categories: {<id>: n}}` in `GET kuvo/work-queue/categories` (#711): no counts drawn until the box says them.
        let counts = queue.counts.as_ref();
        let count = |n: Option<usize>| n.map(|n| div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(n.to_string()).into_any_element());
        let mut rows = Vec::new();
        let in_progress = counts.map(|counts| counts.in_progress);
        let mut progress = NavRow::new("queue-progress", "In Progress")
            .leading(if in_progress.unwrap_or(0) > 0 { spinner("queue-spin", IconSize::Nav, c.text_muted).into_any_element() } else { Icon::new(kuvo_ui::IconName::Clock).color(c.icon).into_any_element() })
            .selected(self.is_selected("progress"))
            .on_click(self.row_click("progress".into(), cx));
        if let Some(n) = count(in_progress) {
            progress = progress.trailing(n);
        }
        rows.push(div().debug_selector(|| "queue-progress".into()).pb(space::S0_5).child(progress).into_any_element());
        rows.push(SectionHeader::new("categories", "Categories").into_any_element());
        for category in &queue.categories {
            let key = format!("category:{}", category.id);
            let selector = format!("category-{}", category.id);
            let mut row = NavRow::new(SharedString::from(selector.clone()), category.name.clone())
                .leading(div().size(px(8.)).rounded(radius::PILL).bg(category_color(&category.id, cx)))
                .selected(self.is_selected(&key))
                .on_click(self.row_click(key, cx));
            if let Some(n) = count(counts.map(|counts| counts.categories.get(&category.id).copied().unwrap_or(0))) {
                row = row.trailing(n);
            }
            rows.push(div().debug_selector(move || selector).pb(space::S0_5).child(row).into_any_element());
        }
        rows
    }

    fn computer_rows(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let c = cx.theme().colors.clone();
        // BOX-NEEDED: your computers and shared machines as one list, `GET kuvo/computers` (and events) → `[{key, name, kind, shared, reach, version, system, working}]` (#711): until then, this box and the machines it runs sessions on (`kuvo/machines`, a Mac's only).
        let mut rows = vec![SectionHeader::new("computers", "Your Computers").into_any_element()];
        rows.push(computer_row("this", self.this_box.to_string(), "Shown in this window".into(), c.success, true, self.is_selected("this"), self.row_click("this".into(), cx), cx));
        match &self.machines {
            Reading::NotYet => rows.push(quiet("Loading machines…", true, cx)),
            Reading::Failed(why) => rows.push(quiet(&format!("Machines couldn’t be read: {why}"), false, cx)),
            Reading::Ready(machines) => {
                for machine in machines {
                    let key = format!("machine:{}", machine.id);
                    let dot = match machine.connection.as_str() {
                        "connected" => c.success,
                        "failed" => c.danger,
                        "connecting" | "reconnecting" | "installing" => c.warning,
                        _ => c.text_faint,
                    };
                    let selected = self.is_selected(&key);
                    rows.push(computer_row(&format!("machine-{}", machine.id), machine.name.clone(), machine.status.clone(), dot, false, selected, self.row_click(key, cx), cx));
                }
            }
        }
        rows
    }
}

#[allow(clippy::too_many_arguments)]
fn computer_row(
    id: &str,
    name: String,
    detail: String,
    dot: Hsla,
    mac: bool,
    selected: bool,
    on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> AnyElement {
    let c = &cx.theme().colors;
    let (hover, selected_bg) = (c.hover, c.selected_card);
    let selector = format!("computer-{id}");
    div()
        .id(SharedString::from(selector.clone()))
        .debug_selector(move || selector)
        .flex()
        .items_center()
        .gap(space::S2)
        .px(space::S2)
        .py(space::S1_5)
        .mb(space::S0_5)
        .rounded(radius::NAV)
        .cursor_pointer()
        .map(|r| kuvo_ui::row::selected_card(r, selected, cx))
        .hover(move |s| s.bg(if selected { selected_bg } else { hover }))
        .on_click(on_click)
        .child(
            div()
                .relative()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded(radius::NAV)
                .bg(c.sunken)
                .border_1()
                .border_color(c.border)
                .child(Icon::new(if mac { kuvo_ui::IconName::Computer } else { kuvo_ui::IconName::Terminal }).color(c.icon))
                .child(div().absolute().bottom(px(-2.)).right(px(-2.)).size(px(9.)).rounded(radius::PILL).border_2().border_color(c.surface).bg(dot)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().truncate().text_ui(TypeSize::Body).text_color(c.text).child(name))
                .child(div().truncate().text_ui(TypeSize::Small).text_color(c.text_muted).child(detail)),
        )
        .into_any_element()
}

/// What a bot is doing, in words, from the box's counts: "1 at work, 1 waiting on you"; none when
/// it's doing nothing (its row shows its job).
fn doing(working: usize, asking: usize) -> Option<String> {
    let at_work = (working > 0).then(|| format!("{working} at work"));
    let waiting = (asking > 0).then(|| if working > 0 { format!("{asking} waiting on you") } else { "Waiting on you".to_owned() });
    match (at_work, waiting) {
        (Some(at_work), Some(waiting)) => Some(format!("{at_work}, {waiting}")),
        (at_work, waiting) => at_work.or(waiting),
    }
}

/// A category's dot, by KuvoClient's rule (`WorkItemChip.color(of:)`: Next teal, Later purple,
/// Parked grey, Done green, a custom one's by its id), in the theme's nearest colours.
fn category_color(id: &str, cx: &App) -> Hsla {
    let c = &cx.theme().colors;
    match id {
        "next" => c.syntax.property,
        "later" => c.syntax.type_name,
        "parked" => c.text_faint,
        "done" => c.success,
        _ => c.syntax.number,
    }
}

/// A bot's still face: its look's colour and shape, with calm eyes (the Mac's `BotAvatar` drawn
/// without moving; its faces and animation aren't brought over yet). A look this doesn't know is
/// graphite and round, as the Mac shows one.
pub fn bot_face(look: &Look, size: Pixels) -> AnyElement {
    let tint: Hsla = rgb(match look.color.as_str() {
        "mint" => 0x5EC7B8,
        "sky" => 0x4F9CF5,
        "indigo" => 0x5C5CF0,
        "violet" => 0x8A5CF5,
        "pink" => 0xED70B5,
        "coral" => 0xF2735C,
        "orange" => 0xF5993D,
        "amber" => 0xF2C24F,
        "lime" => 0x8CCC4F,
        _ => 0x6E7380,
    })
    .into();
    // Deep tints get light eyes, as the Mac's (`isDeep`).
    let deep = !matches!(look.color.as_str(), "mint" | "sky" | "pink" | "coral" | "orange" | "amber" | "lime");
    let eye = if deep { gpui::hsla(0., 0., 1., 0.92) } else { gpui::hsla(0., 0., 0.12, 0.9) };
    let corner = match look.shape.as_str() {
        "squircle" => size * 0.3,
        "pebble" => size * 0.42,
        "gem" => size * 0.18,
        "bloom" => size * 0.36,
        _ => size / 2.,
    };
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(size * 0.16)
        .size(size)
        .rounded(corner)
        .bg(tint)
        .child(div().w(size * 0.11).h(size * 0.2).rounded(radius::PILL).bg(eye))
        .child(div().w(size * 0.11).h(size * 0.2).rounded(radius::PILL).bg(eye))
        .into_any_element()
}

/// Quiet words in a sidebar's place: loading, nothing yet, or what's wrong.
pub fn quiet(words: &str, busy: bool, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .w_full()
        .flex()
        .items_start()
        .gap(space::S2)
        .px(space::S2)
        .pt(space::S3)
        .text_ui(TypeSize::Small)
        .text_color(c.text_muted)
        .children(busy.then(|| div().pt(px(3.)).child(spinner("area-loading", IconSize::Nav, c.text_muted))))
        .child(div().flex_1().min_w_0().child(words.to_owned()))
        .into_any_element()
}

/// The main view of an area whose pages aren't in the app yet: what was picked, and that.
pub fn placeholder(area: Area, title: SharedString, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .debug_selector(|| "placeholder".into())
        .size_full()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(space::S3)
        .px(space::S8)
        .child(
            div()
                .flex()
                .items_center()
                .justify_center()
                .size(px(48.))
                .rounded(radius::PILL)
                .bg(c.sunken)
                .child(Icon::new(area.icon()).size(IconSize::Card).color(c.icon)),
        )
        .child(div().text_ui(TypeSize::Title).medium().text_color(c.text).child(title))
        .child(
            div()
                .max_w(px(420.))
                .text_center()
                .text_ui(TypeSize::Body)
                .text_color(c.text_muted)
                .child("This page isn’t in this app yet. For now, open it in Kuvo Code on your Mac or iPhone."),
        )
        .into_any_element()
}

/// A new view for each area past Sessions.
pub fn views(client: &BoxClient, live: bool, cx: &mut App) -> Vec<(Area, gpui::Entity<AreaView>)> {
    [Area::Bots, Area::Queue, Area::Computers, Area::Settings].into_iter().map(|area| (area, cx.new(|cx| AreaView::new(area, client.clone(), live, cx)))).collect()
}

#[cfg(test)]
mod tests {
    use super::doing;

    #[test]
    fn a_bot_says_what_its_doing_from_the_boxs_counts() {
        assert_eq!(doing(1, 1).as_deref(), Some("1 at work, 1 waiting on you"));
        assert_eq!(doing(0, 1).as_deref(), Some("Waiting on you"));
        assert_eq!(doing(2, 0).as_deref(), Some("2 at work"));
        assert_eq!(doing(0, 0), None);
    }
}
