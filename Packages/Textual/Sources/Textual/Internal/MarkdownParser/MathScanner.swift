import Foundation

// MARK: - Overview
//
// `MathScanner` finds the formulas in Markdown for `MathSyntax`, as Foundation's parser reads the
// text around them. Each `$`, `\(`, `\)`, `\[` and `\]` that isn't escaped is swapped for a
// private-use character of its own, and the Markdown is read once: the ones that come out as text
// can open or close a formula; ones in code or a link written as its address can't, nor ones that
// don't come out at all (a link's address, a link definition). A formula can't run out of code, a
// link's words or a picture's description, or into them. So code spans, fences, links and web
// addresses are the parser's to tell, and what's left here is pairing the delimiters, and telling
// math from prices and the shell's `$$`.

struct MathScanner {
  struct Found {
    /// Its delimiters and what's between, in the text's Unicode scalars.
    var range: Range<Int>
    var formula: MathSyntax.Formula
  }

  /// What a delimiter came out as when the Markdown was read.
  private enum Place {
    /// Text, in the stretch numbered `segment` (between code, links' words and pictures'
    /// descriptions), in `block`.
    case text(segment: Int, block: PresentationIntent?)
    /// Code, or a link written as its address.
    case other
  }

  private let s: [Unicode.Scalar]
  /// Where each delimiter starts.
  private var delimiters: [Int] = []
  /// What each came out as, by where it starts (nil when it didn't come out); before the
  /// Markdown's read, nil, and each is taken as text.
  private var places: [Int: Place]?

  init(_ s: [Unicode.Scalar]) {
    self.s = s
    var i = 0
    while i < s.count {
      if s[i] == "\\", i + 1 < s.count {
        // An escape ("\$" is a dollar sign), or a bracket that opens or closes math.
        if "()[]".unicodeScalars.contains(s[i + 1]) { delimiters.append(i) }
        i += 2
        continue
      }
      if s[i] == "$" { delimiters.append(i) }
      i += 1
    }
  }

  /// Reads the Markdown with `read`, as the text will be read, for where each delimiter comes out;
  /// false when there aren't stand-ins enough.
  mutating func read(standIns: StandIns, with read: (String) throws -> AttributedString) rethrows -> Bool {
    guard let tokens = standIns.make(delimiters.count) else { return false }
    var marked = String.UnicodeScalarView()
    var start = 0
    for (n, i) in delimiters.enumerated() {
      marked.append(contentsOf: s[start..<i])
      marked.append(tokens[n])
      start = i + (s[i] == "$" ? 1 : 2)
    }
    marked.append(contentsOf: s[start...])
    let parsed = try read(String(marked))

    var delimiter: [UInt32: Int] = [:]
    for (n, token) in tokens.enumerated() { delimiter[token.value] = delimiters[n] }
    var places: [Int: Place] = [:]
    var segment = 0
    var link: URL?
    var image: URL?
    for run in parsed.runs {
      let isCode =
        run.inlinePresentationIntent?.contains(.code) == true || run.presentationIntent?.isCodeBlock == true
      if isCode || run.link != link || run.imageURL != image { segment += 1 }
      (link, image) = (run.link, run.imageURL)
      for scalar in String(parsed[run.range].characters).unicodeScalars where scalar.value >= StandIns.first {
        guard let i = delimiter[scalar.value] else { continue }
        // A link written as its address ("<https://…>", "https://…") has its words in it.
        let isAddress = run.link.map { $0.absoluteString.contains(scalar.percentEncoded) } ?? false
        places[i] = isCode || isAddress ? .other : .text(segment: segment, block: run.presentationIntent)
      }
    }
    self.places = places
    return true
  }

  private func place(_ i: Int) -> Place? {
    places.map { $0[i] } ?? .text(segment: 0, block: nil)
  }

  /// The formulas, in order. Before the Markdown's read, every formula there could be: reading it
  /// only takes some away.
  func formulas() -> [Found] {
    var found: [Found] = []
    var k = 0
    while k < delimiters.count {
      let i = delimiters[k]
      var next = i + 1
      if case .text = place(i) {
        var formula: Found?
        if s[i] == "$" {
          let run = dollars(at: i)
          // Three or more are never math: prices ("$$$"), or the shell's.
          if run == 2 { formula = display(at: i, dollars: true) }
          if run == 1 { formula = inline(at: i) }
          next = i + run
        } else if s[i + 1] == "[" {
          formula = display(at: i, dollars: false)
        } else if s[i + 1] == "(" {
          formula = bracketed(at: i)
        }
        if let formula {
          found.append(formula)
          next = formula.range.upperBound
        }
      }
      while k < delimiters.count, delimiters[k] < next { k += 1 }
    }
    return found
  }

  // MARK: Formulas in a line

  /// The `$…$` opened at `i`, as Pandoc reads them: text right after the opening `$` and right
  /// before the closing one, on one line, and no digit after it (so "$5 and $10" stay prices).
  private func inline(at i: Int) -> Found? {
    guard i + 1 < s.count, !s[i + 1].isSpace, s[i + 1] != "$" else { return nil }
    var j = i + 1
    while j < s.count, s[j] != "\n" {
      if s[j] == "\\" {
        j += j + 1 < s.count && s[j + 1] != "\n" ? 2 : 1
        continue
      }
      if s[j] == "$" {
        guard !s[j - 1].isSpace, j + 1 == s.count || !s[j + 1].isDigit, closes(i, at: j) else {
          return nil
        }
        return Found(
          range: i..<(j + 1),
          formula: .init(source: string(s[i...j]), latex: string(s[(i + 1)..<j]), isDisplay: false)
        )
      }
      j += 1
    }
    return nil
  }

  /// The `\(…\)` opened at `i`, on one line.
  private func bracketed(at i: Int) -> Found? {
    var j = i + 2
    while j + 1 < s.count, s[j] != "\n" {
      if s[j] == "\\" {
        if s[j + 1] == ")" {
          let latex = string(s[(i + 2)..<j]).trimmingCharacters(in: .whitespaces)
          guard !latex.isEmpty, closes(i, at: j) else { return nil }
          return Found(
            range: i..<(j + 2),
            formula: .init(source: string(s[i..<(j + 2)]), latex: latex, isDisplay: false)
          )
        }
        j += s[j + 1] == "\n" ? 1 : 2
        continue
      }
      j += 1
    }
    return nil
  }

  /// Whether the delimiter at `j` closes a formula in a line opened at `i`: in the same text,
  /// with no code or link between; or in a table row's cell that didn't come out (a row with more
  /// cells than its header, as a formula's `|` can make it).
  private func closes(_ i: Int, at j: Int) -> Bool {
    guard case .text(let segment, let block) = place(i) else { return false }
    switch place(j) {
    case .text(let other, _)?: return other == segment
    case .other?: return false
    case nil: return block?.isTableCell == true
    }
  }

  // MARK: Formulas of their own

  /// The `$$…$$` or `\[…\]` opened at `i`: closed in its paragraph, or on lines of its own, which
  /// Markdown may have read as other blocks ("+ x" as a list item), up to a blank line.
  private func display(at i: Int, dollars: Bool) -> Found? {
    if dollars, isPrice(at: i) { return nil }
    var j = i + 2
    var close: Int?
    while j < s.count, close == nil {
      switch s[j] {
      case "\n":
        if lineIsBlank(from: j + 1) { return nil }
        j += 1
      case "\\":
        if !dollars, j + 1 < s.count, s[j + 1] == "]" { close = j }
        j += j + 1 < s.count && s[j + 1] != "\n" ? 2 : 1
      case "$" where dollars:
        let run = self.dollars(at: j)
        if run > 2 { return nil }
        // Right before a letter or a digit, it opens the next formula.
        let opensNext = j + 2 < s.count && (s[j + 2].isLetter || s[j + 2].isDigit)
        if run == 2, !isPrice(at: j), !opensNext { close = j }
        j += run
      default:
        j += 1
      }
    }
    guard let close, case .text(let segment, let block)? = place(i),
      case .text(segment, let closingBlock)? = place(close)
    else { return nil }

    if s[i..<close].contains("\n"), block?.blockIdentity != closingBlock?.blockIdentity {
      // Opened at the start of a line's words, closed alone on a later one, in the same quote or
      // list item.
      let after = s[(close + 2)..<lineEnd(from: close)]
      guard i == wordsStart(ofLineAt: i), close == wordsStart(ofLineAt: close),
        after.allSatisfy({ $0.isSpace || Character($0).isPunctuation }),
        closingBlock.containers.ends(with: block.containers)
      else { return nil }
    }

    // Each line without its quote marks and indentation.
    let quotes = block?.components.filter { $0.kind == .blockQuote }.count ?? 0
    var parts: [String] = []
    var start = i + 2
    for (n, end) in (s[start..<close].indices.filter { s[$0] == "\n" } + [close]).enumerated() {
      var from = start
      if n > 0 {
        for _ in 0..<quotes {
          var p = from
          while p < end, p - from < 3, s[p] == " " { p += 1 }
          guard p < end, s[p] == ">" else { break }
          from = p + 1 + (p + 1 < end && s[p + 1] == " " ? 1 : 0)
        }
        while from < end, s[from] == " " || s[from] == "\t" { from += 1 }
      }
      parts.append(string(s[from..<end]))
      start = end + 1
    }
    let latex = parts.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard isMath(latex, from: i, to: close, dollars: dollars) else { return nil }
    let (open, shut) = dollars ? ("$$", "$$") : ("\\[", "\\]")
    return Found(
      range: i..<(close + 2),
      formula: .init(source: open + parts.joined(separator: "\n") + shut, latex: latex, isDisplay: true)
    )
  }

  // MARK: Prices and the shell

  /// Whether `$$` at `i` is a price in parentheses: "($$)".
  private func isPrice(at i: Int) -> Bool {
    i > 0 && i + 2 < s.count && s[i - 1] == "(" && s[i + 2] == ")"
  }

  /// Whether a formula of its own from `i` to `close` is one: something, with no `$` of its own,
  /// and with `$$`, not "($$) … ($$)", nor two `$$` set apart as words in a sentence around nothing
  /// that looks like math: prices ("Joe's is $$ and Katz's is $$ too"), or the shell's.
  private func isMath(_ latex: String, from i: Int, to close: Int, dollars: Bool) -> Bool {
    guard let first = latex.unicodeScalars.first, !latex.hasUnescapedDollar else { return false }
    guard dollars else { return true }
    if ")]}".unicodeScalars.contains(first) { return false }
    let wordsBefore = s[wordsStart(ofLineAt: i, pastListMarker: true)..<i].contains { !$0.isSpace }
    let wordsAfter = s[(close + 2)..<lineEnd(from: close)].contains { !$0.isSpace }
    let spacedInside =
      s[i + 2].isSpace
      && (s[close - 1].isSpace || s[i..<close].contains("\n") && close == wordsStart(ofLineAt: close))
    return !(wordsBefore && wordsAfter && spacedInside) || latex.looksLikeMath
  }

  // MARK: Lines

  private func dollars(at i: Int) -> Int {
    var run = 0
    while i + run < s.count, s[i + run] == "$" { run += 1 }
    return run
  }

  private func lineEnd(from i: Int) -> Int {
    var end = i
    while end < s.count, s[end] != "\n" { end += 1 }
    return end
  }

  private func lineIsBlank(from i: Int) -> Bool {
    s[i..<lineEnd(from: i)].allSatisfy { $0.isSpace || $0 == ">" }
  }

  /// Where the words of the line `i` is on start: past its quote marks and indentation, and with
  /// `pastListMarker`, its list item's marker ("- ", "1. ").
  private func wordsStart(ofLineAt i: Int, pastListMarker: Bool = false) -> Int {
    var p = i
    while p > 0, s[p - 1] != "\n" { p -= 1 }
    while p < i, s[p] == " " || s[p] == "\t" || s[p] == ">" { p += 1 }
    guard pastListMarker else { return p }
    var marker = p
    if marker < i, "-+*".unicodeScalars.contains(s[marker]) {
      marker += 1
    } else {
      while marker < i, marker - p < 9, s[marker].isASCII, s[marker].properties.numericType != nil { marker += 1 }
      guard marker > p, marker < i, s[marker] == "." || s[marker] == ")" else { return p }
      marker += 1
    }
    guard marker < i, s[marker] == " " || s[marker] == "\t" else { return p }
    while marker < i, s[marker] == " " || s[marker] == "\t" { marker += 1 }
    return marker
  }

  private func string(_ scalars: ArraySlice<Unicode.Scalar>) -> String {
    String(String.UnicodeScalarView(scalars))
  }
}

// MARK: - Stand-ins

/// Private-use characters a text doesn't have, written or as `&#…;`, to stand in for others while
/// its Markdown is read.
struct StandIns {
  /// The first one: the Supplementary Private Use Areas (planes 15 and 16) have room for every
  /// delimiter in a long reply, and are rarer in text than the first one (Nerd Fonts' icons, PDFs).
  static let first: UInt32 = 0xF0000

  private var used: Set<UInt32> = []

  init(avoiding text: String) {
    for scalar in text.unicodeScalars where scalar.value >= Self.first { used.insert(scalar.value) }
    guard text.contains("&#") else { return }
    for match in text.matches(of: /&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/) {
      if let value = match.1.flatMap({ UInt32($0, radix: 16) }) ?? match.2.flatMap({ UInt32($0) }) {
        used.insert(value)
      }
    }
  }

  /// `count` of them, or nil when there aren't that many.
  func make(_ count: Int) -> [Unicode.Scalar]? {
    var made: [Unicode.Scalar] = []
    made.reserveCapacity(count)
    var value = Self.first
    while made.count < count, value <= 0x10FFFD {
      // Each plane's last two are noncharacters.
      if value & 0xFFFE != 0xFFFE, !used.contains(value), let scalar = Unicode.Scalar(value) {
        made.append(scalar)
      }
      value += 1
    }
    return made.count == count ? made : nil
  }
}

// MARK: - Helpers

extension Unicode.Scalar {
  fileprivate var isSpace: Bool { properties.isWhitespace }
  fileprivate var isLetter: Bool { properties.isAlphabetic }
  fileprivate var isDigit: Bool { properties.numericType != nil }

  /// As a URL has it: "%F3%B0%80%81".
  fileprivate var percentEncoded: String {
    String(self).utf8.map { String(format: "%%%02X", $0) }.joined()
  }
}

extension String {
  /// Has a `$` that isn't escaped (`\$`).
  fileprivate var hasUnescapedDollar: Bool {
    var escaped = false
    for scalar in unicodeScalars {
      if scalar == "$", !escaped { return true }
      escaped = scalar == "\\" && !escaped
    }
    return false
  }

  /// Has what only math has: a command, a sub- or superscript, braces, an equals sign or another
  /// relation, a plus, or a function's argument ("f(x)").
  fileprivate var looksLikeMath: Bool {
    var previous: Character = " "
    for character in self {
      if "\\^_{}=<>+".contains(character)
        || character == "(" && (previous.isLetter || previous.isNumber)
      {
        return true
      }
      previous = character
    }
    return false
  }
}

extension Optional where Wrapped == PresentationIntent {
  /// The quotes, list items and lists a block is in, innermost first.
  fileprivate var containers: [Int] {
    self?.components.dropFirst().map(\.identity) ?? []
  }
}

extension PresentationIntent {
  var blockIdentity: Int? { components.first?.identity }

  var isCodeBlock: Bool {
    if case .codeBlock = components.first?.kind { return true }
    return false
  }

  var isTableCell: Bool {
    if case .tableCell = components.first?.kind { return true }
    return false
  }
}

extension Array where Element: Equatable {
  fileprivate func ends(with suffix: [Element]) -> Bool {
    count >= suffix.count && Array(self[(count - suffix.count)...]) == suffix
  }
}
