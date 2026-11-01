import AppKit
import Testing
@testable import KuvoCode

/// The model's thinking as it streams in: code between backticks shows in the code face without
/// them, also when a span opens in one chunk and closes in a later one, and the text reads the same
/// once it's restyled.
@MainActor
@Suite struct ThoughtTextTests {
    private let font = NSFont.systemFont(ofSize: 12)

    private func codeRuns(_ view: LongTextView) -> [String] {
        guard let storage = view.textStorage else { return [] }
        var runs: [String] = []
        storage.enumerateAttribute(.font, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if (value as? NSFont)?.fontDescriptor.symbolicTraits.contains(.monoSpace) == true {
                runs.append((storage.string as NSString).substring(with: range))
            }
        }
        return runs
    }

    @Test func spansAcrossChunks() {
        let view = LongTextView()
        var text = ""
        for chunk in ["Run `swi", "ft test` first.\nThen `np", "m run", " build` and done"] {
            text += chunk
            view.show(text, font: font, color: .secondaryLabelColor)
        }
        #expect(view.string == "Run swift test first.\nThen npm run build and done")
        #expect(codeRuns(view) == ["swift test", "npm run build"])

        // Restyled (larger text, say): the same words, the same code.
        view.show(text, font: .systemFont(ofSize: 14), color: .secondaryLabelColor)
        #expect(view.string == "Run swift test first.\nThen npm run build and done")
        #expect(codeRuns(view) == ["swift test", "npm run build"])
    }

    @Test func aBacktickLeftOpenStaysAsWritten() {
        let view = LongTextView()
        view.show("A long line with a lone ` in it", font: font, color: .secondaryLabelColor)
        view.show("A long line with a lone ` in it, and more", font: font, color: .secondaryLabelColor)
        #expect(view.string == "A long line with a lone ` in it, and more")
        #expect(codeRuns(view).isEmpty)
    }
}
