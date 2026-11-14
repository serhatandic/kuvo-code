import ClientDesign
import SwiftUI

extension View {
    /// The window's frosted glass, the surface the cards sit on.
    ///
    /// A behind-window material alone is so thin that another app's window behind
    /// this one shows through as shapes and even text (a dark app under a light
    /// window looked like a smudge). A tint matched to the appearance on top keeps
    /// the see-through feel, like Rex: what's behind comes through as colour only.
    ///
    /// Glass over flat grey reads as muddy grey, though, so the tint is kept light
    /// and carries a faint warm-to-cool light: the frame picks up colour from the
    /// desktop, and has a little of its own even over a grey one.
    func windowGlass() -> some View {
        modifier(WindowGlass())
    }
}

private struct WindowGlass: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @AppStorage(Look.windowKey) private var window = Look.Window.glass

    func body(content: Content) -> some View {
        if window == .solid {
            // Settings › Appearance: the same light, without the desktop showing through.
            content
                .containerBackground(Surface.canvasSolid(scheme), for: .window)
                .background(Surface.ambient(scheme).ignoresSafeArea())
        } else {
            content
                .containerBackground(.regularMaterial, for: .window)
                .background {
                    ZStack {
                        Surface.canvasTint(scheme)
                        Surface.ambient(scheme)
                    }
                    .ignoresSafeArea()
                }
        }
    }
}

/// A drag handle in the gap between two cards that resizes the card on one side.
struct PaneResizer: View {
    /// The card being resized is on this side of the handle.
    enum Side { case leading, trailing }

    @Binding var width: Double
    let range: ClosedRange<Double>
    let side: Side

    @State private var startWidth: Double?
    @State private var isHovering = false

    var body: some View {
        Rectangle()
            .fill(.clear)
            .frame(width: Metrics.paneGap)
            .overlay {
                // A faint line while hovering or dragging, so you can see what you're grabbing.
                Capsule()
                    .fill(.tint)
                    .frame(width: 3)
                    .padding(.vertical, 40)
                    .opacity(isHovering || startWidth != nil ? 0.5 : 0)
            }
            .contentShape(.rect)
            .pointerStyle(.columnResize)
            .onHover { hovering in withAnimation(.easeOut(duration: 0.15)) { isHovering = hovering } }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { drag in
                        let start = startWidth ?? width
                        startWidth = start
                        let delta = side == .leading ? drag.translation.width : -drag.translation.width
                        width = min(max(start + delta, range.lowerBound), range.upperBound)
                    }
                    .onEnded { _ in startWidth = nil }
            )
            .help("Drag to resize")
    }
}
