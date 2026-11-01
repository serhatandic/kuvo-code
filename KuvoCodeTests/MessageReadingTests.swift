import AppKit
import SwiftUI
import Testing
@testable import KuvoCode

/// Your message as VoiceOver reads it: words on the page, as a Text is, not a text area to edit,
/// and read as you see it: a bot's name without the "&" its face is drawn over, a keyword without
/// its "/", a picture's name without its brackets.
@MainActor
@Suite struct MessageReadingTests {
    @Test func aMessageReadsAsTheWordsYouSee() {
        TestEnvironment.prepare()
        var words = AttributedString("Ask &Ada about [Image 1]")
        MessageMentions.apply(to: &words, agents: [.init(reference: .init(name: "Ada", session: "ses_ada"), look: nil)])
        MessageMentions.applyLinksAndPictures(to: &words, pictures: 1)
        let shown = MessageMentions.attributed(MessageMentions.keyword("/review", before: words), font: .systemFont(ofSize: 14))
        let message = SelectableTextView()
        message.show(shown.text, faces: shown.faces, lineLimit: nil)

        #expect(message.accessibilityRole() == .staticText)
        #expect(message.accessibilityValue() == "review Ask Ada about Image 1")
        // Moved through by character, word and line, as it reads.
        let spoken = "review Ask Ada about Image 1" as NSString
        #expect(message.accessibilityNumberOfCharacters() == spoken.length)
        let ada = spoken.range(of: "Ada")
        #expect(message.accessibilityString(for: ada) == "Ada")
        #expect(message.accessibilityString(for: spoken.range(of: "Image 1")) == "Image 1")
        #expect(message.accessibilityAttributedString(for: ada)?.string == "Ada")
        // Its place on screen is where "Ada" is drawn, not its "&".
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 600, height: 40), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = message
        defer { window.close() }
        let written = (message.string as NSString).range(of: "Ada")
        let drawn = message.firstRect(forCharacterRange: written, actualRange: nil)
        #expect(drawn.width > 0)
        #expect(message.accessibilityFrame(for: ada) == drawn)
        // Copied as written.
        #expect(message.string == "/review Ask &Ada about [Image 1]")
    }
}
