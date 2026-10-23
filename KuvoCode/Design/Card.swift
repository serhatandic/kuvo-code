import SwiftUI

/// The window's building block: a rounded pane floating on the window's glass,
/// with a header (icon, title, actions) and content. Like Rex, the focused card is
/// crisp (white in light mode) and the others a warm ivory, all of them opaque so
/// they read over any wallpaper. Edges are lit rather than outlined in gray, and a
/// soft shadow lifts the cards off the glass.
///
/// The header is a bar the content scrolls under: messages run on beneath it and
/// blur away instead of being cut off at a hard line.
struct Card<Icon: View, Actions: View, Content: View>: View {
    var title: String
    var detail: String?
    var isFocused = true
    /// The sidebar has no header bar: its first row is its title.
    var showsHeader = true
    /// False draws no card at all (no fill, edge or shadow): the content sits on the window's glass.
    var showsSurface = true
    /// The title being renamed, in place, in the header.
    var rename: CardRename? = nil
    /// What a click on the icon and title does (`onTitle`), with what it's called: a group
    /// chat's or a bot's editor, say.
    private var titleAction: (() -> Void)?
    private var titleHelp: String?
    @ViewBuilder var icon: () -> Icon
    @ViewBuilder var actions: () -> Actions
    @ViewBuilder var content: () -> Content

    @Environment(\.colorScheme) private var scheme
    @Environment(\.windowControlsInset) private var windowControlsInset
    @Environment(\.windowControlsTrailingInset) private var windowControlsTrailingInset

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Metrics.cardRadius)
        framedContent
            // Opaque fills inside the card (the terminal, pinned rows) match the card's own.
            .environment(\.cardIsFocused, isFocused)
            // On a solid card, text in its own colors: vibrant (as the window's glass makes it),
            // black came out a washed-out gray on white. Without a surface it's on the glass,
            // and stays vibrant, as a sidebar's is.
            .transformEnvironment(\.backgroundMaterial) { if showsSurface { $0 = nil } }
            .clipShape(shape)
            // The shadow comes from the fill alone, so it's drawn from one shape rather than
            // worked out again from everything in the card each time it scrolls.
            .background {
                if showsSurface {
                    shape
                        .fill(Surface.cardFill(scheme, focused: isFocused))
                        .shadow(color: shadowColor, radius: isFocused ? 16 : 6, y: isFocused ? 6 : 2)
                }
            }
            .specularRim(shape, strength: showsSurface ? 1 : 0)
            // The focused card's shadow falls on its neighbors, never theirs on it.
            .zIndex(isFocused ? 1 : 0)
            .animation(.ui, value: isFocused)
    }

    /// The content, under its header. The header takes its room at the top, so content that
    /// doesn't scroll starts below it, while scroll views run on beneath it and fade out there.
    @ViewBuilder private var framedContent: some View {
        if showsHeader {
            // The header's room is kept as safe area rather than given by a bar, so it's the
            // same whether or not the card reaches up into the window's title bar.
            // Exactly the room it's given, whatever its content would like: content wider than
            // that never pushes the cards beside it out of the window.
            content()
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                .safeAreaPadding(.top, Metrics.cardHeaderHeight)
                .overlay(alignment: .top) {
                    header.background(alignment: .top) { headerFade }
                }
        } else {
            content()
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        }
    }

    /// What scrolls up fades out in the card's own color just below the header, and is gone
    /// behind the title: no line cut off in mid-air, nothing showing through the words.
    private var headerFade: some View {
        Surface.cardFill(scheme, focused: isFocused)
            .mask {
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0),
                        .init(color: .black, location: 0.6),
                        .init(color: .black.opacity(0.75), location: 0.74),
                        .init(color: .black.opacity(0.3), location: 0.88),
                        .init(color: .clear, location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
            .frame(height: Metrics.cardHeaderHeight + 24)
            .allowsHitTesting(false)
    }

    private var header: some View {
        HStack(spacing: 8) {
            if let titleAction, rename == nil {
                Button(action: titleAction) {
                    HStack(spacing: 8) {
                        headerIcon
                        headerTitle
                    }
                }
                .buttonStyle(TextButtonStyle(outset: true, dimsAtRest: false))
                .help(titleHelp ?? "")
            } else {
                headerIcon
                headerTitle
            }
            Spacer(minLength: 8)
            HStack(spacing: 2) {
                actions()
            }
            .buttonStyle(CardActionStyle())
        }
        .padding(.leading, 14 + windowControlsInset)
        .padding(.trailing, 8 + windowControlsTrailingInset)
        .frame(height: Metrics.cardHeaderHeight)
        // The whole bar takes clicks, so nothing scrolled under it is clicked by accident; a
        // double-click on it does what one on a title bar does, as the cards' tops are the window's.
        .contentShape(.rect)
        .onTapGesture(count: 2) { TitleBarDoubleClick.perform() }
    }

    private var headerIcon: some View {
        icon()
            .frame(width: 16, height: 16)
            .foregroundStyle(isFocused ? .primary : .secondary)
    }

    private var headerTitle: some View {
        HStack(spacing: 0) {
            if let rename {
                InlineTitleField(original: rename.original, commit: rename.commit, cancel: rename.cancel)
                    .frame(maxWidth: 360)
                    .padding(.trailing, 6)
            } else {
                Text(title)
            }
            if let detail {
                Text(" | " + detail)
            }
        }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(isFocused ? .primary : .secondary)
        .lineLimit(1)
        .truncationMode(.middle)
    }

    /// The card with its icon and title as a button: `action` on a click, `help` its name.
    func onTitle(_ help: String?, _ action: (() -> Void)?) -> Self {
        var card = self
        card.titleHelp = help
        card.titleAction = action
        return card
    }

    /// Soft elevation in place of a dark outline: a wide, faint shadow, a little deeper under
    /// the focused card.
    private var shadowColor: Color {
        scheme == .dark
            ? .black.opacity(isFocused ? 0.36 : 0.22)
            : Surface.slate.opacity(isFocused ? 0.1 : 0.07)
    }
}

extension Card where Actions == EmptyView {
    init(title: String, detail: String? = nil, isFocused: Bool = true, showsHeader: Bool = true, showsSurface: Bool = true, @ViewBuilder icon: @escaping () -> Icon, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, detail: detail, isFocused: isFocused, showsHeader: showsHeader, showsSurface: showsSurface, icon: icon, actions: { EmptyView() }, content: content)
    }
}

/// A card's title, renamed in its header: what it was, and what's done once it's renamed or left.
struct CardRename {
    let original: String
    let commit: (String) -> Void
    let cancel: () -> Void
}

/// The quiet glyph buttons in a card header (split, expand, close).
struct CardActionStyle: ButtonStyle {
    @State private var isHovering = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: 13, weight: .regular))
            .foregroundStyle(isHovering ? .primary : .secondary)
            .frame(width: 26, height: 24)
            .background(configuration.isPressed ? Pressable.pressedFill : isHovering ? Pressable.hoverFill : .clear, in: .rect(cornerRadius: 6))
            .contentShape(.rect)
            .onHover { isHovering = $0 }
            .clickablePointer()
    }
}

extension EnvironmentValues {
    /// Room the leftmost card leaves at its top left for the window's close, minimize and zoom
    /// buttons, when the tab bar is hidden and they sit over it.
    @Entry var windowControlsInset: CGFloat = 0
    /// Room the rightmost card leaves at its top right for the panel button, when the tab bar is
    /// hidden and it sits over it.
    @Entry var windowControlsTrailingInset: CGFloat = 0
}

/// Drags the window, and a double-click does what one on a title bar does: behind the title bar
/// row's project and tabs, and where the title bar would be when the tab bar is hidden.
struct WindowDragArea: View {
    var body: some View {
        Color.clear
            .contentShape(.rect)
            .onTapGesture(count: 2) { TitleBarDoubleClick.perform() }
            .gesture(WindowDragGesture())
            .allowsWindowActivationEvents(true)
            // The title bar moves the window only while the pointer is on it (see TitleBarMoveGate).
            .background(TitleBarMoveGateInstaller())
    }
}

/// The window's own glass, around and between the cards: dragging it moves the window, and a
/// double-click does what a title bar's does, wherever the gap is (the top, the sides, the bottom).
/// Behind the cards, so it only gets the clicks nothing else takes.
struct WindowGapDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { GapView() }
    func updateNSView(_ view: NSView, context: Context) {}

    private final class GapView: NSView {
        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            if event.clickCount == 2 {
                TitleBarDoubleClick.perform()
            } else {
                TitleBarMoveGate.drag(window, with: event)
            }
        }

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    }
}

/// A double-click on a title bar, as System Settings › Desktop & Dock sets it: the window fills
/// the screen (or zooms), minimizes, or nothing happens. Our title bar row is our own views,
/// and they'd take the click before macOS saw it.
enum TitleBarDoubleClick {
    @MainActor static func perform() {
        guard let window = NSApp.currentEvent?.window ?? NSApp.keyWindow else { return }
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window.miniaturize(nil)
        case "None": break
        // Fill, Zoom ("Maximize"), or never changed.
        default: window.zoom(nil)
        }
    }
}
