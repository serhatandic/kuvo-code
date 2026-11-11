@testable import ClientDesign
import SwiftUI
import Testing

/// A session's row in both apps, with "from Mini" at its end: the title always wins. Where the row
/// is too narrow for the note and about twelve characters of the title, the note goes, and the
/// title has the row (its hover text and VoiceOver hint still say where it came from).
@MainActor
struct TitleWithTailTests {
    private let title = "Fix the flaky upload test"

    /// Whether the note (drawn red here) shows in a row `width` wide; `face`: that wide before the title.
    private func showsNote(in width: CGFloat, face: CGFloat = 0) throws -> Bool {
        let row = TitleWithTail(title) { words in
            HStack(spacing: 6) {
                if face > 0 { Color.blue.frame(width: face, height: 10) }
                Text(words).lineLimit(1)
            }
        } tail: {
            Color.red.frame(width: 50, height: 10)
        }
        .font(.system(size: 13))
        .frame(width: width, alignment: .leading)
        let renderer = ImageRenderer(content: row)
        renderer.scale = 1
        let image = try #require(renderer.cgImage)
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let drawn = pixels.withUnsafeMutableBytes { bytes in
            CGContext(data: bytes.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                .map { $0.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height)); return true } ?? false
        }
        try #require(drawn)
        return stride(from: 0, to: pixels.count, by: 4).contains { pixels[$0] > 200 && pixels[$0 + 1] < 80 && pixels[$0 + 2] < 80 && pixels[$0 + 3] > 200 }
    }

    @Test func theNoteShowsWhereTheTitleStillKeepsItsStart() throws {
        #expect(try showsNote(in: 320), "room for the whole title and the note")
        #expect(try showsNote(in: 160), "the title cut, but keeping its first words")
    }

    @Test func aRowTooNarrowForBothIsTheTitlesAlone() throws {
        #expect(try !showsNote(in: 100))
    }

    /// What's before the title (a bot's face) counts against its room too.
    @Test func aFaceBeforeTheTitleLeavesItLessRoom() throws {
        #expect(try showsNote(in: 160))
        #expect(try !showsNote(in: 160, face: 60))
    }

    @Test func whatTheTitleKeepsIsAboutItsFirstTwelveCharacters() {
        #expect(TitleWithTail<EmptyView, EmptyView>.kept(of: title) == "Fix the flak…")
        #expect(TitleWithTail<EmptyView, EmptyView>.kept(of: "Docs for mac") == "Docs for mac", "a short title is kept whole")
        #expect(TitleWithTail<EmptyView, EmptyView>.kept(of: "Bump the eng") == "Bump the eng")
    }
}
