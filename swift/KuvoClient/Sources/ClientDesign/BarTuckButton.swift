import SwiftUI

/// Tucks the whole card over the composer into its one line (`BarTuck`): a small control of the
/// card's own, apart from each bar's chevron, which folds only that bar. It sits over the card's
/// top edge at its right, above the bars' chevrons, rather than taking a row of the card: put it
/// there with `barTuckControl`. The Mac's and the phone's.
public struct BarTuckButton: View {
    private let hide: () -> Void
    public init(hide: @escaping () -> Void) { self.hide = hide }

    #if os(iOS)
    /// As drawn; a finger's 44 to tap (`TuckStyle`).
    nonisolated static let size = CGSize(width: 44, height: 26)
    /// How far it stands over the card's top edge: the rest is over the card.
    nonisolated static let above: CGFloat = 17
    /// From the card's right edge: centered over the bars' chevrons.
    nonisolated static let trailing: CGFloat = 4
    #else
    nonisolated static let size = CGSize(width: 32, height: 18)
    nonisolated static let above: CGFloat = 12
    nonisolated static let trailing: CGFloat = 4
    #endif

    public var body: some View {
        Button(action: hide) {
            Image(systemName: "chevron.down.2")
                .font(.system(size: 11, weight: .semibold))
                .frame(width: Self.size.width, height: Self.size.height)
        }
        .buttonStyle(TuckStyle())
        .accessibilityLabel("Fold all bars")
        // Read ahead of the bars, as it's over them, not after the composer.
        .accessibilitySortPriority(1)
        .help("Fold all bars into one line")
    }
}

extension View {
    /// The card over the composer with its fold-all control (`BarTuckButton`) over its top edge,
    /// while `isShown`: room is kept over the card for what of it stands above the edge, so the
    /// conversation's last line stays clear of it.
    public func barTuckControl(isShown: Bool, hide: @escaping () -> Void) -> some View {
        overlay(alignment: .topTrailing) {
            if isShown {
                BarTuckButton(hide: hide)
                    .padding(.trailing, BarTuckButton.trailing)
                    // Up by `above`: its top that far over the card's.
                    .alignmentGuide(.top) { $0[.top] + BarTuckButton.above }
                    .transition(.opacity)
            }
        }
        .padding(.top, isShown ? BarTuckButton.above : 0)
    }
}

/// A small glass capsule, as other controls that float over the conversation are: secondary ink
/// at rest, the app's fills under the pointer and while pressed (the Mac's Pressable).
private struct TuckStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Tuck(configuration: configuration)
    }

    private struct Tuck: View {
        let configuration: ButtonStyleConfiguration
        @State private var isHovering = false

        var body: some View {
            let isLit = isHovering || configuration.isPressed
            configuration.label
                .foregroundStyle(isLit ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .background(Color.primary.opacity(configuration.isPressed ? 0.13 : isHovering ? 0.08 : 0), in: .capsule)
                .glassEffect(.regular.interactive(), in: .capsule)
                #if os(iOS)
                // Drawn at 26 high, 44 to tap: grown upward only, over the conversation, never
                // further into the card than it's drawn, where the first bar's own buttons are.
                .contentShape(TapRoom(above: 44 - BarTuckButton.size.height))
                #else
                .contentShape(.capsule)
                .onHover { isHovering = $0 }
                .pointerStyle(.link)
                #endif
                .animation(.easeOut(duration: 0.12), value: isHovering)
        }
    }
}

/// Its shape, grown upward by `above`.
private struct TapRoom: Shape {
    let above: CGFloat

    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY - above, width: rect.width, height: rect.height + above))
    }
}
