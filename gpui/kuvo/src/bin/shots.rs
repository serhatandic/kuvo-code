//! Renders Kuvo's screens offscreen against the stand-in box, in light and dark, to
//! `gpui/shots/screens-<screen>-{light,dark}.png`. No window opens, nothing real is reached.
//!
//! `cargo run -p kuvo --features shots --bin shots [-- <screen>...]`

use std::{path::PathBuf, sync::Arc};

use gpui::{AppContext as _, Focusable as _, HeadlessAppContext, px, size};
use kuvo::stand_in::{Replies, StandIn};
use kuvo::{Workspace, bind_keys};
use kuvo_box::BoxClient;
use kuvo_ui::{Appearance, Assets, Theme};

/// The moment the stand-in's sessions are seen at, so the times read the same in every shot.
const NOW: f64 = 1_794_650_000_000.0;

struct Screen {
    slug: &'static str,
    width: f32,
    height: f32,
    /// The session open (none: the landing view).
    session: Option<&'static str>,
    /// What's typed in the composer.
    typed: Option<&'static str>,
    empty: bool,
    /// Tool steps opened (a step's id, and which of its blocks), and outputs shown whole.
    opens: &'static [(&'static str, usize)],
    /// What's typed in the sidebar's search, and how many rows the keyboard walks down.
    search: Option<&'static str>,
    walks: usize,
    /// Files attached in the composer (from `gpui/`).
    attach: &'static [&'static str],
}

const SCREENS: &[Screen] = &[
    Screen { slug: "conversation", width: 1280., height: 820., session: Some("ses_signup"), typed: None, empty: false, opens: &[], search: None, walks: 0, attach: &[] },
    Screen { slug: "landing", width: 1280., height: 820., session: None, typed: None, empty: false, opens: &[], search: None, walks: 0, attach: &[] },
    Screen { slug: "asking", width: 1280., height: 820., session: Some("ses_limits"), typed: None, empty: false, opens: &[], search: None, walks: 0, attach: &[] },
    Screen { slug: "question", width: 1280., height: 820., session: Some("ses_cms"), typed: None, empty: false, opens: &[], search: None, walks: 0, attach: &[] },
    Screen { slug: "slash", width: 1280., height: 820., session: Some("ses_recipes"), typed: Some("/"), empty: false, opens: &[], search: None, walks: 0, attach: &[] },
    Screen { slug: "narrow", width: 860., height: 760., session: Some("ses_signup"), typed: None, empty: false, opens: &[], search: None, walks: 0, attach: &[] },
    Screen { slug: "steps", width: 1280., height: 900., session: Some("ses_signup"), typed: None, empty: false, opens: &[("msg_s2", 2), ("msg_s5", 0), ("msg_s5", 1)], search: None, walks: 0, attach: &[] },
    Screen { slug: "search", width: 1280., height: 820., session: Some("ses_limits"), typed: None, empty: false, opens: &[], search: Some("redis"), walks: 1, attach: &[] },
    Screen { slug: "walking", width: 1280., height: 820., session: Some("ses_limits"), typed: None, empty: false, opens: &[], search: None, walks: 3, attach: &[] },
    Screen { slug: "attached", width: 1280., height: 820., session: Some("ses_dark"), typed: Some("This is how the settings look in dark mode now: the cards blend into the page."), empty: false, opens: &[], search: None, walks: 0, attach: &["shots/theme-dark.png", "kuvo_ui/src/theme.rs"] },
    Screen { slug: "empty", width: 1280., height: 820., session: None, typed: None, empty: true, opens: &[], search: None, walks: 0, attach: &[] },
];

fn main() -> anyhow::Result<()> {
    let only: Vec<String> = std::env::args().skip(1).collect();
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../shots");
    std::fs::create_dir_all(&out)?;
    let text_system = gpui_platform::current_platform(true).text_system();
    let mut cx = HeadlessAppContext::with_platform(text_system, Arc::new(Assets), gpui_platform::current_headless_renderer);
    cx.update(|cx| {
        Theme::init(Appearance::Light, cx);
        bind_keys(cx);
    });
    for screen in SCREENS {
        if !only.is_empty() && !only.iter().any(|slug| slug == screen.slug) {
            continue;
        }
        for appearance in [Appearance::Light, Appearance::Dark] {
            cx.update(|cx| Theme::set_appearance(appearance, cx));
            let stand_in = if screen.empty { StandIn::empty(Replies::Never) } else { StandIn::at(Replies::Never, NOW) };
            // The rate limits' conversation waits on a permission; another one waits behind it.
            let mut second = kuvo::stand_in::redis_permission();
            second["id"] = serde_json::json!("per_push");
            stand_in.set_asks("ses_limits", vec![kuvo::stand_in::redis_permission(), second]);
            let client = BoxClient::new(stand_in);
            let window = cx.open_window(size(px(screen.width), px(screen.height)), |window, cx| cx.new(|cx| Workspace::new(client, false, window, cx)))?;
            let any = window.into();
            cx.update_window(any, |root, window, cx| {
                let workspace = root.downcast::<Workspace>().expect("the workspace");
                workspace.update(cx, |workspace, cx| {
                    workspace.set_now(NOW);
                    workspace.read_at_once(cx);
                    if let Some(session) = screen.session {
                        workspace.open_read_at_once(session, window, cx);
                    }
                    if let Some(view) = workspace.conversation() {
                        for (step, n) in screen.opens {
                            view.update(cx, |view, cx| view.toggle(kuvo::entries::Fold::Step((*step).to_owned(), *n), cx));
                        }
                    }
                    let composer = match workspace.conversation() {
                        Some(view) => view.read(cx).composer().clone(),
                        None => workspace.landing().clone(),
                    };
                    let field = composer.read(cx).field().clone();
                    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
                    composer.update(cx, |composer, cx| composer.attach(screen.attach.iter().map(|path| root.join(path)), cx));
                    if let Some(typed) = screen.typed {
                        field.update(cx, |field, cx| field.set_text(typed, cx));
                    }
                    window.focus(&field.focus_handle(cx), cx);
                    if let Some(search) = screen.search {
                        workspace.search().clone().update(cx, |field, cx| field.set_text(search, cx));
                        workspace.focus_search(window, cx);
                    }
                });
            })?;
            cx.run_until_parked();
            // (After the search's change has come through, which leaves the list.)
            cx.update_window(any, |root, window, cx| {
                let workspace = root.downcast::<Workspace>().expect("the workspace");
                workspace.update(cx, |workspace, cx| {
                    for _ in 0..screen.walks {
                        workspace.walk(1, window, cx);
                    }
                });
            })?;
            cx.run_until_parked();
            cx.update_window(any, |_, window, _| window.refresh())?;
            cx.run_until_parked();
            let image = cx.capture_screenshot(any)?;
            let name = format!("screens-{}-{}.png", screen.slug, if appearance.is_dark() { "dark" } else { "light" });
            image.save(out.join(&name))?;
            println!("{name}: {}x{}", image.width(), image.height());
            cx.update_window(any, |_, window, _| window.remove_window())?;
            cx.run_until_parked();
        }
    }
    Ok(())
}
