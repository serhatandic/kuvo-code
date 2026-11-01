import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Content on its way, in the shape of what's coming: faint rounded bars like lines of text or
/// code, rows like the list that will fill it, a rounded block where a picture goes. One soft
/// sheen crosses the whole of it now and then, played by Core Animation on one clock, so every
/// placeholder on screen sweeps together and costs nothing frame to frame; with Reduce Motion it
/// stands still. It shows only after a moment, fading in, so a quick load shows nothing at all,
/// and cross-fades with the content that takes its place, where nothing else shares its spot (see
/// `fadesOut`): the two sit one over the other in a ZStack, and the content comes in with
/// `.transition(.replacingPlaceholder)`. VoiceOver hears one element: "Loading", or what's loading.
public struct Placeholder: View {
    public enum Kind: Hashable, Sendable {
        /// Lines of text or code: bars of varying widths, some indented.
        case lines(count: Int)
        /// A list's rows: a small rounded square and two bars, a title and a longer detail.
        case rows(count: Int)
        /// A picture: a rounded block that fills the room it's given.
        case image
    }

    let kind: Kind
    let label: String
    let fadesOut: Bool
    let waits: Bool
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme

    /// How long a load runs before it shows.
    static let delay: Double = 0.3

    /// `label` is what VoiceOver says ("Loading skills"). `fadesOut` cross-fades it with the
    /// content that replaces it, which comes in with `.transition(.replacingPlaceholder)`; off
    /// where it sits among other rows of a stack, which would keep its room while it fades and
    /// then close up. `waits` off shows it at once, where a load is known to take a while (a
    /// screen's first, which would otherwise stand empty for that moment).
    public init(_ kind: Kind, label: String = "Loading", fadesOut: Bool = true, waits: Bool = true) {
        self.kind = kind
        self.label = label
        self.fadesOut = fadesOut
        self.waits = waits
        _shown = State(initialValue: !waits)
    }

    public var body: some View {
        PlaceholderHost(kind: kind, still: reduceMotion, ink: PlaceholderInk(scheme: scheme))
            .frame(height: kind.height)
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(shown ? 1 : 0)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityHidden(!shown)
            .transition(fadesOut ? .replacingPlaceholder : .identity)
            .task {
                guard waits, (try? await Task.sleep(for: .seconds(Self.delay))) != nil else { return }
                withAnimation(.easeOut(duration: 0.25)) { shown = true }
            }
    }
}

extension AnyTransition {
    /// Content taking a placeholder's place, and the placeholder leaving it: each fades as the
    /// other does, so the two cross-fade rather than the content showing at once over bars that
    /// fade under it.
    public static var replacingPlaceholder: AnyTransition { .opacity.animation(.easeOut(duration: 0.2)) }
}

extension Placeholder.Kind {
    /// Its height, as its bars and rows set it; nil for a picture, which takes what it's given.
    var height: CGFloat? {
        switch self {
        case .lines(let count): Self.stack(count, of: PlaceholderLayer.lineHeight, gap: PlaceholderLayer.lineGap)
        case .rows(let count): Self.stack(count, of: PlaceholderLayer.rowHeight, gap: PlaceholderLayer.rowGap)
        case .image: nil
        }
    }

    private static func stack(_ count: Int, of height: CGFloat, gap: CGFloat) -> CGFloat {
        let count = CGFloat(max(1, count))
        return count * height + (count - 1) * gap
    }
}

/// The colours a placeholder draws with, resolved for its appearance.
struct PlaceholderInk: Equatable {
    var bar: Color.Resolved
    var sheen: Color.Resolved

    init(scheme: ColorScheme) {
        var environment = EnvironmentValues()
        environment.colorScheme = scheme
        bar = Color.primary.opacity(0.06).resolve(in: environment)
        sheen = Color.primary.opacity(0.07).resolve(in: environment)
    }
}

#if os(macOS)
private struct PlaceholderHost: NSViewRepresentable {
    let kind: Placeholder.Kind
    let still: Bool
    let ink: PlaceholderInk

    func makeNSView(context: Context) -> PlaceholderView { PlaceholderView() }

    func updateNSView(_ view: PlaceholderView, context: Context) {
        view.shape.show(kind, still: still, ink: ink)
    }
}

final class PlaceholderView: NSView {
    let shape = PlaceholderLayer()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        shape.isGeometryFlipped = true
        layer?.addSublayer(shape)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        shape.lay(in: bounds)
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        shape.scale = window?.backingScaleFactor ?? 2
    }
}
#else
private struct PlaceholderHost: UIViewRepresentable {
    let kind: Placeholder.Kind
    let still: Bool
    let ink: PlaceholderInk

    func makeUIView(context: Context) -> PlaceholderView { PlaceholderView() }

    func updateUIView(_ view: PlaceholderView, context: Context) {
        view.shape.show(kind, still: still, ink: ink)
    }
}

final class PlaceholderView: UIView {
    let shape = PlaceholderLayer()

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(shape)
        registerForTraitChanges([UITraitDisplayScale.self]) { (view: PlaceholderView, _) in view.shape.scale = view.traitCollection.displayScale }
    }

    // Its screen's scale is known once it's in a window.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        shape.scale = window?.screen.scale ?? traitCollection.displayScale
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        shape.lay(in: bounds)
    }
}
#endif

/// The placeholder's layers: its bars in one shape, and the sheen, which shows only where they
/// are, crossing them.
final class PlaceholderLayer: CALayer {
    private let bars = CAShapeLayer()
    /// Holds the sheen, cut to the bars.
    private let lit = CALayer()
    private let cut = CAShapeLayer()
    private let sheen = CAGradientLayer()
    private var shown: (kind: Placeholder.Kind, still: Bool, ink: PlaceholderInk)?
    private var laid: CGRect = .null
    var scale: CGFloat = 2 {
        didSet { if scale != oldValue { for layer in [bars, cut] { layer.contentsScale = scale } } }
    }

    static let lineHeight: CGFloat = 8
    static let lineGap: CGFloat = 7
    /// How far each step of a line's indent goes in.
    private static let indent: CGFloat = 18
    /// Lines as code runs: how far in, and how long, as a share of the measure.
    private static let lines: [(indent: CGFloat, share: CGFloat)] = [
        (0, 0.46), (1, 0.62), (2, 0.5), (2, 0.74), (1, 0.34), (0, 0.16),
        (0, 0.56), (1, 0.7), (1, 0.42), (0, 0.22),
    ]
    /// Lines past this read as a wall rather than as text.
    private static let measure: CGFloat = 560

    static let rowHeight: CGFloat = 24
    static let rowGap: CGFloat = 16
    private static let square: CGFloat = 24
    /// A row's title and its detail, as shares of the room beside the square.
    private static let rows: [(title: CGFloat, detail: CGFloat)] = [(0.34, 0.6), (0.46, 0.52), (0.28, 0.64), (0.4, 0.56)]
    private static let rowMeasure: CGFloat = 420

    /// One sweep and the rest after it.
    private static let period: CFTimeInterval = 1.8

    func show(_ kind: Placeholder.Kind, still: Bool, ink: PlaceholderInk) {
        if let shown, shown.kind == kind, shown.still == still, shown.ink == ink { return }
        shown = (kind, still, ink)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if bars.superlayer == nil {
            for layer in [bars, cut] { layer.contentsScale = scale }
            addSublayer(bars)
            addSublayer(lit)
            lit.mask = cut
            lit.addSublayer(sheen)
            sheen.startPoint = CGPoint(x: 0, y: 0.5)
            sheen.endPoint = CGPoint(x: 1, y: 0.5)
        }
        bars.fillColor = ink.bar.cgColor
        var clear = ink.sheen
        clear.opacity = 0
        sheen.colors = [clear.cgColor, ink.sheen.cgColor, clear.cgColor]
        CATransaction.commit()
        draw(force: true)
    }

    func lay(in bounds: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        frame = bounds
        CATransaction.commit()
        draw(force: false)
    }

    private func draw(force: Bool) {
        guard let shown, force || bounds != laid else { return }
        laid = bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        let path = Self.path(shown.kind, in: bounds.size)
        for layer in [bars, cut] {
            layer.frame = bounds
            layer.path = path
        }
        lit.frame = bounds
        sheen.removeAllAnimations()
        sheen.isHidden = shown.still
        guard !shown.still, bounds.width > 0 else { return }
        let width = max(80, bounds.width * 0.4)
        sheen.frame = CGRect(x: -width, y: 0, width: width, height: bounds.height)
        // Across from off its start to off its end, then a rest before the next.
        let animation = CAKeyframeAnimation(keyPath: "position.x")
        animation.values = [-width / 2, bounds.width + width / 2, bounds.width + width / 2]
        animation.keyTimes = [0, 0.7, 1]
        animation.timingFunctions = [CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .linear)]
        animation.duration = Self.period
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        // In step with every other one on screen.
        animation.beginTime = sheen.sharedClockStart(period: Self.period)
        sheen.add(animation, forKey: "sheen")
    }

    /// Its bars, from the top left, as one path.
    private static func path(_ kind: Placeholder.Kind, in size: CGSize) -> CGPath {
        let path = CGMutablePath()
        func bar(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat) {
            let width = min(width, size.width - x)
            guard width > 0 else { return }
            path.addRoundedRect(in: CGRect(x: x, y: y, width: width, height: lineHeight),
                                cornerWidth: lineHeight / 2, cornerHeight: lineHeight / 2)
        }
        switch kind {
        case .lines(let count):
            let measure = min(size.width, Self.measure)
            for index in 0..<max(1, count) {
                let line = lines[index % lines.count]
                bar(line.indent * indent, CGFloat(index) * (lineHeight + lineGap), max(24, measure * line.share))
            }
        case .rows(let count):
            let text = square + 10
            let measure = min(size.width - text, rowMeasure)
            for index in 0..<max(1, count) {
                let row = rows[index % rows.count]
                let top = CGFloat(index) * (rowHeight + rowGap)
                if size.width >= square {
                    path.addRoundedRect(in: CGRect(x: 0, y: top + (rowHeight - square) / 2, width: square, height: square),
                                        cornerWidth: 6, cornerHeight: 6)
                }
                // The title, and its longer detail under it, together on the row's middle.
                let gap: CGFloat = 6
                let first = top + (rowHeight - 2 * lineHeight - gap) / 2
                bar(text, first, max(24, measure * row.title))
                bar(text, first + lineHeight + gap, max(24, measure * row.detail))
            }
        case .image:
            guard size.width > 0, size.height > 0 else { break }
            let radius = min(8, size.width / 2, size.height / 2)
            path.addRoundedRect(in: CGRect(origin: .zero, size: size), cornerWidth: radius, cornerHeight: radius)
        }
        return path
    }
}
