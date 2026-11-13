//! Rows: the sidebar's navigation rows and the list rows of cards and pages.
//!
//! A row shows a wash under the pointer, a stronger one while pressed, and a filled
//! background when it's the one selected. Its trailing slot holds a count badge, a time, or
//! whatever the row needs; long labels end in an ellipsis rather than wrapping.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::{
    icon::{Icon, IconName, IconSize},
    theme::{ActiveTheme, StyledType, TypeSize, radius, space},
};

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// How a row is shown without the pointer, for the gallery and tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    Hovered,
    Pressed,
}

/// A sidebar navigation row: a 14 px icon or leading element, a label, and a trailing slot.
#[derive(IntoElement)]
pub struct NavRow {
    id: ElementId,
    label: SharedString,
    icon: Option<IconName>,
    leading: Option<AnyElement>,
    trailing: Option<AnyElement>,
    /// Shown only while the pointer is over the row (a "more" button, say).
    hover_trailing: Option<AnyElement>,
    selected: bool,
    disabled: bool,
    muted: bool,
    indent: usize,
    shown: Option<RowState>,
    on_click: Option<ClickHandler>,
}

impl NavRow {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            leading: None,
            trailing: None,
            hover_trailing: None,
            selected: false,
            disabled: false,
            muted: false,
            indent: 0,
            shown: None,
            on_click: None,
        }
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    /// Anything in place of the icon: an avatar, a status dot.
    pub fn leading(mut self, element: impl IntoElement) -> Self {
        self.leading = Some(element.into_any_element());
        self
    }

    pub fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing = Some(element.into_any_element());
        self
    }

    pub fn hover_trailing(mut self, element: impl IntoElement) -> Self {
        self.hover_trailing = Some(element.into_any_element());
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Draws the label in the second text level (read, finished, or less important rows).
    pub fn muted(mut self, muted: bool) -> Self {
        self.muted = muted;
        self
    }

    /// Nests the row under the one above it, one step per level.
    pub fn indent(mut self, level: usize) -> Self {
        self.indent = level;
        self
    }

    pub fn shown(mut self, state: RowState) -> Self {
        self.shown = Some(state);
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

/// The height of a navigation row.
pub const NAV_ROW_HEIGHT: Pixels = px(30.);

impl RenderOnce for NavRow {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        let (hover, pressed, selected_bg, accent) = (c.hover, c.pressed, c.selected, c.accent);
        let text = if self.disabled {
            c.text_faint
        } else if self.selected || !self.muted {
            c.text
        } else {
            c.text_muted
        };
        let icon_color = if self.disabled {
            c.text_faint
        } else if self.selected {
            c.text
        } else {
            c.text_muted
        };
        let group: SharedString = format!("row-{:?}", self.id).into();

        let mut row = div()
            .id(self.id)
            .group(group.clone())
            .flex()
            .items_center()
            .gap(space::S2)
            .h(NAV_ROW_HEIGHT)
            .pl(space::S2 + space::S4 * self.indent as f32)
            .pr(space::S2)
            .rounded(radius::NAV)
            .border_1()
            .border_color(gpui::transparent_black())
            .text_ui(TypeSize::Small)
            .text_color(text);

        if self.selected {
            row = row.bg(selected_bg).medium();
        }
        match self.shown {
            Some(RowState::Hovered) => row = row.bg(hover),
            Some(RowState::Pressed) => row = row.bg(pressed),
            None => {}
        }
        if !self.disabled {
            row = row
                .cursor_pointer()
                .tab_index(0)
                .when_selected_or(self.selected, selected_bg, hover)
                .active(move |s| s.bg(pressed))
                .focus_visible(move |s| s.border_color(accent).bg(hover));
            if let Some(handler) = self.on_click {
                row = row.on_click(move |event, window, cx| handler(event, window, cx));
            }
        }

        let leading = match (self.leading, self.icon) {
            (Some(element), _) => Some(element),
            (None, Some(icon)) => {
                Some(Icon::new(icon).size(IconSize::Nav).color(icon_color).into_any_element())
            }
            (None, None) => None,
        };

        let has_hover_trailing = self.hover_trailing.is_some();
        row.children(leading)
            .child(div().flex_1().min_w_0().truncate().child(self.label))
            .children(self.trailing.map(|t| {
                let slot = div().flex().flex_none().items_center();
                if has_hover_trailing {
                    slot.group_hover(group.clone(), |s| s.opacity(0.)).child(t)
                } else {
                    slot.child(t)
                }
            }))
            .children(self.hover_trailing.map(|t| {
                div()
                    .flex()
                    .flex_none()
                    .items_center()
                    .opacity(0.)
                    .group_hover(group.clone(), |s| s.opacity(1.))
                    .child(t)
            }))
    }
}

/// Hover for rows: selected rows keep their fill rather than taking the lighter wash.
trait RowHover: Sized {
    fn when_selected_or(self, selected: bool, selected_bg: gpui::Hsla, hover: gpui::Hsla) -> Self;
}

impl<E: InteractiveElement + Styled> RowHover for E {
    fn when_selected_or(self, selected: bool, selected_bg: gpui::Hsla, hover: gpui::Hsla) -> Self {
        if selected { self.hover(move |s| s.bg(selected_bg)) } else { self.hover(move |s| s.bg(hover)) }
    }
}
