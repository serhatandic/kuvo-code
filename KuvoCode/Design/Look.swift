import AppKit
import SwiftUI

/// Settings › Appearance, beyond light and dark: the accent color, the window's background, and
/// how messages read. Each window applies them with `.appLook()`.
enum Look {
    nonisolated static let accentKey = "appearance.accent"
    static let windowKey = "appearance.window"
    static let textSizeKey = "appearance.textSize"
    static let fontKey = "appearance.font"

    /// The accent: macOS's own, one of its colors, or any color, written "#RRGGBB".
    nonisolated enum Accent: String, CaseIterable, Identifiable {
        case system, blue, purple, pink, red, orange, yellow, green, graphite

        var id: String { rawValue }

        var title: String { rawValue == "system" ? "macOS Accent" : rawValue.capitalized }

        var color: Color {
            switch self {
            case .system: .accentColor
            case .blue: Color(nsColor: .systemBlue)
            case .purple: Color(nsColor: .systemPurple)
            case .pink: Color(nsColor: .systemPink)
            case .red: Color(nsColor: .systemRed)
            case .orange: Color(nsColor: .systemOrange)
            case .yellow: Color(nsColor: .systemYellow)
            case .green: Color(nsColor: .systemGreen)
            case .graphite: Color(nsColor: .systemGray)
            }
        }
    }

    /// The color a stored accent stands for.
    nonisolated static func accent(_ stored: String) -> Color {
        if let preset = Accent(rawValue: stored) { return preset.color }
        return Color(hex: stored) ?? .accentColor
    }

    /// The window behind the cards: frosted glass that lets the desktop through, or solid.
    enum Window: String, CaseIterable, Identifiable {
        case glass, solid
        var id: String { rawValue }
        var title: String { rawValue.capitalized }
    }

    /// Message text sizes, in points.
    static let textSizes: [(size: Double, title: String)] = [(13, "Small"), (14, "Default"), (15.5, "Large"), (17, "Larger")]

    /// The typeface of messages.
    enum Typeface: String, CaseIterable, Identifiable {
        case system, rounded, serif, monospaced
        var id: String { rawValue }

        var title: String {
            switch self {
            case .system: "System"
            case .rounded: "Rounded"
            case .serif: "Serif"
            case .monospaced: "Monospaced"
            }
        }

        var design: Font.Design {
            switch self {
            case .system: .default
            case .rounded: .rounded
            case .serif: .serif
            case .monospaced: .monospaced
            }
        }
    }
}

/// How messages are set: their size and typeface, and code a little smaller, always monospaced.
struct MessageFont: Equatable {
    var size: Double = 14
    var typeface = Look.Typeface.system

    var body: Font { .system(size: size, design: typeface.design) }
    var code: Font { .system(size: size - 1.5, design: .monospaced) }
}

extension EnvironmentValues {
    /// The accent the app is set to, for drawing that needs a color rather than the tint.
    @Entry var accent: Color = .accentColor
    @Entry var messageFont = MessageFont()
}

extension View {
    /// Applies Settings › Appearance to a window's content.
    func appLook() -> some View {
        modifier(AppLook())
    }

    /// The font messages are set in (Settings › Appearance).
    func transcriptFont() -> some View {
        modifier(TranscriptFont(code: false))
    }

    /// Code in messages, and command output: monospaced, a step smaller than messages.
    func transcriptCodeFont() -> some View {
        modifier(TranscriptFont(code: true))
    }
}

private struct AppLook: ViewModifier {
    @AppStorage(Look.accentKey) private var accent = Look.Accent.system.rawValue
    @AppStorage(Look.textSizeKey) private var textSize = 14.0
    @AppStorage(Look.fontKey) private var typeface = Look.Typeface.system

    func body(content: Content) -> some View {
        let color = Look.accent(accent)
        content
            .tint(accent == Look.Accent.system.rawValue ? nil : color)
            .environment(\.accent, color)
            .environment(\.messageFont, MessageFont(size: textSize, typeface: typeface))
    }
}

private struct TranscriptFont: ViewModifier {
    let code: Bool
    @Environment(\.messageFont) private var font

    func body(content: Content) -> some View {
        content.font(code ? font.code : font.body)
    }
}

extension Color {
    /// "#RRGGBB", as a color.
    nonisolated init?(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    /// The color as "#RRGGBB".
    var hex: String {
        let color = NSColor(self).usingColorSpace(.sRGB) ?? .systemBlue
        return String(format: "#%02X%02X%02X", Int(round(color.redComponent * 255)), Int(round(color.greenComponent * 255)), Int(round(color.blueComponent * 255)))
    }
}
