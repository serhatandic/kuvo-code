//! The rail: the big areas at the top, a usage ring per signed-in account at the foot, then Help
//! and Settings. Clicking the area already open folds its sidebar away (Zed's panel buttons).

use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement, ParentElement, SharedString, Styled, Window, deferred, div,
    prelude::FluentBuilder as _, px,
};
use kuvo_ui::{
    ActiveTheme, Icon, IconName, StyledType, TypeSize,
    menu::{hover_card_frame, tooltip_frame},
    small::count_badge,
    theme::{radius, space},
};

use super::{
    Area, Badge, Ctx, Scene,
    data::{self, ACCOUNTS, MORE_ACCOUNTS, WORK_NEAR_LIMIT},
    ring::{self, level_color},
};

/// How many things in an area wait on you, as its button shows: the box's word (sample here).
fn waiting_in(area: Area, scene: Scene) -> usize {
    if scene == Scene::Empty {
        return 0;
    }
    // BOX-NEEDED: how many things in each area wait on you: a new `GET kuvo/waiting` (and `kuvo/waiting/events`, ndjson) → `{sessions, bots, queue}` across the box (`kuvo/attention` is taken: it's the client-in-use lease).
    match area {
        Area::Sessions => data::SESSIONS_WAITING,
        Area::Bots => data::BOTS_WAITING,
        _ => 0,
    }
}

pub fn render(d: &Ctx, _window: &mut Window, cx: &mut App) -> AnyElement {
    let c = cx.theme().colors.clone();
    let open = d.scene.area();
    // The compact option shows an area's name beside its button under the pointer.
    let hovered = (d.draft == super::Draft::C && d.scene == Scene::Working).then_some(Area::Queue);

    let top = [Area::Sessions, Area::Bots, Area::Queue, Area::Computers]
        .into_iter()
        .map(|area| button(d, area, area == open, hovered == Some(area), waiting_in(area, d.scene), cx));

    // In the box's order (`rows`); past the option's room, the rest wait behind "+N", which opens
    // Settings › Usage.
    let accounts: Vec<&data::Account> = if d.scene == Scene::Empty {
        Vec::new()
    } else if d.scene == Scene::Limit {
        std::iter::once(&WORK_NEAR_LIMIT).chain(ACCOUNTS.iter().skip(1)).chain(MORE_ACCOUNTS).collect()
    } else {
        ACCOUNTS.iter().chain(MORE_ACCOUNTS).collect()
    };
    let shown = accounts.len().min(d.look.max_rings);
    let mut rings: Vec<AnyElement> = accounts[..shown]
        .iter()
        .enumerate()
        .map(|(ix, account)| ring_button(d, ix, account, d.scene == Scene::Limit && ix == 0, cx))
        .collect();
    if accounts.len() > shown {
        rings.push(more_rings(d, accounts.len() - shown, cx));
    }
    if d.scene == Scene::Empty {
        rings.push(no_accounts(d, cx));
    }

    div()
        .w(d.look.rail_w)
        .h_full()
        .flex_none()
        .flex()
        .flex_col()
        .items_center()
        .pt(space::S1)
        .pb(space::S3)
        .gap(if d.look.rail_labels { space::S1 } else { space::S1_5 })
        .when(d.draft == super::Draft::C, |r| r.border_r_1().border_color(c.border))
        .children(top)
        .child(div().flex_1())
        .child(div().flex().flex_col().items_center().gap(space::S2).pb(space::S2).children(rings))
        .child(button_with(d, ButtonSpec { id: "help", icon: IconName::Question, name: "Help", selected: false, hovered: false, waiting: 0 }, cx))
        .child(button(d, Area::Settings, open == Area::Settings, false, 0, cx))
        .into_any_element()
}

fn button(d: &Ctx, area: Area, selected: bool, hovered: bool, waiting: usize, cx: &App) -> AnyElement {
    let (icon, name) = (area.icon(), area.name());
    // No shortcut shown: ⌘1 to ⌘8 are the Mac's tabs, so the areas' keys are the user's call.
    button_with(d, ButtonSpec { id: name, icon, name, selected, hovered, waiting }, cx)
}

/// The accounts past the rail's room: "+N", opening Settings › Usage.
fn more_rings(d: &Ctx, count: usize, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let hover = c.hover;
    div()
        .id("more-rings")
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(d.look.ring)
        .rounded(radius::PILL)
        .border_1()
        .border_color(c.border_strong)
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .text_ui(TypeSize::Caption)
        .medium()
        .text_color(c.text_muted)
        .child(format!("+{count}"))
        .into_any_element()
}

/// No account signed in yet: an empty ring that opens Settings › Accounts, named on hover (shown
/// hovered in the first-run scene).
fn no_accounts(d: &Ctx, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    div()
        .id("no-accounts")
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(d.look.ring)
        .rounded(radius::PILL)
        .border_1()
        .border_color(c.border_strong)
        .bg(c.hover)
        .cursor_pointer()
        .child(Icon::new(IconName::Plus).color(c.text_muted))
        .child(
            div()
                .absolute()
                .left_full()
                .top(px(1.))
                .pl((d.look.rail_w - d.look.ring) / 2.)
                .child(deferred(tooltip_frame("Sign in to an account to see its limits here".into(), None, cx)).with_priority(1)),
        )
        .into_any_element()
}

struct ButtonSpec {
    id: &'static str,
    icon: IconName,
    name: &'static str,
    selected: bool,
    hovered: bool,
    waiting: usize,
}

fn button_with(d: &Ctx, b: ButtonSpec, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let size = d.look.rail_button;
    let (hover, selected_bg) = (c.hover, c.selected);
    let badge: Option<AnyElement> = (b.waiting > 0).then(|| match d.look.badge {
        Badge::Count => div().absolute().top(px(-3.)).right(px(-5.)).child(count_badge(b.waiting, cx)).into_any_element(),
        Badge::Dot => div()
            .absolute()
            .top(px(4.))
            .right(px(4.))
            .size(px(8.))
            .rounded(radius::PILL)
            .bg(c.accent)
            .border_1()
            .border_color(c.background)
            .into_any_element(),
    });
    let tile = div()
        .id(SharedString::from(format!("rail-{}", b.id)))
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(size)
        .rounded(radius::NAV)
        .cursor_pointer()
        .when(b.selected, |t| t.bg(selected_bg))
        .when(b.hovered && !b.selected, |t| t.bg(hover))
        .hover(move |s| s.bg(if b.selected { selected_bg } else { hover }))
        .child(Icon::new(b.icon).size(d.look.rail_icon).color(if b.selected { c.text } else { c.text_muted }))
        .children(badge)
        .when(b.hovered, |t| {
            t.child(
                div()
                    .absolute()
                    .left_full()
                    .top(px(1.))
                    .child(deferred(tooltip_frame(b.name.into(), None, cx)).with_priority(1)),
            )
        });
    if d.look.rail_labels {
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(2.))
            .w(d.look.rail_w)
            .child(tile)
            .child(
                div()
                    .text_ui(TypeSize::Caption)
                    .when(b.selected, |l| l.medium())
                    .text_color(if b.selected { c.text } else { c.text_muted })
                    .child(short_name(b.name)),
            )
            .into_any_element()
    } else {
        tile.into_any_element()
    }
}

/// Labels under the rail's buttons are short: "Queue", not "Work Queue".
fn short_name(name: &'static str) -> &'static str {
    match name {
        "Work Queue" => "Queue",
        other => other,
    }
}

fn ring_button(d: &Ctx, ix: usize, account: &data::Account, open: bool, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let hover = c.hover;
    let used = account.used;
    let pad = px(3.);
    let target = d.look.ring + pad * 2.;
    let holder = div()
        .id(SharedString::from(format!("ring-{ix}")))
        .relative()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(target)
        .rounded(radius::PILL)
        .cursor_pointer()
        .hover(move |s| s.bg(hover))
        .when(open, |h| h.bg(c.hover))
        .child(ring::ring(account, d.look.ring, d.look.ring_stroke, d.look.calm, cx))
        .when(open, |h| {
            h.child(
                div()
                    .absolute()
                    .left_full()
                    .bottom(px(-56.))
                    // Clear of the rail, whatever its width.
                    .pl((d.look.rail_w - target) / 2. + space::S2)
                    .child(deferred(hover_card_frame(ring::account_card(account, d.look.calm, true, cx), cx)).with_priority(1)),
            )
        });
    if d.look.ring_percent {
        div()
            .flex()
            .flex_col()
            .items_center()
            .child(holder)
            .child(
                div()
                    .text_ui(TypeSize::Caption)
                    .text_color(if ring::Level::of(used) == ring::Level::Calm { c.text_faint } else { level_color(used, d.look.calm, cx) })
                    .child(format!("{}%", (used * 100.).round() as u32)),
            )
            .into_any_element()
    } else {
        holder.into_any_element()
    }
}
