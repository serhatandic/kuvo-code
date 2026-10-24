import Foundation

/// A ``MarkupParser`` implementation backed by Foundation’s Markdown support.
///
/// This parser leverages Foundation’s Markdown support and preserves structure via
/// presentation intents.
///
/// This parser can process its output to expand custom emoji into inline attachments, and find
/// math as it reads the Markdown (see ``MathSyntax``).
public struct AttributedStringMarkdownParser: MarkupParser {
  private let baseURL: URL?
  private let options: AttributedString.MarkdownParsingOptions
  private let processor: PatternProcessor
  private let math: MathSyntax?

  public init(
    baseURL: URL?,
    options: AttributedString.MarkdownParsingOptions = .init(),
    syntaxExtensions: [SyntaxExtension] = []
  ) {
    self.baseURL = baseURL
    self.options = options
    self.processor = PatternProcessor(syntaxExtensions: syntaxExtensions.filter { !$0.patterns.isEmpty })
    self.math = syntaxExtensions.lazy.compactMap(\.math).first
  }

  public func attributedString(for input: String) throws -> AttributedString {
    if let math {
      return try processor.expand(math.attributedString(markdown: input, options: options, baseURL: baseURL))
    }
    return try processor.expand(
      AttributedString(
        markdown: input,
        including: \.textual,
        options: options,
        baseURL: baseURL
      )
    )
  }
}

extension MarkupParser where Self == AttributedStringMarkdownParser {
  /// Creates a Markdown parser configured for inline-only syntax.
  public static func inlineMarkdown(
    baseURL: URL? = nil,
    syntaxExtensions: [AttributedStringMarkdownParser.SyntaxExtension] = []
  ) -> Self {
    .init(
      baseURL: baseURL,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace),
      syntaxExtensions: syntaxExtensions
    )
  }

  /// Creates a Markdown parser configured for full-document syntax.
  public static func markdown(
    baseURL: URL? = nil,
    syntaxExtensions: [AttributedStringMarkdownParser.SyntaxExtension] = []
  ) -> Self {
    .init(
      baseURL: baseURL,
      syntaxExtensions: syntaxExtensions
    )
  }
}
