//! A code block's Copy button puts the code on the clipboard, as written.

use gpui::{
    Context, IntoElement, Modifiers, ParentElement, Render, Styled, TestAppContext, Window, div,
    point, px, size,
};
use kuvo_ui::{Appearance, Theme, code_block::CodeBlock};

const CODE: &str = "fn keep(name: &str) -> String {\n    name.to_string()\n}\n";

struct Host;

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().w(px(500.)).child(CodeBlock::new("snippet", CODE).language("rust"))
    }
}

#[gpui::test]
fn copy_puts_the_code_on_the_clipboard(cx: &mut TestAppContext) {
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        kuvo_ui::bind_keys(cx);
    });
    let (_, cx) = cx.add_window_view(|_, _| Host);
    cx.simulate_resize(size(px(600.), px(300.)));
    cx.run_until_parked();

    // The Copy button sits at the right end of the 32 px header.
    cx.simulate_click(point(px(470.), px(16.)), Modifiers::default());
    // The trailing newline of a fenced block isn't part of the code.
    assert_eq!(cx.read_from_clipboard().and_then(|c| c.text()).as_deref(), Some(CODE.trim_end()));
}
