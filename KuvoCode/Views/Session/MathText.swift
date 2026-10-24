import Foundation
import SwiftUI
// Measuring a formula is SwiftUIMath's SPI for Textual, the same maker's: used as Textual uses it.
@_spi(Textual) import SwiftUIMath
import Textual

/// LaTeX in a reply, drawn as math: `$…$` and `\(…\)` in a line, `$$…$$` and `\[…\]` on their own.
///
/// Textual finds the formulas as it reads the Markdown (`MathSyntax`): code, links and web
/// addresses keep their dollar signs, and so do prices like "$5 and $10" or "Joe's is $$". A
/// formula in a line is drawn by `InlineMath`; one of its own becomes a code block the code block
/// style draws as math, centered (`MathBlockView`). One SwiftUIMath can't draw shows as it was
/// written.
///
/// Math is always typeset at its own width: SwiftUIMath's line breaking, which Textual's own math
/// asks for, drops spaces and breaks superscripts off.
enum MathText {
    /// The language a formula of its own goes in, as a code block.
    nonisolated static let blockLanguage = "kuvo-math"

    /// Replies' math: drawn where SwiftUIMath can draw it.
    static var syntax: MathSyntax {
        MathSyntax(blockLanguage: blockLanguage) { formula, attributes in
            guard let drawn = drawable(formula.latex) else { return nil }
            var text = AttributedString("\u{FFFC}", attributes: attributes)
            text.textual.attachment = AnyAttachment(InlineMath(latex: formula.latex, drawn: drawn, isDisplay: formula.isDisplay))
            return text
        }
    }

    // MARK: What SwiftUIMath can draw

    /// `latex` as SwiftUIMath draws it, with a few commands it lacks put as ones it has (`\dots`
    /// as `\ldots`, `\operatorname{f}` as `\mathrm{f}`, `\begin{align}` as `aligned`, sizes and
    /// boxes left out); nil when it still can't, so the formula shows as written rather than as
    /// nothing. Kept, as each reply is read again with every word that streams in.
    nonisolated static func drawable(_ latex: String) -> String? {
        let key = latex as NSString
        if let known = drawables.object(forKey: key) { return known.latex }
        let drawn = substituted(latex)
        let width = Math.typographicBounds(for: drawn, fitting: .unspecified, font: .init(name: .latinModern, size: 20), style: .text).width
        let result = width > 0 ? drawn : nil
        drawables.setObject(Drawable(latex: result), forKey: key)
        return result
    }

    nonisolated private final class Drawable: Sendable {
        let latex: String?
        init(latex: String?) { self.latex = latex }
    }

    /// NSCache is thread-safe.
    nonisolated(unsafe) private static let drawables: NSCache<NSString, Drawable> = {
        let cache = NSCache<NSString, Drawable>()
        cache.countLimit = 2000
        return cache
    }()

    /// Commands SwiftUIMath doesn't know, as ones it does; empty ones are left out.
    nonisolated private static let substitutes: [String: String] = [
        "dots": "ldots", "dotsc": "ldots", "dotso": "ldots", "dotsb": "cdots", "dotsm": "cdots", "dotsi": "cdots",
        "varnothing": "emptyset", "lVert": "Vert", "rVert": "Vert", "lvert": "vert", "rvert": "vert",
        "operatorname": "mathrm", "boldsymbol": "bm", "pmb": "bm", "bmod": "mod",
        "big": "", "Big": "", "bigg": "", "Bigg": "", "bigl": "", "bigr": "", "bigm": "", "Bigl": "", "Bigr": "", "Bigm": "",
        "biggl": "", "biggr": "", "biggm": "", "Biggl": "", "Biggr": "", "Biggm": "",
        "boxed": "", "notag": "", "nonumber": "",
    ]

    /// Environments SwiftUIMath doesn't know, as ones it does; empty ones are left out.
    nonisolated private static let environments: [String: String] = [
        "align": "aligned", "align*": "aligned", "flalign": "aligned", "flalign*": "aligned", "eqnarray*": "eqnarray",
        "gather*": "gather", "multline": "gather", "multline*": "gather", "dcases": "cases",
        "equation": "", "equation*": "", "displaymath": "",
    ]

    nonisolated private static func substituted(_ latex: String) -> String {
        guard latex.contains("\\") else { return latex }
        var out = ""
        var rest = latex[...]
        while let slash = rest.firstIndex(of: "\\") {
            out += rest[..<slash]
            rest = rest[rest.index(after: slash)...]
            let name = String(rest.prefix { $0.isASCII && $0.isLetter })
            guard !name.isEmpty else {
                // "\\", "\{", "\,": as they are.
                out += "\\" + rest.prefix(1)
                rest = rest.dropFirst()
                continue
            }
            rest = rest.dropFirst(name.count)
            if name == "begin" || name == "end", rest.first == "{", let close = rest.firstIndex(of: "}") {
                let environment = String(rest[rest.index(after: rest.startIndex)..<close])
                if let substitute = environments[environment] {
                    rest = rest[rest.index(after: close)...]
                    if !substitute.isEmpty { out += "\\\(name){\(substitute)}" }
                    continue
                }
                out += "\\" + name
            } else if name == "tag", let argument = braced(&rest) {
                // An equation's number, after it.
                out += "\\qquad " + (argument.starred ? argument.text : "(\(argument.text))")
            } else if let substitute = substitutes[name] {
                if name == "operatorname", rest.first == "*" { rest = rest.dropFirst() }
                // A space after it, so it doesn't run into the letters after.
                out += substitute.isEmpty ? "" : "\\\(substitute) "
            } else {
                out += "\\" + name
            }
        }
        return out + rest
    }

    /// The `{…}` (or `*{…}`) at the start of `rest`, taken off it.
    nonisolated private static func braced(_ rest: inout Substring) -> (text: Substring, starred: Bool)? {
        var text = rest
        let starred = text.first == "*"
        if starred { text = text.dropFirst() }
        guard text.first == "{" else { return nil }
        var depth = 0
        for index in text.indices {
            if text[index] == "{" { depth += 1 }
            if text[index] == "}" { depth -= 1 }
            if depth == 0 {
                rest = text[text.index(after: index)...]
                return (text[text.index(after: text.startIndex)..<index], starred)
            }
        }
        return nil
    }

    /// Math the size of the text it's in: Textual's 1.2 times, as its own math is.
    nonisolated static let scale: CGFloat = 1.2

    /// A font size a hair from `size` at which `latex` is a whole number of half points wide.
    /// SwiftUIMath draws a formula in a canvas as wide as it measured, then typesets it again for
    /// that width, which it finds in its cache by the width rounded to half points; a canvas a
    /// pixel narrower or wider than the formula misses it, and the formula is set again to fit,
    /// which breaks a superscript off and squashes it. At a width of whole half points, the
    /// canvas is exactly that wide and the cache has it.
    nonisolated static func drawingSize(for latex: String, near size: CGFloat, display: Bool) -> CGFloat {
        var size = size
        for _ in 0..<3 {
            let width = Math.typographicBounds(for: latex, fitting: .unspecified, font: .init(name: .latinModern, size: size), style: display ? .display : .text).width
            guard width > 0 else { return size }
            let target = (width * 2).rounded(.up) / 2
            if target - width < 0.001 { return size }
            size *= target / width
        }
        return size
    }
}

/// A formula in a line of text. Measured and drawn at its own width; drawn larger than it shows,
/// as the text's own size isn't known where it's drawn, and scaled down into its place.
struct InlineMath: Attachment {
    /// As written, and as drawn (see `MathText.drawable`).
    let latex: String
    let drawn: String
    /// Set as a formula of its own is (larger operators, limits above and below).
    let isDisplay: Bool

    var description: String { isDisplay ? "$$\(latex)$$" : "$\(latex)$" }
    var selectionStyle: AttachmentSelectionStyle { .text }

    private static let drawnSize: CGFloat = 40

    var body: some View {
        Math(drawn)
            .mathFont(.init(name: .latinModern, size: MathText.drawingSize(for: drawn, near: Self.drawnSize, display: isDisplay)))
            .mathTypesettingStyle(isDisplay ? .display : .text)
            .mathRenderingMode(.monochrome)
            .fixedSize()
    }

    func baselineOffset(in environment: TextEnvironmentValues) -> CGFloat {
        -bounds(in: environment).descent
    }

    func sizeThatFits(_ proposal: ProposedViewSize, in environment: TextEnvironmentValues) -> CGSize {
        bounds(in: environment).size
    }

    private func bounds(in environment: TextEnvironmentValues) -> Math.TypographicBounds {
        Math.typographicBounds(
            for: drawn,
            fitting: .unspecified,
            font: .init(name: .latinModern, size: FontScaled(MathText.scale).resolve(in: environment)),
            style: isDisplay ? .display : .text
        )
    }
}

/// A formula of its own, in the code block a reply's `$$…$$` became: centered at the size of the
/// text around it, and scrolling sideways when it's wider than the reply.
///
/// It's centered on a whole pixel: centered between two, its edges are rounded to pixels and it's
/// drawn a pixel narrower or wider than it measured, which SwiftUIMath sets again to fit, breaking
/// it onto a second line its height has no room for.
struct MathBlockView: View {
    /// As SwiftUIMath draws it (see `MathText.drawable`).
    let latex: String
    @Environment(\.messageFont) private var font
    @Environment(\.displayScale) private var displayScale
    @State private var room: CGFloat = 0

    var body: some View {
        let size = MathText.drawingSize(for: latex, near: font.size * MathText.scale, display: true)
        let width = Math.typographicBounds(for: latex, fitting: .unspecified, font: .init(name: .latinModern, size: size), style: .display).width
        let formula = Math(latex)
            .mathFont(.init(name: .latinModern, size: size))
            .mathTypesettingStyle(.display)
            .mathRenderingMode(.monochrome)
            .fixedSize()
            .accessibilityLabel(latex)
        ViewThatFits(in: .horizontal) {
            formula
                .padding(.leading, (max(0, room - width) / 2 * displayScale).rounded(.down) / displayScale)
                .frame(maxWidth: .infinity, alignment: .leading)
            ScrollView(.horizontal) {
                formula
            }
            .scrollIndicators(.automatic)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { room = $0 }
        .padding(.vertical, 6)
    }
}

/// Markdown with its math drawn (a file's preview); replies use `FileLinkingParser`, which does
/// the same.
struct MathMarkdownParser: MarkupParser {
    func attributedString(for input: String) throws -> AttributedString {
        try MathText.syntax.attributedString(markdown: input)
    }
}
