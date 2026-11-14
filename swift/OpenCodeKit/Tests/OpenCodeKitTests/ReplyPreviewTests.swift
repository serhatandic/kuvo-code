import Testing
@testable import OpenCodeKit

/// A reply in one line: Markdown's marks off, the words as written.
struct ReplyPreviewTests {
    @Test(arguments: [
        ("**Done** — saved to `bot_a1i96kbu5o/workspace/users.csv`", "Done — saved to bot_a1i96kbu5o/workspace/users.csv"),
        ("# Heading\n> quoted _emph_ and snake_case and C# and 2 * 3", "Heading quoted emph and snake_case and C# and 2 * 3"),
        ("See [the docs](https://x.y/z) and ![pic](a.png)", "See the docs and pic"),
        ("*italic* and ***both*** and a_b_c d__e", "italic and both and a_b_c d__e"),
    ])
    func takesOffOnlyMarkdown(markdown: String, line: String) {
        #expect(ReplyPreview.line(markdown) == line)
    }

    @Test func cutsLongReplies() {
        let line = ReplyPreview.line(String(repeating: "word ", count: 100), limit: 20)
        #expect(line.count == 20)
        #expect(line.hasSuffix("…"))
    }
}
