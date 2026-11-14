//! Kuvo's theme: the type scale, the colours for light and dark, radii and spacing.
//!
//! Every block reads its look from here and nowhere else, so changing a token changes every
//! screen. The rules come from the design brief:
//!
//! - SF Pro (the system font) in regular and medium only;
//! - four sizes of type: 12, 13, 14 and 24 px;
//! - three levels of text: #292929, #5D5D5D and #9E9E9E in light, and their dark equivalents;
//! - icons at 14 px for navigation and 20 px for cards (see [`crate::icon`]);
//! - radii of 8 px for navigation, 16 px for cards, and pills for calls to action.

use gpui::{
    App, BoxShadow, FontWeight, Global, Hsla, Pixels, Styled, Window, WindowAppearance, hsla,
    point, px, rgb, rgba,
};

/// Light or dark.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Appearance {
    #[default]
    Light,
    Dark,
}

impl Appearance {
    /// The appearance the system asks for in this window.
    pub fn of(window: &Window) -> Self {
        match window.appearance() {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Self::Dark,
            WindowAppearance::Light | WindowAppearance::VibrantLight => Self::Light,
        }
    }

    pub fn is_dark(self) -> bool {
        self == Self::Dark
    }

    pub fn toggled(self) -> Self {
        match self {
            Self::Light => Self::Dark,
            Self::Dark => Self::Light,
        }
    }
}

/// The four sizes type comes in. Nothing else is allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypeSize {
    /// 12 px: captions, badges, timestamps, section labels.
    Caption,
    /// 13 px: the body of dense UI: rows, menus, buttons, chat text.
    Small,
    /// 14 px: the body of reading text and fields.
    Body,
    /// 24 px: page and card titles.
    Title,
}

impl TypeSize {
    pub fn size(self) -> Pixels {
        match self {
            Self::Caption => px(12.),
            Self::Small => px(13.),
            Self::Body => px(14.),
            Self::Title => px(24.),
        }
    }

    /// The line height that goes with the size: roughly 1.35 for text sizes, 1.25 for titles.
    pub fn line_height(self) -> Pixels {
        match self {
            Self::Caption => px(16.),
            Self::Small => px(18.),
            Self::Body => px(20.),
            Self::Title => px(30.),
        }
    }
}

/// The two weights type comes in.
pub const REGULAR: FontWeight = FontWeight::NORMAL;
/// Medium. On macOS GPUI reads SF's Medium instance as about 520 rather than 500, and CSS
/// matching sends a request for 500 down to Regular; asking for 520 lands on Medium.
#[cfg(target_os = "macos")]
pub const MEDIUM: FontWeight = FontWeight(520.);
#[cfg(not(target_os = "macos"))]
pub const MEDIUM: FontWeight = FontWeight::MEDIUM;

/// The font families. `.SystemUIFont` is SF Pro on macOS and the system's UI font elsewhere.
pub const UI_FONT: &str = ".SystemUIFont";
/// Monospaced text: SF Mono on macOS, the system's monospace elsewhere.
#[cfg(target_os = "macos")]
pub const MONO_FONT: &str = ".AppleSystemUIFontMonospaced";
#[cfg(not(target_os = "macos"))]
pub const MONO_FONT: &str = "monospace";

/// The letter spacing the brief asks for. GPUI has no tracking control yet, so this is
/// recorded here and not applied; see `notes/theme.md`.
pub const LETTER_SPACING: Pixels = px(-0.15);

/// Corner radii.
pub mod radius {
    use gpui::{Pixels, px};
    /// Small things: chips, keycaps, checkboxes.
    pub const SMALL: Pixels = px(6.);
    /// Navigation: sidebar rows, menu items, plain buttons, fields.
    pub const NAV: Pixels = px(8.);
    /// Menus and popovers: a row's 8 plus the menu's 4 px padding, so the corners nest.
    /// (An addition to the brief's three radii, for the user to confirm.)
    pub const POPOVER: Pixels = px(12.);
    /// Cards, hover cards, code blocks, the composer.
    pub const CARD: Pixels = px(16.);
    /// Calls to action, switches, badges and avatars: fully rounded.
    pub const PILL: Pixels = px(999.);
}

/// Spacing, on a 4 px grid (with 2 and 6 for the tight spots).
pub mod space {
    use gpui::{Pixels, px};
    pub const S0_5: Pixels = px(2.);
    pub const S1: Pixels = px(4.);
    pub const S1_5: Pixels = px(6.);
    pub const S2: Pixels = px(8.);
    pub const S3: Pixels = px(12.);
    pub const S4: Pixels = px(16.);
    pub const S5: Pixels = px(20.);
    pub const S6: Pixels = px(24.);
    pub const S8: Pixels = px(32.);
    pub const S10: Pixels = px(40.);
}

/// Every colour a block may use. Blocks never write a colour literal of their own.
#[derive(Clone, Debug)]
pub struct Colors {
    /// The window behind everything: the sidebar sits straight on it.
    pub background: Hsla,
    /// The dots of the dotted backdrop.
    pub backdrop_dot: Hsla,
    /// Main content and cards.
    pub surface: Hsla,
    /// Things lifted above the content: menus, popovers, hover cards.
    pub elevated: Hsla,
    /// Wells sunk into a surface: fields, code blocks, chips, icon tiles.
    pub sunken: Hsla,

    /// The first level of text: titles, labels, what you read.
    pub text: Hsla,
    /// The second level: descriptions, secondary labels, icons at rest.
    pub text_muted: Hsla,
    /// The third level: hints, placeholders, timestamps, disabled text.
    pub text_faint: Hsla,
    /// Text on the primary (inverted) call to action.
    pub text_on_primary: Hsla,
    /// Text on the accent colour.
    pub text_on_accent: Hsla,

    /// Hairlines between and around things.
    pub border: Hsla,
    /// A stronger edge: fields and secondary buttons.
    pub border_strong: Hsla,

    /// Washes laid over a surface under the pointer, while pressed, and when selected.
    pub hover: Hsla,
    pub pressed: Hsla,
    pub selected: Hsla,

    /// The primary call to action: inverted from the surface, dark on light and light on dark.
    pub primary: Hsla,
    pub primary_hover: Hsla,
    pub primary_pressed: Hsla,

    /// The accent: focus rings, links, the text cursor, switches that are on, unread badges.
    pub accent: Hsla,
    pub accent_hover: Hsla,
    pub accent_pressed: Hsla,
    /// The accent, faint, behind selected text.
    pub selection: Hsla,
    /// The focus ring around a focused field.
    pub focus_ring: Hsla,
    /// Behind `inline code` in running text.
    pub inline_code: Hsla,

    pub success: Hsla,
    pub warning: Hsla,
    pub danger: Hsla,
    /// A destructive button (Discard, Delete): its fill under the pointer and pressed.
    pub danger_hover: Hsla,
    pub danger_pressed: Hsla,

    /// Behind a diff's added and removed lines, and their signs and counts.
    pub diff_added_wash: Hsla,
    pub diff_removed_wash: Hsla,
    pub diff_added: Hsla,
    pub diff_removed: Hsla,

    /// Fills for avatars without a picture, picked by name so a person keeps theirs.
    pub avatars: [Hsla; 6],

    /// Syntax colours for code.
    pub syntax: Syntax,
}

/// Syntax colours, chosen to sit calmly on [`Colors::sunken`].
#[derive(Clone, Debug)]
pub struct Syntax {
    pub plain: Hsla,
    pub comment: Hsla,
    pub keyword: Hsla,
    pub string: Hsla,
    pub number: Hsla,
    pub function: Hsla,
    pub type_name: Hsla,
    pub constant: Hsla,
    pub property: Hsla,
    pub punctuation: Hsla,
    pub line_number: Hsla,
}

fn hex(value: u32) -> Hsla {
    rgb(value).into()
}

fn hexa(value: u32) -> Hsla {
    rgba(value).into()
}

impl Colors {
    pub fn light() -> Self {
        Self {
            background: hex(0xF7F7F7),
            backdrop_dot: hexa(0x2929291F),
            surface: hex(0xFFFFFF),
            elevated: hex(0xFFFFFF),
            sunken: hex(0xF4F4F4),

            text: hex(0x292929),
            text_muted: hex(0x5D5D5D),
            text_faint: hex(0x9E9E9E),
            text_on_primary: hex(0xFFFFFF),
            text_on_accent: hex(0xFFFFFF),

            border: hex(0xEBEBEB),
            border_strong: hex(0xDEDEDE),

            hover: hexa(0x2929290A),
            pressed: hexa(0x2929291F),
            selected: hexa(0x2929291A),

            primary: hex(0x292929),
            primary_hover: hex(0x3B3B3B),
            primary_pressed: hex(0x1C1C1C),

            // The macOS system blue, which is also the Mac app's accent unless the user picks
            // another; the accent itself is a brand decision left to the user.
            accent: hex(0x0A7AFF),
            accent_hover: hex(0x086DE6),
            accent_pressed: hex(0x0761CC),
            selection: hexa(0x0A7AFF2E),
            focus_ring: hexa(0x0A7AFF66),
            inline_code: hex(0xF0F0F0),

            success: hex(0x2E9E5B),
            warning: hex(0xC7820E),
            danger: hex(0xD93B3B),
            danger_hover: hex(0xC43030),
            danger_pressed: hex(0xAD2828),

            diff_added_wash: hexa(0x2E9E5B1A),
            diff_removed_wash: hexa(0xD93B3B17),
            diff_added: hex(0x237A46),
            diff_removed: hex(0xB52E2E),

            avatars: [hex(0xD9E4F5), hex(0xF5E1D3), hex(0xDCEFDF), hex(0xEDDDF3), hex(0xF3E9C9), hex(0xD7ECEE)],

            syntax: Syntax {
                plain: hex(0x292929),
                comment: hex(0x858585),
                keyword: hex(0xA6366F),
                string: hex(0x2F7D4F),
                number: hex(0xB25B12),
                function: hex(0x2F5FB3),
                type_name: hex(0x7A4BB0),
                constant: hex(0xB25B12),
                property: hex(0x3D6E8C),
                punctuation: hex(0x7A7A7A),
                line_number: hex(0xA3A3A3),
            },
        }
    }

    pub fn dark() -> Self {
        Self {
            background: hex(0x0F0F0F),
            backdrop_dot: hexa(0xFFFFFF1A),
            surface: hex(0x181818),
            elevated: hex(0x242424),
            sunken: hex(0x121212),

            // The same three steps as light, mirrored: bright, mid and dim greys.
            text: hex(0xECECEC),
            text_muted: hex(0xA3A3A3),
            text_faint: hex(0x6E6E6E),
            text_on_primary: hex(0x181818),
            text_on_accent: hex(0xFFFFFF),

            border: hex(0x262626),
            border_strong: hex(0x333333),

            hover: hexa(0xFFFFFF0D),
            pressed: hexa(0xFFFFFF1F),
            selected: hexa(0xFFFFFF1A),

            primary: hex(0xECECEC),
            primary_hover: hex(0xFFFFFF),
            primary_pressed: hex(0xD4D4D4),

            accent: hex(0x2E8BFF),
            accent_hover: hex(0x4799FF),
            accent_pressed: hex(0x2479E0),
            selection: hexa(0x2E8BFF47),
            focus_ring: hexa(0x2E8BFF73),
            inline_code: hex(0x2A2A2A),

            success: hex(0x4CC27A),
            warning: hex(0xE0A43A),
            danger: hex(0xF06363),
            danger_hover: hex(0xF27878),
            danger_pressed: hex(0xDB5050),

            diff_added_wash: hexa(0x4CC27A1F),
            diff_removed_wash: hexa(0xF0636324),
            diff_added: hex(0x6FD394),
            diff_removed: hex(0xF58080),

            avatars: [hex(0x2B3A52), hex(0x4A3528), hex(0x2A4232), hex(0x3E2F4A), hex(0x463D24), hex(0x24404A)],

            syntax: Syntax {
                plain: hex(0xE3E3E3),
                comment: hex(0x858585),
                keyword: hex(0xE884B5),
                string: hex(0x8BCF9F),
                number: hex(0xF0A86B),
                function: hex(0x82AEF0),
                type_name: hex(0xC3A0F0),
                constant: hex(0xF0A86B),
                property: hex(0x8EC3DE),
                punctuation: hex(0x8C8C8C),
                line_number: hex(0x666666),
            },
        }
    }
}

/// The theme: an appearance and its colours. Kept as a GPUI global.
#[derive(Clone, Debug)]
pub struct Theme {
    pub appearance: Appearance,
    pub colors: Colors,
}

impl Global for Theme {}

impl Theme {
    pub fn new(appearance: Appearance) -> Self {
        let colors = match appearance {
            Appearance::Light => Colors::light(),
            Appearance::Dark => Colors::dark(),
        };
        Self { appearance, colors }
    }

    /// Installs the theme for the given appearance.
    pub fn init(appearance: Appearance, cx: &mut App) {
        cx.set_global(Self::new(appearance));
    }

    /// Switches every window to the other appearance.
    pub fn set_appearance(appearance: Appearance, cx: &mut App) {
        cx.set_global(Self::new(appearance));
        cx.refresh_windows();
    }

    /// The soft shadow under things lifted above the content (menus, popovers, hover cards).
    pub fn elevated_shadow(&self) -> Vec<BoxShadow> {
        let (near, far) = if self.appearance.is_dark() {
            (hsla(0., 0., 0., 0.40), hsla(0., 0., 0., 0.35))
        } else {
            (hsla(0., 0., 0., 0.06), hsla(0., 0., 0., 0.08))
        };
        vec![
            BoxShadow {
                color: near,
                offset: point(px(0.), px(1.)),
                blur_radius: px(2.),
                spread_radius: px(0.),
                inset: false,
            },
            BoxShadow {
                color: far,
                offset: point(px(0.), px(8.)),
                blur_radius: px(24.),
                spread_radius: px(-4.),
                inset: false,
            },
        ]
    }

    /// The faint shadow that sets a card off a surface of the same colour.
    pub fn card_shadow(&self) -> Vec<BoxShadow> {
        let color = if self.appearance.is_dark() {
            hsla(0., 0., 0., 0.30)
        } else {
            hsla(0., 0., 0., 0.04)
        };
        vec![BoxShadow {
            color,
            offset: point(px(0.), px(1.)),
            blur_radius: px(3.),
            spread_radius: px(0.),
            inset: false,
        }]
    }
}

/// Reads the theme from anything that can see the app.
pub trait ActiveTheme {
    fn theme(&self) -> &Theme;
}

impl ActiveTheme for App {
    fn theme(&self) -> &Theme {
        self.global::<Theme>()
    }
}

/// Type helpers every styled element gets: `.text_ui(TypeSize::Small)`, `.medium()`.
pub trait StyledType: Styled + Sized {
    /// Sets the size and the line height that goes with it, in the UI font.
    fn text_ui(self, size: TypeSize) -> Self {
        self.font_family(UI_FONT)
            .text_size(size.size())
            .line_height(size.line_height())
    }

    /// Monospaced text. SF Mono runs larger than SF Pro, so it's set a step down (14 → 13,
    /// 13 → 12), never below 12.
    fn text_mono(self, size: TypeSize) -> Self {
        let mono = match size {
            TypeSize::Body => TypeSize::Small.size(),
            TypeSize::Small | TypeSize::Caption => TypeSize::Caption.size(),
            TypeSize::Title => TypeSize::Title.size(),
        };
        self.font_family(MONO_FONT).text_size(mono).line_height(size.line_height())
    }

    fn medium(self) -> Self {
        self.font_weight(MEDIUM)
    }

    fn regular(self) -> Self {
        self.font_weight(REGULAR)
    }
}

impl<T: Styled> StyledType for T {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The brief's three text colours, exactly.
    #[test]
    fn light_text_levels_are_the_briefs() {
        let colors = Colors::light();
        assert_eq!(colors.text, hex(0x292929));
        assert_eq!(colors.text_muted, hex(0x5D5D5D));
        assert_eq!(colors.text_faint, hex(0x9E9E9E));
    }

    fn luminance(color: Hsla) -> f32 {
        let rgba = color.to_rgb();
        let channel = |c: f32| {
            if c <= 0.03928 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(rgba.r) + 0.7152 * channel(rgba.g) + 0.0722 * channel(rgba.b)
    }

    fn contrast(a: Hsla, b: Hsla) -> f32 {
        let (la, lb) = (luminance(a), luminance(b));
        (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
    }

    /// Text people read stays readable on every surface it sits on, in both appearances: the
    /// first two levels meet WCAG AA for body text (4.5:1, and 7:1 for the first). The faint
    /// level is the brief's #9E9E9E, about 2.5:1 on light surfaces: it's kept for hints and
    /// times, never for anything that must be read.
    #[test]
    fn text_levels_stay_readable_in_both_appearances() {
        for colors in [Colors::light(), Colors::dark()] {
            for surface in [colors.surface, colors.background, colors.sunken, colors.elevated] {
                assert!(contrast(colors.text, surface) >= 7.0);
                assert!(contrast(colors.text_muted, surface) >= 4.5);
                assert!(contrast(colors.text_faint, surface) >= 2.4);
            }
            assert!(contrast(colors.text_on_primary, colors.primary) >= 7.0);
            // Code stays readable on its well: comments 3:1, line numbers 2:1 at least.
            assert!(contrast(colors.syntax.comment, colors.sunken) >= 3.0);
            assert!(contrast(colors.syntax.line_number, colors.sunken) >= 2.0);
        }
    }
}
