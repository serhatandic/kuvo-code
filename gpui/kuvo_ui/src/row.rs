//! Rows: the sidebar's navigation rows and the list rows of cards and pages.
//!
//! A row shows a wash under the pointer, a stronger one while pressed, and a filled
//! background when it's the one selected. Its trailing slot holds a count badge, a time, or
//! whatever the row needs; long labels end in an ellipsis rather than wrapping.

use std::rc::Rc;

use gpui::{
    AnyElement, App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder as _, px,
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
    /// Where the keyboard is, walking the list: its ring and a wash.
    cursor: bool,
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
            cursor: false,
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

    /// Marks it as where the keyboard is in its list (arrows walk it, Return opens it).
    pub fn cursor(mut self, cursor: bool) -> Self {
        self.cursor = cursor;
        self
    }
}

/// The height of a navigation row.
pub const NAV_ROW_HEIGHT: Pixels = px(32.);

/// A selected row or tile in the rail or a sidebar, as every one of them draws it: its own card
/// (the theme's `selected_card`, a hairline and a soft shadow), not a grey wash.
pub fn selected_card<E: gpui::Styled>(element: E, selected: bool, cx: &App) -> E {
    if !selected {
        return element;
    }
    let theme = cx.theme();
    element.bg(theme.colors.selected_card).shadow(theme.selected_shadow())
}

impl RenderOnce for NavRow {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        let (hover, pressed, selected_bg, accent) = (c.hover, c.pressed, c.selected_card, c.accent);
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
            c.icon
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
            .text_ui(TypeSize::Body)
            .text_color(text);

        row = selected_card(row, self.selected, cx);
        if self.cursor {
            row = row.border_color(accent);
            if !self.selected {
                row = row.bg(hover);
            }
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
                .when(!self.selected, |row| row.active(move |s| s.bg(pressed)))
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

        // The end of the row: what it shows at rest, and what takes its place under the
        // pointer (the hover action sits over the resting content, so nothing shifts).
        let end = match (self.trailing, self.hover_trailing) {
            (None, None) => None,
            (Some(rest), None) => Some(div().flex().flex_none().items_center().child(rest)),
            (rest, Some(action)) => Some(
                div()
                    .relative()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_end()
                    .min_w(px(24.))
                    .h_full()
                    .children(rest.map(|rest| {
                        div().flex().items_center().group_hover(group.clone(), |s| s.opacity(0.)).child(rest)
                    }))
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .right(px(-4.))
                            .flex()
                            .items_center()
                            .opacity(0.)
                            .group_hover(group.clone(), |s| s.opacity(1.))
                            .child(action),
                    ),
            ),
        };
        // Leading things narrower than an icon (status dots) are centred in an icon's width, so
        // every label in a list starts at the same place.
        let leading = leading.map(|l| div().flex().flex_none().justify_center().min_w(IconSize::Nav.pixels()).child(l));
        row.children(leading)
            .child(div().flex_1().min_w_0().truncate().child(self.label))
            .children(end)
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

/// A section's header in a sidebar: a quiet label, with actions that show under the pointer.
#[derive(IntoElement)]
pub struct SectionHeader {
    id: ElementId,
    label: SharedString,
    actions: Vec<AnyElement>,
}

impl SectionHeader {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self { id: id.into(), label: label.into(), actions: Vec::new() }
    }

    pub fn action(mut self, element: impl IntoElement) -> Self {
        self.actions.push(element.into_any_element());
        self
    }
}

impl RenderOnce for SectionHeader {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        let group: SharedString = format!("section-{:?}", self.id).into();
        div()
            .id(self.id)
            .group(group.clone())
            .flex()
            .items_center()
            .justify_between()
            .h(px(28.))
            .pl(space::S2)
            .pt(space::S2)
            .text_ui(TypeSize::Caption)
            .text_color(c.text_faint)
            .child(self.label)
            .child(
                div()
                    .flex()
                    .items_center()
                    .opacity(0.)
                    .group_hover(group, |s| s.opacity(1.))
                    .children(self.actions),
            )
    }
}

/// A row in a card's list: a leading tile, a title over a line of detail, and something at the
/// end (a button, a chip, a value with a chevron). Rows in a list are divided by hairlines.
#[derive(IntoElement)]
pub struct ListRow {
    id: ElementId,
    title: SharedString,
    title_extra: Option<AnyElement>,
    detail: Option<SharedString>,
    leading: Option<AnyElement>,
    trailing: Option<AnyElement>,
    shown: Option<RowState>,
    on_click: Option<ClickHandler>,
}

impl ListRow {
    pub fn new(id: impl Into<ElementId>, title: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            title_extra: None,
            detail: None,
            leading: None,
            trailing: None,
            shown: None,
            on_click: None,
        }
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Something right after the title (a status chip).
    pub fn title_extra(mut self, element: impl IntoElement) -> Self {
        self.title_extra = Some(element.into_any_element());
        self
    }

    /// An icon in a 36 px tile, at the card size.
    pub fn icon(mut self, icon: IconName, cx: &App) -> Self {
        let c = &cx.theme().colors;
        self.leading = Some(
            div()
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(36.))
                .rounded(radius::NAV)
                .bg(c.sunken)
                .border_1()
                .border_color(c.border)
                .child(Icon::new(icon).size(IconSize::Card).color(c.icon))
                .into_any_element(),
        );
        self
    }

    pub fn leading(mut self, element: impl IntoElement) -> Self {
        self.leading = Some(element.into_any_element());
        self
    }

    pub fn trailing(mut self, element: impl IntoElement) -> Self {
        self.trailing = Some(element.into_any_element());
        self
    }

    pub fn shown(mut self, state: RowState) -> Self {
        self.shown = Some(state);
        self
    }

    /// Makes the whole row a target (a row that opens a page or a setting).
    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

impl RenderOnce for ListRow {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = &cx.theme().colors;
        let (hover, pressed) = (c.hover, c.pressed);
        let mut row = div()
            .id(self.id)
            .flex()
            .items_center()
            .gap(space::S3)
            .px(space::S4)
            .py(space::S3)
            .when(self.shown == Some(RowState::Hovered), |d| d.bg(hover))
            .when(self.shown == Some(RowState::Pressed), |d| d.bg(pressed))
            .children(self.leading)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(space::S2)
                            .child(div().text_ui(TypeSize::Small).medium().text_color(c.text).truncate().child(self.title))
                            .children(self.title_extra),
                    )
                    .children(self.detail.map(|d| {
                        div().text_ui(TypeSize::Caption).text_color(c.text_muted).truncate().child(d)
                    })),
            )
            .children(self.trailing.map(|t| div().flex().flex_none().items_center().child(t)));
        if let Some(handler) = self.on_click {
            row = row
                .cursor_pointer()
                .hover(move |s| s.bg(hover))
                .active(move |s| s.bg(pressed))
                .on_click(move |e, w, cx| handler(e, w, cx));
        }
        row
    }
}

/// A card holding rows, divided by hairlines (settings, accounts, integrations).
pub fn row_card(rows: impl IntoIterator<Item = AnyElement>, cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    let mut card = div()
        .flex()
        .flex_col()
        .rounded(radius::CARD)
        .border_1()
        .border_color(c.border)
        .bg(c.surface)
        .overflow_hidden();
    for (ix, row) in rows.into_iter().enumerate() {
        if ix > 0 {
            card = card.child(div().h(px(1.)).mx(space::S4).bg(c.border));
        }
        card = card.child(row);
    }
    card
}
