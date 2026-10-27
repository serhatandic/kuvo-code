import QuartzCore
import SwiftUI

/// A computer starting, or being reached: this Mac on the left, a short wire, the machine on the
/// right with a lamp beside it. While it's on its way, dashes flow along the wire toward the
/// machine, on one clock with every other one on screen, and the lamp is grey. When it answers,
/// the wire draws in solid and the lamp lights green with a small settle, seen only where the view
/// stays on screen after. With Reduce Motion the wire stands still. Its words go under it, and
/// VoiceOver hears one element: those words.
public struct ConnectingLink: View {
    let words: String?
    let isConnected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme

    /// `words` is what the place says is happening ("Opening Gmail on lokum…"), in the
    /// surrounding font; with none (a heading says it), the scene stands alone.
    public init(_ words: String? = nil, isConnected: Bool = false) {
        self.words = words
        self.isConnected = isConnected
    }

    public var body: some View {
        VStack(spacing: 10) {
            SceneHost<ConnectingLinkLayer>(scene: .init(connected: isConnected, still: reduceMotion,
                                                        ink: SceneInk(scheme: scheme, accent: accent)))
                .frame(width: ConnectingLinkLayer.size.width, height: ConnectingLinkLayer.size.height)
            if let words {
                Text(words)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(words ?? (isConnected ? "Connected" : "Connecting"))
    }
}

/// The link's layers: the two computers, the wire between them, and the lamp.
final class ConnectingLinkLayer: CALayer, SceneLayer {
    struct Scene: Equatable {
        var connected: Bool
        var still: Bool
        var ink: SceneInk
    }

    static let size = CGSize(width: 128, height: 24)
    /// One dash and its gap going by.
    private static let period: CFTimeInterval = 0.7
    private static let dash: [CGFloat] = [2.5, 4.5]
    private static let lamp: CGFloat = 2.5

    private var shown: Scene?

    static func make() -> ConnectingLinkLayer { ConnectingLinkLayer() }
    var scale: CGFloat = 2 {
        didSet { if scale != oldValue { rescale(to: scale) } }
    }

    func show(_ scene: Scene) {
        guard scene != shown else { return }
        // Answering on screen plays its arrival; one first drawn connected doesn't.
        let answers = (shown.map { !$0.connected } ?? false) && scene.connected && !scene.still
        shown = scene
        build(scene, answers: answers)
    }

    private func build(_ scene: Scene, answers: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        sublayers?.forEach { $0.removeFromSuperlayer() }
        let ink = scene.ink
        let mid = Self.size.height / 2
        @discardableResult
        func add(_ path: CGPath, stroke: Color.Resolved? = nil, fill: Color.Resolved? = nil, dash: [CGFloat]? = nil) -> CAShapeLayer {
            let layer = sceneShape(path, stroke: stroke, fill: fill, dash: dash, scale: scale)
            layer.frame = CGRect(origin: .zero, size: Self.size)
            addSublayer(layer)
            return layer
        }

        // This Mac: a laptop, its screen and its base.
        let laptop = CGMutablePath()
        laptop.addRoundedRect(in: CGRect(x: 2.75, y: 4.75, width: 18.5, height: 12), cornerWidth: 2, cornerHeight: 2)
        laptop.move(to: CGPoint(x: 0.75, y: 19.5))
        laptop.addLine(to: CGPoint(x: 23.25, y: 19.5))
        add(laptop, stroke: ink.outline)

        // The machine: two units of a rack, a light on each.
        let server = CGMutablePath()
        server.addRoundedRect(in: CGRect(x: 100.75, y: 3.75, width: 18.5, height: 7), cornerWidth: 2, cornerHeight: 2)
        server.addRoundedRect(in: CGRect(x: 100.75, y: 13.25, width: 18.5, height: 7), cornerWidth: 2, cornerHeight: 2)
        add(server, stroke: ink.outline)
        let lights = CGMutablePath()
        lights.addEllipse(in: CGRect(x: 103.5, y: 6.25, width: 2, height: 2))
        lights.addEllipse(in: CGRect(x: 103.5, y: 15.75, width: 2, height: 2))
        add(lights, fill: ink.outline)

        let wire = CGMutablePath()
        wire.move(to: CGPoint(x: 30, y: mid))
        wire.addLine(to: CGPoint(x: 94, y: mid))

        let side = 2 * Self.lamp
        let lamp = sceneShape(sceneDot(radius: Self.lamp), fill: scene.connected ? ink.green : ink.unlit, scale: scale)
        lamp.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        lamp.position = CGPoint(x: 125.5, y: mid)
        addSublayer(lamp)

        guard scene.connected else {
            let dashes = add(wire, stroke: ink.path, dash: Self.dash)
            // Toward the machine: the pattern's phase running down moves it along the wire.
            if !scene.still {
                dashes.addLoop("lineDashPhase", values: [Self.dash.reduce(0, +), 0], period: Self.period, timing: .linear)
            }
            return
        }
        let solid = add(wire, stroke: ink.outline)
        guard answers else { return }
        // The dashes give way to the wire drawing in, and then the lamp lights.
        let dashes = add(wire, stroke: ink.path, dash: Self.dash)
        dashes.opacity = 0
        dashes.addOnce("opacity", values: [1, 0], duration: 0.3)
        solid.addOnce("strokeEnd", values: [0, 1], duration: 0.35)
        lamp.addOnce("fillColor", values: [ink.unlit.cgColor, ink.green.cgColor], duration: 0.15, delay: 0.3)
        lamp.addOnce("transform.scale", values: [1, 1.7, 0.85, 1], times: [0, 0.3, 0.65, 1], duration: 0.5, delay: 0.3)
    }
}
