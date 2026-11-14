//! Buttons: primary, secondary and ghost, in a rounded or pill shape, and icon-only buttons.
//!
//! Every button shows a wash under the pointer, a deeper one while pressed, and fades when
//! disabled. Buttons are tab stops: a keyboard focus draws the accent ring, and Return or
//! Space presses the focused button (GPUI sends that as a click).

use std::rc::Rc;

use gpui::{
    App, ClickEvent, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement,
    Pixels, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::{
    icon::{Icon, IconName, IconSize},
    theme::{ActiveTheme, StyledType, TypeSize, radius, space},
};

/// How loud a button is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonStyle {
    /// The one thing to do here: filled, inverted from the surface.
    Primary,
    /// A real choice that isn't the main one: outlined.
    #[default]
    Secondary,
    /// Quiet actions in toolbars and rows: no fill until the pointer is over it.
    Ghost,
    /// Filled with the accent, for the one action that sends something (the composer's send).
    Accent,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ButtonSize {
    /// 24 px tall: inside rows and dense toolbars.
    Small,
    /// 32 px tall: most buttons.
    #[default]
    Medium,
    /// 40 px tall: the call to action on a card or empty page.
    Large,
}

impl ButtonSize {
    fn height(self) -> Pixels {
        match self {
            Self::Small => px(24.),
            Self::Medium => px(32.),
            Self::Large => px(40.),
        }
    }

    fn padding(self, pill: bool) -> Pixels {
        let base = match self {
            Self::Small => space::S2,
            Self::Medium => space::S3,
            Self::Large => space::S5,
        };
        if pill { base + px(4.) } else { base }
    }

    fn type_size(self) -> TypeSize {
        match self {
            Self::Small => TypeSize::Caption,
            Self::Medium => TypeSize::Small,
            Self::Large => TypeSize::Body,
        }
    }
}

/// A state a button can be shown in without the pointer, so the gallery and tests can show
/// every state side by side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShownState {
    Hovered,
    Pressed,
    Focused,
}

type ClickHandler = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// A button with a label, and optionally an icon before it and a shortcut after it.
#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    label: Option<SharedString>,
    icon: Option<IconName>,
    icon_after: Option<IconName>,
    shortcut: Option<SharedString>,
    style: ButtonStyle,
    size: ButtonSize,
    pill: bool,
    square: bool,
    disabled: bool,
    loading: bool,
    selected: bool,
    full_width: bool,
    shown: Option<ShownState>,
    tooltip: Option<SharedString>,
    on_click: Option<ClickHandler>,
}

impl Button {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: Some(label.into()),
            icon: None,
            icon_after: None,
            shortcut: None,
            style: ButtonStyle::default(),
            size: ButtonSize::default(),
            pill: false,
            square: false,
            disabled: false,
            loading: false,
            selected: false,
            full_width: false,
            shown: None,
            tooltip: None,
            on_click: None,
        }
    }

    /// A square button with only an icon. Give it a tooltip: it's the button's only words.
    pub fn icon_only(id: impl Into<ElementId>, icon: IconName, label: impl Into<SharedString>) -> Self {
        let mut button = Self::new(id, "");
        button.label = None;
        button.icon = Some(icon);
        button.square = true;
        button.style = ButtonStyle::Ghost;
        button.tooltip = Some(label.into());
        button
    }

    pub fn style(mut self, style: ButtonStyle) -> Self {
        self.style = style;
        self
    }

    pub fn primary(self) -> Self {
        self.style(ButtonStyle::Primary)
    }

    pub fn ghost(self) -> Self {
        self.style(ButtonStyle::Ghost)
    }

    pub fn accent(self) -> Self {
        self.style(ButtonStyle::Accent)
    }

    pub fn size(mut self, size: ButtonSize) -> Self {
        self.size = size;
        self
    }

    /// Fully rounded: the shape for calls to action.
    pub fn pill(mut self) -> Self {
        self.pill = true;
        self
    }

    pub fn icon(mut self, icon: IconName) -> Self {
        self.icon = Some(icon);
        self
    }

    pub fn icon_after(mut self, icon: IconName) -> Self {
        self.icon_after = Some(icon);
        self
    }

    /// A key hint drawn in a keycap after the label, like Return on a dialog's main button.
    pub fn shortcut(mut self, keys: impl Into<SharedString>) -> Self {
        self.shortcut = Some(keys.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Working: a spinner takes the icon's place and presses do nothing until it's done.
    pub fn loading(mut self, loading: bool) -> Self {
        self.loading = loading;
        self
    }

    /// On, for buttons that toggle (a segment that's chosen, a filter that's applied).
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub fn full_width(mut self) -> Self {
        self.full_width = true;
        self
    }

    pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
        self.tooltip = Some(text.into());
        self
    }

    /// Shows the button as if hovered, pressed or focused (for the gallery and tests).
    pub fn shown(mut self, state: ShownState) -> Self {
        self.shown = Some(state);
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(handler));
        self
    }
}

struct Look {
    fill: Option<Hsla>,
    hover: Hsla,
    pressed: Hsla,
    text: Hsla,
    border: Option<Hsla>,
}

impl RenderOnce for Button {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme();
        let c = &theme.colors;
        let look = match self.style {
            ButtonStyle::Primary => Look {
                fill: Some(c.primary),
                hover: c.primary_hover,
                pressed: c.primary_pressed,
                text: c.text_on_primary,
                border: None,
            },
            ButtonStyle::Accent => Look {
                fill: Some(c.accent),
                hover: c.accent_hover,
                pressed: c.accent_pressed,
                text: c.text_on_accent,
                border: None,
            },
            ButtonStyle::Secondary => Look {
                fill: Some(if self.selected { c.selected } else { c.surface }),
                hover: c.hover,
                pressed: c.pressed,
                text: c.text,
                border: Some(c.border_strong),
            },
            ButtonStyle::Ghost => Look {
                fill: self.selected.then_some(c.selected),
                hover: c.hover,
                pressed: c.pressed,
                text: if self.selected || self.label.is_some() { c.text } else { c.text_muted },
                border: None,
            },
        };
        let washes = matches!(self.style, ButtonStyle::Secondary | ButtonStyle::Ghost);
        let height = self.size.height();
        let rounding = if self.pill { radius::PILL } else { radius::NAV };
        let ring = c.focus_ring;
        let accent = c.accent;
        let gap = c.surface;
        let faint = c.text_faint;
        let keycap_border = if matches!(self.style, ButtonStyle::Primary | ButtonStyle::Accent) {
            look.text.opacity(0.35)
        } else {
            c.border_strong
        };
        let icon_color = look.text;
        let disabled = self.disabled;

        // Found by its id in tests (`debug_bounds`).
        let selector = self.id.to_string();
        let mut button = div()
            .id(self.id)
            .debug_selector(move || selector)
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .gap(space::S1_5)
            .h(height)
            .rounded(rounding)
            .text_ui(self.size.type_size())
            .medium()
            .text_color(look.text)
            .whitespace_nowrap();

        if self.square {
            button = button.w(height);
        } else {
            button = button.px(self.size.padding(self.pill));
        }
        if self.full_width {
            button = button.w_full();
        }
        if let Some(fill) = look.fill {
            button = button.bg(fill);
        }
        // Every button has a 1 px edge, transparent unless it's outlined, so the focus ring can
        // take it over without moving anything.
        button = button
            .border_1()
            .border_color(look.border.unwrap_or(gpui::transparent_black()));

        // Washes sit on top of the fill for outlined and ghost buttons; filled buttons change
        // their fill instead.
        let pressed_fill = if washes { look.fill.map_or(look.pressed, |f| blend(f, look.pressed)) } else { look.pressed };
        let hover_fill = if washes { look.fill.map_or(look.hover, |f| blend(f, look.hover)) } else { look.hover };

        let filled = look.fill.is_some();
        if disabled {
            button = button.opacity(0.4).cursor_default();
        } else if self.loading {
            button = button.cursor_default();
        } else {
            match self.shown {
                Some(ShownState::Hovered) => button = button.bg(hover_fill),
                Some(ShownState::Pressed) => button = button.bg(pressed_fill),
                Some(ShownState::Focused) => {
                    button = focus_style(button, accent, ring, gap, look.fill.is_some(), hover_fill)
                }
                None => {}
            }
            button = button
                .cursor_pointer()
                .tab_index(0)
                .hover(move |s| s.bg(hover_fill))
                .active(move |s| s.bg(pressed_fill))
                .focus_visible(move |s| focus_style(s, accent, ring, gap, filled, hover_fill));
            if let Some(handler) = self.on_click {
                button = button.on_click(move |event, window, cx| handler(event, window, cx));
            }
        }
        if let Some(text) = self.tooltip {
            button = button.tooltip(move |_window, cx| crate::menu::Tooltip::new(text.clone()).build(cx));
        }

        let size = IconSize::Nav;
        let leading = if self.loading {
            Some(crate::small::spinner("loading", size, icon_color).into_any_element())
        } else {
            self.icon.map(|i| Icon::new(i).size(size).color(icon_color).into_any_element())
        };
        button
            .children(leading)
            .children(self.label)
            .children(self.icon_after.map(|i| Icon::new(i).size(size).color(icon_color)))
            .children(self.shortcut.map(|keys| keycap(keys, keycap_border, if disabled { faint } else { icon_color }).into_any_element()))
    }
}

/// A small keycap, like the Return hint on a dialog's main button.
pub fn keycap(keys: SharedString, border: Hsla, color: Hsla) -> impl IntoElement {
    div()
        .flex()
        .items_center()
        .justify_center()
        .min_w(px(18.))
        .h(px(18.))
        .px(space::S1)
        .rounded(radius::SMALL)
        .border_1()
        .border_color(border)
        .text_ui(TypeSize::Caption)
        .regular()
        .text_color(color)
        .child(keys)
}

/// The keyboard focus ring: a 2 px halo outside the edge, so it never moves the layout.
pub fn focus_ring(color: Hsla) -> Vec<gpui::BoxShadow> {
    vec![gpui::BoxShadow {
        color,
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(2.),
        inset: false,
    }]
}

/// How a focused button looks. A filled button gets a ring set off by a 2 px gap, so it shows
/// even on an accent fill; a ghost button (which would show a halo through itself) gets an
/// accent edge and the hover wash.
fn focus_style<S: Styled>(style: S, accent: Hsla, ring: Hsla, gap: Hsla, filled: bool, hover_fill: Hsla) -> S {
    if filled {
        style.shadow(offset_focus_ring(gap, ring))
    } else {
        style.border_color(accent).bg(hover_fill)
    }
}

/// A focus ring 2 px out from the edge, with the surface colour in between.
pub fn offset_focus_ring(gap: Hsla, ring: Hsla) -> Vec<gpui::BoxShadow> {
    let spread = |px_: f32, color| gpui::BoxShadow {
        color,
        offset: gpui::point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(px_),
        inset: false,
    };
    // Shadows paint in order, so the gap goes on top of the wider ring.
    vec![spread(4., ring), spread(2., gap)]
}

/// Lays a translucent wash over an opaque fill.
fn blend(base: Hsla, wash: Hsla) -> Hsla {
    base.blend(wash)
}

