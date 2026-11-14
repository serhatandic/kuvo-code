import SwiftUI

/// Shared measurements, so spacing and shapes stay consistent and nest concentrically.
public enum Metrics {
    /// The transcript and composer column. Long lines are hard to read.
    public static let readableWidth: CGFloat = 760
    public static let composerRadius: CGFloat = 14
    public static let cardRadius: CGFloat = 14
    /// A card's header bar: icon, title and actions.
    public static let cardHeaderHeight: CGFloat = 38
    /// The window's close, minimize and zoom buttons, with the tab bar hidden: the sidebar
    /// leaves this much above its first row for them, so they read as the list's first row.
    public static let windowControlsHeight: CGFloat = 26
    /// Space between cards, and between cards and the window's edge.
    public static let paneGap: CGFloat = 8
    public static let bubbleRadius: CGFloat = 18
    public static let gutter: CGFloat = 20
}

extension Animation {
    /// The app's default motion: quick, with a little give.
    public static var ui: Animation {
        #if DEBUG
        if let held = uiForTests { return held }
        #endif
        return standardUI
    }

    #if DEBUG
    /// Tests: the app's motion in place of `ui` (one held at a point of its way, to look at a
    /// frame of it).
    nonisolated(unsafe) public static var uiForTests: Animation?
    #endif

    private static let standardUI: Animation = {
        #if DEBUG
        // KUVO_DEMO_SLOW=<times>: slower, to look at a transition frame by frame.
        if let slow = ProcessInfo.processInfo.environment["KUVO_DEMO_SLOW"].flatMap(Double.init) {
            return .spring(response: 0.32 * slow, dampingFraction: 0.86)
        }
        #endif
        return .spring(response: 0.32, dampingFraction: 0.86)
    }()
}

/// What a fold opens and closes (a bar's rows, a step's details): shown only as far down as its
/// container has room for it yet, and fading as it goes, so it never shows past the container's
/// edge as the container closes over it. The container grows and shrinks by it, with the same
/// animation, and any space above it is inside it (a padding of its own, not its stack's spacing),
/// so the two edges stay together.
public struct FoldTransition: Transition {
    public init() {}

    public func body(content: Content, phase: TransitionPhase) -> some View {
        content
            .clipShape(FoldClip(shown: phase.isIdentity ? 1 : 0))
            .opacity(phase.isIdentity ? 1 : 0)
    }
}

extension Transition where Self == FoldTransition {
    public static var fold: FoldTransition { FoldTransition() }
}

/// The part of a fold's content in its container: the top `shown` of its height. Wide open once
/// it's all but all shown (the spring passes 1 and comes back), so nothing it draws past its
/// bounds (a shadow, a rim) is cut, or comes and goes as it settles.
nonisolated private struct FoldClip: Shape {
    var shown: CGFloat

    var animatableData: CGFloat {
        get { shown }
        set { shown = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let room: CGFloat = 10_000
        let open = rect.insetBy(dx: -room, dy: -room)
        guard shown < 0.995 else { return Path(open) }
        // Only the bottom edge cuts.
        return Path(CGRect(x: open.minX, y: open.minY, width: open.width, height: rect.minY - open.minY + rect.height * max(0, shown)))
    }
}

extension View {
    /// Centers content in the readable column.
    public func readableColumn() -> some View {
        frame(maxWidth: Metrics.readableWidth).frame(maxWidth: .infinity)
    }
}

extension Double {
    /// "$0.42", "<$0.01", or nothing for free.
    public var formattedCost: String? {
        guard self > 0 else { return nil }
        return self < 0.01 ? "<$0.01" : formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }
}

extension Int {
    /// 950, 12.4k, 1.2M
    public var compactTokens: String {
        formatted(.number.notation(.compactName).precision(.significantDigits(1...3)))
    }
}
