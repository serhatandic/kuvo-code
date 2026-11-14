import AppKit

/// Copying text, as Copy does everywhere: what was on the clipboard goes, the text takes its place.
enum Clipboard {
    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

extension Int {
    /// "1 session", "3 sessions": the count and the thing counted.
    func counting(_ one: String, _ many: String? = nil) -> String {
        "\(self) \(self == 1 ? one : many ?? one + "s")"
    }
}
