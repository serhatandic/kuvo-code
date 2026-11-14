import SwiftUI

// MARK: - Overview
//
// HighlightedTextFragment displays syntax-highlighted code using a two-phase approach.
// Tokenization runs asynchronously and is keyed by content, while highlighting runs
// synchronously on token or environment changes (theme, color scheme, dynamic type).
//
// The presentationIntent is preserved after highlighting so pasteboard formatters can
// reconstruct the block structure when copying code.

struct HighlightedTextFragment: View {
  @Environment(\.textEnvironment) private var textEnvironment

  @State private var model = Model()

  private let content: AttributedSubstring
  private let languageHint: String?
  private let theme: StructuredText.HighlighterTheme

  init(
    _ content: AttributedSubstring,
    languageHint: String?,
    theme: StructuredText.HighlighterTheme
  ) {
    self.content = content
    self.languageHint = languageHint
    self.theme = theme
  }

  var body: some View {
    let code = String(content.characters[...])
    TextFragment(
      model.highlighted(
        code: code,
        presentationIntent: content.presentationIntent,
        languageHint: languageHint,
        theme: theme,
        environment: textEnvironment
      )
    )
    .foregroundStyle(theme.foregroundColor)
    // Its language too: a block still being written gets its own once its fence closes.
    .task(id: Tuple(code, languageHint)) {
      await model.tokenize(code: code, languageHint: languageHint)
    }
  }
}

extension HighlightedTextFragment {
  @MainActor @Observable final class Model {
    /// The code's tokens, once read here, and the language they were read in.
    private var tokens: (code: String, language: String, tokens: [CodeToken])?

    @ObservationIgnored
    private var memo: (key: Tuple<String, StructuredText.HighlighterTheme, TextEnvironmentValues>, tokens: [CodeToken], value: AttributedString)?

    /// The code, colored: with its tokens as read here or before (code read once is colored at
    /// once each time it shows again, not plain first), plain until then.
    func highlighted(
      code: String,
      presentationIntent: PresentationIntent?,
      languageHint: String?,
      theme: StructuredText.HighlighterTheme,
      environment: TextEnvironmentValues
    ) -> AttributedString {
      let tokens =
        (self.tokens.flatMap { $0.code == code && $0.language == languageHint ? $0.tokens : nil })
        ?? languageHint.flatMap { TokenCache.shared.tokens(of: code, in: $0) }
        ?? [CodeToken(content: code, type: .plain)]
      let key = Tuple(code, theme, environment)
      if let memo, memo.key == key, memo.tokens == tokens { return memo.value }
      let value = Self.highlight(tokens: tokens, presentationIntent: presentationIntent, using: theme, environment: environment)
      memo = (key, tokens, value)
      return value
    }

    func tokenize(code: String, languageHint: String?) async {
      guard let languageHint else { return }
      // Read before: kept here too, as the cache may let it go.
      if let cached = TokenCache.shared.tokens(of: code, in: languageHint) {
        if self.tokens?.code != code || self.tokens?.language != languageHint { self.tokens = (code, languageHint, cached) }
        return
      }
      guard let tokenizer = await CodeTokenizer.loaded() else { return }
      let tokens = await tokenizer.tokenize(code: code, language: languageHint)
      TokenCache.shared.insert(tokens, of: code, in: languageHint)
      // The code changed meanwhile (a block still being written), which cancelled this: its
      // tokens, of the code as it was, would show over the newer code's.
      guard !Task.isCancelled else { return }
      self.tokens = (code, languageHint, tokens)
    }

    private static func highlight(
      tokens: [CodeToken],
      presentationIntent: PresentationIntent?,
      using theme: StructuredText.HighlighterTheme,
      environment: TextEnvironmentValues
    ) -> AttributedString {
      var attributes = AttributeContainer()
      // Re-apply the presentation intent for pasteboard formatters
      attributes.presentationIntent = presentationIntent
      ForegroundColorProperty(theme.foregroundColor)
        .apply(in: &attributes, environment: environment)
      var highlightedCode = AttributedString()

      for token in tokens {
        var content = AttributedString(token.content)
        var tokenAttributes = attributes

        if let tokenProperties = theme.tokenProperties[token.type] {
          tokenProperties.apply(in: &tokenAttributes, environment: environment)
        }

        content.mergeAttributes(tokenAttributes)
        highlightedCode.append(content)
      }

      return highlightedCode
    }
  }
}

/// Code read into tokens lately, by its language: a code block made again (scrolled back into
/// view) is colored at once rather than plain until its code is read again.
@MainActor final class TokenCache {
  static let shared = TokenCache()

  private struct Key: Hashable {
    let code: String
    let language: String
  }

  /// About how much code it keeps, in characters; the oldest goes first.
  private static let limit = 2_000_000
  private var tokens: [Key: [CodeToken]] = [:]
  private var order: [Key] = []
  private var size = 0

  func tokens(of code: String, in language: String) -> [CodeToken]? {
    tokens[Key(code: code, language: language)]
  }

  func insert(_ tokens: [CodeToken], of code: String, in language: String) {
    let key = Key(code: code, language: language)
    guard self.tokens.updateValue(tokens, forKey: key) == nil else { return }
    order.append(key)
    size += code.utf16.count
    while size > Self.limit, !order.isEmpty {
      let oldest = order.removeFirst()
      self.tokens[oldest] = nil
      size -= oldest.code.utf16.count
    }
  }
}
