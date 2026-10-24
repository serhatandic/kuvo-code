import Foundation

extension AttributedStringMarkdownParser {
  /// A syntax extension that replaces matched tokens after Markdown parsing, or math, which is
  /// found as the Markdown is read (see ``MathSyntax``).
  public struct SyntaxExtension {
    let patterns: [PatternTokenizer.Pattern]
    let replace:
      (
        _ token: PatternTokenizer.Token,
        _ attributes: AttributeContainer
      ) -> AttributedString?
    var math: MathSyntax? = nil
  }
}

extension AttributedStringMarkdownParser.SyntaxExtension {
  /// Replaces `:shortcode:` sequences using the provided custom emoji definitions.
  public static func emoji(_ emoji: Set<Emoji>) -> Self {
    guard !emoji.isEmpty else {
      return Self(patterns: [], replace: { _, _ in nil })
    }

    let emojiMap = Dictionary(
      uniqueKeysWithValues: emoji.map { emoji in
        (emoji.shortcode, emoji)
      }
    )

    return Self(patterns: [.emoji]) { token, attributes in
      guard let shortcode = token.capturedContent, let emoji = emojiMap[shortcode] else {
        return nil
      }

      return AttributedString(
        shortcode,
        attributes: attributes.emojiURL(emoji.url)
      )
    }
  }

  /// Draws math as attachments: `$…$` and `\(…\)` in a line, and `$$…$$` and `\[…\]` as blocks
  /// of their own (` ```math ` code blocks).
  public static var math: Self {
    .math(
      MathSyntax { formula, attributes in
        let attachment = MathAttachment(latex: formula.latex, style: formula.isDisplay ? .block : .inline)
        return AttributedString("\u{FFFC}", attributes: attributes.attachment(.init(attachment)))
      }
    )
  }

  /// Draws math as `syntax` makes it.
  public static func math(_ syntax: MathSyntax) -> Self {
    Self(patterns: [], replace: { _, _ in nil }, math: syntax)
  }
}
