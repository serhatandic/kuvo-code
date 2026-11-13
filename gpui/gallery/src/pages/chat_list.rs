use std::time::Duration;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, IntoElement, ParentElement, Render,
    SharedString, Styled, Task, Window, div, px, relative,
};
use kuvo_ui::{
    ActiveTheme, Button, IconName, StyledType, TypeSize,
    chat_list::{ChatListState, chat_list},
    theme::{radius, space},
};

use crate::{Gallery, page as frame, section};

#[derive(Clone)]
pub enum Message {
    User(SharedString),
    Agent(String),
    Status(SharedString),
}

/// A conversation, with a reply that can stream into it.
pub struct Conversation {
    pub messages: Vec<Message>,
    pub list: ChatListState,
    stream: Option<Task<()>>,
}

const REPLY: &str = "I found it. The form clears every field when the server says the email is taken, because the error path calls reset() before showing the message. I moved the reset into the success path only, so a taken email now keeps what was typed and shows the error under the email field. I added a test that signs up twice with the same address and checks the name and password are still there. Both test suites pass.";

pub fn sample() -> Vec<Message> {
    vec![
        Message::User("Users say the sign-up form gets completely wiped if the email is already taken. Can you look?".into()),
        Message::Status("Worked for 12s".into()),
        Message::Agent("Looking at the sign-up flow now. The form lives in web/src/signup/Form.tsx and posts to /api/accounts; the server answers 409 when the email exists.".into()),
        Message::User("Keep what they typed, and tell them which field is wrong.".into()),
        Message::Status("Worked for 25s · 2 files changed".into()),
        Message::Agent(REPLY.to_string()),
    ]
}

impl Conversation {
    pub fn new(messages: Vec<Message>, cx: &mut Context<Self>) -> Self {
        let list = ChatListState::new(messages.len(), cx);
        Self { messages, list, stream: None }
    }

    /// Streams a new reply in, a few words at a time.
    pub fn stream_reply(&mut self, cx: &mut Context<Self>) {
        self.messages.push(Message::User("Can you also check the other forms?".into()));
        self.messages.push(Message::Agent(String::new()));
        self.list.push(2);
        cx.notify();
        let words: Vec<&'static str> = "Checked the other five forms. Settings, invite and billing had the same reset-before-error pattern; I fixed those the same way and added a test each. The contact and feedback forms were already fine. Nothing else in web/src calls reset() on an error path.".split(' ').collect();
        self.stream = Some(cx.spawn(async move |this, cx| {
            for word in words {
                cx.background_executor().timer(Duration::from_millis(60)).await;
                let still_here = this.update(cx, |this, cx| {
                    let last = this.messages.len() - 1;
                    if let Message::Agent(text) = &mut this.messages[last] {
                        if !text.is_empty() {
                            text.push(' ');
                        }
                        text.push_str(word);
                    }
                    this.list.changed(last);
                    cx.notify();
                });
                if still_here.is_err() {
                    return;
                }
            }
        }));
    }

    /// Adds a finished exchange at once (for the shot of a reader who scrolled away).
    pub fn add_exchange(&mut self, cx: &mut Context<Self>) {
        self.messages.push(Message::User("Can you also check the other forms?".into()));
        self.messages.push(Message::Agent("Checking settings, invite and billing next.".into()));
        self.list.push(2);
        cx.notify();
    }
}

fn message(message: &Message, cx: &App) -> AnyElement {
    let c = &cx.theme().colors;
    let body = match message {
        Message::User(text) => div().flex().justify_end().child(
            div()
                .max_w(relative(0.78))
                .px(space::S4)
                .py(px(10.)) // between the 8 and 12 steps, so one line sits centred
                .rounded(radius::CARD)
                .bg(c.sunken)
                .text_ui(TypeSize::Body)
                .text_color(c.text)
                .child(text.clone()),
        ),
        Message::Agent(text) => div().text_ui(TypeSize::Body).text_color(c.text).child(text.clone()),
        Message::Status(text) => div()
            .flex()
            .justify_center()
            .text_ui(TypeSize::Caption)
            .text_color(c.text_faint)
            .child(text.clone()),
    };
    // Each message is centred in a readable column and spaced from the next.
    div()
        .w_full()
        .flex()
        .justify_center()
        .px(space::S6)
        .pb(space::S5)
        .child(div().w_full().max_w(px(640.)).child(body))
        .into_any_element()
}

impl Render for Conversation {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = cx.entity();
        div().size_full().child(chat_list(&self.list, move |ix, _, cx| {
            let m = view.read(cx).messages[ix].clone();
            message(&m, cx)
        }))
    }
}


pub struct Chats {
    pub following: Entity<Conversation>,
    pub scrolled: Entity<Conversation>,
}

impl Chats {
    pub fn new(cx: &mut Context<Gallery>) -> Self {
        Self {
            following: cx.new(|cx| Conversation::new(sample(), cx)),
            scrolled: cx.new(|cx| Conversation::new(sample(), cx)),
        }
    }
}

pub fn page(chats: &Chats, _window: &mut Window, cx: &mut Context<Gallery>) -> AnyElement {
    let theme = cx.theme();
    let c = &theme.colors;
    let pane = |title: &'static str, convo: &Entity<Conversation>| {
        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap(space::S2)
            .child(div().text_ui(TypeSize::Caption).text_color(c.text_faint).child(title))
            .child(
                div()
                    .relative()
                    .h(px(520.))
                    .rounded(radius::CARD)
                    .overflow_hidden()
                    .bg(c.surface)
                    .border_1()
                    .border_color(c.border)
                    .child(div().absolute().top_0().left_0().size_full().child(convo.clone())),
            )
    };
    let following = chats.following.clone();
    let scrolled = chats.scrolled.clone();
    frame(
        "Chat list",
        "Newest at the bottom. It follows a reply while it streams, keeps your place when you scroll back, and offers a way back to the latest.",
        vec![
            section(
                "Two readers of the same conversation",
                div()
                    .flex()
                    .flex_col()
                    .gap(space::S4)
                    .child(
                        div()
                            .flex()
                            .gap(space::S5)
                            .child(pane("At the bottom: follows the reply as it arrives", &chats.following))
                            .child(pane("Scrolled back: stays put, and offers the way back", &chats.scrolled)),
                    )
                    .child(
                        div().flex().gap(space::S2).child(
                            Button::new("stream", "Stream a reply into both")
                                .icon(IconName::Sparkle)
                                .on_click(move |_, _, cx| {
                                    following.update(cx, |c, cx| c.stream_reply(cx));
                                    scrolled.update(cx, |c, cx| c.stream_reply(cx));
                                }),
                        ),
                    ),
                cx,
            ),
        ],
        cx,
    )
}
