import AppKit
import ClientDesign
import SwiftUI
import Textual

/// Code blocks in replies and Markdown: one recessed well with the code and its line numbers,
/// and the language and a Copy button in its top corner. A formula of its own, which a reply's
/// `$$…$$` became (`MathText`), is drawn as math instead (as code, should it not draw).
struct CopyableCodeBlockStyle: StructuredText.CodeBlockStyle {
    @ViewBuilder func makeBody(configuration: Configuration) -> some View {
        if configuration.languageHint == MathText.blockLanguage,
           let latex = (Mirror(reflecting: configuration.codeBlock).descendant("content") as? AttributedSubstring).map({ String($0.characters) }),
           let drawn = MathText.drawable(latex.trimmingCharacters(in: .whitespacesAndNewlines)) {
            MessageMath(latex: drawn)
        } else {
            CopyableCodeBlock(configuration: configuration)
        }
    }
}

private struct CopyableCodeBlock: View {
    let configuration: StructuredText.CodeBlockStyleConfiguration
    /// The code, which Textual keeps private: read from the copy action's proxy, once; nil (no
    /// numbers) if a Textual update moves it.
    private let content: AttributedSubstring?
    /// How many lines it has, for their numbers.
    private let lineCount: Int?
    private let firstLine: String?
    @State private var copied = false
    @State private var isHoveringCopy = false
    /// What decides whether the first line would run in under the corner: the code's room, and
    /// the corner's size.
    @State private var codeWidth: CGFloat = 0
    @State private var cornerSize: CGSize = .zero
    @Environment(\.colorScheme) private var scheme
    @Environment(\.cardIsFocused) private var cardIsFocused
    @Environment(\.findHighlight) private var highlight
    @Environment(\.messageFont) private var font

    private static let shape = RoundedRectangle(cornerRadius: 10)
    /// The same room above and below the code.
    private static let inset: CGFloat = 12

    init(configuration: StructuredText.CodeBlockStyleConfiguration) {
        self.configuration = configuration
        let content = Mirror(reflecting: configuration.codeBlock).descendant("content") as? AttributedSubstring
        self.content = content
        lineCount = content.map { $0.unicodeScalars.reduce(1) { $1 == "\n" ? $0 + 1 : $0 } }
        firstLine = content.map { String($0.characters.prefix { $0 != "\n" }) }
    }

    /// The first line is too long to share its row with the corner: the code starts below it,
    /// so nothing is hidden under the language and Copy. Its width from the font's advance, a
    /// little larger than the code is set, to be safe. Not laid out as text: doing that here,
    /// while SwiftUI lays the conversation out, could crash in CoreText.
    private var clearsCorner: Bool {
        guard let firstLine, !firstLine.isEmpty, codeWidth > 0 else { return false }
        let width = CodeLine.width(of: firstLine, advance: Self.advance(font.size - 1.5))
        return 14 + width + 8 > codeWidth - cornerSize.width
    }

    /// The monospaced system font's advance at `size`, from its metrics.
    private static func advance(_ size: CGFloat) -> CGFloat {
        if let known = advances[size] { return known }
        let advance = NSFont.monospacedSystemFont(ofSize: size, weight: .regular).maximumAdvancement.width
        advances[size] = advance
        return advance
    }

    private static var advances: [CGFloat: CGFloat] = [:]

    /// The code with Find's marks in it, while Find has places there: drawn without its colors,
    /// as the highlighter colors it over the marks.
    private var marked: AttributedString? {
        guard highlight != nil, let content, content.runs.contains(where: { $0.attributes.swiftUI.backgroundColor != nil }) else { return nil }
        var code = AttributedString(content)
        if code.characters.last == "\n" { code.characters.removeLast() }
        return code
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // Beside the code, not in it: selecting and copying code never takes the numbers.
            if let lineCount, lineCount > 1 {
                LineNumbers(count: lineCount)
                    .padding(.leading, 12)
                    .padding(.vertical, Self.inset)
            }
            Overflow {
                Group {
                    if let marked {
                        // Set as the code is, so the numbers still line up.
                        Text(marked)
                            .font(.system(size: font.size * 0.85, design: .monospaced))
                            .lineSpacing(font.size * 0.85 * 0.225)
                    } else {
                        configuration.label
                    }
                }
                    .textual.lineSpacing(.fontScaled(0.225))
                    .textual.fontScale(0.85)
                    .fixedSize(horizontal: false, vertical: true)
                    .monospaced()
                    .padding(.horizontal, 14)
                    .padding(.vertical, Self.inset)
            }
            .onGeometryChange(for: CGFloat.self, of: \.size.width) { codeWidth = $0 }
        }
        // Room above the code for the corner, when its first line would reach in under it.
        .padding(.top, clearsCorner ? max(0, cornerSize.height - Self.inset + 2) : 0)
        // Outside the scrolling code, so they stay in the corner when long lines scroll sideways.
        // They float over the first line's end, or above a first line that would reach them.
        .overlay(alignment: .topTrailing) {
            corner
                .padding(.leading, 28)
                .padding(.trailing, 6)
                .padding(.vertical, 6)
                .onGeometryChange(for: CGSize.self, of: \.size) { cornerSize = $0 }
                .background { cornerBackdrop }
        }
        .clipShape(Self.shape)
        .recessedWell(Self.shape)
        .textual.blockSpacing(.init(top: 0, bottom: 16))
        #if DEBUG
        .onAppear { ScrollFrameMonitor.codeBlocksMade += 1 }
        #endif
    }

    /// The well's own color, solid, fading in from the left: code under the corner disappears
    /// into it instead of running into the words.
    private var cornerBackdrop: some View {
        ZStack {
            Surface.cardFill(scheme, focused: cardIsFocused)
            Surface.well(scheme)
        }
        .mask {
            HStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: 28)
                Color.black
            }
        }
        .allowsHitTesting(false)
    }

    private var corner: some View {
        HStack(spacing: 2) {
            Text(CodeLanguage.name(of: configuration.languageHint))
                .foregroundStyle(.tertiary)
            Button {
                configuration.codeBlock.copyToPasteboard()
                withAnimation(.ui) { copied = true }
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    withAnimation(.ui) { copied = false }
                }
            } label: {
                // As wide as "Copied", so the language beside it stays put when it changes.
                ZStack {
                    Label("Copied", systemImage: "checkmark")
                        .hidden()
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .buttonStyle(CornerButtonStyle(isHovering: isHoveringCopy))
            .clickablePointer()
            .background(HoverTracker { isHoveringCopy = $0 })
            .help("Copy Code")
        }
        .font(.system(size: 11, weight: .medium))
    }
}

/// Copy's look: TextButtonStyle's, with the hover handed in from a tracking area.
private struct CornerButtonStyle: ButtonStyle {
    let isHovering: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .foregroundStyle(isHovering ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .background(configuration.isPressed ? Pressable.pressedFill : isHovering ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: 5))
            .contentShape(.rect(cornerRadius: 5))
            .animation(.easeOut(duration: 0.12), value: isHovering)
    }
}

/// A code block's line numbers, one per line of the code beside it, in one text set as the code
/// is (its font at 0.85 of the messages' size, Textual's spacing of 0.225 of that between lines).
/// The code's lines never wrap (long ones scroll sideways), so the numbers line up with them.
private struct LineNumbers: View {
    let count: Int
    @Environment(\.messageFont) private var font

    var body: some View {
        let size = font.size * 0.85
        Text(verbatim: Self.numbers(count))
            .font(.system(size: size, design: .monospaced))
            .lineSpacing(size * 0.225)
            .multilineTextAlignment(.trailing)
            .foregroundStyle(.tertiary)
            .fixedSize()
            .textSelection(.disabled)
            .accessibilityHidden(true)
    }

    /// "1\n2\n…\ncount".
    private static func numbers(_ count: Int) -> String {
        (1...max(count, 1)).map(String.init).joined(separator: "\n")
    }
}

/// A formula on its own line, at the size of the message text it's in.
private struct MessageMath: View {
    let latex: String
    @Environment(\.messageFont) private var font

    var body: some View {
        MathBlockView(latex: latex, textSize: font.size)
    }
}
