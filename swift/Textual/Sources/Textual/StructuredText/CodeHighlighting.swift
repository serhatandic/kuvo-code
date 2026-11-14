import Foundation

/// Code blocks colored ahead of time.
public enum CodeHighlighting {
  /// Reads the code blocks in `markdown` (as `StructuredText` would read them) into tokens, off
  /// the main thread, so that when they show, they're colored at once rather than plain first.
  public static func prepare(markdown texts: [String]) async {
    let blocks = await Task.detached(priority: .utility) {
      var blocks: [(code: String, language: String)] = []
      var seen = Set<String>()
      for text in texts where text.contains("```") || text.contains("~~~") {
        // Foundation's Markdown, as `AttributedStringMarkdownParser.markdown()` reads it (its own
        // syntax extensions don't touch code blocks), which can be read off the main thread.
        guard let parsed = try? AttributedString(markdown: text) else { continue }
        for (intent, range) in parsed.runs[\.presentationIntent] {
          let language = intent?.components.lazy.compactMap { component -> String? in
            if case .codeBlock(let language) = component.kind { language } else { nil }
          }.first
          guard let language, language.lowercased() != "math" else { continue }
          // As a code block shows it: without its last line break.
          var code = String(parsed[range].characters)
          if code.hasSuffix("\n") { code.removeLast() }
          if seen.insert(language + "\u{0}" + code).inserted { blocks.append((code, language)) }
        }
      }
      return blocks
    }.value
    let unread = await MainActor.run { blocks.filter { TokenCache.shared.tokens(of: $0.code, in: $0.language) == nil } }
    guard !unread.isEmpty, let tokenizer = await CodeTokenizer.loaded() else { return }
    for block in unread {
      guard !Task.isCancelled else { return }
      let tokens = await tokenizer.tokenize(code: block.code, language: block.language)
      await MainActor.run { TokenCache.shared.insert(tokens, of: block.code, in: block.language) }
    }
  }
}

extension CodeHighlighting {
  /// A piece of code and what kind of token it is ("keyword", "string", …), as Prism reads it.
  public struct Token: Sendable, Hashable {
    public let text: String
    public let type: String
  }

  /// `code`'s tokens in `language`, if they've been read lately (by this or by a code block).
  @MainActor public static func cachedTokens(of code: String, in language: String) -> [Token]? {
    TokenCache.shared.tokens(of: code, in: language)?.map { Token(text: $0.content, type: $0.type.rawValue) }
  }

  /// `code` read into tokens in `language`, off the main thread, and kept for next time; nil if
  /// there's no tokenizer.
  public static func tokens(of code: String, in language: String) async -> [Token]? {
    if let cached = await cachedTokens(of: code, in: language) { return cached }
    guard let tokenizer = await CodeTokenizer.loaded() else { return nil }
    let tokens = await tokenizer.tokenize(code: code, language: language)
    await MainActor.run { TokenCache.shared.insert(tokens, of: code, in: language) }
    return tokens.map { Token(text: $0.content, type: $0.type.rawValue) }
  }
}
