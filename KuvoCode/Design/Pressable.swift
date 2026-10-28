import AppKit
import SwiftUI

/// How the app's small, chrome-less controls show they can be clicked: a clear shade at rest
/// (secondary, never the faint tertiary that reads as disabled), and under the pointer a fill
/// behind them and full-strength ink, darker while pressed.
enum Pressable {
    static let hoverFill = Color.primary.opacity(0.08)
    static let pressedFill = Color.primary.opacity(0.13)
}

extension View {
    /// The pointing hand over something you can click, while you can: with the hover fill, it's
    /// how a control without a border says so.
    func clickablePointer() -> some View {
        modifier(ClickablePointer())
    }
}

private struct ClickablePointer: ViewModifier {
    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View {
        content.pointerStyle(isEnabled ? .link : nil)
    }
}

/// A small icon button: the copy, undo and branch icons under messages, a card's actions.
struct IconButtonStyle: ButtonStyle {
    var width: CGFloat = 24
    var height: CGFloat = 22
    var cornerRadius: CGFloat = 6

    func makeBody(configuration: Configuration) -> some View {
        PressableLabel(configuration: configuration, cornerRadius: cornerRadius) {
            configuration.label
                .labelStyle(.iconOnly)
                .frame(width: width, height: height)
        }
    }
}

/// A small text (or icon and text) button, like a code block's Copy or a link under a reply:
/// it gets the same fill under the pointer, padded so the fill clears the text. `outset` lets
/// the fill reach past the text without moving it, for text that lines up with what's around
/// it (a step in the transcript, the branch under the project's name).
struct TextButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = 5
    var outset = false
    /// False for a button that reads as a title (a menu of what a panel shows): it keeps its own ink.
    var dimsAtRest = true

    func makeBody(configuration: Configuration) -> some View {
        PressableLabel(configuration: configuration, cornerRadius: cornerRadius, dimsAtRest: dimsAtRest) {
            configuration.label
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
        }
        .padding(.horizontal, outset ? -6 : 0)
        .padding(.vertical, outset ? -3 : 0)
    }
}

private struct PressableLabel<Label: View>: View {
    let configuration: ButtonStyleConfiguration
    let cornerRadius: CGFloat
    var dimsAtRest = true
    @ViewBuilder let label: () -> Label
    @State private var isHovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        label()
            .foregroundStyle(isHovering && isEnabled || !dimsAtRest ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
            .background(fill, in: .rect(cornerRadius: cornerRadius))
            .contentShape(.rect(cornerRadius: cornerRadius))
            .opacity(isEnabled ? 1 : 0.45)
            .onHover { isHovering = $0 }
            .clickablePointer()
            .animation(.easeOut(duration: 0.12), value: isHovering)
    }

    private var fill: Color {
        guard isEnabled else { return .clear }
        if configuration.isPressed { return Pressable.pressedFill }
        return isHovering ? Pressable.hoverFill : .clear
    }
}

/// The clear (×) button at the end of a search field: it brightens under the pointer, as the
/// system's own search fields do.
struct ClearFieldButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ClearFieldButton(configuration: configuration)
    }

    private struct ClearFieldButton: View {
        let configuration: ButtonStyleConfiguration
        @State private var isHovering = false

        var body: some View {
            configuration.label
                .foregroundStyle(configuration.isPressed ? AnyShapeStyle(.primary) : isHovering ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tertiary))
                .contentShape(.circle)
                .onHover { isHovering = $0 }
                .clickablePointer()
        }
    }
}

/// A remove (−) button in a list of settings: it turns red under the pointer, so it reads as
/// both clickable and what it does.
struct RemoveButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RemoveButton(configuration: configuration)
    }

    private struct RemoveButton: View {
        let configuration: ButtonStyleConfiguration
        @State private var isHovering = false

        var body: some View {
            configuration.label
                .foregroundStyle(isHovering || configuration.isPressed ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                .opacity(configuration.isPressed ? 0.7 : 1)
                .contentShape(.circle)
                .onHover { isHovering = $0 }
                .clickablePointer()
        }
    }
}

/// A small white-on-gray badge button on a corner, like an attachment's remove (×): the gray
/// deepens under the pointer.
struct BadgeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        BadgeButton(configuration: configuration)
    }

    private struct BadgeButton: View {
        let configuration: ButtonStyleConfiguration
        @State private var isHovering = false

        var body: some View {
            configuration.label
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, isHovering || configuration.isPressed ? Color(white: 0.35) : .gray)
                .contentShape(.circle)
                .onHover { isHovering = $0 }
                .clickablePointer()
        }
    }
}

/// A row in a pick list (the palette, Open Quickly, "@" and "/" suggestions): tinted when it's
/// the chosen one, a soft fill under the pointer otherwise.
struct ListRowButtonStyle: ButtonStyle {
    let isSelected: Bool
    var cornerRadius: CGFloat = 7

    func makeBody(configuration: Configuration) -> some View {
        ListRow(configuration: configuration, isSelected: isSelected, cornerRadius: cornerRadius)
    }

    private struct ListRow: View {
        let configuration: ButtonStyleConfiguration
        let isSelected: Bool
        let cornerRadius: CGFloat
        @State private var isHovering = false

        var body: some View {
            configuration.label
                .background(fill, in: .rect(cornerRadius: cornerRadius))
                .contentShape(.rect(cornerRadius: cornerRadius))
                .onHover { isHovering = $0 }
                .clickablePointer()
        }

        private var fill: AnyShapeStyle {
            if isSelected { return AnyShapeStyle(.tint.opacity(configuration.isPressed ? 0.24 : 0.16)) }
            if configuration.isPressed { return AnyShapeStyle(Pressable.pressedFill) }
            return isHovering ? AnyShapeStyle(Pressable.hoverFill) : AnyShapeStyle(.clear)
        }
    }
}

/// A filled chip or strip that's a button (the composer's comment count, a fold of unchanged
/// lines): its fill deepens under the pointer.
struct FilledButtonStyle<S: Shape>: ButtonStyle {
    let shape: S
    var rest = 0.05

    func makeBody(configuration: Configuration) -> some View {
        Filled(configuration: configuration, shape: shape, rest: rest)
    }

    private struct Filled: View {
        let configuration: ButtonStyleConfiguration
        let shape: S
        let rest: Double
        @State private var isHovering = false

        var body: some View {
            configuration.label
                .background(Color.primary.opacity(configuration.isPressed ? rest + 0.1 : isHovering ? rest + 0.05 : rest), in: shape)
                .contentShape(shape)
                .onHover { isHovering = $0 }
                .clickablePointer()
                .animation(.easeOut(duration: 0.12), value: isHovering)
        }
    }
}

/// The little chevron that tells a title or a label opens a menu.
struct MenuChevron: View {
    var body: some View {
        Image(systemName: "chevron.down")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(.secondary)
            // It only says there's a menu, which VoiceOver says itself ("Go Down" otherwise).
            .accessibilityHidden(true)
    }
}

/// A small accent-colored button, like the "+" that comments on a line of a diff: it grows a
/// little and deepens under the pointer.
struct AccentBadgeButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        AccentBadge(configuration: configuration)
    }

    private struct AccentBadge: View {
        let configuration: ButtonStyleConfiguration
        @State private var isHovering = false

        var body: some View {
            configuration.label
                .brightness(configuration.isPressed ? -0.15 : isHovering ? -0.07 : 0)
                .scaleEffect(isHovering ? 1.12 : 1)
                .onHover { isHovering = $0 }
                .clickablePointer()
                .animation(.easeOut(duration: 0.12), value: isHovering)
        }
    }
}

/// Hover that still arrives under a view that takes the pointer, like the text selection Textual
/// lays over a whole reply: an AppKit tracking area sees the pointer whatever is on top of it.
/// Put it behind the control; it never takes clicks. It also shows `cursor` there: the layer on
/// top sets its own (Textual's I-beam) on every move, so this sets it again just after.
struct HoverTracker: NSViewRepresentable {
    var cursor: NSCursor? = .pointingHand
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> TrackingView { TrackingView(cursor: cursor, changed: changed) }

    func updateNSView(_ view: TrackingView, context: Context) {
        view.cursor = cursor
        view.changed = changed
    }

    final class TrackingView: NSView {
        var cursor: NSCursor?
        var changed: (Bool) -> Void
        private var isInside = false

        init(cursor: NSCursor?, changed: @escaping (Bool) -> Void) {
            self.cursor = cursor
            self.changed = changed
            super.init(frame: .zero)
            addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeInActiveApp, .inVisibleRect], owner: self))
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func mouseEntered(with event: NSEvent) {
            isInside = true
            changed(true)
            showCursor()
        }

        override func mouseMoved(with event: NSEvent) { showCursor() }

        override func mouseExited(with event: NSEvent) {
            isInside = false
            changed(false)
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        /// Now, and again once the event has been handled, after whatever set the cursor on top.
        private func showCursor() {
            guard let cursor else { return }
            cursor.set()
            DispatchQueue.main.async { [weak self] in
                if self?.isInside == true { cursor.set() }
            }
        }
    }
}
