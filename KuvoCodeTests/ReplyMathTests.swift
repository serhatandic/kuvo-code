import Foundation
import Testing
import Textual
@testable import KuvoCode

/// Math in a reply, as it's drawn: `$…$` and `\(…\)` in a line, `$$…$$` and `\[…\]` on their own,
/// centered; and what isn't math kept as written: prices, the shell's `$$`, code, links and web
/// addresses. Lists, quotes and tables keep their shape around a formula, a formula still
/// streaming in shows as written, and one SwiftUIMath can't draw shows as written too.
@MainActor
@Suite struct ReplyMathTests {
    nonisolated struct Snippet: CustomTestStringConvertible, Sendable {
        let name: String
        let markdown: String
        /// What it shows, block by block (see `shown`).
        let blocks: [String]

        init(_ name: String, _ markdown: String, _ blocks: [String]) {
            self.name = name
            self.markdown = markdown
            self.blocks = blocks
        }

        var testDescription: String { name }
    }

    nonisolated static let snippets: [Snippet] = [
        Snippet("A formula in a line, both ways", "Euler: $e^{i\\pi} + 1 = 0$, and \\(a_1 + b_1\\) too.", ["Euler: ⟨e^{i\\pi} + 1 = 0⟩, and ⟨a_1 + b_1⟩ too."]),
        Snippet("Formulas of their own, both ways", "The energy is\n\n$$E = mc^2$$\n\nor\n\n\\[\\int_0^1 x\\,dx = \\frac{1}{2}\\]", ["The energy is", "```kuvo-math E = mc^2", "or", "```kuvo-math \\int_0^1 x\\,dx = \\frac{1}{2}"]),
        Snippet("A formula on lines of its own, as Markdown would garble it", "$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$", ["```kuvo-math \\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}"]),
        Snippet("One set apart from the words around it", "Energy is $$E=mc^2$$ here.", ["Energy is", "```kuvo-math E=mc^2", "here."]),
        Snippet("Prices", "It costs $5 and $10, or $20-$30 a month.", ["It costs $5 and $10, or $20-$30 a month."]),
        Snippet("Prices as dollar signs", "Joe's is $$ and Katz's is $$ too.", ["Joe's is $$ and Katz's is $$ too."]),
        Snippet("Price tiers", "Tiers: ($$) cheap, ($$$) mid, ($$$$) high.", ["Tiers: ($$) cheap, ($$$) mid, ($$$$) high."]),
        Snippet("The shell's $$ and variables in code", "Run `echo $$` and `echo $HOME`, then $$ again; it costs $10.", ["Run `echo $$` and `echo $HOME`, then $$ again; it costs $10."]),
        Snippet("Code spans", "Cost $10 and `$HOME` and $x$, `a $y$ b`.", ["Cost $10 and `$HOME` and ⟨x⟩, `a $y$ b`."]),
        Snippet("A code block", "```sh\necho $HOME $$\nprice=$5 and $x$\n```", ["```sh echo $HOME $$\nprice=$5 and $x$"]),
        Snippet("Indented code", "    export PATH=$HOME/bin:$PATH", ["``` export PATH=$HOME/bin:$PATH"]),
        Snippet("A code block with Windows line ends", "```\r\necho $a$\r\n```\r\nand $b$", ["``` echo $a$", "and ⟨b⟩"]),
        Snippet("Escaped dollar signs", "Escaped: \\$5 and \\$10, and \\$x\\$.", ["Escaped: $5 and $10, and $x$."]),
        Snippet("A link's address", "[Products](https://example.com/api?$filter=Price&$top=2) and $x$.", ["[Products](https://example.com/api?$filter=Price&$top=2) and ⟨x⟩."]),
        Snippet("A link's address on the next line", "[Products](\n/products?$filter=a&$top=2\n) after", ["[Products](/products?$filter=a&$top=2) after"]),
        Snippet("A link's title on the next line", "[Products](/products?$filter=a \"Title $x$\"\n) after", ["[Products](/products?$filter=a) after"]),
        Snippet("A link written as its address", "<https://example.com/$a$/b$> and $y$", ["[https://example.com/$a$/b$](https://example.com/$a$/b$) and ⟨y⟩"]),
        Snippet("A web address", "See https://example.com/$a$b and $y$.", ["See [https://example.com/$a$b](https://example.com/$a$b) and ⟨y⟩."]),
        Snippet("A link definition", "[ref]: https://example.com/?$a=1$\n\n[Docs][ref] $z$", ["[Docs](https://example.com/?$a=1$) ⟨z⟩"]),
        Snippet("A price before a link", "$5 [docs](https://example.com/?$top=2) here", ["$5 [docs](https://example.com/?$top=2) here"]),
        Snippet("Right after a list marker", "- $$E=mc^2$$\n- next\n\n1. $$a^2$$\n2. $$b^2$$", ["- ⟪E=mc^2⟫", "- next", "1. ⟪a^2⟫", "2. ⟪b^2⟫"]),
        Snippet("After an item's label", "1. Energy: $$E=mc^2$$\n2. Next", ["1. Energy: ⟪E=mc^2⟫", "2. Next"]),
        Snippet("After an item's label, over a lazy line", "1. Energy: $$E =\nmc^2$$\n2. Next", ["1. Energy: ⟪E =\nmc^2⟫", "2. Next"]),
        Snippet("On an item's own line", "1. Energy:\n   $$E=mc^2$$\n2. Next", ["1. Energy:", "1. ```kuvo-math E=mc^2", "2. Next"]),
        Snippet("On an item's own lines", "- First\n  $$\n  x^2\n  $$\n- Second", ["- First", "- ```kuvo-math x^2", "- Second"]),
        Snippet("In a list item's words", "- A formula $x^2$ in a list item", ["- A formula ⟨x^2⟩ in a list item"]),
        Snippet("In a quote's words", "> A quote with $x^2$ in it", ["> A quote with ⟨x^2⟩ in it"]),
        Snippet("On a quote's own lines", "> $$\n> E = mc^2\n> $$", ["> ```kuvo-math E = mc^2"]),
        Snippet("In a list in a quote", "> - $$a^2$$\n> - b", ["> - ⟪a^2⟫", "> - b"]),
        Snippet("In a table's cells", "| a | b |\n|---|---|\n| $x^2$ | $$y$$ |", ["|0 a", "|1 b", "|0 ⟨x^2⟩", "|1 ⟪y⟫"]),
        Snippet("With bars, in a table's cell", "| a | b |\n|---|---|\n| $|x|$ | y |", ["|0 a", "|1 b", "|0 ⟨|x|⟩", "|1 y"]),
        Snippet("Prices in a table row", "| price | tier |\n|---|---|\n| ($$) | $$ and $$ |", ["|0 price", "|1 tier", "|0 ($$)", "|1 $$ and $$"]),
        Snippet("In a heading", "# Heading $$x^2$$", ["# Heading ⟪x^2⟫"]),
        Snippet("Over a line that looks like a list item", "$$\nx\n+ 2x\n$$", ["```kuvo-math x\n+ 2x"]),
        Snippet("Not across a blank line", "$$a\n\nb$$", ["$$a", "b$$"]),
        Snippet("Not closing right before a word", "$$x$$y", ["$$x$$y"]),
        Snippet("A code fence on a list marker's line", "- ```\n  $x$\n  ```\n- $y$", ["- ``` $x$", "- ⟨y⟩"]),
        Snippet("Emphasis marks in a formula", "Asterisks $a*b*c$ and underscores $a_1 + b_1$, **bold $x^2$**", ["Asterisks ⟨a*b*c⟩ and underscores ⟨a_1 + b_1⟩, bold ⟨x^2⟩"]),
        Snippet("Streaming in: not closed yet", "Streaming $x^2 + \\frac", ["Streaming $x^2 + \\frac"]),
        Snippet("Streaming in: a formula of its own not closed yet", "Streaming\n\n$$\n\\int_0^1", ["Streaming", "$$ \\int_0^1"]),
        Snippet("One SwiftUIMath can't draw", "Arrow $\\xrightarrow{f}$ here", ["Arrow $\\xrightarrow{f}$ here"]),
        Snippet("Commands drawn as ones SwiftUIMath has", "Boxed $\\boxed{42}$ and $a \\dots b$", ["Boxed ⟨\\boxed{42}⟩ and ⟨a \\dots b⟩"]),
        Snippet("Private-use characters in the text", "PUA \u{E000}0\u{E001} and \u{E000}12345678901234567890\u{E001}, \u{F0000}\u{F0001} and $x$ and $$y$$", ["PUA \u{E000}0\u{E001} and \u{E000}12345678901234567890\u{E001}, \u{F0000}\u{F0001} and ⟨x⟩ and", "```kuvo-math y"]),
        Snippet("Windows line ends", "Windows\r\n$$\r\nx^2\r\n$$\r\nline", ["Windows", "```kuvo-math x^2", "line"]),
        Snippet("A web address without its scheme", "See www.example.com/$a$ and $y$.", ["See [www.example.com/$a$](http://www.example.com/$a$) and ⟨y⟩."]),
    ]

    @Test(arguments: snippets)
    func aReplyShows(_ snippet: Snippet) throws {
        let text = try FileLinkingParser(folders: { [] }).attributedString(for: snippet.markdown)
        #expect(Self.shown(text) == snippet.blocks)
    }

    /// A Markdown file's preview draws math as replies do.
    @Test func aFilesPreview() throws {
        let markdown = "Cost $5, and $x^2$:\n\n$$\na\n+ b\n$$\n\n`$HOME`"
        let preview = try MathMarkdownParser().attributedString(for: markdown)
        #expect(Self.shown(preview) == ["Cost $5, and ⟨x^2⟩:", "```kuvo-math a\n+ b", "`$HOME`"])
    }

    /// Find counts a formula as one place in the text, as it's drawn, finds no words in it, and
    /// finds a price as written.
    @Test func findCountsAFormulaAsOne() {
        let shown = FindText.shown(markdown: "Area $\\pi r^2$ costs $5\n\n$$a+b$$\n\nend", folders: [])
        #expect(shown == "Area \u{FFFC} costs $5" + String(repeating: "\u{FFFC}", count: 4) + "end")
        #expect(FindText.ranges(of: "pi", in: shown).isEmpty)
        #expect(FindText.ranges(of: "$5", in: shown).count == 1)
    }

    /// A reply's blocks as text: a formula in a line as ⟨latex⟩ (⟪latex⟫ when set as one of its
    /// own), inline code in backticks, a link as [words](address), and each block after what it's
    /// in: "> " a quote, "- " or "1. " a list item, "|0 " a table's first column, "# " a heading,
    /// "```language " a code block.
    static func shown(_ text: AttributedString) -> [String] {
        var blocks: [(identity: Int, line: String)] = []
        for run in text.runs {
            let components = run.presentationIntent?.components ?? []
            let characters = String(text[run.range].characters)
            let body: String
            if let math = run.textual.attachment?.base as? InlineMath {
                body = math.isDisplay ? "⟪\(math.latex)⟫" : "⟨\(math.latex)⟩"
            } else if run.inlinePresentationIntent?.contains(.code) == true {
                body = "`\(characters)`"
            } else if let link = run.link {
                body = "[\(characters)](\(link.absoluteString))"
            } else {
                body = characters
            }
            if let identity = components.first?.identity, blocks.last?.identity == identity {
                blocks[blocks.count - 1].line += body
                continue
            }
            var prefix = ""
            for (index, component) in components.enumerated().reversed() {
                switch component.kind {
                case .blockQuote: prefix += "> "
                case .listItem(let ordinal):
                    let isOrdered = index + 1 < components.count && components[index + 1].kind == .orderedList
                    prefix += isOrdered ? "\(ordinal). " : "- "
                case .tableCell(let column): prefix += "|\(column) "
                case .header(let level): prefix += String(repeating: "#", count: level) + " "
                case .codeBlock(let language): prefix += "```\(language ?? "") "
                default: break
                }
            }
            blocks.append((components.first?.identity ?? -1, prefix + body))
        }
        return blocks.map { $0.line.hasSuffix("\n") ? String($0.line.dropLast()) : $0.line }
    }
}
