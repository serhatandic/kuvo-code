use gpui::{AnyElement, App, Context, IntoElement, ParentElement, Styled, Window, div, px};
use kuvo_ui::{
    ActiveTheme, IconSize, StyledType, TypeSize,
    row::{ListRow, row_card},
    small::{Avatar, Checkbox, Chip, ChipTone, Switch, count_badge, spinner, status_dot},
    theme::space,
};

use crate::{Gallery, page as frame, section};

/// The values the page's switches and checkboxes show.
pub struct Settings {
    pub notify: bool,
    pub sleep: bool,
    pub include: [bool; 3],
}

impl Default for Settings {
    fn default() -> Self {
        Self { notify: true, sleep: false, include: [true, false, true] }
    }
}

pub fn page(settings: &Settings, _window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    let toggles = toggles(settings, cx).into_any_element();
    frame(
        "Small pieces",
        "Switches for settings that apply at once, checkboxes for choices confirmed later, chips, avatars, badges, status lights and a spinner.",
        vec![
            section("Switches and checkboxes", toggles, cx),
            section("Chips, avatars, badges and status", pieces(cx), cx),
        ],
        cx,
    )
}

fn toggles(settings: &Settings, cx: &mut Context<Gallery>) -> impl IntoElement + use<> {
    let gallery = cx.entity().downgrade();
    let set = move |f: fn(&mut Settings, bool)| {
        let gallery = gallery.clone();
        move |on: bool, _: &mut Window, cx: &mut App| {
            gallery
                .update(cx, |g, cx| {
                    f(&mut g.demos.settings, on);
                    cx.notify();
                })
                .ok();
        }
    };
    let c = &cx.theme().colors;
    let include = |ix: usize, label: &'static str| {
        Checkbox::new(("include", ix), settings.include[ix]).label(label).on_change(set(match ix {
            0 => |s: &mut Settings, on| s.include[0] = on,
            1 => |s: &mut Settings, on| s.include[1] = on,
            _ => |s: &mut Settings, on| s.include[2] = on,
        }))
    };
    div()
        .flex()
        .gap(space::S8)
        .items_start()
        .child(div().flex_1().child(row_card(
            [
                ListRow::new("s-notify", "Tell me when an agent needs me")
                    .detail("A notification on this Mac and your phone")
                    .trailing(Switch::new("sw-notify", settings.notify).on_change(set(|s, on| s.notify = on)))
                    .into_any_element(),
                ListRow::new("s-sleep", "Keep working when this Mac sleeps")
                    .detail("Off")
                    .trailing(Switch::new("sw-sleep", settings.sleep).on_change(set(|s, on| s.sleep = on)))
                    .into_any_element(),
                ListRow::new("s-locked", "Share usage with your team")
                    .detail("Your organisation decides this")
                    .trailing(Switch::new("sw-locked", true).disabled(true))
                    .into_any_element(),
            ],
            cx,
        )))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(space::S3)
                .w(px(260.))
                .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child("Include in the summary"))
                .child(include(0, "Open issues"))
                .child(include(1, "Pull requests waiting on you"))
                .child(include(2, "Sessions that finished overnight"))
                .child(Checkbox::new("include-x", false).label("Billing (needs admin)").disabled(true)),
        )
}

fn pieces(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let label = |text: &'static str| div().w(px(96.)).flex_none().text_ui(TypeSize::Caption).text_color(c.text_faint).child(text);
    let line = || div().flex().items_center().gap(space::S3);
    div()
        .flex()
        .flex_col()
        .gap(space::S5)
        .child(
            line()
                .child(label("Chips"))
                .child(Chip::new("c-all", "All"))
                .child(Chip::new("c-mine", "Assigned to me").selected(true))
                .child(Chip::new("c-det", "Detected").dot().tone(ChipTone::Success))
                .child(Chip::new("c-wait", "Waiting on you").dot().tone(ChipTone::Warning))
                .child(Chip::new("c-fail", "Failed").dot().tone(ChipTone::Danger))
                .child(Chip::new("c-file", "Form.tsx").icon(kuvo_ui::IconName::File).on_remove(|_, _| {})),
        )
        .child(
            line()
                .child(label("Avatars"))
                .child(Avatar::new("Mira").size(px(18.)))
                .child(Avatar::new("Kuvo Foreman").size(px(24.)).status(c.success))
                .child(Avatar::new("serhat andic").size(px(32.)))
                .child(Avatar::new("Research Bot").size(px(40.)).status(c.warning))
                .child(Avatar::new("Ops").size(px(40.))),
        )
        .child(
            line()
                .child(label("Badges"))
                .child(count_badge(1, cx))
                .child(count_badge(12, cx))
                .child(count_badge(76, cx))
                .child(count_badge(240, cx)),
        )
        .child(
            line()
                .child(label("Status"))
                .child(div().flex().items_center().gap(space::S1_5).child(status_dot(c.success)).child(div().text_ui(TypeSize::Small).child("Running")))
                .child(div().flex().items_center().gap(space::S1_5).child(status_dot(c.warning)).child(div().text_ui(TypeSize::Small).child("Needs you")))
                .child(div().flex().items_center().gap(space::S1_5).child(status_dot(c.danger)).child(div().text_ui(TypeSize::Small).child("Failed")))
                .child(div().flex().items_center().gap(space::S1_5).child(status_dot(c.text_faint)).child(div().text_ui(TypeSize::Small).child("Idle"))),
        )
        .child(
            line()
                .child(label("Spinners"))
                .child(spinner("sp-nav", IconSize::Nav, c.text_muted))
                .child(spinner("sp-card", IconSize::Card, c.text_muted))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(space::S2)
                        .child(spinner("sp-label", IconSize::Nav, c.accent))
                        .child(div().text_ui(TypeSize::Small).text_color(c.text_muted).child("Working on it…")),
                ),
        )
}
