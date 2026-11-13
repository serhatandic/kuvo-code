use gpui::{AnyElement, App, Context, IntoElement, ParentElement, Styled, Window, div, px};
use kuvo_ui::{ActiveTheme, markdown::Markdown, theme::space};

use crate::{Gallery, page as frame, section};

const REPLY: &str = r#"# Sign-up form fix

## What changed

The sign-up form kept failing on a **taken email** because the error path called `reset()` before it showed the message. Everything the person typed was gone by the time they read it.

1. The reset now runs only after a successful sign-up.
2. A `409` from `/api/accounts` puts the error under the email field.
3. The other forms had the same pattern:
   - settings and invite are fixed the same way;
   - billing needs a look from someone who knows the payment flow.

> The contact and feedback forms were already fine: they never reset on error.

See the [pull request](https://github.com) for the diff, or run the tests yourself:

```bash
bun test web/src/signup
```
"#;

const PLAN: &str = r#"### Plan

- [x] Reproduce with a taken address
- [x] Keep the fields on error
- [ ] Ask about billing's flow
- [ ] ~~Rewrite the form~~ (not needed)

| File | Change |
|---|---|
| `web/src/signup/Form.tsx` | +17 −35 |
| `web/src/signup/Form.test.tsx` | +42 |
| `web/src/settings/Profile.tsx` | +6 −9 |

---

_Worked for 38s._ Everything above is ready for review."#;

pub fn page(_window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    frame(
        "Markdown",
        "Agents answer in markdown: headings, emphasis, inline code, links, lists with tasks, quotes, tables and code, set in Kuvo's type.",
        vec![section("An agent's reply, at chat width", body(cx), cx)],
        cx,
    )
}

fn body(cx: &App) -> impl IntoElement {
    let c = &cx.theme().colors;
    div()
        .flex()
        .gap(space::S8)
        .items_start()
        .child(div().flex_1().min_w_0().child(Markdown::new("md-reply", REPLY)))
        .child(div().w(px(1.)).self_stretch().bg(c.border))
        .child(div().flex_1().min_w_0().child(Markdown::new("md-plan", PLAN)))
}
