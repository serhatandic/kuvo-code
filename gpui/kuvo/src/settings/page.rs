//! Drawing Settings: the sidebar (title, search, sections) and a page (its title, quiet group
//! labels, a card of rows for each group, each row's name and line on the left and its control on
//! the right), with what the box refused over it, a confirm, or the sign-in sheet.

use gpui::{
    AnyElement, App, AppContext as _, Context, Hsla, InteractiveElement, IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window, div, list,
    prelude::FluentBuilder as _, px, svg,
};
use kuvo_box::areas::{Account, Level};
use kuvo_ui::{
    ActiveTheme, Icon, IconName, IconSize, StyledType, TypeSize,
    button::{Button, ButtonSize},
    menu::{Menu, MenuEntry, PopoverMenu},
    row::{NavRow, SectionHeader},
    small::{Switch, spinner},
    theme::{radius, space},
};

use super::rows::{self, Control, Leading, Row, Tone};
use super::{Item, PAGE_WIDTH, Pick, SettingsView};
use crate::area::Area;
use crate::areas::placeholder;
use crate::time;

impl SettingsView {
    /// The sidebar: "Settings", the search, and the sections it finds.
    pub fn sidebar(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let found = self.sections_found();
        let row = |section: &'static str, icon: IconName, this: &SettingsView, cx: &mut Context<SettingsView>| {
            let selector = format!("setting-{section}");
            let row = NavRow::new(SharedString::from(selector.clone()), section).icon(icon).selected(this.section == section).on_click(cx.listener(move |_, _, _, cx| {
                cx.emit(Pick { section: section.to_owned(), record: true });
            }));
            div().debug_selector(move || selector).pb(space::S0_5).child(row).into_any_element()
        };
        let built: Vec<AnyElement> = rows::BUILT.iter().filter(|(section, _)| found.contains(section)).map(|(section, icon)| row(section, *icon, self, cx)).collect();
        let elsewhere: Vec<AnyElement> = rows::ELSEWHERE.iter().filter(|(section, _)| found.contains(section)).map(|(section, icon)| row(section, *icon, self, cx)).collect();
        let nothing = built.is_empty() && elsewhere.is_empty();
        div()
            .id("settings-sidebar")
            .size_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .flex_none()
                    .px(space::S4)
                    .pt(space::S4)
                    .pb(space::S3)
                    .flex()
                    .flex_col()
                    .gap(space::S3)
                    .child(div().pl(space::S1).text_size(px(17.)).medium().text_color(c.text).child("Settings"))
                    .child(
                        div()
                            .debug_selector(|| "settings-search".into())
                            .flex()
                            .items_center()
                            .gap(space::S2)
                            .h(px(36.))
                            .px(space::S3)
                            .rounded(radius::POPOVER)
                            .bg(c.background)
                            .border_1()
                            .border_color(c.border)
                            .child(Icon::new(IconName::Search).color(c.icon))
                            .child(div().flex_1().min_w_0().child(self.search.clone())),
                    ),
            )
            .child(
                div()
                    .id("settings-sections")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(space::S2)
                    .pb(space::S4)
                    .children(built)
                    .when(!elsewhere.is_empty(), |d| d.child(SectionHeader::new("settings-elsewhere", "In Kuvo Code on Your Mac")).children(elsewhere))
                    .when(nothing, |d| d.child(div().px(space::S2).pt(space::S2).text_ui(TypeSize::Small).text_color(c.text_muted).child("No settings match."))),
            )
            .into_any_element()
    }

    fn item(&mut self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let Some(item) = self.items.get(ix).cloned() else { return div().into_any_element() };
        let body: AnyElement = match item {
            Item::Title(title) => div().pt(space::S8).pb(space::S2).text_ui(TypeSize::Title).medium().text_color(c.text).child(title).into_any_element(),
            Item::Group(label) => div().pt(space::S6).pb(space::S2).text_ui(TypeSize::Body).text_color(c.text_muted).child(label).into_any_element(),
            Item::Row { row, first, last } => self.row(*row, first, last, cx),
            Item::Note { key, words, busy } => div()
                .debug_selector(move || key)
                .pt(space::S4)
                .flex()
                .items_start()
                .gap(space::S2)
                .text_ui(TypeSize::Small)
                .text_color(c.text_muted)
                .children(busy.then(|| div().pt(px(3.)).child(spinner("settings-reading", IconSize::Nav, c.text_muted))))
                .child(div().flex_1().min_w_0().child(words))
                .into_any_element(),
            Item::Nothing(query) => div().pt(space::S4).text_ui(TypeSize::Body).text_color(c.text_muted).child(format!("Nothing on this page matches “{query}”.")).into_any_element(),
            Item::Placeholder => div().h(px(560.)).child(placeholder(Area::Settings, self.section.clone().into(), cx)).into_any_element(),
            Item::End => div().h(space::S10).into_any_element(),
        };
        // Each item in a column as wide as a page's cards, in the middle.
        div().w_full().flex().justify_center().px(space::S8).child(div().w_full().max_w(px(PAGE_WIDTH)).child(body)).into_any_element()
    }

    fn row(&mut self, row: Row, first: bool, last: bool, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        let Row { key, leading, title, detail, tone, control } = row;
        let leading: Option<AnyElement> = match leading {
            Leading::None => None,
            Leading::Mark(service) => Some(match kuvo_ui::icon::mark_path(&service) {
                Some(path) => div().flex().flex_none().items_center().justify_center().size(px(28.)).rounded(radius::PILL).bg(c.sunken).child(svg().path(path).size(px(16.)).text_color(kuvo_ui::icon::mark_color(&service).unwrap_or(c.text))).into_any_element(),
                None => initial(&service, cx),
            }),
            Leading::Initial(name) => Some(initial(&name, cx)),
        };
        let control = self.control(&key, control, cx);
        let selector = key.clone();
        div()
            .id(SharedString::from(key))
            .debug_selector(move || selector)
            .w_full()
            .bg(c.card)
            .when(first, |d| d.rounded_t(radius::POPOVER).mt(px(0.)))
            .when(last, |d| d.rounded_b(radius::POPOVER))
            .shadow(if first && last { cx.theme().card_shadow() } else { Vec::new() })
            .px(space::S5)
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(space::S3)
                    .py(space::S4)
                    .when(!last, |d| d.border_b_1().border_color(c.border))
                    .children(leading)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(space::S0_5)
                            .child(div().text_ui(TypeSize::Body).medium().text_color(c.text).child(title))
                            .when(!detail.is_empty(), |d| d.child(div().text_ui(TypeSize::Small).text_color(if tone == Tone::Warning { c.warning } else { c.text_muted }).child(detail))),
                    )
                    .child(div().flex_none().max_w(px(320.)).child(control)),
            )
            .into_any_element()
    }

    fn control(&mut self, key: &str, control: Control, cx: &mut Context<Self>) -> AnyElement {
        let c = cx.theme().colors.clone();
        match control {
            Control::None => div().into_any_element(),
            Control::Text(words) => div().text_ui(TypeSize::Body).text_color(c.text_muted).child(words).into_any_element(),
            Control::Busy(words) => div().flex().items_center().gap(space::S2).text_ui(TypeSize::Small).text_color(c.text_muted).child(spinner(SharedString::from(format!("{key}-busy")), IconSize::Nav, c.text_muted)).child(words).into_any_element(),
            Control::Switch { on, act } => {
                let this = cx.entity().downgrade();
                Switch::new(SharedString::from(format!("{key}-switch")), on)
                    .on_change(move |_, _, cx| {
                        this.update(cx, |this, cx| this.act(act.clone(), cx)).ok();
                    })
                    .into_any_element()
            }
            Control::Buttons(buttons) => div()
                .flex()
                .gap(space::S2)
                .children(buttons.into_iter().map(|(label, act)| {
                    let id = SharedString::from(format!("{key}-{}", label.to_lowercase().replace([' ', '…'], "-").trim_end_matches('-')));
                    Button::new(id, label).size(ButtonSize::Small).on_click(cx.listener(move |this, _, _, cx| this.act(act.clone(), cx)))
                }))
                .into_any_element(),
            Control::Menu { shown, choices } => {
                let this = cx.entity().downgrade();
                let id = SharedString::from(format!("{key}-menu"));
                // A menu of actions on an account shows "…"; a setting's shows what's chosen.
                let trigger: AnyElement = if shown.is_empty() {
                    Button::icon_only(id.clone(), IconName::More, "More").ghost().size(ButtonSize::Small).into_any_element()
                } else {
                    div()
                        .id(id.clone())
                        .debug_selector({
                            let id = id.to_string();
                            move || id
                        })
                        .flex()
                        .items_center()
                        .gap(space::S2)
                        .min_w(px(160.))
                        .h(px(32.))
                        .px(space::S3)
                        .rounded(radius::NAV)
                        .border_1()
                        .border_color(c.border_strong)
                        .bg(c.card)
                        .cursor_pointer()
                        .child(div().flex_1().min_w_0().truncate().text_ui(TypeSize::Body).text_color(c.text).child(shown))
                        .child(div().flex().flex_none().flex_col().child(svg().path(IconName::ChevronUp.path()).size(px(10.)).text_color(c.icon)).child(svg().path(IconName::ChevronDown.path()).size(px(10.)).text_color(c.icon)))
                        .into_any_element()
                };
                PopoverMenu::new(SharedString::from(format!("{key}-popover")), trigger, move |_, cx| {
                    let (choices, this) = (choices.clone(), this.clone());
                    cx.new(|cx| {
                        let mut menu = Menu::new(cx).width(px(240.));
                        for (label, act, checked) in choices {
                            let this = this.clone();
                            menu = menu.entry(MenuEntry::new(label).checked(checked).on_select(move |_, cx| {
                                this.update(cx, |this, cx| this.act(act.clone(), cx)).ok();
                            }));
                        }
                        menu
                    })
                })
                .align_right()
                .into_any_element()
            }
            Control::Windows(account) => windows(&account, self.now.unwrap_or_else(time::now_ms), cx),
        }
    }
}

fn initial(name: &str, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let letter = name.chars().next().map(|first| first.to_uppercase().to_string()).unwrap_or_default();
    div().flex().flex_none().items_center().justify_center().size(px(28.)).rounded(radius::PILL).bg(c.sunken).text_ui(TypeSize::Small).medium().text_color(c.text_muted).child(letter).into_any_element()
}

/// A level's colour, as the rail's rings draw it; quiet where the box doesn't say one yet.
fn level_color(level: Option<Level>, cx: &App) -> Hsla {
    let c = &cx.theme().colors;
    match level {
        Some(Level::Over) => c.danger,
        Some(Level::Near) => c.warning,
        Some(Level::Calm) => c.success,
        None => c.text_muted,
    }
}

/// An account's windows, as the rail's hover card shows them: each one's name, share and meter,
/// and when it starts over.
fn windows(account: &Account, now: f64, cx: &App) -> AnyElement {
    let c = cx.theme().colors.clone();
    div()
        .w(px(260.))
        .flex()
        .flex_col()
        .gap(space::S3)
        .children(account.windows.iter().map(|window| {
            // A window whose time has passed has started over: not read since (PROTOCOL.md).
            let over = window.resets_at.is_some_and(|at| at <= now);
            // BOX-NEEDED: each window's level, `windows[].level` in `GET kuvo/agents/api/kuvo/limits`' rows (#711): the meter is quiet until the box says it.
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
                        .child(div().flex_none().text_color(if calm { c.text_muted } else { color }).child(said)),
                )
                .child(div().h(px(4.)).w_full().rounded(radius::PILL).bg(c.border).child(div().h_full().w(gpui::relative(if over { 0. } else { window.used.clamp(0., 1.) })).rounded(radius::PILL).bg(color)))
                .children(resets.map(|resets| div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(resets)))
        }))
        .into_any_element()
}

impl Render for SettingsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = cx.theme().colors.clone();
        if self.dark != cx.theme().appearance.is_dark() {
            self.rebuild(cx);
        }
        let page = list(self.list.clone(), cx.processor(|this, ix, _, cx| this.item(ix, cx))).size_full();
        let problem = self.problem.clone().map(|problem| {
            div()
                .absolute()
                .top(space::S4)
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .px(space::S8)
                .child(
                    div()
                        .debug_selector(|| "settings-problem".into())
                        .max_w(px(PAGE_WIDTH))
                        .w_full()
                        .flex()
                        .items_center()
                        .gap(space::S3)
                        .px(space::S4)
                        .py(space::S3)
                        .rounded(radius::NAV)
                        .bg(c.card)
                        .border_1()
                        .border_color(c.danger)
                        .shadow(cx.theme().card_shadow())
                        .child(Icon::new(IconName::Warning).color(c.danger))
                        .child(div().flex_1().min_w_0().text_ui(TypeSize::Small).text_color(c.text).child(problem))
                        .child(Button::icon_only("settings-problem-close", IconName::Close, "Close").ghost().size(ButtonSize::Small).on_click(cx.listener(|this, _, _, cx| {
                            this.problem = None;
                            cx.notify();
                        }))),
                )
        });
        let confirm = self.confirm.clone().map(|confirm| {
            sheet(
                div()
                    .debug_selector(|| "settings-confirm".into())
                    .w(px(400.))
                    .flex()
                    .flex_col()
                    .gap(space::S3)
                    .p(space::S6)
                    .rounded(radius::CARD)
                    .bg(c.elevated)
                    .border_1()
                    .border_color(c.border)
                    .shadow(cx.theme().elevated_shadow())
                    .child(div().text_ui(TypeSize::Body).medium().text_color(c.text).child(confirm.title))
                    .child(div().text_ui(TypeSize::Small).text_color(c.text_muted).child(confirm.body))
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap(space::S2)
                            .pt(space::S2)
                            .child(Button::new("confirm-cancel", "Cancel").on_click(cx.listener(|this, _, _, cx| {
                                this.confirm = None;
                                cx.notify();
                            })))
                            .child(Button::new("confirm-go", confirm.button).destructive().on_click(cx.listener(|this, _, _, cx| this.confirmed(cx)))),
                    )
                    .into_any_element(),
                cx,
            )
        });
        let sign_in = self.sign_in.clone().map(|sheet_view| sheet(sheet_view.into_any_element(), cx));
        div()
            .id("settings-page")
            .debug_selector(|| "settings-page".into())
            .relative()
            .size_full()
            .bg(c.sidebar)
            .child(page)
            .children(problem)
            .children(confirm)
            .children(sign_in)
    }
}

/// A sheet over the page, on a dimmed backdrop that takes the clicks.
fn sheet(content: AnyElement, cx: &App) -> AnyElement {
    let dim = if cx.theme().appearance.is_dark() { gpui::hsla(0., 0., 0., 0.45) } else { gpui::hsla(0., 0., 0., 0.12) };
    div()
        .id("settings-sheet")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .p(space::S6)
        .bg(dim)
        .occlude()
        .child(content)
        .into_any_element()
}
