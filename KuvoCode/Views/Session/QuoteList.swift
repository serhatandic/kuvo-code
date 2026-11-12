import AppKit
import ClientDesign
import ClientText
import SwiftUI

/// The quotes you're answering, each with your answer under it: as tall as they are up to a
/// point, then they scroll, made as they come into view (there can be hundreds), with the
/// one you're answering in view. A quote's own field shows while it has words or the keyboard,
/// or once you click the quote; the rest are only the quotes, over the composer's own field.
struct QuoteList: View {
    @Binding var quotes: [Drafts.Quote]
    /// The quote whose answer is to take the keyboard.
    let focus: (id: UUID, request: MessageField.FocusRequest)?
    /// Each change lets go of the keyboard.
    var blur = 0
    let font: NSFont
    /// Pictures attached to the message, which an answer can name.
    var images = 0
    var onKey: (MessageField.Key) -> Bool
    /// An answer took the keyboard (true) or let it go.
    var onFocus: (UUID, Bool) -> Void
    var onPaste: (NSPasteboard) -> [String]? = { _ in nil }
    /// How tall they are together, measured as they lay out.
    @State private var height: CGFloat = 0
    @State private var position = ScrollPosition(idType: UUID.self)
    /// The quote whose field shows though it's empty: the one you clicked, or that took the keyboard.
    @State private var open: UUID?
    /// Clicking a quote gives its field the keyboard.
    @State private var clicked: (id: UUID, request: MessageField.FocusRequest)?

    private static let tallest: CGFloat = 260
    /// How far its edges fade, where there's more past them.
    static let fade: CGFloat = 14

    /// Your answer to a quote, found by its ID each time: a field on its way out (the quote was
    /// just dropped) reads nothing rather than a place in the list that's gone, which crashed.
    private func response(to id: UUID) -> Binding<String> {
        Binding(
            get: { quotes.first { $0.id == id }?.response ?? "" },
            set: { text in
                guard let index = quotes.firstIndex(where: { $0.id == id }) else { return }
                quotes[index].response = text
            }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if quotes.count > 1 {
                HStack {
                    Text("\(quotes.count) quotes")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Remove All") { withAnimation(.ui) { quotes.removeAll() } }
                        .buttonStyle(TextButtonStyle())
                        .font(.subheadline)
                }
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(quotes) { quote in
                        VStack(alignment: .leading, spacing: 6) {
                            // "Replying to" once there's one; with more, the count above says it.
                            QuoteCard(text: quote.text, says: quotes.count == 1) {
                                let id = quote.id
                                withAnimation(.ui) { quotes.removeAll { $0.id == id } }
                            }
                            .contentShape(.rect)
                            .onTapGesture { answer(quote.id) }
                            .clickablePointer()
                            .accessibilityAction(named: "Answer This") { answer(quote.id) }
                            if !quote.response.isEmpty || open == quote.id {
                                MessageField(text: response(to: quote.id), placeholder: "Your answer to this…", font: font, maxLines: 10,
                                             focus: focus?.id == quote.id ? focus?.request : (clicked?.id == quote.id ? clicked?.request : nil),
                                             blur: blur, images: images,
                                             onKey: onKey, onFocus: { focused in
                                                 onFocus(quote.id, focused)
                                                 if focused {
                                                     open = quote.id
                                                 } else if open == quote.id, quotes.first(where: { $0.id == quote.id })?.response.isEmpty != false {
                                                     withAnimation(.ui) { open = nil }
                                                 }
                                             }, onPaste: onPaste, identifier: "quote-answer", label: "Your Answer", edgeRoom: Self.fade)
                                    .padding(.leading, 12)
                                    .padding(.bottom, 4)
                                    .transition(.opacity)
                            }
                        }
                        .id(quote.id)
                        .transition(.opacity.combined(with: .offset(y: 4)))
                    }
                }
                .scrollTargetLayout()
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            }
            .scrollPosition($position)
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(height > Self.tallest ? .automatic : .never)
            // Taller than it shows: it fades out at an edge with more past it, rather than being
            // cut there; at its end, nothing's faded.
            .fadingScrollEdges(Self.fade)
            // Its own height until it's measured, so it doesn't take the window's first.
            .frame(height: height == 0 ? nil : min(height, Self.tallest))
            .fixedSize(horizontal: false, vertical: height == 0)
            .onChange(of: focus?.id, initial: true) { _, id in
                guard let id else { return }
                open = id
                Task {
                    await Task.yield()
                    position.scrollTo(id: id)
                }
            }
        }
    }

    private func answer(_ id: UUID) {
        withAnimation(.ui) { open = id }
        clicked = (id: id, request: MessageField.FocusRequest())
    }
}
