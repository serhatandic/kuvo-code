import SwiftUI
import Textual

/// Token colors for every piece of code in the app (diffs, files, replies): Xcode's in light
/// mode, and luminous pastels in dark mode (lavender, sky, mint, coral), which hold on a dark
/// surface where deep purples and blues sink into it.
public enum CodeColors {
    public static func color(for type: String, dark: Bool) -> Color? {
        switch type {
        case "keyword", "important", "atrule", "rule", "literal", "directive", "preprocessor":
            return dark ? Color(hex: 0xC3A6FF) : Color(hex: 0x9B2393)
        case "string", "char", "attr-value", "template-string", "url":
            return dark ? Color(hex: 0xFF9E87) : Color(hex: 0xC41A16)
        case "comment", "prolog", "doctype", "cdata", "block-comment", "doc-comment", "mark":
            return dark ? Color(hex: 0x7F8A9A) : Color(hex: 0x5D6C79)
        case "number", "boolean", "constant", "entity":
            return dark ? Color(hex: 0xF2D07E) : Color(hex: 0x1C00CF)
        case "class-name", "builtin", "namespace":
            return dark ? Color(hex: 0x7DC9FF) : Color(hex: 0x0B4F79)
        case "function", "function-variable", "function-name", "method":
            return dark ? Color(hex: 0x86E1C6) : Color(hex: 0x326D74)
        case "property", "attr-name", "key", "property-access":
            return dark ? Color(hex: 0xA9DCF7) : Color(hex: 0x3E8087)
        case "tag", "selector", "title":
            return dark ? Color(hex: 0xFF9CC4) : Color(hex: 0x9B2393)
        case "regex", "variable", "symbol":
            return dark ? Color(hex: 0xFFBE8C) : Color(hex: 0x6C36A9)
        case "inserted":
            return dark ? Color(hex: 0x8FD99A) : Color(hex: 0x1E7D32)
        case "deleted":
            return dark ? Color(hex: 0xFF8A80) : Color(hex: 0xC0392B)
        case "operator", "punctuation":
            return nil
        default:
            return nil
        }
    }

    /// The same palette for Textual, which draws the code blocks in replies and Markdown files.
    public static let theme: StructuredText.HighlighterTheme = {
        let names = [
            "keyword", "important", "atrule", "literal", "directive", "preprocessor",
            "string", "char", "attr-value", "url", "regex",
            "comment", "prolog", "doctype", "cdata", "block-comment", "doc-comment", "mark",
            "number", "boolean", "constant", "entity",
            "class-name", "builtin", "namespace", "function", "function-name",
            "property", "attr-name", "tag", "selector", "variable", "inserted", "deleted",
        ]
        let bold: Set = ["keyword", "literal", "boolean", "mark"]
        var properties: [StructuredText.HighlighterTheme.TokenType: AnyTextProperty] = [:]
        for name in names {
            guard let light = color(for: name, dark: false), let dark = color(for: name, dark: true) else { continue }
            let color = DynamicColor(light: light, dark: dark)
            properties[.init(rawValue: name)] = bold.contains(name)
                ? AnyTextProperty(.foregroundColor(color), .fontWeight(.semibold))
                : AnyTextProperty(.foregroundColor(color))
        }
        return StructuredText.HighlighterTheme(
            foregroundColor: DynamicColor(light: Color(hex: 0x1F2328), dark: Color(hex: 0xE6E8EE)),
            backgroundColor: DynamicColor(.clear),
            tokenProperties: properties
        )
    }()
}
