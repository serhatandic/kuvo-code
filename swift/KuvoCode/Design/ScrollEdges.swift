import SwiftUI

/// A scroll view that ends at its own edges: what's scrolled out of sight fades out there, rather
/// than showing past them, under the window's buttons and the sidebar button above the sidebar
/// (macOS lets a scroll view's content draw outside it). Like the system's own sidebars.
struct FadingScrollEdges: ViewModifier {
    var length: CGFloat = 16
    /// Which way it scrolls: its top and bottom fade, or its leading and trailing edges.
    var axis: Axis = .vertical
    @State private var hidden = Ends()

    struct Ends: Equatable {
        var top = false
        var bottom = false
    }

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: Ends.self) { geometry in
                axis == .vertical
                    ? Ends(top: geometry.visibleRect.minY > 1, bottom: geometry.visibleRect.maxY < geometry.contentSize.height - 1)
                    : Ends(top: geometry.visibleRect.minX > 1, bottom: geometry.visibleRect.maxX < geometry.contentSize.width - 1)
            } action: { _, ends in hidden = ends }
            .mask {
                if axis == .vertical {
                    VStack(spacing: 0) {
                        LinearGradient(colors: [hidden.top ? .clear : .black, .black], startPoint: .top, endPoint: .bottom)
                            .frame(height: length)
                        Color.black
                        LinearGradient(colors: [.black, hidden.bottom ? .clear : .black], startPoint: .top, endPoint: .bottom)
                            .frame(height: length)
                    }
                } else {
                    HStack(spacing: 0) {
                        LinearGradient(colors: [hidden.top ? .clear : .black, .black], startPoint: .leading, endPoint: .trailing)
                            .frame(width: length)
                        Color.black
                        LinearGradient(colors: [.black, hidden.bottom ? .clear : .black], startPoint: .leading, endPoint: .trailing)
                            .frame(width: length)
                    }
                }
            }
    }
}

extension View {
    /// See `FadingScrollEdges`.
    func fadingScrollEdges(_ length: CGFloat = 16, axis: Axis = .vertical) -> some View {
        modifier(FadingScrollEdges(length: length, axis: axis))
    }
}
