import QuartzCore
import SwiftUI

/// Waiting on you somewhere else: signing in on a page in your browser, a code to enter there,
/// your phone. Kuvo Code's mark on the left, a dotted way, and the place you finish on the right.
/// An accent dot goes over once and waits at that place, a soft ring going out from it now and
/// then, on one clock with every other one on screen; with Reduce Motion the dot is already there,
/// still. Its words go under it, and VoiceOver hears one element: those words.
public struct HandoffWait: View {
    public enum Place: Hashable, Sendable {
        /// A page in your browser.
        case browser
        /// Your phone.
        case phone
    }

    let words: String?
    let place: Place
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme

    /// `words` is what the place says it waits for ("Waiting for you to finish…"), in the
    /// surrounding font; with none, the scene stands alone.
    public init(_ words: String? = nil, to place: Place) {
        self.words = words
        self.place = place
    }

    public var body: some View {
        VStack(spacing: 10) {
            SceneHost<HandoffLayer>(scene: .init(place: place, still: reduceMotion, ink: SceneInk(scheme: scheme, accent: accent)))
                .frame(width: HandoffLayer.size.width, height: HandoffLayer.size.height)
            if let words {
                Text(words)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(words ?? "Waiting for you")
    }
}

/// The handoff's layers: the app, the way, the place, and the dot that goes over.
final class HandoffLayer: CALayer, SceneLayer {
    struct Scene: Equatable {
        var place: HandoffWait.Place
        var still: Bool
        var ink: SceneInk
    }

    static let size = CGSize(width: 120, height: 24)
    /// The dot's trip over, and the time between its rings once there.
    private static let trip: CFTimeInterval = 0.9
    private static let period: CFTimeInterval = 2.4
    private static let dot: CGFloat = 3

    private var shown: Scene?

    static func make() -> HandoffLayer { HandoffLayer() }
    /// It went over once: drawn again (another appearance, another place), it's there already.
    private var arrived = false
    var scale: CGFloat = 2 {
        didSet { if scale != oldValue { rescale(to: scale) } }
    }

    func show(_ scene: Scene) {
        guard scene != shown else { return }
        shown = scene
        build(travels: !arrived && !scene.still)
        arrived = true
    }

    private func build(travels: Bool) {
        guard let scene = shown else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        sublayers?.forEach { $0.removeFromSuperlayer() }
        let ink = scene.ink
        let mid = Self.size.height / 2
        func add(_ path: CGPath, stroke: Color.Resolved? = nil, fill: Color.Resolved? = nil, width: CGFloat = 1.5, dash: [CGFloat]? = nil) {
            let layer = sceneShape(path, stroke: stroke, fill: fill, width: width, dash: dash, scale: scale)
            layer.frame = CGRect(origin: .zero, size: Self.size)
            addSublayer(layer)
        }

        // Kuvo Code: a rounded square, its line inside the box.
        add(CGPath(roundedRect: CGRect(x: 0.75, y: 2.75, width: 18.5, height: 18.5), cornerWidth: 5, cornerHeight: 5, transform: nil),
            stroke: ink.outline)

        // The place you finish, at the right end; where it starts on the left.
        let start: CGFloat
        switch scene.place {
        case .browser:
            // A globe: its rim, a meridian and the equator.
            let globe = CGMutablePath()
            globe.addEllipse(in: CGRect(x: 100.75, y: 2.75, width: 18.5, height: 18.5))
            globe.addEllipse(in: CGRect(x: 105.5, y: 2.75, width: 9, height: 18.5))
            globe.move(to: CGPoint(x: 100.75, y: mid))
            globe.addLine(to: CGPoint(x: 119.25, y: mid))
            add(globe, stroke: ink.outline)
            start = 100
        case .phone:
            // A phone standing up, the island at its top.
            let phone = CGMutablePath()
            phone.addRoundedRect(in: CGRect(x: 105.25, y: 1.75, width: 11.5, height: 20.5), cornerWidth: 3, cornerHeight: 3)
            phone.move(to: CGPoint(x: 109.5, y: 4.75))
            phone.addLine(to: CGPoint(x: 112.5, y: 4.75))
            add(phone, stroke: ink.outline)
            start = 104.5
        }

        // Where the dot waits: just before the place, the dotted way leading up to it.
        let rest = CGPoint(x: start - 5.5, y: mid)
        let way = CGMutablePath()
        way.move(to: CGPoint(x: 26, y: mid))
        way.addLine(to: CGPoint(x: rest.x - Self.dot - 4, y: mid))
        add(way, stroke: ink.path, width: 2, dash: [0, 4.5])

        let side = 2 * Self.dot
        let dot = sceneShape(sceneDot(radius: Self.dot), fill: ink.accent, scale: scale)
        dot.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        dot.position = rest
        addSublayer(dot)
        guard !scene.still else { return }

        // The ring, from the dot outward and gone, on the clock; behind the dot while it travels.
        let waiting = CALayer()
        waiting.frame = CGRect(origin: .zero, size: Self.size)
        insertSublayer(waiting, below: dot)
        let reach: CGFloat = 10
        let ring = sceneShape(sceneDot(radius: Self.dot), stroke: ink.accent, width: 1, scale: scale)
        ring.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        ring.position = rest
        ring.opacity = 0
        waiting.addSublayer(ring)
        let wide = CGPath(ellipseIn: CGRect(x: Self.dot - reach, y: Self.dot - reach, width: 2 * reach, height: 2 * reach), transform: nil)
        ring.addLoop("path", values: [sceneDot(radius: Self.dot), wide, wide], times: [0, 0.6, 1], period: Self.period, timing: .easeOut)
        ring.addLoop("opacity", values: [0.55, 0, 0], times: [0, 0.6, 1], period: Self.period, timing: .easeOut)

        guard travels else { return }
        // Out of the app and over, once.
        dot.addOnce("position.x", values: [10, rest.x], duration: Self.trip, timing: .easeInEaseOut)
        dot.addOnce("opacity", values: [0, 1, 1], times: [0, 0.25, 1], duration: Self.trip)
        dot.addOnce("transform.scale", values: [0.5, 1, 1], times: [0, 0.3, 1], duration: Self.trip)
        waiting.addOnce("opacity", values: [0, 0, 1], times: [0, 0.75, 1], duration: Self.trip + 0.3)
    }
}
