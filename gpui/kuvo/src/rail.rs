//! The rail: the areas' buttons at the top, with what waits on you in each on its icon; at its foot
//! a usage ring per account, then Help and Settings. Clicking the area already open folds its
//! sidebar away, or brings it back (Zed's panel buttons).
//!
//! The rings are their own view ([`Rings`]): their accounts are read on their own clock, so a
//! reading redraws the rings, not the window.

use std::time::Duration;

use gpui::{
    AnyElement, App, Context, Hsla, InteractiveElement, IntoElement, LineCap, ParentElement, PathBuilder, PathStyle, Pixels, Render, SharedString,
    StatefulInteractiveElement, StrokeOptions, Styled, Task, Window, canvas, div, point, prelude::FluentBuilder as _, px, svg,
};
use kuvo_box::BoxClient;
use kuvo_box::areas::{Account, Level};
use kuvo_ui::{
    ActiveTheme, Icon, IconName, IconSize, StyledType, TypeSize,
    menu::{HoverCard, Tooltip},
    small::count_badge,
    theme::{radius, space},
};

use crate::area::{Area, OpenHelp, ShowAccounts, ShowUsage};
use crate::time;
use crate::workspace::Workspace;

/// How wide it is.
pub const WIDTH: Pixels = px(60.);
/// Its buttons' size.
const BUTTON: Pixels = px(40.);
/// A ring's size and stroke; an account's second ring sits just inside the first.
const RING: Pixels = px(34.);
const STROKE: Pixels = px(2.5);
const INNER_GAP: Pixels = px(1.5);
/// How many rings show before "+N", where the window is tall enough.
const MOST_RINGS: usize = 4;
/// The room a ring takes in the rail, its gap included.
const RING_ROOM: f32 = 48.;
/// The rail's height besides its rings: the title bar, the four areas, Help and Settings, gaps.
const RAIL_REST: f32 = 44. + 4. * 46. + 2. * 46. + 40.;
/// How often the accounts are read again while the app runs (the box reads them on its own clock;
/// this only picks up what it read), and sooner after a read that failed (a box still starting).
const REREAD: Duration = Duration::from_secs(120);
const RETRY: Duration = Duration::from_secs(10);

pub fn render(workspace: &Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let open = workspace.area();
    let waiting = workspace.waiting();
    let top = [Area::Sessions, Area::Bots, Area::Queue, Area::Computers].into_iter().map(|area| {
        // BOX-NEEDED: how many things in each area wait on you, `{sessions, bots, queue}` from `GET kuvo/waiting` (#711): none drawn while the box doesn't say.
        let count = waiting.map_or(0, |waiting| match area {
            Area::Sessions => waiting.sessions,
            Area::Bots => waiting.bots,
            Area::Queue => waiting.queue,
            _ => 0,
        });
        area_button(area, area == open, count, cx)
    });
    div()
        .id("rail")
        .w(WIDTH)
        .h_full()
        .flex_none()
        .flex()
        .flex_col()
        .items_center()
        .pt(space::S1)
        .pb(space::S3)
        .gap(space::S1_5)
        .children(top)
        .child(div().flex_1())
        .child(workspace.rings().clone())
        .child(
            button("rail-help", IconName::Question, false, 0, cx)
                .tooltip(|_, cx| Tooltip::new("Help").build(cx))
                .on_click(|_, window, cx| window.dispatch_action(Box::new(OpenHelp), cx)),
        )
        .child(area_button(Area::Settings, open == Area::Settings, 0, cx))
        .into_any_element()
}

fn area_button(area: Area, selected: bool, waiting: usize, cx: &mut Context<Workspace>) -> AnyElement {
    let (name, keys) = (area.name(), area.keys());
    button(SharedString::from(format!("rail-{}", area.slug())), area.icon(), selected, waiting, cx)
        // (Its id says whether it's open, so a tooltip from before doesn't linger: Zed's.)
        .tooltip(move |_, cx| Tooltip::new(name).shortcut(keys).build(cx))
        .on_click(cx.listener(move |this, _, window, cx| this.rail_pressed(area, window, cx)))
        .into_any_element()
}

fn button(id: impl Into<SharedString>, icon: IconName, selected: bool, waiting: usize, cx: &App) -> gpui::Stateful<gpui::Div> {
    let c = &cx.theme().colors;
    let (hover, selected_bg) = (c.hover, c.selected_card);
    let id: SharedString = id.into();
    let selector = id.to_string();
    div()
        .id(SharedString::from(format!("{id}-{}", if selected { "open" } else { "shut" })))
        .debug_selector(move || selector)
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(BUTTON)
        .rounded(radius::NAV)
        .cursor_pointer()
        .map(|t| kuvo_ui::row::selected_card(t, selected, cx))
        .hover(move |s| s.bg(if selected { selected_bg } else { hover }))
        .child(Icon::new(icon).size(IconSize::Card).color(if selected { c.text } else { c.icon }))
        .when(waiting > 0, |t| t.child(div().absolute().top(px(-3.)).right(px(-5.)).child(count_badge(waiting, cx))))
}

// MARK: The rings

/// The accounts' rings, in the box's order (its limits' `rows`), as their own view.
pub struct Rings {
    client: BoxClient,
    accounts: Option<Vec<Account>>,
    /// Now, as a window's "starts over in" counts from it (fixed for shots).
    now: Option<f64>,
    _reading: Option<Task<()>>,
    again: Option<Task<()>>,
}

impl Rings {
    pub fn new(client: BoxClient, live: bool, cx: &mut Context<Self>) -> Rings {
        let mut rings = Rings { client, accounts: None, now: None, _reading: None, again: None };
        if live {
            rings._reading = Some(cx.spawn(async move |this, cx| {
                loop {
                    let Ok(client) = this.read_with(cx, |this, _| this.client.clone()) else { break };
                    let accounts = cx.background_executor().spawn(async move { client.accounts() }).await;
                    let read = accounts.is_ok();
                    if this.update(cx, |this, cx| this.take(accounts, cx)).is_err() {
                        break;
                    }
                    cx.background_executor().timer(if read { REREAD } else { RETRY }).await;
                }
            }));
        }
        rings
    }

    /// Reads the accounts again now, off this thread (the box has just been reached).
    pub fn read_again(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        self.again = Some(cx.spawn(async move |this, cx| {
            let accounts = cx.background_executor().spawn(async move { client.accounts() }).await;
            this.update(cx, |this, cx| this.take(accounts, cx)).ok();
        }));
    }

    /// Reads the accounts at once, on this thread (shots and tests, against a stand-in).
    pub fn read_at_once(&mut self, cx: &mut Context<Self>) {
        let accounts = self.client.accounts();
        self.take(accounts, cx);
    }

    pub fn set_now(&mut self, now: f64) {
        self.now = Some(now);
    }

    /// What the box said. One that can't be read (an older box, its agents' bridge not running)
    /// keeps what was there, and shows nothing until it's read once.
    fn take(&mut self, accounts: kuvo_box::Result<Vec<Account>>, cx: &mut Context<Self>) {
        if let Ok(accounts) = accounts {
            self.accounts = Some(accounts);
            cx.notify();
        }
    }

    pub fn accounts(&self) -> Option<&[Account]> {
        self.accounts.as_deref()
    }

    fn now(&self) -> f64 {
        self.now.unwrap_or_else(time::now_ms)
    }
}

impl Render for Rings {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = cx.theme().colors.clone();
        let Some(accounts) = self.accounts.as_ref() else { return div().into_any_element() };
        let now = self.now();
        // As many as the rail has room for (four at most), the rest behind "+N" (which takes a
        // ring's room itself), so Help and Settings stay in reach in a short window.
        let room = ((f32::from(window.viewport_size().height) - RAIL_REST) / RING_ROOM).floor().max(0.) as usize;
        let most = if accounts.len() <= room.min(MOST_RINGS) { accounts.len() } else { room.saturating_sub(1).min(MOST_RINGS) };
        let mut rings: Vec<AnyElement> = accounts.iter().take(most).enumerate().map(|(ix, account)| ring_button(ix, account, now, cx)).collect();
        // Past the rail's room: "+N", opening Settings › Usage.
        if accounts.len() > most {
            let more = accounts.len() - most;
            let hover = c.hover;
            rings.push(
                div()
                    .id("more-rings")
                    .debug_selector(|| "more-rings".into())
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(RING)
                    .rounded(radius::PILL)
                    .border_1()
                    .border_color(c.border)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .text_ui(TypeSize::Caption)
                    .medium()
                    .text_color(c.text_muted)
                    .child(format!("+{more}"))
                    .tooltip(move |_, cx| Tooltip::new(format!("{more} more in Usage")).build(cx))
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(ShowUsage), cx))
                    .into_any_element(),
            );
        }
        // None signed in: an empty ring that says where to sign in.
        if accounts.is_empty() {
            let hover = c.hover;
            rings.push(
                div()
                    .id("no-accounts")
                    .debug_selector(|| "no-accounts".into())
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(RING)
                    .rounded(radius::PILL)
                    .border_1()
                    .border_color(c.border)
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .child(Icon::new(IconName::Plus).color(c.icon))
                    .tooltip(|_, cx| Tooltip::new("Sign in to an account to see its limits here").build(cx))
                    .on_click(|_, window, cx| window.dispatch_action(Box::new(ShowAccounts), cx))
                    .into_any_element(),
            );
        }
        div().flex().flex_col().items_center().gap(space::S2).pb(space::S2).children(rings).into_any_element()
    }
}

/// The colour of a level, as the box says it; a share it doesn't level yet is drawn quiet.
fn level_color(level: Option<Level>, cx: &App) -> Hsla {
    let c = &cx.theme().colors;
    match level {
        Some(Level::Over) => c.danger,
        Some(Level::Near) => c.warning,
        Some(Level::Calm) => c.success,
        None => c.text_muted,
    }
}

fn ring_button(ix: usize, account: &Account, now: f64, cx: &mut Context<Rings>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let hover = c.hover;
    // BOX-NEEDED: which window is each ring, `windows[].span: short|long` in `GET kuvo/agents/api/kuvo/limits`' rows (#711): the short window outside and the long one inside where the box says them; until then one ring, the share of its fullest window still current (KuvoClient's `tightest(at:)`, a view).
    let rings = account.rings(now);
    let card = account.clone();
    // Each ring by its own window: its share, and its colour by the box's level.
    // BOX-NEEDED: how close to its limit, `windows[].level: calm|near|over` in `GET kuvo/agents/api/kuvo/limits`' rows (#711): until the box says it, an arc is drawn quiet, never coloured by a threshold here.
    let arcs_drawn: Vec<AnyElement> = if rings.is_empty() {
        vec![arcs(RING, STROKE, 0., c.text_muted, c.border).into_any_element()]
    } else {
        rings
            .iter()
            .enumerate()
            .map(|(ix, window)| {
                let size = RING - (STROKE + INNER_GAP) * 2. * ix as f32;
                let inset = (STROKE + INNER_GAP) * ix as f32;
                let selector = format!("ring-{}-arc-{ix}", account_key(account));
                div().debug_selector(move || selector).absolute().top(inset).left(inset).size(size).child(arcs(size, STROKE, window.used, level_color(window.level, cx), c.border)).into_any_element()
            })
            .collect()
    };
    let mark_size = if rings.len() > 1 { px(12.) } else { px(15.) };
    let mark: AnyElement = match kuvo_ui::icon::mark_path(&account.service) {
        Some(path) => svg().path(path).size(mark_size).flex_none().text_color(kuvo_ui::icon::mark_color(&account.service).unwrap_or(c.text)).into_any_element(),
        // A service a newer box names, with no mark here: its first letter.
        None => div().text_ui(TypeSize::Caption).medium().text_color(c.text_muted).child(account.service.chars().next().map(|first| first.to_uppercase().to_string()).unwrap_or_default()).into_any_element(),
    };
    let selector = format!("ring-{ix}");
    div()
        .id(SharedString::from(format!("ring-{ix}")))
        .debug_selector(move || selector)
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(RING + px(6.))
        .rounded(radius::PILL)
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .child(
            div()
                .relative()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(RING)
                .children(arcs_drawn)
                .child(mark),
        )
        .hoverable_tooltip(move |_, cx| {
            let account = card.clone();
            HoverCard::new(move |_, cx| account_card(&account, now, cx)).build(cx)
        })
        .on_click(|_, window, cx| window.dispatch_action(Box::new(ShowUsage), cx))
        .into_any_element()
}

/// How a ring's arcs are named in tests: the account's service and label.
fn account_key(account: &Account) -> String {
    format!("{}{}", account.service, account.label.as_deref().map(|label| format!("-{label}")).unwrap_or_default())
}

/// Paints a ring: a faint track, and an arc from the top, clockwise, for `used` (0 to 1).
fn arcs(size: Pixels, stroke: Pixels, used: f32, color: Hsla, track: Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| (),
        move |bounds, _, window, _| {
            let r = (size - stroke) / 2.;
            let center = point(bounds.origin.x + size / 2., bounds.origin.y + size / 2.);
            let style = || PathStyle::Stroke(StrokeOptions { line_width: f32::from(stroke), line_cap: LineCap::Round, ..Default::default() });
            let top = point(center.x, center.y - r);
            let bottom = point(center.x, center.y + r);
            let mut full = PathBuilder::stroke(stroke).with_style(style());
            full.move_to(top);
            full.arc_to(point(r, r), px(0.), false, true, bottom);
            full.arc_to(point(r, r), px(0.), false, true, top);
            if let Ok(path) = full.build() {
                window.paint_path(path, track);
            }
            let used = used.clamp(0., 1.);
            if used <= 0.005 {
                return;
            }
            let mut arc = PathBuilder::stroke(stroke).with_style(style());
            arc.move_to(top);
            if used >= 0.995 {
                arc.arc_to(point(r, r), px(0.), false, true, bottom);
                arc.arc_to(point(r, r), px(0.), false, true, top);
            } else {
                let angle = used * std::f32::consts::TAU;
                let end = point(center.x + r * angle.sin(), center.y - r * angle.cos());
                arc.arc_to(point(r, r), px(0.), used > 0.5, true, end);
            }
            if let Ok(path) = arc.build() {
                window.paint_path(path, color);
            }
        },
    )
    .absolute()
    .top_0()
    .left_0()
    .size(size)
}

/// What resting on a ring shows: the account, its plan, and each window with when it starts over.
fn account_card(account: &Account, now: f64, cx: &App) -> AnyElement {
    let c = cx.theme().colors.clone();
    let title = account.title();
    let windows = account.windows.iter().map(|window| {
        // A window whose time has passed has started over: not read since, not used (PROTOCOL.md).
        let over = window.resets_at.is_some_and(|at| at <= now);
        let color = level_color(window.level, cx);
        let calm = !matches!(window.level, Some(Level::Near | Level::Over));
        let said = if over { "Not read since it started over".to_owned() } else { format!("{}% used", (window.used * 100.).round() as u32) };
        let resets = window.resets_at.filter(|_| !over).map(|at| format!("Starts over in {}", time::until(at, now)));
        div()
            .flex()
            .flex_col()
            .gap(space::S1)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(space::S2)
                    .text_ui(TypeSize::Small)
                    .child(div().min_w_0().truncate().text_color(c.text).child(window.title()))
                    .child(div().flex_none().text_color(if calm { c.text_muted } else { color }).when(!calm, |d| d.medium()).child(said)),
            )
            .child(
                // BOX-NEEDED: each window's level, `windows[].level` (#711): the meter is quiet until the box says it.
                div().h(px(4.)).w_full().rounded(radius::PILL).bg(c.border).child(div().h_full().w(gpui::relative(if over { 0. } else { window.used.clamp(0., 1.) })).rounded(radius::PILL).bg(color)),
            )
            .children(resets.map(|resets| div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(resets)))
    });
    div()
        .flex()
        .flex_col()
        .gap(space::S3)
        .child(
            div()
                .flex()
                .flex_col()
                .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child(title))
                .children(account.plan.clone().map(|plan| div().text_ui(TypeSize::Caption).text_color(c.text_muted).child(format!("{plan} plan")))),
        )
        .children(windows)
        .into_any_element()
}
