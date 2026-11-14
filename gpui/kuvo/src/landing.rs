//! The landing view, for a new conversation: the composer in the middle, on the dotted backdrop,
//! with where it starts above it: the project (or no project, a chat) and the box it's on.

use gpui::{AnyElement, AppContext as _, Context, IntoElement, ParentElement, SharedString, Styled, Window, div, px};
use kuvo_box::models::StartIn;
use kuvo_ui::{
    ActiveTheme, Button, ButtonSize, IconName, StyledType, TypeSize,
    backdrop::backdrop,
    menu::{Menu, MenuEntry, PopoverMenu},
    small::status_dot,
    theme::space,
};

use crate::entries::COLUMN;
use crate::workspace::{BoxState, Workspace};

pub fn render(workspace: &Workspace, _window: &mut Window, cx: &mut Context<Workspace>) -> AnyElement {
    let c = cx.theme().colors.clone();
    let place = workspace.landing_place();
    let label = match &place {
        StartIn::Project(directory) => workspace.project_name(directory),
        StartIn::Chat => "No project".to_owned(),
    };
    // Every project the box lists, newest first, then none (a chat).
    let projects: Vec<(String, String)> = workspace.listing().sidebar().projects.iter().map(|group| (group.directory.clone(), group.name.clone())).collect();
    let this = cx.entity().downgrade();
    let picked = place.clone();
    let project_chip = PopoverMenu::new(
        "project-menu",
        Button::new("project-chip", label).ghost().size(ButtonSize::Small).icon(IconName::Folder).icon_after(IconName::ChevronDown),
        move |_, cx| {
            let (projects, this, picked) = (projects.clone(), this.clone(), picked.clone());
            cx.new(|cx| {
                let mut menu = Menu::new(cx).width(px(240.)).header("Start in");
                for (directory, name) in projects {
                    let checked = picked == StartIn::Project(directory.clone());
                    let this = this.clone();
                    menu = menu.entry(MenuEntry::new(name).icon(IconName::Folder).checked(checked).on_select(move |_, cx| {
                        this.update(cx, |this, cx| this.pick_place(StartIn::Project(directory.clone()), cx)).ok();
                    }));
                }
                let this = this.clone();
                menu.separator().entry(MenuEntry::new("No project").detail("a chat").icon(IconName::Message).checked(picked == StartIn::Chat).on_select(move |_, cx| {
                    this.update(cx, |this, cx| this.pick_place(StartIn::Chat, cx)).ok();
                }))
            })
        },
    );
    let dot = match workspace.box_state() {
        BoxState::Connected => c.success,
        BoxState::Connecting => c.text_faint,
        BoxState::Updating => c.warning,
        BoxState::Unreachable(_) => c.danger,
    };
    let computer = div()
        .flex()
        .items_center()
        .gap(space::S1_5)
        .h(px(24.))
        .px(space::S2)
        .text_ui(TypeSize::Caption)
        .text_color(c.text_muted)
        .child(kuvo_ui::Icon::new(IconName::Computer).size(kuvo_ui::IconSize::Nav).color(c.text_muted))
        .child(SharedString::from(workspace.box_name()))
        .child(status_dot(dot));
    div()
        .relative()
        .size_full()
        .child(backdrop())
        .child(
            div()
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .px(space::S6)
                // A little above the middle, where the eye rests.
                .pb(px(96.))
                .child(
                    div()
                        .w_full()
                        .max_w(px(COLUMN))
                        .flex()
                        .flex_col()
                        .gap(space::S2)
                        .child(div().flex().items_center().gap(space::S1).ml(-space::S1).child(project_chip).child(computer))
                        .child(workspace.landing().clone()),
                ),
        )
        .into_any_element()
}
