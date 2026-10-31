import AppKit
import Observation
import SwiftUI

/// A card of the host's at the foot of the dashboard, above the footer's own row (fork addition:
/// Kuvo Code's "Working in the background", while its window is closed). Nil shows none.
@MainActor @Observable
public final class HostCard {
    public static let shared = HostCard()
    public var content: AnyView?
    /// What the panel's Quit items (the Options menu's and the right-click menu's) do in place of
    /// quitting, while set: Kuvo Code's "Stop Background Work…", while Quit only takes it to the
    /// menu bar. Nil quits.
    public var quitItem: HostQuitItem?

    private init() {}

    /// The panel's Quit: the host's own while it set one, else the app quits.
    static func quit() {
        if let quitItem = shared.quitItem { quitItem.action() } else { NSApplication.shared.terminate(nil) }
    }

    /// The Quit items' title: the host's own while it set one.
    static var quitTitle: String { shared.quitItem?.title ?? "Quit \(HostApp.name)" }
}

/// The host's own Quit for the panel's menus (fork addition).
public struct HostQuitItem {
    public let title: String
    public let action: @MainActor () -> Void

    public init(title: String, action: @escaping @MainActor () -> Void) {
        self.title = title
        self.action = action
    }
}

extension View {
    /// The panel's grouped-card surface, for the host's card to sit on as the panel's own cards do
    /// (fork addition).
    public func panelCardSurface() -> some View {
        cardSurface()
    }

    /// A button on the panel's glass capsule, as the footer's Options is: its label stays as
    /// bright before the panel has the keyboard as after, where the system's glass button draws
    /// it dimmed (fork addition).
    public func panelGlassButton() -> some View {
        modifier(PanelGlassButton())
    }
}

private struct PanelGlassButton: ViewModifier {
    @Environment(PopoverTransparencyStore.self) private var transparency

    func body(content: Content) -> some View {
        content
            .font(.system(size: 13, weight: .semibold))
            .frame(height: 28)
            .contentShape(Capsule())
            .buttonStyle(.plain)
            .interactiveGlass(in: Capsule(), reinforced: transparency.effectiveStyle.needsChromeLegibilityBacking)
    }
}
