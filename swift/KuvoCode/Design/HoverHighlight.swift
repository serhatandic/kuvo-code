import SwiftUI

/// A flat control: nothing behind it at rest, a soft fill under the pointer, and a
/// firmer one while it's the selected item. Used for sidebar rows and the composer's
/// pills, so controls sit in the surface instead of floating on it.
struct HoverHighlight<S: Shape>: ViewModifier {
    let shape: S
    var isSelected = false
    /// Secondary ink until the pointer is on it, for controls that shouldn't outshout what's
    /// around them (the composer's).
    var mutesInk = false
    @State private var isHovering = false

    func body(content: Content) -> some View {
        content
            .foregroundStyle(mutesInk && !isHovering ? AnyShapeStyle(.secondary) : AnyShapeStyle(.foreground))
            .background(fill, in: shape)
            .contentShape(shape)
            .onHover { isHovering = $0 }
            .clickablePointer()
            .animation(.easeOut(duration: 0.12), value: isHovering)
    }

    private var fill: Color {
        if isSelected { return Color.primary.opacity(0.08) }
        return isHovering ? Color.primary.opacity(0.06) : .clear
    }
}

extension View {
    func hoverHighlight<S: Shape>(in shape: S, selected: Bool = false, mutesInk: Bool = false) -> some View {
        modifier(HoverHighlight(shape: shape, isSelected: selected, mutesInk: mutesInk))
    }

    func hoverHighlight(selected: Bool = false) -> some View {
        hoverHighlight(in: RoundedRectangle(cornerRadius: 8), selected: selected)
    }
}
