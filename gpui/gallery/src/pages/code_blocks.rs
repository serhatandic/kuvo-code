use gpui::{AnyElement, App, Context, IntoElement, ParentElement, Styled, Window, div};
use kuvo_ui::{ActiveTheme, StyledType, TypeSize, code_block::CodeBlock, theme::space};

use crate::{Gallery, page as frame, section};

const RUST: &str = r#"/// Keeps what the person typed when sign-up fails.
pub fn on_error(form: &mut Form, error: ApiError) -> Result<(), Error> {
    if error.status == 409 {
        form.field("email").set_error("This email already has an account");
        return Ok(()); // nothing is reset
    }
    let retries = 3;
    Err(Error::Network { retries, message: error.message.clone() })
}"#;

const TS: &str = r#"export async function signUp(form: SignUpForm): Promise<Result> {
  const response = await api.post("/accounts", form.values());
  if (response.status === 409) {
    form.setError("email", "This email already has an account");
    return { ok: false };
  }
  form.reset();
  return { ok: true, id: response.body.id };
}"#;

const JSON: &str = r#"{
  "name": "research-bot",
  "model": "claude-opus-5-5",
  "schedule": { "every": "1d", "at": "07:00" },
  "allowed": ["browse", "files"],
  "budget": 12.5
}"#;

const PYTHON: &str = r#"def summarize(sessions, limit=5):
    """The longest-running sessions first."""
    ranked = sorted(sessions, key=lambda s: s.duration, reverse=True)
    return [s.title for s in ranked[:limit]]"#;

pub fn page(_window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    frame(
        "Code blocks",
        "Highlighted with tree-sitter's grammars in the theme's syntax colours. Line numbers where they help, Copy on every block, and long lines scroll rather than wrap.",
        vec![
            section("With line numbers (a file, a diff)", numbered(cx), cx),
            section("In a message: no numbers; the Copy button after a click", in_messages(cx), cx),
        ],
        cx,
    )
}

fn numbered(_cx: &App) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(space::S4)
        .child(CodeBlock::new("cb-rust", RUST).language("rust").line_numbers(true))
        .child(CodeBlock::new("cb-ts", TS).language("typescript").line_numbers(true))
}

fn in_messages(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .gap(space::S4)
        .items_start()
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .gap(space::S3)
                .child(CodeBlock::new("cb-json", JSON).language("json").shown_copied())
                .child(CodeBlock::new("cb-sh", "bun test web/src/signup --watch").language("bash")),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .flex_1()
                .min_w_0()
                .gap(space::S3)
                .child(CodeBlock::new("cb-py", PYTHON).language("python"))
                .child(
                    div()
                        .text_ui(TypeSize::Caption)
                        .text_color(c.text_faint)
                        .child("Unknown languages are shown plain:"),
                )
                .child(CodeBlock::new("cb-plain", "Error: listen EADDRINUSE: address already in use :::4096").language("log")),
        )
}
