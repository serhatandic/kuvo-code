import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// What a conversation is up to, as one family of small round marks: the sidebar's rows, the tabs,
/// a bot's face. Only three of them move, each for a reason: working turns and breathes, needs you
/// sends a ripple out (the only mark that reaches outward), and new settles once as it arrives.
/// The rest stay still. Played by Core Animation, every loop on one clock, so a long list of them
/// moves in step and costs the app nothing from frame to frame.
public struct StatusMark: View {
    public enum Kind: Hashable, Sendable {
        /// Its agent is at work.
        case working
        /// Its own turn is over, and subagents it started are still at it.
        case subagents
        /// It waits on you: a permission, a question, a sign-in.
        case needsYou
        /// Finished since you were last there.
        case new
        /// Its last run failed.
        case failed
        /// It wakes itself up later.
        case wake
        /// It watches for a change.
        case watching
        case paused
        /// What you sent waits for its computer to come back.
        case waitingForComputer
        /// Its computer isn't connected.
        case offline

        /// What VoiceOver says for it, after the row's title.
        /// On a folded row (a session's branches, a project), a mark that comes from a
        /// conversation under it, in words.
        public var wordsFromUnder: String {
            switch self {
            case .needsYou: "One under it needs you"
            case .working: "One under it is working"
            case .subagents: "One under it has subagents at work"
            case .failed: "One under it failed"
            case .new: "One under it is done"
            default: words
            }
        }

        public var words: String {
            switch self {
            case .working: "Working"
            case .subagents: "Subagents at work"
            case .needsYou: "Needs you"
            case .new: "New"
            case .failed: "Failed"
            case .wake: "Wakes up later"
            case .watching: "Watching for a change"
            case .paused: "Paused"
            case .waitingForComputer: "Waiting for its computer"
            case .offline: "Not connected"
            }
        }
    }

    let kind: Kind?
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.markInk) private var markInk

    public init(_ kind: Kind, size: CGFloat = 14) {
        self.kind = kind
        self.size = size
    }

    /// A place that shows a state when there is one, and nothing (keeping its room) when there
    /// isn't: kept in place, a state that comes plays its arrival.
    public init(showing kind: Kind?, size: CGFloat = 14) {
        self.kind = kind
        self.size = size
    }

    /// The label it sits in, for its ink: see `markInk(_:)`.
    private var label: StatusMarkInk.Label {
        switch markInk {
        case .own: .standard
        case .control: isEnabled ? .standard : .disabled
        case .onFill: isEnabled ? .onFill : .disabled
        case .tinted(let color): isEnabled ? .tinted(color) : .disabled
        }
    }

    public var body: some View {
        StatusMarkHost(kind: kind, size: size, still: reduceMotion,
                       ink: StatusMarkInk(scheme: scheme, accent: accent, label: label))
            .frame(width: size, height: size)
            // Beside text, on its middle.
            .alignmentGuide(.firstTextBaseline) { $0.height * 0.85 }
            .alignmentGuide(.lastTextBaseline) { $0.height * 0.85 }
            .accessibilityElement()
            .accessibilityLabel(kind?.words ?? "")
            .accessibilityHidden(kind == nil)
    }
}

/// A conversation's state for its mark, from what's known about it: the first that holds wins,
/// so what needs you is never hidden behind work, and work behind news.
public enum ConversationState {
    public static func kind(needsYou: Bool, working: Bool, subagentsOnly: Bool = false, failed: Bool, isNew: Bool,
                            offline: Bool = false, waitingForComputer: Bool = false, paused: Bool = false,
                            wakes: Bool = false, watching: Bool = false) -> StatusMark.Kind? {
        if needsYou { return .needsYou }
        if working { return subagentsOnly ? .subagents : .working }
        if offline { return .offline }
        if waitingForComputer { return .waitingForComputer }
        if failed { return .failed }
        if isNew { return .new }
        if paused { return .paused }
        if wakes { return .wake }
        if watching { return .watching }
        return nil
    }

    /// A folded project's mark, from its conversations': the most pressing of what calls you back
    /// to them (one waits on you, one is at work, one failed, one finished since you looked), so
    /// folding it hides none of that. Their other states (a wake-up, a computer away) stay theirs.
    public static func folded(_ kinds: some Sequence<StatusMark.Kind?>) -> StatusMark.Kind? {
        let order: [StatusMark.Kind] = [.needsYou, .working, .subagents, .failed, .new]
        var best: Int?
        for kind in kinds {
            guard let kind, let rank = order.firstIndex(of: kind), rank < best ?? order.count else { continue }
            if rank == 0 { return .needsYou }  // nothing outranks it: the rest needn't be looked at
            best = rank
        }
        return best.map { order[$0] }
    }
}

extension StatusMark {
    /// The colour a mark takes from the control it sits in, as the control's own words do.
    public enum Ink: Sendable {
        /// Its own ink, whatever is around it: a disabled container (a row while it sends) doesn't
        /// dim it, nor its words.
        case own
        /// A control's label that greys when it's disabled (a system button, a card's action): the
        /// same grey then.
        case control
        /// A filled accent button's white: its grey once it's disabled (a default or glass prominent
        /// button's, which loses its fill then).
        case onFill
        /// A colour of its own: a work item's In progress blue.
        case tinted(Color)
    }
}

extension View {
    /// The colour the marks in this view (a `Spinner` in a button's label) take from the control:
    /// grey with its words when it's disabled, or a filled accent button's white. Without it a
    /// mark keeps its own ink.
    public func markInk(_ ink: StatusMark.Ink) -> some View {
        environment(\.markInk, ink)
    }
}

extension EnvironmentValues {
    @Entry var markInk = StatusMark.Ink.own
}

/// The colours a mark draws with, resolved for its appearance.
struct StatusMarkInk: Equatable {
    /// What the mark sits in, for its ink: a label like any other, a filled accent button's white
    /// one, or a disabled control's grey one.
    enum Label: Equatable { case standard, onFill, disabled, tinted(Color) }

    var ink: Color.Resolved
    /// Quieter than ink, still clear of the row: a state that's away rather than at work.
    var muted: Color.Resolved
    var faint: Color.Resolved
    var accent: Color.Resolved
    var orange: Color.Resolved
    var red: Color.Resolved
    /// What's drawn on a red fill.
    var onRed: Color.Resolved

    init(scheme: ColorScheme, accent: Color, label: Label = .standard) {
        var environment = EnvironmentValues()
        environment.colorScheme = scheme
        // The ring and its track in the label's colour: the button's white on its fill, a disabled
        // control's grey (as dim as its words).
        switch label {
        case .standard:
            ink = Color.primary.opacity(0.6).resolve(in: environment)
            faint = Color.primary.opacity(0.16).resolve(in: environment)
        case .onFill:
            ink = Color.white.opacity(0.95).resolve(in: environment)
            faint = Color.white.opacity(0.32).resolve(in: environment)
        case .disabled:
            ink = Color.primary.opacity(0.3).resolve(in: environment)
            faint = Color.primary.opacity(0.1).resolve(in: environment)
        case .tinted(let color):
            ink = color.resolve(in: environment)
            faint = color.opacity(0.22).resolve(in: environment)
        }
        muted = Color.primary.opacity(0.38).resolve(in: environment)
        self.accent = accent.resolve(in: environment)
        orange = Color.orange.resolve(in: environment)
        red = Color.red.resolve(in: environment)
        onRed = Color.white.resolve(in: environment)
    }
}

#if os(macOS)
private struct StatusMarkHost: NSViewRepresentable {
    let kind: StatusMark.Kind?
    let size: CGFloat
    let still: Bool
    let ink: StatusMarkInk

    func makeNSView(context: Context) -> StatusMarkView { StatusMarkView() }

    func updateNSView(_ view: StatusMarkView, context: Context) {
        view.mark.show(kind, size: size, still: still, ink: ink)
    }
}

final class StatusMarkView: NSView {
    let mark = StatusMarkLayer()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        mark.isGeometryFlipped = true
        layer?.addSublayer(mark)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        mark.frame = bounds
        CATransaction.commit()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        mark.scale = window?.backingScaleFactor ?? 2
    }
}
#else
private struct StatusMarkHost: UIViewRepresentable {
    let kind: StatusMark.Kind?
    let size: CGFloat
    let still: Bool
    let ink: StatusMarkInk

    func makeUIView(context: Context) -> StatusMarkView { StatusMarkView() }

    func updateUIView(_ view: StatusMarkView, context: Context) {
        view.mark.show(kind, size: size, still: still, ink: ink)
    }
}

final class StatusMarkView: UIView {
    let mark = StatusMarkLayer()

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(mark)
        registerForTraitChanges([UITraitDisplayScale.self]) { (view: StatusMarkView, _) in view.mark.scale = view.traitCollection.displayScale }
    }

    // Its screen's scale is known once it's in a window.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        mark.scale = window?.screen.scale ?? traitCollection.displayScale
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        mark.frame = bounds
        CATransaction.commit()
    }
}
#endif

extension CALayer {
    /// When a loop of `period` starts on this layer so that it's at the same point as every other
    /// loop of that period on screen, however late it was added: all count from the media clock's
    /// zero. The marks, step rings, placeholders and lines that move together use it.
    func sharedClockStart(period: CFTimeInterval) -> CFTimeInterval {
        let now = CACurrentMediaTime()
        return convertTime(now, from: nil) - now.truncatingRemainder(dividingBy: period)
    }
}

/// The mark's layers, drawn in a 16-point square scaled to its size, and its motion as keyframes.
final class StatusMarkLayer: CALayer {
    private var shown: (kind: StatusMark.Kind?, size: CGFloat, still: Bool, ink: StatusMarkInk)?
    var scale: CGFloat = 2 {
        didSet { if scale != oldValue { sublayers?.forEach { $0.contentsScale = scale } } }
    }

    func show(_ kind: StatusMark.Kind?, size: CGFloat, still: Bool, ink: StatusMarkInk) {
        if let shown, shown.kind == kind, shown.size == size, shown.still == still, shown.ink == ink { return }
        // A change of state on screen arrives with its own small motion; one first drawn doesn't,
        // so rows scrolled into view stay calm.
        let arrives = shown.map { $0.kind != kind } ?? false
        shown = (kind, size, still, ink)
        build(kind, size: size, still: still, ink: ink, arrives: arrives && !still)
    }

    // MARK: Drawing

    private func build(_ kind: StatusMark.Kind?, size: CGFloat, still: Bool, ink: StatusMarkInk, arrives: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        sublayers?.forEach { $0.removeFromSuperlayer() }
        removeAllAnimations()
        guard let kind else { return }
        let k = size / 16
        let line = max(1.2, 1.5 * k)
        let box = CGRect(x: 0, y: 0, width: size, height: size)
        let center = CGPoint(x: size / 2, y: size / 2)

        func shape(_ path: CGPath, stroke: Color.Resolved? = nil, fill: Color.Resolved? = nil, width: CGFloat = line, dash: [CGFloat]? = nil) -> CAShapeLayer {
            let layer = CAShapeLayer()
            layer.frame = box
            layer.path = path
            layer.fillColor = fill?.cgColor
            layer.strokeColor = stroke?.cgColor
            layer.lineWidth = width
            layer.lineCap = .round
            layer.lineJoin = .round
            layer.lineDashPattern = dash?.map { NSNumber(value: Double($0 * k)) }
            layer.contentsScale = scale
            addSublayer(layer)
            return layer
        }
        func circle(_ r: CGFloat) -> CGPath {
            // From the top, clockwise, so a part of it starts at twelve o'clock.
            let path = CGMutablePath()
            path.addArc(center: center, radius: r * k, startAngle: -.pi / 2, endAngle: 3 * .pi / 2, clockwise: false)
            return path
        }
        func lines(_ segments: [(CGPoint, CGPoint)]) -> CGPath {
            let path = CGMutablePath()
            for (a, b) in segments {
                path.move(to: CGPoint(x: a.x * k, y: a.y * k))
                path.addLine(to: CGPoint(x: b.x * k, y: b.y * k))
            }
            return path
        }
        func dot(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) -> CGPath {
            CGPath(ellipseIn: CGRect(x: (x - r) * k, y: (y - r) * k, width: 2 * r * k, height: 2 * r * k), transform: nil)
        }

        switch kind {
        case .working:
            _ = shape(circle(6), stroke: ink.faint)
            let arc = shape(circle(6), stroke: ink.ink)
            arc.strokeEnd = 0.32
            if !still {
                loop(arc, "transform.rotation.z", values: [0, 2 * Double.pi], period: 1.6, timing: .linear)
                loop(arc, "strokeEnd", values: [0.19, 0.45, 0.19], period: 3.2, timing: .easeInEaseOut)
            }
        case .subagents:
            let segments = shape(circle(6), stroke: ink.ink, dash: [8.6, 4])
            _ = shape(dot(8, 8, 1.6), fill: ink.ink)
            if !still {
                loop(segments, "transform.rotation.z", values: [0, 2 * Double.pi], period: 4.8, timing: .linear)
                loop(segments, "opacity", values: [0.55, 1, 0.55], period: 1.6, timing: .easeInEaseOut)
            }
        case .needsYou:
            let ripple = shape(circle(4.2), stroke: ink.orange, width: max(1, 1.25 * k))
            let disc = shape(dot(8, 8, 4.2), fill: ink.orange)
            if still {
                ripple.transform = CATransform3DMakeScale(1.5, 1.5, 1)
                ripple.opacity = 0.4
            } else {
                ripple.opacity = 0
                loop(ripple, "transform.scale", values: [1, 1, 1, 1.85], times: [0, 0.4, 0.42, 1], period: 2.4, timing: .easeOut)
                loop(ripple, "opacity", values: [0, 0, 0.75, 0], times: [0, 0.4, 0.42, 1], period: 2.4, timing: .easeOut)
                if arrives { once(disc, "transform.scale", values: [0.3, 1.1, 1], duration: 0.45) }
            }
        case .new:
            let disc = shape(dot(8, 8, 3.9), fill: ink.accent)
            if arrives {
                once(disc, "transform.scale", values: [1.9, 0.82, 1], duration: 0.62)
                once(disc, "opacity", values: [0, 1, 1], duration: 0.62)
            }
        case .failed:
            // Filled, as small marks are: the unread dot beside it is, and a ring read lighter than
            // the thing it warns about. Its "!" in white, the disc's own knockout.
            _ = shape(dot(8, 8, 6.75), fill: ink.red)
            _ = shape(lines([(CGPoint(x: 8, y: 4.9), CGPoint(x: 8, y: 8.5))]), stroke: ink.onRed, width: max(1.4, 1.7 * k))
            _ = shape(dot(8, 11.1, 1.05), fill: ink.onRed)
            if arrives { once(self, "transform.translation.x", values: [0, -1.5, 1.5, -0.8, 0], duration: 0.5) }
        case .wake:
            _ = shape(circle(6), stroke: ink.accent)
            let hands = CGMutablePath()
            hands.move(to: CGPoint(x: 8 * k, y: 5.2 * k))
            hands.addLine(to: CGPoint(x: 8 * k, y: 8 * k))
            hands.addLine(to: CGPoint(x: 10 * k, y: 9.3 * k))
            _ = shape(hands, stroke: ink.accent)
        case .watching:
            _ = shape(circle(6), stroke: ink.accent)
            let pupil = shape(dot(8, 8, 2), fill: ink.accent)
            if !still {
                loop(pupil, "transform.translation.x", values: [0, 0, -1.6 * k, -1.6 * k, 1.4 * k, 1.4 * k, 0],
                     times: [0, 0.7, 0.76, 0.84, 0.9, 0.96, 1], period: 6.4, timing: .easeInEaseOut)
            }
        case .paused:
            _ = shape(circle(6), stroke: ink.ink)
            _ = shape(lines([(CGPoint(x: 6.7, y: 5.9), CGPoint(x: 6.7, y: 10.1)), (CGPoint(x: 9.3, y: 5.9), CGPoint(x: 9.3, y: 10.1))]), stroke: ink.ink)
        case .waitingForComputer:
            _ = shape(circle(6), stroke: ink.ink, dash: [1.6, 2.6])
        case .offline:
            _ = shape(circle(6), stroke: ink.muted)
            _ = shape(lines([(CGPoint(x: 4.2, y: 11.8), CGPoint(x: 11.8, y: 4.2))]), stroke: ink.muted)
        }
    }

    // MARK: Motion

    /// A loop on the shared clock: every mark with the same period is at the same point of it.
    private func loop(_ layer: CALayer, _ keyPath: String, values: [Double], times: [Double]? = nil,
                      period: CFTimeInterval, timing: CAMediaTimingFunctionName) {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        animation.keyTimes = times?.map { NSNumber(value: $0) }
        animation.timingFunction = CAMediaTimingFunction(name: timing)
        animation.duration = period
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        animation.beginTime = layer.sharedClockStart(period: period)
        layer.add(animation, forKey: keyPath)
    }

    /// A one-time motion as a state arrives.
    private func once(_ layer: CALayer, _ keyPath: String, values: [Double], duration: CFTimeInterval) {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(animation, forKey: "arrive." + keyPath)
    }
}
