//! Drafts of a two-level sidebar in the style of OpenBot's: a narrow rail that switches between
//! the big areas (Sessions, Bots, Work Queue, Computers, Settings), with a usage ring per account
//! at its foot, and beside it the area's own sidebar. Three options, each in the scenes that
//! matter, drawn from fixed sample data. Drafts only: the app doesn't use any of this yet.
//!
//! `bin/shots.rs` renders each to `shots/sidebar-<option>-<scene>-<light|dark>.png`.

mod data;
mod lists;
mod main_view;
mod rail;
mod ring;

use gpui::{
    AnyElement, App, Context, Hsla, InteractiveElement as _, IntoElement, StatefulInteractiveElement as _, ParentElement, Pixels, Render, SharedString, Size, Styled, Window,
    div, prelude::FluentBuilder as _, px, rgb, size,
};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, Icon, IconName, IconSize, StyledType, TypeSize,
    small::Chip,
    theme::{radius, space},
};

use ring::CalmColor;

/// The options drafted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Draft {
    /// OpenBot's layout as closely as fits Kuvo.
    A,
    /// A labelled rail, a "Needs you" group on top (Capy's), percentages under the rings.
    B,
    /// A compact rail, labels on hover, quiet rings, folding projects.
    C,
}

impl Draft {
    pub const ALL: &'static [Draft] = &[Draft::A, Draft::B, Draft::C];

    pub fn slug(self) -> &'static str {
        match self {
            Draft::A => "a",
            Draft::B => "b",
            Draft::C => "c",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Draft::A => "A · OpenBot's layout",
            Draft::B => "B · Labelled rail, Needs you",
            Draft::C => "C · Compact rail",
        }
    }
}

/// The scenes each option is drawn in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scene {
    /// A session waiting on you, open.
    Waiting,
    /// An agent at work, open.
    Working,
    /// An account's ring near its limit, its card open.
    Limit,
    /// A narrow window.
    Narrow,
    /// The first run: nothing yet.
    Empty,
    Bots,
    Queue,
    Computers,
    Settings,
}

impl Scene {
    pub const ALL: &'static [Scene] = &[
        Scene::Waiting,
        Scene::Working,
        Scene::Limit,
        Scene::Narrow,
        Scene::Empty,
        Scene::Bots,
        Scene::Queue,
        Scene::Computers,
        Scene::Settings,
    ];

    pub fn slug(self) -> &'static str {
        match self {
            Scene::Waiting => "waiting",
            Scene::Working => "working",
            Scene::Limit => "limit",
            Scene::Narrow => "narrow",
            Scene::Empty => "empty",
            Scene::Bots => "bots",
            Scene::Queue => "queue",
            Scene::Computers => "computers",
            Scene::Settings => "settings",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Scene::Waiting => "Waiting on you",
            Scene::Working => "At work",
            Scene::Limit => "Near a limit",
            Scene::Narrow => "Narrow window",
            Scene::Empty => "First run",
            Scene::Bots => "Bots",
            Scene::Queue => "Work Queue",
            Scene::Computers => "Computers",
            Scene::Settings => "Settings",
        }
    }

    pub fn area(self) -> Area {
        match self {
            Scene::Bots => Area::Bots,
            Scene::Queue => Area::Queue,
            Scene::Computers => Area::Computers,
            Scene::Settings => Area::Settings,
            _ => Area::Sessions,
        }
    }

    /// The window the scene is drawn in.
    pub fn window_size(self) -> Size<Pixels> {
        match self {
            Scene::Narrow => size(px(760.), px(800.)),
            _ => size(px(1280.), px(800.)),
        }
    }

    /// The session open in the scene.
    fn open_session(self) -> Option<&'static str> {
        match self {
            Scene::Waiting => Some("blog"),
            Scene::Working | Scene::Limit | Scene::Narrow => Some("signup"),
            _ => None,
        }
    }
}

/// The rail's areas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    Sessions,
    Bots,
    Queue,
    Computers,
    Settings,
}

impl Area {
    pub fn name(self) -> &'static str {
        match self {
            Area::Sessions => "Sessions",
            Area::Bots => "Bots",
            Area::Queue => "Work Queue",
            Area::Computers => "Computers",
            Area::Settings => "Settings",
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            Area::Sessions => IconName::Message,
            Area::Bots => IconName::Bot,
            Area::Queue => IconName::Queue,
            Area::Computers => IconName::Computer,
            Area::Settings => IconName::Settings,
        }
    }

}

/// How the main view sits beside the sidebars.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Panel {
    /// One raised panel holds the area's sidebar and the main view, its top left corner rounded
    /// against the rail (OpenBot's).
    Joined,
    /// The area's sidebar sits on the window with the rail; the main view is an inset card (the
    /// app's phase 2 look, and Capy's).
    Card,
}

/// How a rail button shows what's waiting in its area.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Badge {
    Count,
    Dot,
}

/// Everything an option draws differently.
struct Look {
    rail_w: Pixels,
    rail_button: Pixels,
    rail_icon: IconSize,
    rail_labels: bool,
    ring: Pixels,
    ring_stroke: Pixels,
    ring_percent: bool,
    /// How many rings the rail shows before "+N".
    max_rings: usize,
    calm: CalmColor,
    badge: Badge,
    list_w: Option<Pixels>,
    /// The list floats over the main view (the compact option, narrow).
    list_overlay: bool,
    list_title: bool,
    needs_you: bool,
    folding: bool,
    panel: Panel,
    /// The back, forward and + buttons sit at the sidebar's right edge (OpenBot's), rather than
    /// beside the computer switcher.
    nav_at_edge: bool,
    /// The open conversation's title sits in the title bar (OpenBot's) rather than over the
    /// main view.
    title_in_bar: bool,
}

impl Look {
    fn of(draft: Draft, scene: Scene) -> Self {
        let narrow = scene == Scene::Narrow;
        match draft {
            Draft::A => Look {
                rail_w: px(60.),
                rail_button: px(40.),
                rail_icon: IconSize::Card,
                rail_labels: false,
                ring: px(34.),
                ring_stroke: px(3.),
                ring_percent: false,
                max_rings: 4,
                calm: CalmColor::Green,
                badge: Badge::Count,
                list_w: (!narrow).then_some(px(272.)),
                list_overlay: false,
                list_title: false,
                needs_you: false,
                folding: false,
                panel: Panel::Joined,
                nav_at_edge: !narrow,
                title_in_bar: true,
            },
            Draft::B => Look {
                rail_w: if narrow { px(56.) } else { px(84.) },
                rail_button: px(40.),
                rail_icon: IconSize::Card,
                rail_labels: !narrow,
                ring: px(30.),
                ring_stroke: px(3.),
                ring_percent: !narrow,
                max_rings: 3,
                calm: CalmColor::Green,
                badge: Badge::Count,
                list_w: Some(if narrow { px(232.) } else { px(272.) }),
                list_overlay: false,
                list_title: false,
                needs_you: true,
                folding: false,
                panel: Panel::Card,
                nav_at_edge: false,
                title_in_bar: false,
            },
            Draft::C => Look {
                rail_w: px(48.),
                rail_button: px(32.),
                rail_icon: IconSize::Nav,
                rail_labels: false,
                ring: px(26.),
                ring_stroke: px(2.5),
                ring_percent: false,
                max_rings: 4,
                calm: CalmColor::Grey,
                badge: Badge::Dot,
                list_w: Some(px(256.)),
                list_overlay: narrow,
                list_title: true,
                needs_you: false,
                folding: true,
                panel: Panel::Card,
                nav_at_edge: false,
                title_in_bar: false,
            },
        }
    }
}

/// What a draft draws from: the option, the scene, and the option's look.
struct Ctx {
    draft: Draft,
    scene: Scene,
    look: Look,
}

const TITLE_BAR: Pixels = px(44.);

/// Draws one option in one scene, filling its window.
pub fn render(draft: Draft, scene: Scene, window: &mut Window, cx: &mut App) -> AnyElement {
    let d = Ctx { draft, scene, look: Look::of(draft, scene) };
    let c = cx.theme().colors.clone();

    let list = d.look.list_w.map(|w| lists::render(&d, w, window, cx));
    let main = main_view::render(&d, window, cx);

    let body = match d.look.panel {
        Panel::Joined => div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .bg(c.surface)
            .rounded_tl(radius::CARD)
            .border_t_1()
            .border_l_1()
            .border_color(c.border)
            .overflow_hidden()
            .children(list.map(|list| div().h_full().flex_none().border_r_1().border_color(c.border).child(list)))
            .child(div().flex_1().min_w_0().h_full().child(main))
            .into_any_element(),
        Panel::Card => {
            let main_card = div()
                .flex_1()
                .min_w_0()
                .h_full()
                .pb(space::S2)
                .pr(space::S2)
                .child(
                    div()
                        .size_full()
                        .rounded(radius::CARD)
                        .bg(c.surface)
                        .border_1()
                        .border_color(c.border)
                        .overflow_hidden()
                        .child(main),
                );
            if d.look.list_overlay {
                // The area's sidebar floats over the conversation, opened from the rail.
                let theme = cx.theme().clone();
                div()
                    .relative()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .child(main_card)
                    // A scrim over the conversation, so the sidebar reads as floating over it.
                    .child(
                        div().absolute().top_0().left_0().right(space::S2).bottom(space::S2).rounded(radius::CARD).bg(gpui::hsla(
                            0.,
                            0.,
                            0.,
                            if theme.appearance.is_dark() { 0.45 } else { 0.12 },
                        )),
                    )
                    .children(list.map(|list| {
                        div()
                            .absolute()
                            .top_0()
                            .left_0()
                            .bottom(space::S2)
                            .rounded_r(radius::CARD)
                            .bg(c.background)
                            .border_1()
                            .border_l_0()
                            .border_color(c.border)
                            .shadow(theme.elevated_shadow())
                            .overflow_hidden()
                            .child(list)
                    }))
                    .into_any_element()
            } else {
                div().flex_1().min_w_0().h_full().flex().children(list).child(main_card).into_any_element()
            }
        }
    };

    div()
        .size_full()
        .flex()
        .flex_col()
        .bg(c.background)
        .text_ui(TypeSize::Small)
        .text_color(c.text)
        .child(title_bar(&d, cx))
        .child(div().flex_1().min_h_0().flex().child(rail::render(&d, window, cx)).child(body))
        .into_any_element()
}

/// The system's window buttons, drawn in their own colours so the title bar reads as a window's.
fn window_buttons() -> impl IntoElement {
    let light = |color: u32| div().size(px(12.)).rounded(radius::PILL).bg(Hsla::from(rgb(color)));
    div().flex().flex_none().gap(px(8.)).child(light(0xFF5F57)).child(light(0xFEBC2E)).child(light(0x28C840))
}

/// The computer switcher: the computer this window shows, in the workspace switcher's place.
fn computer_switcher(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    // BOX-NEEDED: the computers it switches between, and whether this one is reached, from `GET kuvo/computers` (see lists.rs).
    div()
        .id("computer-switcher")
        .flex()
        .flex_none()
        .items_center()
        .gap(space::S1_5)
        .h(px(28.))
        .px(space::S2)
        .rounded(radius::NAV)
        .cursor_pointer()
        .hover(|s| s.bg(c.hover))
        .child(Icon::new(IconName::Computer).color(c.text_muted))
        .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).child("This Mac"))
        .child(Icon::new(IconName::ChevronDown).color(c.text_faint))
}

fn nav_buttons() -> impl IntoElement {
    div()
        .flex()
        .flex_none()
        .items_center()
        .gap(space::S0_5)
        .child(Button::icon_only("back", IconName::ArrowLeft, "Back").size(ButtonSize::Small))
        .child(Button::icon_only("forward", IconName::ArrowRight, "Forward").size(ButtonSize::Small).disabled(true))
        .child(Button::icon_only("new", IconName::Plus, "New Session").size(ButtonSize::Small))
}

fn title_bar(d: &Ctx, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let zone = d.look.rail_w + if d.look.list_overlay { px(0.) } else { d.look.list_w.unwrap_or(px(0.)) };
    let (title, detail) = main_view::title(d);
    div()
        .h(TITLE_BAR)
        .flex_none()
        .flex()
        .items_center()
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .min_w(zone)
                .h_full()
                .pl(space::S4)
                .pr(space::S2)
                .gap(space::S2)
                .child(window_buttons())
                .child(div().w(space::S2))
                .child(computer_switcher(cx))
                .when(d.look.nav_at_edge, |z| z.child(div().flex_1()))
                .child(nav_buttons()),
        )
        .when(d.look.title_in_bar, |bar| {
            bar.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(space::S2)
                    .pl(space::S3)
                    .pr(space::S4)
                    .child(div().flex_none().text_ui(TypeSize::Small).medium().text_color(c.text).child(title))
                    .children(detail.map(|detail| div().min_w_0().truncate().text_ui(TypeSize::Small).text_color(c.text_faint).child(detail))),
            )
        })
}

/// A view that draws one draft, for the shots.
pub struct DraftView {
    pub draft: Draft,
    pub scene: Scene,
}

impl Render for DraftView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        render(self.draft, self.scene, window, cx)
    }
}

/// The gallery's page: pick an option and a scene, and see it at its window's size.
pub struct Picker {
    draft: Draft,
    scene: Scene,
}

impl Picker {
    pub fn new() -> Self {
        Self { draft: Draft::A, scene: Scene::Working }
    }
}

impl Default for Picker {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for Picker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = cx.theme().colors.clone();
        let frame_size = self.scene.window_size();
        let drafts = Draft::ALL.iter().map(|&draft| {
            Chip::new(SharedString::from(format!("pick-{}", draft.slug())), draft.title())
                .selected(draft == self.draft)
                .into_any_element()
        });
        let scenes = Scene::ALL.iter().map(|&scene| {
            Chip::new(SharedString::from(format!("pick-{}", scene.slug())), scene.title())
                .selected(scene == self.scene)
                .into_any_element()
        });
        let entity = cx.entity();
        let draft_buttons = Draft::ALL.iter().zip(drafts).map(|(&draft, chip)| {
            let entity = entity.clone();
            div()
                .id(SharedString::from(format!("pick-draft-{}", draft.slug())))
                .cursor_pointer()
                .on_click(move |_, _, cx| entity.update(cx, |p, cx| { p.draft = draft; cx.notify(); }))
                .child(chip)
        });
        let scene_buttons = Scene::ALL.iter().zip(scenes).map(|(&scene, chip)| {
            let entity = entity.clone();
            div()
                .id(SharedString::from(format!("pick-scene-{}", scene.slug())))
                .cursor_pointer()
                .on_click(move |_, _, cx| entity.update(cx, |p, cx| { p.scene = scene; cx.notify(); }))
                .child(chip)
        });
        div()
            .flex()
            .flex_col()
            .gap(space::S4)
            .p(space::S8)
            .child(div().text_ui(TypeSize::Title).medium().text_color(c.text).child("Sidebar drafts"))
            .child(
                div()
                    .text_ui(TypeSize::Body)
                    .text_color(c.text_muted)
                    .child("A rail for the big areas, and each area's own sidebar beside it. Sample data only."),
            )
            .child(div().flex().flex_wrap().gap(space::S2).children(draft_buttons))
            .child(div().flex().flex_wrap().gap(space::S2).children(scene_buttons))
            .child(
                div()
                    .flex_none()
                    .w(frame_size.width)
                    .h(frame_size.height)
                    .rounded(radius::CARD)
                    .border_1()
                    .border_color(c.border_strong)
                    .overflow_hidden()
                    .child(render(self.draft, self.scene, window, cx)),
            )
    }
}
