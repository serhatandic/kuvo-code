import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// How far a download or an install has come, as one thin bar: a faint track and an accent fill
/// that eases to each new value. Under it, in small secondary digits, how much on the left ("34 of
/// 92 MB", or "34%" when only a share is known) and, once its pace is clear, about how long is
/// left on the right. With no total yet, a short accent segment glides along the track instead,
/// played by Core Animation on one clock; with Reduce Motion it stands still. VoiceOver hears one
/// element: what it is and how much, with the percent as its value.
public struct ProgressLine: View {
    public enum Layout: Sendable {
        /// The bar, and its numbers on a line under it.
        case stacked
        /// The numbers beside the bar, on one line, for a row with no room under it.
        case inline
        /// The bar alone, where the words beside it say how far ("part 4 of 9").
        case bar
    }

    let label: String
    let fraction: Double?
    let done: Int64?
    let total: Int64?
    let layout: Layout
    /// How far it got, with nothing going on now (it waits): grey, not the accent, and no time left.
    let isStill: Bool
    /// How far it was lately, to tell its pace by.
    @State private var samples: [Words.Sample] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The amount's size: 12 points, larger with larger text (the phone's Dynamic Type).
    @ScaledMetric(relativeTo: .caption) private var amountSize: CGFloat = 12
    @Environment(\.accent) private var accent
    @Environment(\.colorScheme) private var scheme

    /// A share of the way, 0 to 1; nil while it isn't known. `label` is what VoiceOver says it is
    /// ("Downloading").
    public init(_ label: String, fraction: Double?, layout: Layout = .stacked) {
        self.label = label
        self.fraction = fraction
        self.done = nil
        self.total = nil
        self.layout = layout
        self.isStill = false
    }

    /// Bytes so far, of a total when it's known. `still`: nothing's going on now (it waits).
    public init(_ label: String, bytes done: Int64, of total: Int64?, layout: Layout = .stacked, still: Bool = false) {
        self.label = label
        self.done = done
        self.total = total.flatMap { $0 > 0 ? $0 : nil }
        self.fraction = self.total.map { Double(done) / Double($0) }
        self.layout = layout
        self.isStill = still
    }

    private var share: Double? { fraction.map { min(1, max(0, $0)) } }

    /// Bytes to tell of: none while nothing has come of a size not known.
    private var bytes: Int64? { done.flatMap { $0 > 0 || total != nil ? $0 : nil } }

    private var amount: String? {
        if done != nil { return bytes.map { Words.amount(done: $0, of: total) } }
        return share.map(Words.percent)
    }

    private var timeLeft: String? { isStill ? nil : Words.secondsLeft(samples).map(Words.timeLeft) }

    public var body: some View {
        Group {
            switch layout {
            case .stacked:
                VStack(spacing: 6) {
                    bar
                    HStack(spacing: 8) {
                        // A line kept from the start, so nothing under it moves when numbers come.
                        Text(amount ?? " ")
                        Spacer(minLength: 8)
                        if let timeLeft { Text(timeLeft) }
                    }
                    .font(.system(size: amountSize))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
            case .bar:
                bar
            case .inline:
                HStack(spacing: 8) {
                    bar
                        .frame(minWidth: 60)
                    if let amount {
                        Text([amount, timeLeft].compactMap(\.self).joined(separator: " · "))
                            .font(.system(size: amountSize))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bytes.map { "\(label), \(Words.spokenAmount(done: $0, of: total))" } ?? label)
        .accessibilityValue([share.map { "\(Words.percent($0).dropLast()) percent" },
                             timeLeft.map { $0.lowercased() + " left" }]
            .compactMap(\.self).joined(separator: ", "))
        .accessibilityAddTraits(isStill ? [] : .updatesFrequently)
        .onAppear { note(share) }
        .onChange(of: share) { _, share in note(share) }
        // Stalled: no pace to tell, so no guess at what's left.
        .task(id: samples.last?.time) {
            guard !samples.isEmpty, (try? await Task.sleep(for: .seconds(Self.stall))) != nil else { return }
            samples = []
        }
    }

    private var bar: some View {
        Capsule()
            .fill(Color.primary.opacity(0.08))
            .frame(height: 4)
            .overlay(alignment: .leading) {
                if let share {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(isStill ? AnyShapeStyle(.tertiary) : AnyShapeStyle(accent))
                            .frame(width: max(4, proxy.size.width * share))
                    }
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: share)
                } else {
                    ProgressGlideHost(still: reduceMotion, ink: StatusMarkInk(scheme: scheme, accent: accent))
                }
            }
            .clipShape(.capsule)
    }

    /// How long without news before it counts as stalled.
    private static let stall: Double = 4
    /// How far back its pace is told from.
    private static let window: TimeInterval = 5

    private func note(_ share: Double?) {
        guard let share, share < 1 else { samples = []; return }
        let now = Date.timeIntervalSinceReferenceDate
        // A few a second is plenty, and keeps a chatty download's list short.
        if let last = samples.last, now - last.time < 0.25 { return }
        // Gone back (started over): its old pace says nothing.
        if let last = samples.last, share < last.fraction { samples = [] }
        samples = samples.filter { now - $0.time <= Self.window } + [(now, share)]
    }
}

extension ProgressLine {
    /// What the line's numbers say, the same on the Mac and the phone.
    public enum Words {
        /// How far it was at a moment: seconds on any steady clock, and the share of the way.
        public typealias Sample = (time: TimeInterval, fraction: Double)

        /// "34%": never 100 before it's all there.
        public static func percent(_ fraction: Double) -> String {
            "\(Int((min(1, max(0, fraction)) * 100).rounded(.down)))%"
        }

        /// "34 of 92 MB", "1.2 of 3.4 GB", in the total's unit; "34 MB" with no total.
        public static func amount(done: Int64, of total: Int64?) -> String {
            let unit = Unit(for: total ?? done)
            let digits = unit.digits(for: total ?? done)
            let so = unit.number(done, digits: digits, down: true)
            guard let total else { return "\(so) \(unit.short)" }
            return "\(so) of \(unit.number(total, digits: digits, down: false)) \(unit.short)"
        }

        /// "34 of 92 megabytes", for VoiceOver.
        public static func spokenAmount(done: Int64, of total: Int64?) -> String {
            let unit = Unit(for: total ?? done)
            let digits = unit.digits(for: total ?? done)
            let so = unit.number(done, digits: digits, down: true)
            guard let total else { return "\(so) \(unit.long)" }
            return "\(so) of \(unit.number(total, digits: digits, down: false)) \(unit.long)"
        }

        /// About how long is left at the pace of the samples, when they say: at least two seconds
        /// of them, and some way made in that time.
        public static func secondsLeft(_ samples: [Sample]) -> Double? {
            guard let first = samples.first, let last = samples.last, last.fraction < 1 else { return nil }
            let elapsed = last.time - first.time
            let made = last.fraction - first.fraction
            guard elapsed >= 2, made > 0.0005 else { return nil }
            return (1 - last.fraction) / (made / elapsed)
        }

        /// "A few seconds", "About 20 seconds", "About a minute", "About 4 minutes", "About an hour".
        public static func timeLeft(_ seconds: Double) -> String {
            switch seconds {
            case ..<10: return "A few seconds"
            case ..<55: return "About \(max(10, Int((seconds / 5).rounded()) * 5)) seconds"
            case ..<90: return "About a minute"
            case ..<(55 * 60): return "About \(max(2, Int((seconds / 60).rounded()))) minutes"
            case ..<(90 * 60): return "About an hour"
            default: return "About \(max(2, Int((seconds / 3600).rounded()))) hours"
            }
        }

        /// Sizes as the Finder counts them, a thousand to the next.
        private enum Unit {
            case bytes, kilobytes, megabytes, gigabytes

            init(for size: Int64) {
                switch size {
                case ..<1_000: self = .bytes
                case ..<1_000_000: self = .kilobytes
                case ..<1_000_000_000: self = .megabytes
                default: self = .gigabytes
                }
            }

            var size: Double {
                switch self {
                case .bytes: 1
                case .kilobytes: 1e3
                case .megabytes: 1e6
                case .gigabytes: 1e9
                }
            }

            var short: String {
                switch self {
                case .bytes: "bytes"
                case .kilobytes: "KB"
                case .megabytes: "MB"
                case .gigabytes: "GB"
                }
            }

            var long: String {
                switch self {
                case .bytes: "bytes"
                case .kilobytes: "kilobytes"
                case .megabytes: "megabytes"
                case .gigabytes: "gigabytes"
                }
            }

            /// A decimal while the total is under ten of it, so small totals still move.
            func digits(for size: Int64) -> Int {
                self != .bytes && Double(size) / self.size < 10 ? 1 : 0
            }

            func number(_ value: Int64, digits: Int, down: Bool) -> String {
                let scale = digits == 1 ? 10.0 : 1
                let scaled = Double(value) / size * scale
                let rounded = (down ? scaled.rounded(.down) : scaled.rounded()) / scale
                return digits == 1 ? String(format: "%.1f", rounded) : String(Int(rounded))
            }
        }
    }
}

#if os(macOS)
private struct ProgressGlideHost: NSViewRepresentable {
    let still: Bool
    let ink: StatusMarkInk

    func makeNSView(context: Context) -> ProgressGlideView { ProgressGlideView() }

    func updateNSView(_ view: ProgressGlideView, context: Context) {
        view.glide.show(still: still, ink: ink)
    }
}

final class ProgressGlideView: NSView {
    let glide = ProgressGlideLayer()

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.addSublayer(glide)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        glide.lay(in: bounds)
    }
}
#else
private struct ProgressGlideHost: UIViewRepresentable {
    let still: Bool
    let ink: StatusMarkInk

    func makeUIView(context: Context) -> ProgressGlideView { ProgressGlideView() }

    func updateUIView(_ view: ProgressGlideView, context: Context) {
        view.glide.show(still: still, ink: ink)
    }
}

final class ProgressGlideView: UIView {
    let glide = ProgressGlideLayer()

    init() {
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        layer.addSublayer(glide)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        glide.lay(in: bounds)
    }
}
#endif

/// The segment that glides along the track while the total isn't known: from off its start to
/// off its end, again and again, every one on the same clock.
final class ProgressGlideLayer: CALayer {
    private let segment = CALayer()
    private var still = false
    private var laid: CGRect = .null

    /// How much of the track the segment covers, and its trip along it.
    private static let length: CGFloat = 0.28
    private static let period: CFTimeInterval = 1.5

    func show(still: Bool, ink: StatusMarkInk) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if segment.superlayer == nil { addSublayer(segment) }
        segment.backgroundColor = ink.accent.cgColor
        CATransaction.commit()
        let changed = still != self.still
        self.still = still
        if changed { glide(force: true) }
    }

    func lay(in bounds: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        frame = bounds
        CATransaction.commit()
        glide(force: false)
    }

    private func glide(force: Bool) {
        guard force || bounds != laid else { return }
        laid = bounds
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        let width = max(12, bounds.width * Self.length)
        segment.bounds = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        segment.cornerRadius = bounds.height / 2
        // Still, it rests in the middle, where it can't be read as a share of the way.
        segment.position = CGPoint(x: bounds.midX, y: bounds.midY)
        segment.removeAllAnimations()
        guard !still, bounds.width > 0 else { return }
        let animation = CAKeyframeAnimation(keyPath: "position.x")
        animation.values = [-width / 2, bounds.width + width / 2]
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        animation.duration = Self.period
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        animation.beginTime = segment.sharedClockStart(period: Self.period)
        segment.add(animation, forKey: "glide")
    }
}
