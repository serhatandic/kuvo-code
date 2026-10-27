import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Something asked that hasn't answered yet, beside its name: three small dots that rise one after
/// another, then rest. A computer being searched, say. Played by Core Animation on the same clock
/// as every other loader; still with Reduce Motion.
public struct AskingDots: View {
    var dot: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    public init(dot: CGFloat = 4) {
        self.dot = dot
    }

    public var body: some View {
        AskingDotsHost(dot: dot, still: reduceMotion, ink: StatusMarkInk(scheme: scheme, accent: .accentColor).ink)
            .frame(width: dot * 3 + dot * 0.75 * 2, height: dot * 2.5)
            .accessibilityHidden(true)
    }
}

#if os(macOS)
private struct AskingDotsHost: NSViewRepresentable {
    let dot: CGFloat
    let still: Bool
    let ink: Color.Resolved

    func makeNSView(context: Context) -> AskingDotsView { AskingDotsView() }
    func updateNSView(_ view: AskingDotsView, context: Context) { view.dots.show(dot: dot, still: still, ink: ink) }
}

final class AskingDotsView: NSView {
    let dots = AskingDotsLayer()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        dots.isGeometryFlipped = true
        layer?.addSublayer(dots)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dots.frame = bounds
        dots.layout(in: bounds)
        CATransaction.commit()
    }
}
#else
private struct AskingDotsHost: UIViewRepresentable {
    let dot: CGFloat
    let still: Bool
    let ink: Color.Resolved

    func makeUIView(context: Context) -> AskingDotsView { AskingDotsView() }
    func updateUIView(_ view: AskingDotsView, context: Context) { view.dots.show(dot: dot, still: still, ink: ink) }
}

final class AskingDotsView: UIView {
    let dots = AskingDotsLayer()

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(dots)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        dots.frame = bounds
        dots.layout(in: bounds)
        CATransaction.commit()
    }
}
#endif

/// The three dots and their rise, a third of a second apart, every 1.2 s.
final class AskingDotsLayer: CALayer {
    private let parts = [CALayer(), CALayer(), CALayer()]
    private var shown: (dot: CGFloat, still: Bool, ink: Color.Resolved)?
    static let period: CFTimeInterval = 1.2

    override init() {
        super.init()
        parts.forEach(addSublayer)
    }

    override init(layer: Any) { super.init(layer: layer) }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func show(dot: CGFloat, still: Bool, ink: Color.Resolved) {
        if let shown, shown.dot == dot, shown.still == still, shown.ink == ink { return }
        shown = (dot, still, ink)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        for (index, part) in parts.enumerated() {
            part.backgroundColor = ink.cgColor
            part.cornerRadius = dot / 2
            part.removeAllAnimations()
            part.opacity = still ? 0.7 : 0.45
            guard !still else { continue }
            let rise = CAKeyframeAnimation(keyPath: "transform.translation.y")
            rise.values = [0, -dot * 0.7, 0, 0]
            rise.keyTimes = [0, 0.18, 0.42, 1]
            let light = CAKeyframeAnimation(keyPath: "opacity")
            light.values = [0.45, 1, 0.45, 0.45]
            light.keyTimes = [0, 0.18, 0.42, 1]
            for animation in [rise, light] {
                animation.duration = Self.period
                animation.repeatCount = .infinity
                animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                animation.isRemovedOnCompletion = false
                // On the shared clock, each a little after the one before.
                animation.beginTime = part.sharedClockStart(period: Self.period) + Double(index) * 0.15
                part.add(animation, forKey: animation.keyPath)
            }
        }
        if !bounds.isEmpty { layout(in: bounds) }
    }

    func layout(in box: CGRect) {
        guard let dot = shown?.dot else { return }
        for (index, part) in parts.enumerated() {
            part.frame = CGRect(x: CGFloat(index) * dot * 1.75, y: box.height - dot * 1.1, width: dot, height: dot)
        }
    }
}
