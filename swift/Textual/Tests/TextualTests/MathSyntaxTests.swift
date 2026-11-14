import Foundation
import Testing

@testable import Textual

/// Math as the Markdown parser reads it: formulas drawn in a line or as blocks of their own, and
/// dollar signs in code, links and prices left as written. (Kuvo Code's own rendering of many
/// more cases is in its app tests, `ReplyMathTests`.)
@MainActor
@Suite struct MathSyntaxTests {
  /// With Textual's own `.math`: a formula in a line is an attachment, one of its own a `math`
  /// code block, which `StructuredText` draws as math.
  @Test func textualsOwnMath() throws {
    let parser = AttributedStringMarkdownParser.markdown(syntaxExtensions: [.math])
    let text = try parser.attributedString(for: "Area $\\pi r^2$, costs $5.\n\n$$\na\n+ b\n$$")
    #expect(blocks(text) == ["Area ⟨\\pi r^2⟩, costs $5.", "math: a\n+ b"])
  }

  @Test func codeAndLinksKeepTheirDollarSigns() throws {
    let text = try syntax.attributedString(
      markdown: "`$HOME` and [docs](https://example.com/?$top=2) and <https://example.com/$a$>, $x$\n\n```sh\n$y$\n```")
    #expect(
      blocks(text) == [
        "$HOME and docs and https://example.com/$a$, ⟨x⟩", "sh: $y$",
      ])
    #expect(text.runs.contains { $0.link?.absoluteString == "https://example.com/?$top=2" })
  }

  @Test func pricesAndTheShellsDollarSigns() throws {
    let text = try syntax.attributedString(markdown: "It's $5 and $10; Joe's is $$ and Katz's is $$ too; ($$) and $$$.")
    #expect(blocks(text) == ["It's $5 and $10; Joe's is $$ and Katz's is $$ too; ($$) and $$$."])
  }

  /// One `inline` doesn't make shows as written, and isn't set apart.
  @Test func oneThatCantBeDrawnShowsAsWritten() throws {
    let syntax = MathSyntax { formula, attributes in
      formula.latex.contains("\\bad") ? nil : self.syntax.inline(formula, attributes)
    }
    let text = try syntax.attributedString(markdown: "Good $x$, bad $\\bad{x}$\n\n$$\\bad{y}$$")
    #expect(blocks(text) == ["Good ⟨x⟩, bad $\\bad{x}$", "$$\\bad{y}$$"])
  }

  /// Lists, quotes and tables keep their shape: a formula of its own goes in its list item or
  /// quote, and stays in its table cell's line.
  @Test func blocksAroundFormulas() throws {
    let text = try syntax.attributedString(
      markdown: "- Energy:\n  $$E = mc^2$$\n- Next\n\n> $$\n> a\n> $$\n\n| a | b |\n|---|---|\n| $$x$$ | $|y|$ |")
    #expect(
      blocks(text) == [
        "Energy:", "code: E = mc^2", "Next", "code: a", "a", "b", "⟪x⟫", "⟨|y|⟩",
      ])
    let math = text.runs.first { $0.presentationIntent?.components.first?.kind == .codeBlock(languageHint: "code") }
    #expect(math?.presentationIntent?.components.contains { if case .listItem = $0.kind { true } else { false } } == true)
  }

  // MARK: Helpers

  /// Formulas in a line as ⟨latex⟩ (⟪latex⟫ for a display one), set apart in a "code" block.
  private let syntax = MathSyntax(blockLanguage: "code") { formula, attributes in
    AttributedString(formula.isDisplay ? "⟪\(formula.latex)⟫" : "⟨\(formula.latex)⟩", attributes: attributes)
  }

  /// Each block's text; a code block's as "language: code", a math attachment as ⟨latex⟩.
  private func blocks(_ text: AttributedString) -> [String] {
    var blocks: [(identity: Int, text: String)] = []
    for run in text.runs {
      let intent = run.presentationIntent?.components.first
      var characters = String(text[run.range].characters)
      if let math = run.textual.attachment?.base as? MathAttachment {
        characters = math.displayStyle == .block ? "⟪\(math.latex)⟫" : "⟨\(math.latex)⟩"
      }
      if case .codeBlock(let language) = intent?.kind {
        characters = "\(language ?? ""): " + characters.trimmingCharacters(in: .newlines)
      }
      if let identity = intent?.identity, blocks.last?.identity == identity {
        blocks[blocks.count - 1].text += characters
      } else {
        blocks.append((intent?.identity ?? -1, characters))
      }
    }
    return blocks.map(\.text)
  }
}
