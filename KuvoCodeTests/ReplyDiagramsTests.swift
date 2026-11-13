import AppKit
import ClientDesign
import Foundation
import Testing
@testable import KuvoCode

/// A diagram in a reply: a ```mermaid block an agent writes is drawn as a diagram, as a Markdown
/// file's preview draws one; while the reply is still being written and the block isn't closed
/// yet, it shows as code, so half a diagram never shows as one Mermaid can't read. Read as the
/// conversation reads a reply: in its pieces, the one still being written marked.
@MainActor
@Suite struct ReplyDiagramsTests {
    private let diagram = "graph TD\n  A[Request] --> B{Cache?}\n  B -- hit --> C[Reply]"

    private func kinds(_ markdown: String, isWriting: Bool = false) -> [String] {
        MarkdownChunks.split(markdown, isWriting: isWriting).flatMap { chunk in
            let text = isWriting ? MarkdownChunks.text(of: chunk, marking: CodeLanguage.writing) : chunk.text
            return ReplyDocument.cached(markdown: text, parser: FileLinkingParser(folders: { [] }), style: .init(), diagrams: true).segments
        }.map { segment in
            switch segment {
            case .diagram: "diagram"
            case .code: "code"
            case .text: "text"
            default: "other"
            }
        }
    }

    @Test func aWrittenDiagramIsDrawn() {
        #expect(kinds("How a request goes:\n\n```mermaid\n\(diagram)\n```\n\nThat's all.") == ["text", "diagram", "text"])
    }

    @Test func oneStillBeingWrittenShowsAsCodeTillItsDone() {
        #expect(kinds("How a request goes:\n\n```mermaid\n\(diagram)", isWriting: true) == ["text", "code"])
        // In a quote, too.
        #expect(kinds("> ```mermaid\n> \(diagram.replacingOccurrences(of: "\n", with: "\n> "))", isWriting: true).contains("code"))
        // Its fence closed and the reply going on: drawn while the rest is written. (A fence at
        // the very end could still be growing, into "````", so it waits for what comes next.)
        #expect(kinds("How a request goes:\n\n```mermaid\n\(diagram)\n```\n\nThen", isWriting: true) == ["text", "diagram", "text"])
        // Written: drawn, however its reply ended.
        #expect(kinds("How a request goes:\n\n```mermaid\n\(diagram)\n```") == ["text", "diagram"])
    }

    /// Find's places in a diagram's code show in its code, so the count Find gives can be seen.
    @Test func oneFindHasPlacesInShowsItsCode() {
        var parser = FileLinkingParser(folders: { [] })
        parser.highlight = FindHighlight(query: "Cache", current: 0)
        let segments = ReplyDocument(markdown: "```mermaid\n\(diagram)\n```", parser: parser, style: .init(), diagrams: true).segments
        guard case .code = segments.first else { Issue.record("Not shown as code: \(segments)"); return }
        parser.highlight = FindHighlight(query: "nowhere", current: nil)
        guard case .diagram = ReplyDocument(markdown: "```mermaid\n\(diagram)\n```", parser: parser, style: .init(), diagrams: true).segments.first else {
            Issue.record("A diagram without Find's places in it was shown as code"); return
        }
    }

    /// Mermaid, as the app carries it, draws one, and says what's wrong with one it can't read.
    @Test func mermaidDrawsItOrSaysWhatsWrong() async {
        let drawn = await MermaidRenderer.shared.render(diagram, dark: false, width: 400)
        guard case .drawn(let image) = drawn else { Issue.record("Not drawn: \(String(describing: drawn))"); return }
        #expect(image.size.width == 400 && image.size.height > 40)
        #expect(Self.isDrawnOn(image), "The picture is blank")
        let broken = await MermaidRenderer.shared.render("graph TD\n  A[Request --> B{", dark: false, width: 400)
        guard case .failed(let problem) = broken else { Issue.record("A broken one was drawn"); return }
        #expect(!problem.isEmpty)
    }

    @Test func otherCodeStaysCode() {
        #expect(kinds("```swift\nlet a = 1\n```") == ["code"])
        // A fence of three inside a block of four doesn't close it early.
        #expect(kinds("````mermaid\ngraph TD\n```\n  A --> B", isWriting: true) == ["code"])
    }

    /// Whether `image` has more than one color in it: a picture taken of a page that didn't draw is
    /// all one.
    private static func isDrawnOn(_ image: NSImage) -> Bool {
        guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return false }
        let width = cg.width, height = cg.height
        var pixels = [UInt32](repeating: 0, count: width * height)
        let drawn = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn && pixels.contains { $0 != pixels[0] }
    }
}
