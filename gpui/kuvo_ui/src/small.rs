//! Small pieces: a switch, a checkbox, chips, avatars, count badges, status dots and a spinner.
//!
//! Switches and checkboxes hold no state: the view that draws them owns the value and changes
//! it in `on_change`, so what's shown is always what the box says.

use std::{rc::Rc, time::Duration};

use gpui::{
    Animation, AnimationExt as _, App, ElementId, Hsla, InteractiveElement, IntoElement,
    ParentElement, Pixels, RenderOnce, SharedString, StatefulInteractiveElement, Styled,
    Transformation, Window, div, percentage, prelude::FluentBuilder as _, px, svg,
};

use crate::{
    icon::{Icon, IconName, IconSize},
    theme::{ActiveTheme, StyledType, TypeSize, radius, space},
};

type ChangeHandler = Rc<dyn Fn(bool, &mut Window, &mut App)>;

/// A switch, for settings that take effect at once.
#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    on: bool,
    disabled: bool,
    label: Option<SharedString>,
    on_change: Option<ChangeHandler>,
}

impl Switch {
    pub fn new(id: impl Into<ElementId>, on: bool) -> Self {
        Self { id: id.into(), on, disabled: false, label: None, on_change: None }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Called with the new value when the switch is clicked, or pressed with Space or Return.
    pub fn on_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Switch {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        // The thumb stays white either way, as on macOS; only the track says on or off.
        let (track, thumb) = if self.on { (c.accent, c.text_on_accent) } else { (c.border_strong, c.text_on_accent) };
        let ring = c.focus_ring;
        let on = self.on;
        let mut root = div()
            .id(self.id)
            .flex()
            .items_center()
            .gap(space::S2)
            .text_ui(TypeSize::Small)
            .text_color(c.text)
            .child(
                div()
                    .flex()
                    .items_center()
                    .flex_none()
                    .w(px(30.))
                    .h(px(18.))
                    .p(px(2.))
                    .rounded(radius::PILL)
                    .bg(track)
                    .when(on, |d| d.justify_end())
                    .child(div().size(px(14.)).rounded(radius::PILL).bg(thumb).shadow(cx.theme().card_shadow())),
            )
            .children(self.label);
        if self.disabled {
            root = root.opacity(0.4);
        } else {
            root = root
                .cursor_pointer()
                .tab_index(0)
                .rounded(radius::PILL)
                .focus_visible(move |s| s.shadow(crate::button::focus_ring(ring)));
            if let Some(handler) = self.on_change {
                root = root.on_click(move |_, window, cx| handler(!on, window, cx));
            }
        }
        root
    }
}

/// A checkbox, for choices that are confirmed later (a form, a list of things to include).
#[derive(IntoElement)]
pub struct Checkbox {
    id: ElementId,
    checked: bool,
    disabled: bool,
    label: Option<SharedString>,
    on_change: Option<ChangeHandler>,
}

impl Checkbox {
    pub fn new(id: impl Into<ElementId>, checked: bool) -> Self {
        Self { id: id.into(), checked, disabled: false, label: None, on_change: None }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_change(mut self, handler: impl Fn(bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Checkbox {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        let checked = self.checked;
        let accent = c.accent;
        let ring = c.focus_ring;
        let box_ = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(16.))
            .rounded(radius::SMALL)
            .map(|d| {
                if checked {
                    d.bg(c.accent).child(Icon::new(IconName::Check).size(IconSize::Nav).color(c.text_on_accent))
                } else {
                    d.bg(c.surface).border_1().border_color(c.border_strong)
                }
            });
        let mut root = div()
            .id(self.id)
            .group("checkbox")
            .flex()
            .items_center()
            .gap(space::S2)
            .text_ui(TypeSize::Small)
            .text_color(c.text)
            .child(box_)
            .children(self.label);
        if self.disabled {
            root = root.opacity(0.4);
        } else {
            root = root
                .cursor_pointer()
                .tab_index(0)
                .rounded(radius::SMALL)
                .focus_visible(move |s| s.shadow(crate::button::focus_ring(ring)))
                .when(!checked, |d| d.hover(move |s| s.text_color(accent)));
            if let Some(handler) = self.on_change {
                root = root.on_click(move |_, window, cx| handler(!checked, window, cx));
            }
        }
        root
    }
}

/// How a chip reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ChipTone {
    #[default]
    Neutral,
    Success,
    Warning,
    Danger,
    Accent,
}

/// A chip: a short tag (a filter, a status, a file in the composer's context).
#[derive(IntoElement)]
pub struct Chip {
    id: ElementId,
    label: SharedString,
    icon: Option<IconName>,
    dot: bool,
    tone: ChipTone,
    selected: bool,
    on_remove: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
}

impl Chip {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self { id: id.into(), label: label.into(), icon: None, dot: false, tone: ChipTone::Neutral, selected: false, on_remove: None }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// A status dot before the label, in the chip's tone ("● Detected").
    pub fn dot(mut self) -> Self {
        self.dot = true;
        self
    }

    pub fn tone(mut self, tone: ChipTone) -> Self {
        self.tone = tone;
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    /// Shows a small × that removes the chip.
    pub fn on_remove(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_remove = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for Chip {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        let tone = match self.tone {
            ChipTone::Neutral => c.text_muted,
            ChipTone::Success => c.success,
            ChipTone::Warning => c.warning,
            ChipTone::Danger => c.danger,
            ChipTone::Accent => c.accent,
        };
        let (bg, border, text) = if self.selected {
            (c.accent.opacity(0.12), c.accent.opacity(0.35), c.accent)
        } else if self.tone == ChipTone::Neutral {
            (c.sunken, c.border, c.text)
        } else {
            (tone.opacity(0.10), tone.opacity(0.25), tone)
        };
        let hover = c.pressed;
        div()
            .id(self.id)
            .flex()
            .flex_none()
            .items_center()
            .gap(space::S1)
            .h(px(22.))
            .px(space::S2)
            .rounded(radius::SMALL)
            .bg(bg)
            .border_1()
            .border_color(border)
            .text_ui(TypeSize::Caption)
            .text_color(text)
            .when(self.dot, |d| d.child(status_dot(tone)))
            .children(self.icon.map(|i| Icon::new(i).size(IconSize::Nav).color(text)))
            .child(self.label)
            .children(self.on_remove.map(|remove| {
                div()
                    .id("remove")
                    .ml(px(-2.))
                    .mr(px(-4.))
                    .rounded(px(4.))
                    .cursor_pointer()
                    .hover(move |s| s.bg(hover))
                    .on_click(move |_, window, cx| remove(window, cx))
                    .child(Icon::new(IconName::Close).size(IconSize::Nav).color(text))
            }))
    }
}

/// A small round status light.
pub fn status_dot(color: Hsla) -> impl IntoElement {
    div().size(px(7.)).flex_none().rounded(radius::PILL).bg(color)
}

/// A count in a pill: unread messages, sessions waiting for you. Shows "99+" past 99.
pub fn count_badge(count: usize, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let text = if count > 99 { "99+".to_string() } else { count.to_string() };
    div()
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .min_w(px(18.))
        .h(px(18.))
        .px(px(5.))
        .rounded(radius::PILL)
        .bg(c.accent)
        .text_ui(TypeSize::Caption)
        .medium()
        .text_color(c.text_on_accent)
        .child(text)
}

/// An avatar: a picture, or initials on a fill picked by name.
#[derive(IntoElement)]
pub struct Avatar {
    name: SharedString,
    size: Pixels,
    status: Option<Hsla>,
}

impl Avatar {
    pub fn new(name: impl Into<SharedString>) -> Self {
        Self { name: name.into(), size: px(24.), status: None }
    }

    pub fn size(mut self, size: Pixels) -> Self {
        self.size = size;
        self
    }

    /// A status dot at the bottom right (online, busy).
    pub fn status(mut self, color: Hsla) -> Self {
        self.status = Some(color);
        self
    }

    /// The letters shown: the first letter of the first two words.
    pub fn initials(name: &str) -> String {
        name.split_whitespace()
            .filter_map(|word| word.chars().next())
            .take(2)
            .flat_map(char::to_uppercase)
            .collect()
    }
}

impl RenderOnce for Avatar {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        let hash = self.name.bytes().fold(5381u32, |h, b| h.wrapping_mul(33) ^ b as u32);
        let fill = c.avatars[hash as usize % c.avatars.len()];
        // Initials in one of the type sizes, by how big the avatar is.
        let type_size = if self.size < px(28.) {
            TypeSize::Caption
        } else if self.size < px(36.) {
            TypeSize::Small
        } else {
            TypeSize::Body
        };
        let ring = c.surface;
        div()
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(self.size)
            .rounded(radius::PILL)
            .bg(fill)
            .text_ui(type_size)
            .medium()
            .text_color(c.text)
            .child(Self::initials(&self.name))
            .children(self.status.map(|status| {
                div()
                    .absolute()
                    .bottom(px(-1.))
                    .right(px(-1.))
                    .size(px(9.))
                    .rounded(radius::PILL)
                    .border_2()
                    .border_color(ring)
                    .bg(status)
            }))
    }
}

/// A spinner: a turning arc, for work in progress. Holds still when the system asks for less
/// motion (GPUI's animations do that themselves).
pub fn spinner(id: impl Into<ElementId>, size: IconSize, color: Hsla) -> impl IntoElement {
    svg()
        .path(IconName::Spinner.path())
        .size(size.pixels())
        .flex_none()
        .text_color(color)
        .with_animation(id, Animation::new(Duration::from_millis(900)).repeat(), |svg, delta| {
            svg.with_transformation(Transformation::rotate(percentage(delta)))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_take_the_first_two_words() {
        assert_eq!(Avatar::initials("Mira"), "M");
        assert_eq!(Avatar::initials("sam rivera"), "SR");
        assert_eq!(Avatar::initials("Kuvo Foreman Bot"), "KF");
        assert_eq!(Avatar::initials("  "), "");
    }
}
