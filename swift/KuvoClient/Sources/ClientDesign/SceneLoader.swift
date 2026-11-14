import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// What the loaders that draw a small scene share (`HandoffWait`, `ConnectingLink`): their colours, a
// view that hosts their layers, and their motion on the shared clock.

/// The colours a scene draws with, resolved for its appearance.
struct SceneInk: Equatable {
    /// The things it shows: a computer, a page, a phone.
    var outline: Color.Resolved
    /// The way between them.
    var path: Color.Resolved
    /// A lamp not lit yet.
    var unlit: Color.Resolved
    var accent: Color.Resolved
    var green: Color.Resolved

    init(scheme: ColorScheme, accent: Color) {
        var environment = EnvironmentValues()
        environment.colorScheme = scheme
        outline = Color.primary.opacity(0.5).resolve(in: environment)
        path = Color.primary.opacity(0.28).resolve(in: environment)
        unlit = Color.primary.opacity(0.22).resolve(in: environment)
        self.accent = accent.resolve(in: environment)
        green = Color.green.resolve(in: environment)
    }
}

/// A scene's layers, drawn from the top left in a box of a fixed size.
protocol SceneLayer: CALayer {
    associatedtype Scene: Equatable
    /// A new one (not `init()`, which CALayer's `+layer` makes ambiguous here).
    static func make() -> Self
    var scale: CGFloat { get set }
    func show(_ scene: Scene)
}

#if os(macOS)
struct SceneHost<Layer: SceneLayer>: NSViewRepresentable {
    let scene: Layer.Scene

    func makeNSView(context: Context) -> SceneView<Layer> { SceneView() }

    func updateNSView(_ view: SceneView<Layer>, context: Context) {
        view.drawing.show(scene)
    }
}

final class SceneView<Layer: SceneLayer>: NSView {
    let drawing = Layer.make()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        drawing.isGeometryFlipped = true
        layer?.addSublayer(drawing)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        drawing.frame = bounds
        CATransaction.commit()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        drawing.scale = window?.backingScaleFactor ?? 2
    }
}
#else
struct SceneHost<Layer: SceneLayer>: UIViewRepresentable {
    let scene: Layer.Scene

    func makeUIView(context: Context) -> SceneView<Layer> { SceneView() }

    func updateUIView(_ view: SceneView<Layer>, context: Context) {
        view.drawing.show(scene)
    }
}

final class SceneView<Layer: SceneLayer>: UIView {
    let drawing = Layer.make()

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(drawing)
        registerForTraitChanges([UITraitDisplayScale.self]) { (view: SceneView<Layer>, _) in view.drawing.scale = view.traitCollection.displayScale }
    }

    // Its screen's scale is known once it's in a window.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        drawing.scale = window?.screen.scale ?? traitCollection.displayScale
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        drawing.frame = bounds
        CATransaction.commit()
    }
}
#endif

extension CALayer {
    /// Sharp on a screen of `scale`, every layer under this one too, its motion going on.
    func rescale(to scale: CGFloat) {
        sublayers?.forEach {
            $0.contentsScale = scale
            $0.rescale(to: scale)
        }
    }

    /// A loop on the shared clock: every one with the same period, anywhere on screen, is at the
    /// same point of it.
    func addLoop(_ keyPath: String, values: [Any], times: [Double]? = nil, period: CFTimeInterval,
              timing: CAMediaTimingFunctionName) {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        animation.keyTimes = times?.map { NSNumber(value: $0) }
        animation.timingFunction = CAMediaTimingFunction(name: timing)
        animation.duration = period
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        let now = CACurrentMediaTime()
        animation.beginTime = convertTime(now, from: nil) - now.truncatingRemainder(dividingBy: period)
        add(animation, forKey: keyPath)
    }

    /// A motion that plays once, from now or after `delay`, holding its first value meanwhile.
    func addOnce(_ keyPath: String, values: [Any], times: [Double]? = nil, duration: CFTimeInterval,
              delay: CFTimeInterval = 0, timing: CAMediaTimingFunctionName = .easeOut) {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        animation.keyTimes = times?.map { NSNumber(value: $0) }
        animation.timingFunction = CAMediaTimingFunction(name: timing)
        animation.duration = duration
        animation.fillMode = .backwards
        animation.beginTime = convertTime(CACurrentMediaTime(), from: nil) + delay
        add(animation, forKey: "once." + keyPath)
    }
}

/// A shape for a scene: stroked or filled, its lines round at the ends.
func sceneShape(_ path: CGPath, stroke: Color.Resolved? = nil, fill: Color.Resolved? = nil, width: CGFloat = 1.5,
                dash: [CGFloat]? = nil, scale: CGFloat) -> CAShapeLayer {
    let layer = CAShapeLayer()
    layer.path = path
    layer.fillColor = fill?.cgColor
    layer.strokeColor = stroke?.cgColor
    layer.lineWidth = width
    layer.lineCap = .round
    layer.lineJoin = .round
    layer.lineDashPattern = dash?.map { NSNumber(value: Double($0)) }
    layer.contentsScale = scale
    return layer
}

/// A circle, drawn from its own top left, for a layer whose bounds are its square.
func sceneDot(radius r: CGFloat) -> CGPath {
    CGPath(ellipseIn: CGRect(x: 0, y: 0, width: 2 * r, height: 2 * r), transform: nil)
}
