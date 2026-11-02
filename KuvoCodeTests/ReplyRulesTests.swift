import Foundation
import Testing
@testable import KuvoCode

/// The lines a reply draws, as Claude's and ChatGPT's apps have them: none under its headings,
/// and `---` as one thin line, as quiet as the space around it is even. The same as the
/// phone's (kuvo-code-ios's ReplyRulesTests), so a reply reads alike on both.
@MainActor
@Suite struct ReplyRulesTests {
    /// Each line a reply draws, top to bottom: "under <the heading>" or "line <its thickness>".
    static func lines(_ markdown: String) -> [String] {
        let document = ReplyDocument(markdown: markdown, parser: FileLinkingParser(folders: { [] }), style: .init())
        var lines: [String] = []
        for case .text(let text) in document.segments {
            text.enumerateAttribute(.replyRule, in: NSRange(location: 0, length: text.length)) { value, range, _ in
                if case .line(let height)? = value as? ReplyRule {
                    lines.append("line \(height)")
                } else if value != nil {
                    // A line under a heading.
                    lines.append("under \((text.string as NSString).substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines))")
                }
            }
        }
        return lines
    }

    @Test func headingsHaveNoLineUnderThemAndARuleIsOneThinLine() {
        let reply = """
            # The History and Future of Artificial Intelligence

            *An overview, from the first ideas to what may come next*

            ---

            ## Table of Contents

            1. Early ideas
            2. The first programs

            ### The 1950s

            | Year | What |
            | --- | --- |
            | 1956 | Dartmouth |
            """
        #expect(Self.lines(reply) == ["line 1.0"])
    }
}
