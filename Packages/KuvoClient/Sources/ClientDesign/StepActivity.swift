import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A step at work in a conversation: a tool call, a command, a subagent. Its own icon (the one it
/// shows once done) sits small inside a thin ring, and a short accent arc sweeps around it. When
/// the step ends, the arc closes into a faint ring that fades as the icon grows to its place, so
/// the finished step stands where it ran and nothing beside it moves. Without an icon, the ring
/// alone. How long it has run counts beside its title (`StepActivity.Elapsed`). The sweep is Core
/// Animation on one clock, so every step at work turns in step and costs nothing frame to frame.
public struct StepActivity: View {
    let symbol: String?
    let running: Bool
    let size: CGFloat
    /// Running, but something under it shows the work (its open steps): its arc holds still, as
    /// with Reduce Motion, so only the deepest step at work moves.
    let holds: Bool
    /// Whether the ring is still up: while it runs, and for its closing motion once it ends.
    @State private var ringed: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme

    /// How small the icon sits inside the ring.
    static let inset: CGFloat = 0.6
    /// The closing motion, from the end of the step to the icon alone.
    nonisolated static let closing: CFTimeInterval = 0.35

    /// `size` is the icon's column: the ring fills it, and the icon keeps the width it has there.
    /// `holds`: running, with the work shown deeper down, so its arc holds still.
    public init(symbol: String?, running: Bool, size: CGFloat = 16, holds: Bool = false) {
        self.symbol = symbol
        self.running = running
        self.size = size
        self.holds = holds
        _ringed = State(initialValue: running)
    }

    public var body: some View {
        Group {
            if let symbol {
                Image(systemName: symbol)
                    .scaleEffect(running ? Self.inset : 1)
                    .animation(reduceMotion ? nil : .easeOut(duration: Self.closing), value: running)
                    .frame(width: size)
                    // Behind the icon, so the row is as tall running as done.
                    .background { ring }
            } else {
                Color.clear
                    .frame(width: size, height: size)
                    .overlay { ring }
            }
        }
        // The step's own words say what it is; while it runs, this says so.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Running")
        .accessibilityHidden(!running)
        .task(id: running) {
            if running {
                ringed = true
            } else if ringed {
                if !reduceMotion {
                    guard (try? await Task.sleep(for: .seconds(Self.closing + 0.05))) != nil else { return }
                }
                ringed = false
            }
        }
    }

    @ViewBuilder private var ring: some View {
        if ringed || running {
            StepRingHost(running: running, size: size, around: symbol != nil, still: reduceMotion || holds,
                         ink: StatusMarkInk(scheme: scheme, accent: accent))
                .frame(width: size, height: size)
        }
    }
}

extension StepActivity {
    /// How long a step has run, for beside its title: "14s", "1m 12s", in tertiary with digits
    /// that don't jostle, a second at a time while it's on screen, and how long it took once it's
    /// done, as it stays. It shows from its second second, so a quick step doesn't flash a count
    /// (and a quick step done shows none). Its room is kept from the start, as wide as the largest
    /// count of its kind ("00s", then "00m 00s"), so the step's line moves only when it passes a
    /// minute or an hour, and not as it ends. VoiceOver hears "14 seconds" after the step's Running.
    public struct Elapsed: View {
        let since: Date
        /// Its end once it's done, nil while it runs.
        let until: Date?
        let running: Bool
        @State private var now = Date()

        /// Counted from `since` while it's `running`, and to `until` once it's done: a step's
        /// end, as its engine recorded it. A step done whose end isn't known shows no count, the
        /// same whether it was seen running or opened from history. A computer whose clock runs
        /// ahead never shows less than nothing.
        public init(since: Date, running: Bool = true, until: Date? = nil) {
            self.since = since
            self.running = running
            self.until = running ? nil : until
        }

        public var body: some View {
            let seconds = Self.seconds(since, until ?? now)
            if running || (until != nil && seconds >= 2) {
                ZStack(alignment: .leading) {
                    Text(Self.room(seconds)).hidden()
                    Text(Self.text(seconds))
                }
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .fixedSize()
                .opacity(seconds >= 2 ? 1 : 0)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Self.spoken(seconds))
                .accessibilityHidden(seconds < 2)
                .task(id: running ? since : nil) {
                    guard running else { return }
                    while !Task.isCancelled {
                        now = Date()
                        // On to when what it says changes: its next whole second, or past an hour
                        // (hours and minutes), its next whole minute.
                        let elapsed = max(0, now.timeIntervalSince(since))
                        let step: Double = elapsed < 3600 ? 1 : 60
                        guard (try? await Task.sleep(for: .seconds(step - elapsed.truncatingRemainder(dividingBy: step)))) != nil else { return }
                    }
                }
            }
        }

        static func seconds(_ since: Date, _ until: Date) -> Int {
            max(0, Int(until.timeIntervalSince(since)))
        }

        /// The room a count of `seconds` keeps: the widest of its kind.
        static func room(_ seconds: Int) -> String {
            if seconds < 60 { return "00s" }
            if seconds < 3600 { return "00m 00s" }
            return "00h 00m"
        }

        /// "14s", "1m 12s", "2h 5m".
        public static func text(_ seconds: Int) -> String {
            if seconds < 60 { return "\(seconds)s" }
            if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
            return "\(seconds / 3600)h \(seconds % 3600 / 60)m"
        }

        /// "14 seconds", "1 minute, 12 seconds".
        public static func spoken(_ seconds: Int) -> String {
            Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .wide, maximumUnitCount: 2))
        }
    }
}

#if os(macOS)
private struct StepRingHost: NSViewRepresentable {
    let running: Bool
    let size: CGFloat
    let around: Bool
    let still: Bool
    let ink: StatusMarkInk

    func makeNSView(context: Context) -> StepRingView { StepRingView() }

    func updateNSView(_ view: StepRingView, context: Context) {
        view.ring.show(running: running, size: size, around: around, still: still, ink: ink)
    }
}

final class StepRingView: NSView {
    let ring = StepRingLayer()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        ring.isGeometryFlipped = true
        layer?.addSublayer(ring)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.frame = bounds
        CATransaction.commit()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        ring.scale = window?.backingScaleFactor ?? 2
    }
}
#else
private struct StepRingHost: UIViewRepresentable {
    let running: Bool
    let size: CGFloat
    let around: Bool
    let still: Bool
    let ink: StatusMarkInk

    func makeUIView(context: Context) -> StepRingView { StepRingView() }

    func updateUIView(_ view: StepRingView, context: Context) {
        view.ring.show(running: running, size: size, around: around, still: still, ink: ink)
    }
}

final class StepRingView: UIView {
    let ring = StepRingLayer()

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(ring)
        registerForTraitChanges([UITraitDisplayScale.self]) { (view: StepRingView, _) in view.ring.scale = view.traitCollection.displayScale }
    }

    // Its screen's scale is known once it's in a window.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        ring.scale = window?.screen.scale ?? traitCollection.displayScale
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.frame = bounds
        CATransaction.commit()
    }
}
#endif

/// The ring's layers: a faint track and the accent arc that sweeps it, drawn in a 16-point square
/// scaled to its size.
final class StepRingLayer: CALayer {
    private let track = CAShapeLayer()
    private let arc = CAShapeLayer()
    private var shown: (running: Bool, size: CGFloat, around: Bool, still: Bool, ink: StatusMarkInk)?
    var scale: CGFloat = 2 {
        didSet { if scale != oldValue { sublayers?.forEach { $0.contentsScale = scale } } }
    }

    /// How much of the ring the arc covers.
    private static let length: CGFloat = 0.24
    private static let period: CFTimeInterval = 1.4

    func show(running: Bool, size: CGFloat, around: Bool, still: Bool, ink: StatusMarkInk) {
        if let shown, shown.running == running, shown.size == size, shown.around == around, shown.still == still, shown.ink == ink { return }
        // Only a step seen running closes its ring; one first drawn done has none.
        let ends = shown?.running == true && !running && !still
        shown = (running, size, around, still, ink)

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        if track.superlayer == nil {
            for layer in [track, arc] {
                layer.fillColor = nil
                layer.lineCap = .round
                addSublayer(layer)
            }
        }
        let k = size / 16
        let box = CGRect(x: 0, y: 0, width: size, height: size)
        // Around an icon, wide enough to hold it; alone, the size of a mark beside text.
        let path = CGMutablePath()
        path.addArc(center: CGPoint(x: size / 2, y: size / 2), radius: (around ? 7.25 : 5.5) * k,
                    startAngle: -.pi / 2, endAngle: 3 * .pi / 2, clockwise: false)
        for layer in [track, arc] {
            layer.frame = box
            layer.path = path
            layer.lineWidth = max(1, 1.15 * k)
            layer.contentsScale = scale
        }
        track.strokeColor = ink.faint.cgColor

        if running {
            removeAllAnimations()
            opacity = 1
            arc.removeAllAnimations()
            arc.transform = CATransform3DIdentity
            arc.strokeColor = ink.accent.cgColor
            arc.strokeEnd = Self.length
            if !still { sweep() }
        } else if ends {
            close(ink)
        } else {
            arc.removeAllAnimations()
            opacity = 0
        }
    }

    /// Round and round, on the shared clock: every ring at work is at the same point of its turn.
    private func sweep() {
        let animation = CAKeyframeAnimation(keyPath: "transform.rotation.z")
        animation.values = [0, 2 * Double.pi]
        animation.timingFunction = CAMediaTimingFunction(name: .linear)
        animation.duration = Self.period
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        animation.beginTime = arc.sharedClockStart(period: Self.period)
        arc.add(animation, forKey: "sweep")
    }

    /// The step ended: the arc runs on from where it is to close the ring, turning faint, and the
    /// ring fades.
    private func close(_ ink: StatusMarkInk) {
        let angle = (arc.presentation()?.value(forKeyPath: "transform.rotation.z") as? Double) ?? 0
        arc.removeAllAnimations()
        arc.setValue(angle, forKeyPath: "transform.rotation.z")
        arc.strokeEnd = 1
        arc.strokeColor = ink.faint.cgColor
        opacity = 0

        let closes = StepActivity.closing * 0.6
        let grow = CABasicAnimation(keyPath: "strokeEnd")
        grow.fromValue = Self.length
        grow.toValue = 1
        grow.duration = closes
        grow.timingFunction = CAMediaTimingFunction(name: .easeOut)
        arc.add(grow, forKey: "close.strokeEnd")
        let fade = CABasicAnimation(keyPath: "strokeColor")
        fade.fromValue = ink.accent.cgColor
        fade.toValue = ink.faint.cgColor
        fade.duration = closes
        arc.add(fade, forKey: "close.strokeColor")
        let out = CAKeyframeAnimation(keyPath: "opacity")
        out.values = [1, 1, 0]
        out.keyTimes = [0, 0.45, 1]
        out.duration = StepActivity.closing
        out.timingFunction = CAMediaTimingFunction(name: .easeIn)
        add(out, forKey: "close.opacity")
    }
}
