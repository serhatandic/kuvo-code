//! The title bar: the window's buttons, the computer switcher, back, forward and New Session over
//! the rail and the area's sidebar; then the main view's title, and the side panel's button.
//! Dragging it moves the window.

use gpui::{
    AnyElement, App, AppContext as _, Context, InteractiveElement, IntoElement, MouseButton, ParentElement, Styled, div, prelude::FluentBuilder as _, px,
};
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, IconName, StyledType, TypeSize,
    menu::{Menu, MenuEntry, PopoverMenu},
    small::status_dot,
    theme::space,
};

use crate::area::{Area, Back, Forward, ShowComputers};
use crate::workspace::{BoxState, Workspace};
use crate::{NewSession, rail, sidebar};

/// How tall it is.
pub const HEIGHT: f32 = 44.;
/// The room the window's own buttons take at its left (macOS's traffic lights).
const LIGHTS: f32 = 84.;

pub fn render(workspace: &Workspace, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let (title, beside) = workspace.title(cx);
    // Over the rail and the area's sidebar: the switcher, then back, forward and + at the
    // sidebar's edge (OpenBot's); with the sidebar folded, they sit together.
    let zone = rail::WIDTH + if workspace.sidebar_shown() { px(sidebar::WIDTH) } else { px(0.) };
    let nav = div()
        .flex()
        .flex_none()
        .items_center()
        .gap(space::S0_5)
        .child(
            Button::icon_only("back", IconName::ArrowLeft, "Back")
                .ghost()
                .size(ButtonSize::Small)
                .tooltip("⌘[")
                .disabled(!workspace.can_go_back())
                .on_click(|_, window, cx| window.dispatch_action(Box::new(Back), cx)),
        )
        .child(
            Button::icon_only("forward", IconName::ArrowRight, "Forward")
                .ghost()
                .size(ButtonSize::Small)
                .tooltip("⌘]")
                .disabled(!workspace.can_go_forward())
                .on_click(|_, window, cx| window.dispatch_action(Box::new(Forward), cx)),
        )
        .child(
            Button::icon_only("new-session", IconName::Plus, "New Session")
                .ghost()
                .size(ButtonSize::Small)
                .tooltip("⌘N")
                .on_click(|_, window, cx| window.dispatch_action(Box::new(NewSession), cx)),
        );
    let panel_button = (workspace.area() == Area::Sessions).then(|| {
        Button::icon_only("toggle-panel", IconName::PanelRight, if workspace.is_panel_open() { "Hide Panel" } else { "Show Panel" })
            .ghost()
            .size(ButtonSize::Small)
            .selected(workspace.is_panel_open())
            .tooltip("⌥⌘0")
            .on_click(cx.listener(|this, _, _, cx| this.toggle_panel(cx)))
    });
    div()
        .id("title-bar")
        .flex()
        .flex_none()
        .items_center()
        .h(px(HEIGHT))
        .on_mouse_down(MouseButton::Left, |event, window, _| {
            if event.click_count == 1 {
                window.start_window_move();
            }
        })
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(space::S2)
                .min_w(zone)
                .h_full()
                .pl(px(LIGHTS))
                .pr(space::S2)
                .child(buttons(computer_switcher(workspace, cx)))
                .when(workspace.sidebar_shown(), |zone| zone.child(div().flex_1()))
                .child(buttons(nav)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(space::S2)
                .pl(space::S3)
                .pr(space::S3)
                .children(title.map(|title| div().debug_selector(|| "window-title".into()).min_w_0().truncate().text_ui(TypeSize::Small).medium().text_color(c.text).child(title)))
                .children(beside.map(|beside| div().flex_none().text_ui(TypeSize::Small).text_color(c.text_faint).child(beside)))
                .child(div().flex_1())
                .children(panel_button.map(buttons)),
        )
        .into_any_element()
}

/// A press in here is its buttons', never the title bar's window move.
fn buttons(child: impl IntoElement) -> impl IntoElement {
    div().flex_none().on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation()).child(child)
}

/// The computer whose box the window shows, and how it stands; it opens the list of your computers.
fn computer_switcher(workspace: &Workspace, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let name = workspace.box_name();
    let (dot, said) = match workspace.box_state() {
        BoxState::Connected => (None, None),
        BoxState::Connecting => (Some(c.text_faint), Some("Connecting…".to_owned())),
        BoxState::Updating => (Some(c.warning), Some(kuvo_box::gate::UPDATING.to_owned())),
        BoxState::Unreachable(why) => (Some(c.danger), Some(why.clone())),
    };
    let trigger = Button::new("computer-switcher", name.clone()).ghost().size(ButtonSize::Small).icon(IconName::Computer).icon_after(IconName::ChevronDown);
    let menu_name = name.clone();
    div()
        .flex()
        .items_center()
        .gap(space::S1)
        .child(
            PopoverMenu::new("computer-menu", trigger, move |_, cx| {
                let (name, said) = (menu_name.clone(), said.clone());
                cx.new(|cx| {
                    let mut entry = MenuEntry::new(name).icon(IconName::Computer).checked(true);
                    if let Some(said) = said {
                        entry = entry.detail(said);
                    }
                    // BOX-NEEDED: your computers to switch between, and whether each is reached, `GET kuvo/computers` (#711); and the app reaching a machine's box at all (it reaches this Mac's only).
                    Menu::new(cx)
                        .width(px(280.))
                        .header("Shown in This Window")
                        .entry(entry)
                        .separator()
                        .entry(MenuEntry::new("Switching to another computer").detail("not in this app yet").disabled(true))
                        .entry(MenuEntry::new("Show Computers").shortcut("⌃4").on_select(|window, cx| window.dispatch_action(Box::new(ShowComputers), cx)))
                })
            })
            .into_any_element(),
        )
        .children(dot.map(status_dot))
        .into_any_element()
}
