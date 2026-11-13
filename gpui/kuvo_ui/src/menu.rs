//! Menus and popovers: tooltips, dropdown menus, context menus and hover cards.

use gpui::{
    AnyView, App, AppContext, Context, IntoElement, ParentElement, Render, SharedString, Styled,
    Window, div, px,
};

use crate::theme::{ActiveTheme, StyledType, TypeSize, radius, space};

/// A tooltip: a short label in a small dark capsule, shown after the pointer rests.
pub struct Tooltip {
    text: SharedString,
}

impl Tooltip {
    pub fn new(text: impl Into<SharedString>) -> Self {
        Self { text: text.into() }
    }

    pub fn build(self, cx: &mut App) -> AnyView {
        cx.new(|_| self).into()
    }
}

impl Render for Tooltip {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div().pl(px(4.)).pt(px(6.)).child(
            div()
                .px(space::S2)
                .py(space::S1)
                .rounded(radius::NAV)
                .bg(theme.colors.elevated)
                .border_1()
                .border_color(theme.colors.border)
                .shadow(theme.elevated_shadow())
                .text_ui(TypeSize::Caption)
                .text_color(theme.colors.text)
                .child(self.text.clone()),
        )
    }
}
