import AppKit
import SwiftUI

extension Color {
    static let additions = Color(nsColor: .systemGreen)
    static let deletions = Color(nsColor: .systemRed)
}

/// Text that shimmers while the agent is working ("Thinking…"): a light sweeping across it,
/// played by Core Animation (as a SwiftUI animation, three on screen took a tenth of a core,
/// even with the window hidden).
struct ShimmerText: View {
    let text: String
    @Environment(\.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var width: CGFloat = 0

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .overlay {
                if !reduceMotion, width > 0 {
                    // Its letters, as they're set here (cut short the same way), are where the
                    // light shows.
                    ShimmerSweep(key: "\(width)|\(text)", letters: Text(text).environment(\.self, environment).frame(width: width, alignment: .leading))
                }
            }
    }
}

private struct ShimmerSweep<Letters: View>: NSViewRepresentable {
    /// Changes when the letters do.
    let key: String
    let letters: Letters
    @Environment(\.displayScale) private var scale

    func makeNSView(context: Context) -> ShimmerView { ShimmerView() }

    func updateNSView(_ view: ShimmerView, context: Context) {
        guard view.key != key || view.scale != scale else { return }
        let renderer = ImageRenderer(content: letters)
        renderer.scale = scale
        view.show(renderer.cgImage, key: key, scale: scale)
    }
}

private final class ShimmerView: NSView {
    /// Shows only where the letters are; the light moves inside it.
    private let lit = CALayer()
    private let letters = CALayer()
    private let sweep = CAGradientLayer()
    private var image: CGImage?
    private(set) var key = ""
    private(set) var scale: CGFloat = 0
    private static let cycle = 1.6

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.addSublayer(lit)
        lit.mask = letters
        lit.addSublayer(sweep)
        sweep.startPoint = CGPoint(x: 0, y: 0.5)
        sweep.endPoint = CGPoint(x: 1, y: 0.5)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func show(_ image: CGImage?, key: String, scale: CGFloat) {
        self.key = key
        self.scale = scale
        self.image = image
        letters.contents = image
        letters.contentsScale = scale
        needsLayout = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        effectiveAppearance.performAsCurrentDrawingAppearance {
            sweep.colors = [NSColor.clear.cgColor, NSColor.labelColor.withAlphaComponent(0.9).cgColor, NSColor.clear.cgColor]
        }
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        let width = bounds.width, height = bounds.height
        lit.frame = bounds
        lit.masksToBounds = true
        let scale = max(letters.contentsScale, 1)
        let size = image.map { CGSize(width: CGFloat($0.width) / scale, height: CGFloat($0.height) / scale) } ?? bounds.size
        letters.frame = CGRect(x: 0, y: (height - size.height) / 2, width: size.width, height: size.height)
        viewDidChangeEffectiveAppearance()
        // The light, six tenths as wide as the text, from well before it to just past it.
        sweep.frame = CGRect(x: 0, y: 0, width: width * 0.6, height: height)
        let animation = CABasicAnimation(keyPath: "position.x")
        animation.fromValue = -1.2 * width + width * 0.3
        animation.toValue = 1.44 * width + width * 0.3
        animation.duration = Self.cycle
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        // In step with every other one on screen.
        let now = CACurrentMediaTime()
        animation.beginTime = sweep.convertTime(now, from: nil) - now.truncatingRemainder(dividingBy: Self.cycle)
        sweep.add(animation, forKey: "sweep")
    }
}

/// `+12 −3`, in diff colors.
struct DiffStat: View {
    let additions: Int
    let deletions: Int

    var body: some View {
        HStack(spacing: 4) {
            if additions > 0 { Text("+\(additions)").foregroundStyle(Color.additions) }
            if deletions > 0 { Text("−\(deletions)").foregroundStyle(Color.deletions) }
        }
        .font(.caption.monospacedDigit().weight(.medium))
    }
}
