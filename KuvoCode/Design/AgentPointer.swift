import AppKit
import ClientDesign
import SwiftUI

/// The pointer that shows where the agent acts on a page it browses: it glides to the element,
/// pulses where it clicks, and rings the field it types into, so watching the agent reads like
/// watching someone use the page.
nonisolated enum AgentPointer {
    /// What the agent does there.
    enum Action: String {
        case click, type, select, hover
    }

    /// The arrow, its tip at the origin, pointing up and to the left in a y-up space, about 20
    /// points tall. (Never changed after it's made.)
    nonisolated(unsafe) static let arrow: CGPath = {
        let path = CGMutablePath()
        path.move(to: .zero)
        path.addLine(to: CGPoint(x: 0, y: -18))
        path.addLine(to: CGPoint(x: 4.6, y: -13.8))
        path.addLine(to: CGPoint(x: 7.6, y: -20.4))
        path.addLine(to: CGPoint(x: 10.6, y: -19.1))
        path.addLine(to: CGPoint(x: 7.7, y: -12.6))
        path.addLine(to: CGPoint(x: 13.6, y: -12.6))
        path.closeSubpath()
        return path
    }()

    /// How long it stays after the agent's last step.
    static let lingers: Duration = .milliseconds(2600)
}

/// The pointer over a page drawn in layers (a machine's browser, from its pictures).
@MainActor
final class AgentPointerLayers {
    private let pointer = CAShapeLayer()
    private let pulse = CAShapeLayer()
    private let ring = CAShapeLayer()
    private var hide: Task<Void, Never>?

    init(in host: CALayer) {
        let accent = NSColor.controlAccentColor.cgColor
        pointer.path = AgentPointer.arrow
        pointer.fillColor = accent
        pointer.strokeColor = NSColor.white.cgColor
        pointer.lineWidth = 1.5
        pointer.lineJoin = .round
        pointer.shadowColor = NSColor.black.cgColor
        pointer.shadowOpacity = 0.3
        pointer.shadowRadius = 3
        pointer.shadowOffset = CGSize(width: 0, height: -1)
        pointer.opacity = 0
        pulse.fillColor = NSColor.controlAccentColor.withAlphaComponent(0.25).cgColor
        pulse.strokeColor = accent
        pulse.lineWidth = 2
        pulse.opacity = 0
        ring.fillColor = nil
        ring.strokeColor = accent
        ring.lineWidth = 2
        ring.opacity = 0
        for layer in [ring, pulse, pointer] { host.addSublayer(layer) }
    }

    /// Moves to `point` (in the host's coordinates, y up) over `rect`, the element, and shows the action.
    func show(_ action: AgentPointer.Action, at point: CGPoint, over rect: CGRect) {
        let appearing = pointer.opacity == 0
        let from = appearing ? CGPoint(x: point.x + 46, y: point.y - 38) : pointer.position
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        pointer.position = point
        pointer.opacity = 1
        CATransaction.commit()
        let move = CABasicAnimation(keyPath: "position")
        move.fromValue = from
        move.toValue = point
        move.duration = 0.32
        move.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0, 0.2, 1)
        pointer.add(move, forKey: "move")
        if appearing {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            fade.duration = 0.2
            pointer.add(fade, forKey: "fade")
        }
        switch action {
        case .click: pulse(at: point)
        case .type, .select: ring(around: rect)
        case .hover: break
        }
        hide?.cancel()
        hide = Task { @MainActor [weak self] in
            try? await Task.sleep(for: AgentPointer.lingers)
            guard let self, !Task.isCancelled else { return }
            CATransaction.begin()
            CATransaction.setAnimationDuration(0.35)
            self.pointer.opacity = 0
            CATransaction.commit()
        }
    }

    private func pulse(at point: CGPoint) {
        let radius: CGFloat = 16
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        pulse.path = CGPath(ellipseIn: CGRect(x: -radius, y: -radius, width: radius * 2, height: radius * 2), transform: nil)
        pulse.position = point
        CATransaction.commit()
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.3
        grow.toValue = 1.4
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = 0.5
        group.beginTime = CACurrentMediaTime() + 0.28
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        pulse.add(group, forKey: "pulse")
    }

    private func ring(around rect: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.path = CGPath(roundedRect: rect.insetBy(dx: -3, dy: -3), cornerWidth: 6, cornerHeight: 6, transform: nil)
        CATransaction.commit()
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0, 1, 1, 0]
        fade.keyTimes = [0, 0.15, 0.7, 1]
        fade.duration = 1.4
        fade.beginTime = CACurrentMediaTime() + 0.2
        ring.add(fade, forKey: "ring")
    }

    func clear() {
        hide?.cancel()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for layer in [pointer, pulse, ring] {
            layer.removeAllAnimations()
            layer.opacity = 0
        }
        CATransaction.commit()
    }
}

/// The pointer over this Mac's browser, as SwiftUI over the web view: `step` is the agent's
/// latest action there, in the page's points.
struct AgentPointerOverlay: View {
    let step: BrowserSession.AgentStep?
    @State private var shown: BrowserSession.AgentStep?
    @State private var visible = false
    @State private var pulse = false
    @Environment(\.accent) private var accent

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let shown {
                if shown.action == .type || shown.action == .select {
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(accent, lineWidth: 2)
                        .frame(width: shown.rect.width + 6, height: shown.rect.height + 6)
                        .offset(x: shown.rect.minX - 3, y: shown.rect.minY - 3)
                        .opacity(pulse ? 0 : 1)
                }
                Circle()
                    .fill(accent.opacity(0.25))
                    .overlay(Circle().stroke(accent, lineWidth: 2))
                    .frame(width: 32, height: 32)
                    .scaleEffect(pulse ? 1.4 : 0.3)
                    .opacity(shown.action == .click && pulse ? 0 : shown.action == .click ? 0.9 : 0)
                    .offset(x: shown.rect.midX - 16, y: shown.rect.midY - 16)
                ArrowShape()
                    .fill(accent)
                    .overlay(ArrowShape().stroke(.white, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round)))
                    .frame(width: 14, height: 21)
                    .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
                    .offset(x: shown.rect.midX, y: shown.rect.midY)
                    .opacity(visible ? 1 : 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
        .task(id: step?.id) {
            guard let step else { return }
            pulse = false
            withAnimation(.timingCurve(0.3, 0, 0.2, 1, duration: 0.32)) {
                shown = step
                visible = true
            }
            // A newer step cancels this one: it stops here, rather than hiding the arrow the newer
            // step just showed.
            do {
                try await Task.sleep(for: .milliseconds(280))
                withAnimation(.easeOut(duration: step.action == .click ? 0.5 : 1.2)) { pulse = true }
                try await Task.sleep(for: AgentPointer.lingers)
            } catch {
                return
            }
            withAnimation(.easeOut(duration: 0.35)) { visible = false }
        }
    }

    /// The arrow, its tip at the top left.
    private nonisolated struct ArrowShape: Shape {
        func path(in rect: CGRect) -> Path {
            var transform = CGAffineTransform(scaleX: rect.width / 13.6, y: -rect.height / 20.4)
            return Path(AgentPointer.arrow.copy(using: &transform) ?? AgentPointer.arrow)
        }
    }
}
