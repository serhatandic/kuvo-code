import ClientDesign
import SwiftUI

/// The bars in the card over the composer, in the order they show.
enum ComposerBar: Hashable {
    case goal, handoff, review, sideQuestion, subagents, background, wakes
}

/// A row of the card over the composer: a line under it, between it and the next.
struct CardRow: ViewModifier {
    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            Divider()
                .padding(.horizontal, 14)
                .allowsHitTesting(false)
        }
    }
}
