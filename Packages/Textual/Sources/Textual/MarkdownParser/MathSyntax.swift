import Foundation

/// LaTeX in Markdown: `$…$` and `\(…\)` in a line, `$$…$$` and `\[…\]` set apart.
///
/// Foundation's Markdown parser, which Textual reads Markdown with, can't be given syntax of its
/// own, and it would garble a formula first (`\\` read as an escape, `_` and `*` as emphasis,
/// `+ x` as a list item). So the formulas are found as the parser reads the Markdown around them
/// (code, links, web addresses and link definitions keep their dollar signs), each is swapped
/// for a character of its own while the Markdown is read, and put back after: in the line as
/// `inline` makes it, or as a code block of `blockLanguage`.
///
/// `$5 and $10` stay prices, and so do "Joe's is $$ and Katz's is $$ too" and the shell's `$$`.
public struct MathSyntax {
  public struct Formula: Hashable, Sendable {
    /// As written, with its dollar signs or brackets.
    public let source: String
    public let latex: String
    /// `$$…$$` or `\[…\]`.
    public let isDisplay: Bool
  }

  /// The language of the code block a display formula of its own becomes.
  public var blockLanguage: String

  /// A formula in a line of text, with the attributes of the text around it; nil leaves it as
  /// written. A display formula it makes goes in a code block of its own instead, unless it's in
  /// a table cell or a heading, opens a list item, or shares its line with words in a list item
  /// or quote.
  public var inline: (Formula, AttributeContainer) -> AttributedString?

  public init(
    blockLanguage: String = "math",
    inline: @escaping (Formula, AttributeContainer) -> AttributedString?
  ) {
    self.blockLanguage = blockLanguage
    self.inline = inline
  }

  /// `markdown` read as `AttributedString(markdown:including:options:baseURL:)` reads it, with
  /// Textual's attributes, and its math drawn.
  public func attributedString(
    markdown: String,
    options: AttributedString.MarkdownParsingOptions = .init(),
    baseURL: URL? = nil
  ) throws -> AttributedString {
    func read(_ text: String) throws -> AttributedString {
      try AttributedString(markdown: text, including: \.textual, options: options, baseURL: baseURL)
    }
    // Most replies have none: nothing to do.
    guard markdown.contains("$") || markdown.contains("\\(") || markdown.contains("\\[") else {
      return try read(markdown)
    }
    // A Windows line end is one line end, as Markdown reads it.
    let text =
      markdown.utf8.contains(13)
      ? markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      : markdown
    let scalars = Array(text.unicodeScalars)
    var scanner = MathScanner(scalars)
    // Prices alone ("$5 and $10") are read once, as text without math is.
    guard !scanner.formulas().isEmpty else { return try read(markdown) }
    let standIns = StandIns(avoiding: text)
    guard
      try scanner.read(standIns: standIns, with: { try AttributedString(markdown: $0, options: options, baseURL: baseURL) }),
      case let found = scanner.formulas(), !found.isEmpty, let marks = standIns.make(found.count)
    else {
      return try read(markdown)
    }

    var marked = String.UnicodeScalarView()
    var start = 0
    for (n, formula) in found.enumerated() {
      marked.append(contentsOf: scalars[start..<formula.range.lowerBound])
      marked.append(marks[n])
      start = formula.range.upperBound
    }
    marked.append(contentsOf: scalars[start...])
    var output = try read(String(marked))
    putBack(found.map(\.formula), marks: marks, in: &output)
    return output
  }

  // MARK: Putting them back

  /// Each mark in `text` swapped for its formula, last first, so the ones before keep their place.
  private func putBack(_ formulas: [Formula], marks: [Unicode.Scalar], in text: inout AttributedString) {
    var formula: [UInt32: Formula] = [:]
    for (n, mark) in marks.enumerated() { formula[mark.value] = formulas[n] }
    // Found by the text's scalars, which is quick, rather than by walking its characters (a long
    // reply is read again with each streamed word).
    var places: [(offset: Int, formula: Formula)] = []
    for (offset, scalar) in text.unicodeScalars.enumerated() where scalar.value >= StandIns.first {
      if let found = formula[scalar.value] { places.append((offset, found)) }
    }
    var identities: Identities?
    for place in places.reversed() {
      let start = text.unicodeScalars.index(text.startIndex, offsetBy: place.offset)
      let end = text.unicodeScalars.index(after: start)
      let attributes = text[start..<end].runs.first?.attributes ?? AttributeContainer()
      let made = inline(place.formula, attributes)
      if place.formula.isDisplay, made != nil,
        let paragraph = paragraph(around: start, in: text),
        setsApart(start..<end, in: paragraph, of: text)
      {
        setApart(place.formula, at: start..<end, in: paragraph, of: &text, identities: &identities)
      } else {
        text.replaceSubrange(
          start..<end,
          with: made ?? AttributedString(place.formula.source, attributes: attributes)
        )
      }
    }
  }

  /// The paragraph `index` is in, if it's in one.
  private func paragraph(
    around index: AttributedString.Index,
    in text: AttributedString
  ) -> (intent: PresentationIntent, range: Range<AttributedString.Index>)? {
    for (intent, range) in text.runs[\.presentationIntent] where range.contains(index) {
      guard let intent, intent.components.first?.kind == .paragraph else { return nil }
      return (intent, range)
    }
    return nil
  }

  /// Whether a display formula at `mark` goes in a block of its own: at the left edge, or alone on
  /// its line in a list item or quote, but not opening a list item (whose marker would go with it).
  private func setsApart(
    _ mark: Range<AttributedString.Index>,
    in paragraph: (intent: PresentationIntent, range: Range<AttributedString.Index>),
    of text: AttributedString
  ) -> Bool {
    let before = text[paragraph.range.lowerBound..<mark.lowerBound]
    let after = text[mark.upperBound..<paragraph.range.upperBound]
    let first = before.characters.allSatisfy(\.isWhitespace)
    let containers = paragraph.intent.components.dropFirst()
    if first, let item = containers.first, case .listItem = item.kind {
      // The item's first paragraph: the first with the item in it.
      let firstOfItem = text.runs[\.presentationIntent].first {
        $0.0?.components.contains { $0.identity == item.identity } == true
      }
      if firstOfItem?.0?.blockIdentity == paragraph.intent.blockIdentity { return false }
    }
    guard !containers.isEmpty else { return true }
    func isBreak(_ intent: InlinePresentationIntent?) -> Bool {
      intent?.isDisjoint(with: [.softBreak, .lineBreak]) == false
    }
    let last = before.runs.last?.inlinePresentationIntent, next = after.runs.first?.inlinePresentationIntent
    return (first || isBreak(last)) && (after.characters.allSatisfy(\.isWhitespace) || isBreak(next))
  }

  /// The formula at `mark` as a code block, between what's before it in its paragraph and what's
  /// after it, each a paragraph of its own.
  private func setApart(
    _ formula: Formula,
    at mark: Range<AttributedString.Index>,
    in paragraph: (intent: PresentationIntent, range: Range<AttributedString.Index>),
    of text: inout AttributedString,
    identities: inout Identities?
  ) {
    var ids = identities ?? Identities(text)
    defer { identities = ids }
    var before = AttributedString(text[paragraph.range.lowerBound..<mark.lowerBound])
    var after = AttributedString(text[mark.upperBound..<paragraph.range.upperBound])
    while let last = before.characters.last, last.isWhitespace { before.characters.removeLast() }
    while let first = after.characters.first, first.isWhitespace { after.characters.removeFirst() }
    var parent: PresentationIntent?
    for container in paragraph.intent.components.dropFirst().reversed() {
      parent = PresentationIntent(container.kind, identity: container.identity, parent: parent)
    }
    var block = AttributedString(formula.latex + "\n")
    block.presentationIntent = PresentationIntent(
      .codeBlock(languageHint: blockLanguage), identity: ids.next(), parent: parent)
    if !after.characters.isEmpty {
      after.presentationIntent = PresentationIntent(.paragraph, identity: ids.next(), parent: parent)
    }
    text.replaceSubrange(paragraph.range, with: before + block + after)
  }

  /// New blocks' identities, past every one the text has.
  private struct Identities {
    private var last: Int

    init(_ text: AttributedString) {
      last = text.runs[\.presentationIntent].compactMap { $0.0?.components.map(\.identity).max() }.max() ?? 0
    }

    mutating func next() -> Int {
      last += 1
      return last
    }
  }
}
