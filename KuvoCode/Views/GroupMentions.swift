import AppKit
import ClientDesign
import SwiftUI
import Textual

/// "@Mira" in a group chat, so you see at a glance who's being asked: the name in bold, in the
/// bot's own color, and in a bot's message, the bot's face in place of the @.
nonisolated enum GroupMentions {
    /// Where each bot is named with @, last first, so replacing them leaves the earlier ones where
    /// they were. Longer names win ("@Miranda" isn't "@Mira"), and a name must end where a word does.
    static func find(in text: String, bots: [Bot]) -> [(range: Range<String.Index>, bot: Bot)] {
        var found: [(range: Range<String.Index>, bot: Bot)] = []
        for bot in bots.sorted(by: { $0.name.count > $1.name.count }) where !bot.name.isEmpty {
            var start = text.startIndex
            while let range = text.range(of: "@" + bot.name, options: [.caseInsensitive, .diacriticInsensitive], range: start..<text.endIndex) {
                start = range.upperBound
                if range.upperBound < text.endIndex, text[range.upperBound].isLetter || text[range.upperBound].isNumber { continue }
                if found.contains(where: { $0.range.overlaps(range) }) { continue }
                found.append((range, bot))
            }
        }
        return found.sorted { $0.range.lowerBound > $1.range.lowerBound }
    }

    /// The bot's color for its name in text: deep enough to read on a light card, light enough
    /// on a dark one.
    static func ink(_ look: BotLook) -> Color {
        let tint = look.color.color
        return Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(isDark ? tint.mix(with: .white, by: 0.25) : tint.mix(with: .black, by: 0.3))
        })
    }

    /// "@User" and "@you": you, named by a bot.
    static func findYou(in text: String) -> [Range<String.Index>] {
        var found: [Range<String.Index>] = []
        for name in ["@User", "@you"] {
            var start = text.startIndex
            while let range = text.range(of: name, options: [.caseInsensitive], range: start..<text.endIndex) {
                start = range.upperBound
                if range.upperBound < text.endIndex, text[range.upperBound].isLetter || text[range.upperBound].isNumber { continue }
                found.append(range)
            }
        }
        return found.sorted { $0.lowerBound > $1.lowerBound }
    }

    /// Styles the mentions in `text`; `faces` puts each bot's face in place of its @. You, named
    /// as "@User", show in your accent color.
    static func apply(to text: inout AttributedString, bots: [Bot], faces: Bool) {
        let plain = String(text.characters)
        for range in findYou(in: plain) {
            let start = plain.distance(from: plain.startIndex, to: range.lowerBound)
            let length = plain.distance(from: range.lowerBound, to: range.upperBound)
            let lower = text.characters.index(text.startIndex, offsetBy: start)
            let upper = text.characters.index(lower, offsetBy: length)
            text[lower..<upper].swiftUI.foregroundColor = Look.accent(UserDefaults.standard.string(forKey: Look.accentKey) ?? Look.Accent.system.rawValue)
            text[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
        }
        let characters = String(text.characters)
        for (range, bot) in find(in: characters, bots: bots) {
            let start = characters.distance(from: characters.startIndex, to: range.lowerBound)
            let length = characters.distance(from: range.lowerBound, to: range.upperBound)
            let lower = text.characters.index(text.startIndex, offsetBy: start)
            let upper = text.characters.index(lower, offsetBy: length)
            let name = text.characters.index(after: lower)
            text[name..<upper].swiftUI.foregroundColor = ink(bot.look)
            text[name..<upper].inlinePresentationIntent = .stronglyEmphasized
            if faces {
                var face = AttributedString("\u{FFFC}", attributes: text[lower..<name].runs.first?.attributes ?? AttributeContainer())
                face.textual.attachment = AnyAttachment(MentionFace(look: bot.look))
                face[FindReadsAs.self] = text.characters[lower]
                text.replaceSubrange(lower..<name, with: face)
            } else {
                text[lower..<name].swiftUI.foregroundColor = ink(bot.look)
                text[lower..<name].inlinePresentationIntent = .stronglyEmphasized
            }
        }
    }

    /// Your message, as plain words with its mentions styled.
    static func styled(_ text: String, bots: [Bot]) -> AttributedString {
        var styled = AttributedString(text)
        apply(to: &styled, bots: bots, faces: false)
        return styled
    }
}

/// A bot's face in a line of text, where its @ was.
nonisolated struct MentionFace: Attachment {
    let look: BotLook
    var description: String { "@" }
    var selectionStyle: AttachmentSelectionStyle { .text }

    // Drawn at a size of its own, then scaled into its square slot in the text.
    var body: some View {
        BotAvatar(look: look, size: 40, animates: false)
    }

    func baselineOffset(in environment: TextEnvironmentValues) -> CGFloat {
        FontScaled<CGFloat>.fontScaled(-0.2).resolve(in: environment)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        FontScaled<CGSize>.fontScaled(width: 1.08, height: 1.08).resolve(in: environment)
    }
}
