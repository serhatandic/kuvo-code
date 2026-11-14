//! Icons: Kuvo's own line icons, drawn on a 16-unit grid, in two sizes.
//!
//! The SVGs live in `gpui/assets/icons` and are compiled into the binary, so an icon can never
//! go missing at run time. GPUI draws an SVG as a mask, so an icon takes the colour it's given.

use std::borrow::Cow;

use gpui::{AssetSource, Hsla, IntoElement, Pixels, RenderOnce, SharedString, Styled, Window, px, svg};

/// The two sizes icons come in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IconSize {
    /// 14 px: navigation, rows, buttons, menus.
    #[default]
    Nav,
    /// 20 px: cards and empty states.
    Card,
}

impl IconSize {
    pub fn pixels(self) -> Pixels {
        match self {
            Self::Nav => px(14.),
            Self::Card => px(20.),
        }
    }
}

macro_rules! icons {
    ($($variant:ident => $file:literal,)*) => {
        /// Every icon Kuvo has.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum IconName { $($variant,)* }

        impl IconName {
            pub const ALL: &'static [IconName] = &[$(IconName::$variant,)*];

            /// The icon's name, as its file is called.
            pub fn name(self) -> &'static str {
                match self { $(IconName::$variant => $file,)* }
            }

            /// The asset path GPUI loads it from.
            pub fn path(self) -> &'static str {
                match self { $(IconName::$variant => concat!("icons/", $file, ".svg"),)* }
            }

            fn bytes(self) -> &'static [u8] {
                match self {
                    $(IconName::$variant => include_bytes!(concat!("../../assets/icons/", $file, ".svg")),)*
                }
            }
        }
    };
}

icons! {
    ArrowDown => "arrow-down",
    ArrowLeft => "arrow-left",
    ArrowRight => "arrow-right",
    ArrowUp => "arrow-up",
    Bell => "bell",
    Bot => "bot",
    Branch => "branch",
    Check => "check",
    ChevronDown => "chevron-down",
    ChevronLeft => "chevron-left",
    ChevronRight => "chevron-right",
    ChevronUp => "chevron-up",
    Clock => "clock",
    Close => "close",
    Compose => "compose",
    Computer => "computer",
    Copy => "copy",
    External => "external",
    File => "file",
    Folder => "folder",
    Globe => "globe",
    Image => "image",
    Info => "info",
    Link => "link",
    Message => "message",
    Mic => "mic",
    Minus => "minus",
    Moon => "moon",
    More => "more",
    PanelRight => "panel-right",
    Paperclip => "paperclip",
    Pencil => "pencil",
    Pin => "pin",
    Plus => "plus",
    Question => "question",
    Queue => "queue",
    Return => "return",
    Search => "search",
    Settings => "settings",
    Shield => "shield",
    Sidebar => "sidebar",
    Sliders => "sliders",
    Sparkle => "sparkle",
    Spinner => "spinner",
    Stop => "stop",
    Sun => "sun",
    Terminal => "terminal",
    Trash => "trash",
    Undo => "undo",
    User => "user",
    Warning => "warning",
}

/// The services' marks, by the box's `service` id (a plan's limits): OpenUsage's provider icons
/// (MIT), as Kuvo Code ships them (`gpui/LICENSES-DEPS.md`). One colour each, drawn as a mask.
const MARKS: &[(&str, &str, &[u8])] = &[
    ("antigravity", "marks/antigravity.svg", include_bytes!("../../assets/marks/antigravity.svg")),
    ("claude", "marks/claude.svg", include_bytes!("../../assets/marks/claude.svg")),
    ("codex", "marks/codex.svg", include_bytes!("../../assets/marks/codex.svg")),
    ("copilot", "marks/copilot.svg", include_bytes!("../../assets/marks/copilot.svg")),
    ("cursor", "marks/cursor.svg", include_bytes!("../../assets/marks/cursor.svg")),
    ("grok", "marks/grok.svg", include_bytes!("../../assets/marks/grok.svg")),
    ("ollama", "marks/ollama.svg", include_bytes!("../../assets/marks/ollama.svg")),
    ("opencode", "marks/opencode.svg", include_bytes!("../../assets/marks/opencode.svg")),
    ("openrouter", "marks/openrouter.svg", include_bytes!("../../assets/marks/openrouter.svg")),
    ("zai", "marks/zai.svg", include_bytes!("../../assets/marks/zai.svg")),
];

/// The asset path of `service`'s mark, if Kuvo has one (a service a newer box names may not).
pub fn mark_path(service: &str) -> Option<&'static str> {
    MARKS.iter().find(|(id, ..)| *id == service).map(|(_, path, _)| *path)
}

/// The assets Kuvo's blocks need: hand this to `Application::with_assets`.
pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        if let Some((_, _, bytes)) = MARKS.iter().find(|(_, mark, _)| *mark == path) {
            return Ok(Some(Cow::Borrowed(bytes)));
        }
        Ok(IconName::ALL
            .iter()
            .find(|icon| icon.path() == path)
            .map(|icon| Cow::Borrowed(icon.bytes())))
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(IconName::ALL
            .iter()
            .map(|icon| icon.path())
            .chain(MARKS.iter().map(|(_, mark, _)| *mark))
            .filter(|p| p.starts_with(path))
            .map(SharedString::from)
            .collect())
    }
}

/// An icon, tinted with the colour it's given (the muted text colour unless told otherwise).
#[derive(IntoElement)]
pub struct Icon {
    name: IconName,
    size: IconSize,
    color: Option<Hsla>,
}

impl Icon {
    pub fn new(name: IconName) -> Self {
        Self { name, size: IconSize::Nav, color: None }
    }

    pub fn size(mut self, size: IconSize) -> Self {
        self.size = size;
        self
    }

    pub fn color(mut self, color: Hsla) -> Self {
        self.color = Some(color);
        self
    }
}

impl RenderOnce for Icon {
    fn render(self, _window: &mut Window, cx: &mut gpui::App) -> impl IntoElement {
        use crate::theme::ActiveTheme;
        let color = self.color.unwrap_or(cx.theme().colors.text_muted);
        svg()
            .path(self.name.path())
            .size(self.size.pixels())
            .flex_none()
            .text_color(color)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every icon loads through the asset source the app is given, and is an SVG GPUI can read.
    #[test]
    fn every_icon_loads_as_an_svg() {
        for icon in IconName::ALL {
            let bytes = Assets.load(icon.path()).unwrap().unwrap_or_else(|| panic!("{}", icon.name()));
            let text = std::str::from_utf8(&bytes).unwrap();
            assert!(text.starts_with("<svg") && text.contains("viewBox=\"0 0 16 16\""));
        }
        assert!(Assets.load("icons/nope.svg").unwrap().is_none());
    }

    /// Every service the box reads limits of has its mark, and it loads as an SVG.
    #[test]
    fn every_service_has_a_mark() {
        for service in ["claude", "codex", "grok", "cursor", "antigravity", "copilot", "openrouter", "zai", "ollama", "opencode"] {
            let path = mark_path(service).unwrap_or_else(|| panic!("{service}"));
            let bytes = Assets.load(path).unwrap().unwrap();
            assert!(std::str::from_utf8(&bytes).unwrap().starts_with("<svg"));
        }
        assert_eq!(mark_path("newer"), None);
    }
}
