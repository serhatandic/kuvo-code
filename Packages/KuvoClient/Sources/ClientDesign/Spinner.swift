import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Kuvo Code's loader: its prompt mark (the chevron and the cursor) drawing itself in short
/// dashes, over a faint copy of itself, then fading to start again. Quiet and in one ink, so it
/// sits in a row of text. Played by Core Animation, so it costs the app nothing from frame to
/// frame (as a SwiftUI timeline, each one on screen redrew the window 30 times a second); not
/// `ProgressView`, which hosts an AppKit view that flies in from the window's corner when it
/// appears during an animation.
public struct Spinner: View {
    var size: CGFloat = 11
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let cycle = 1.6

    public init(size: CGFloat = 11) {
        self.size = size
    }

    public var body: some View {
        Group {
            if reduceMotion {
                mark
            } else {
                SpinnerMotion(size: size)
            }
        }
        .frame(width: size, height: size)
        // Beside text, on its middle: in a row lined up on text's baseline, an AppKit view's top
        // goes there, which hung it below the line (a card's "To Finance", measured 7 pt low).
        .alignmentGuide(.firstTextBaseline) { $0.height * 0.9 }
        .alignmentGuide(.lastTextBaseline) { $0.height * 0.9 }
        .accessibilityLabel("Working")
    }

    /// Still, whole.
    private var mark: some View {
        let style = Self.style(size)
        return ZStack {
            PromptMark(part: .chevron).stroke(.secondary, style: style)
            PromptMark(part: .cursor).stroke(.secondary, style: style)
        }
        .opacity(0.8)
        .frame(width: size, height: size * PromptMark.aspect)
    }

    static func style(_ size: CGFloat) -> StrokeStyle {
        let line = max(1, size * 0.11)
        return StrokeStyle(lineWidth: line, lineCap: .round, lineJoin: .round, dash: [line * 1.0, line * 1.8])
    }

    /// At `p` of the way through a round: how much of the chevron and of the cursor is drawn, and
    /// how clear it is. The chevron draws, then the cursor; both hold a moment, then fade.
    static func frame(at p: Double) -> (chevron: Double, cursor: Double, opacity: Double) {
        func eased(_ x: Double) -> Double {
            let t = max(0, min(1, x))
            return t * t * (3 - 2 * t)
        }
        let fade = p < 0.78 ? 1 : 1 - (p - 0.78) / 0.22
        return (eased(p / 0.4), eased((p - 0.32) / 0.28), 0.35 + 0.65 * fade)
    }
}


#if os(macOS)
/// The loader moving: its mark as shape layers, a round of it as keyframes.
private struct SpinnerMotion: NSViewRepresentable {
    let size: CGFloat

    func makeNSView(context: Context) -> SpinnerView { SpinnerView() }

    func updateNSView(_ view: SpinnerView, context: Context) {
        view.size = size
    }
}

private final class SpinnerView: NSView {
    var size: CGFloat = 0 {
        didSet { if size != oldValue { build() } }
    }
    private let mark = CALayer()
    private let faint = (CAShapeLayer(), CAShapeLayer())
    private let drawn = (CAShapeLayer(), CAShapeLayer())

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        mark.isGeometryFlipped = true
        layer?.addSublayer(mark)
        for part in [faint.0, faint.1, drawn.0, drawn.1] { mark.addSublayer(part) }
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

    /// The ink follows the appearance (light or dark).
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        color()
    }

    private func color() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let ink = NSColor.secondaryLabelColor
            for part in [faint.0, faint.1] { part.strokeColor = ink.withAlphaComponent(ink.alphaComponent * 0.18).cgColor }
            for part in [drawn.0, drawn.1] { part.strokeColor = ink.cgColor }
        }
    }

    private func build() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        let style = Spinner.style(size)
        let height = size * PromptMark.aspect
        let box = CGRect(x: 0, y: (size - height) / 2, width: size, height: height)
        for (part, layer) in [(PromptMark.Part.chevron, faint.0), (.cursor, faint.1), (.chevron, drawn.0), (.cursor, drawn.1)] {
            layer.path = PromptMark(part: part).path(in: box).cgPath
            layer.fillColor = nil
            layer.lineWidth = style.lineWidth
            layer.lineCap = .round
            layer.lineJoin = .round
            layer.lineDashPattern = style.dash.map { NSNumber(value: Double($0)) }
            layer.contentsScale = window?.backingScaleFactor ?? 2
        }
        color()

        let frames = (0...48).map { Spinner.frame(at: Double($0) / 48) }
        func play(_ layer: CALayer, _ keyPath: String, _ values: [Double]) {
            let animation = CAKeyframeAnimation(keyPath: keyPath)
            animation.values = values
            animation.duration = Spinner.cycle
            animation.repeatCount = .infinity
            animation.isRemovedOnCompletion = false
            // In step with every other loader on screen.
            animation.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) - CACurrentMediaTime().truncatingRemainder(dividingBy: Spinner.cycle)
            layer.removeAnimation(forKey: keyPath)
            layer.add(animation, forKey: keyPath)
        }
        play(drawn.0, "strokeEnd", frames.map(\.chevron))
        play(drawn.1, "strokeEnd", frames.map(\.cursor))
        play(mark, "opacity", frames.map(\.opacity))
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        for layer in [faint.0, faint.1, drawn.0, drawn.1] { layer.contentsScale = window?.backingScaleFactor ?? 2 }
    }
}

/// The app icon's prompt, `>_`: its chevron or its cursor, in the box it's given.
nonisolated struct PromptMark: Shape {
    enum Part { case chevron, cursor }
    let part: Part

    /// Height over width of the two together.
    static let aspect: CGFloat = 530.0 / 690.0

    func path(in rect: CGRect) -> Path {
        // The icon's coordinates (scripts/icon.py), around the mark and its stroke.
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + (x - 170) / 690 * rect.width, y: rect.minY + (y - 250) / 530 * rect.height)
        }
        var path = Path()
        switch part {
        case .chevron:
            path.move(to: point(247, 324))
            path.addLine(to: point(437, 512))
            path.addLine(to: point(247, 700))
        case .cursor:
            path.move(to: point(547, 700))
            path.addLine(to: point(777, 700))
        }
        return path
    }
}

#else
/// The loader moving: its mark as shape layers, a round of it as keyframes.
private struct SpinnerMotion: UIViewRepresentable {
    let size: CGFloat

    func makeUIView(context: Context) -> SpinnerView { SpinnerView() }

    func updateUIView(_ view: SpinnerView, context: Context) {
        view.size = size
    }
}

private final class SpinnerView: UIView {
    var size: CGFloat = 0 {
        didSet { if size != oldValue { build() } }
    }
    private let mark = CALayer()
    private let faint = (CAShapeLayer(), CAShapeLayer())
    private let drawn = (CAShapeLayer(), CAShapeLayer())

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(mark)
        for part in [faint.0, faint.1, drawn.0, drawn.1] { mark.addSublayer(part) }
        // The ink follows the appearance (light or dark).
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SpinnerView, _) in view.color() }
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

    private func color() {
        let ink = UIColor.secondaryLabel.resolvedColor(with: traitCollection)
        var alpha: CGFloat = 1
        ink.getWhite(nil, alpha: &alpha)
        for part in [faint.0, faint.1] { part.strokeColor = ink.withAlphaComponent(alpha * 0.18).cgColor }
        for part in [drawn.0, drawn.1] { part.strokeColor = ink.cgColor }
    }

    private func build() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        let style = Spinner.style(size)
        let height = size * PromptMark.aspect
        let box = CGRect(x: 0, y: (size - height) / 2, width: size, height: height)
        for (part, layer) in [(PromptMark.Part.chevron, faint.0), (.cursor, faint.1), (.chevron, drawn.0), (.cursor, drawn.1)] {
            layer.path = PromptMark(part: part).path(in: box).cgPath
            layer.fillColor = nil
            layer.lineWidth = style.lineWidth
            layer.lineCap = .round
            layer.lineJoin = .round
            layer.lineDashPattern = style.dash.map { NSNumber(value: Double($0)) }
            layer.contentsScale = traitCollection.displayScale
        }
        color()

        let frames = (0...48).map { Spinner.frame(at: Double($0) / 48) }
        func play(_ layer: CALayer, _ keyPath: String, _ values: [Double]) {
            let animation = CAKeyframeAnimation(keyPath: keyPath)
            animation.values = values
            animation.duration = Spinner.cycle
            animation.repeatCount = .infinity
            animation.isRemovedOnCompletion = false
            // In step with every other loader on screen.
            animation.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) - CACurrentMediaTime().truncatingRemainder(dividingBy: Spinner.cycle)
            layer.removeAnimation(forKey: keyPath)
            layer.add(animation, forKey: keyPath)
        }
        play(drawn.0, "strokeEnd", frames.map(\.chevron))
        play(drawn.1, "strokeEnd", frames.map(\.cursor))
        play(mark, "opacity", frames.map(\.opacity))
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        for layer in [faint.0, faint.1, drawn.0, drawn.1] { layer.contentsScale = traitCollection.displayScale }
    }
}

/// The app icon's prompt, `>_`: its chevron or its cursor, in the box it's given.
nonisolated struct PromptMark: Shape {
    enum Part { case chevron, cursor }
    let part: Part

    /// Height over width of the two together.
    static let aspect: CGFloat = 530.0 / 690.0

    func path(in rect: CGRect) -> Path {
        // The icon's coordinates (scripts/icon.py), around the mark and its stroke.
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + (x - 170) / 690 * rect.width, y: rect.minY + (y - 250) / 530 * rect.height)
        }
        var path = Path()
        switch part {
        case .chevron:
            path.move(to: point(247, 324))
            path.addLine(to: point(437, 512))
            path.addLine(to: point(247, 700))
        case .cursor:
            path.move(to: point(547, 700))
            path.addLine(to: point(777, 700))
        }
        return path
    }
}
#endif
