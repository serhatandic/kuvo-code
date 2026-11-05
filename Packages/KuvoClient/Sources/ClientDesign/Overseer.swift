import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// A bot overseeing a project's sessions, in a sidebar: its face on the project's row, and a lane in
// its colour from the project's folder down to each of its sessions, as branches hang from theirs.
// As the bot does something to one of them, a light runs down its lane to that session and its
// elbow glows a moment; one that finished pleases its face. Each is played once by Core Animation,
// and nothing moves at rest.

/// A bot's face on a project it oversees sessions in: still, looking after them; bright while one
/// of them needs you, asleep while it's paused, and pleased a moment when one finishes.
public struct OverseerFace: View {
    public enum Pose: Hashable, Sendable {
        case rest, needsYou, paused
    }

    let look: BotLook
    let size: CGFloat
    let pose: Pose
    let pleased: String?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var scale

    /// `pleased`: the mark of a session of its that just finished, which pleases it once.
    public init(look: BotLook, size: CGFloat, pose: Pose, pleased: String? = nil) {
        self.look = look
        self.size = size
        self.pose = pose
        self.pleased = pleased
    }

    public var body: some View {
        OverseerFaceHost(spec: OverseerFaceView.Spec(look: look, size: size, pose: pose, scheme: scheme, scale: scale), pleased: pleased)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

#if os(macOS)
private struct OverseerFaceHost: NSViewRepresentable {
    let spec: OverseerFaceView.Spec
    let pleased: String?
    func makeNSView(context: Context) -> OverseerFaceView { OverseerFaceView() }
    func updateNSView(_ view: OverseerFaceView, context: Context) { view.show(spec, pleased: pleased) }
}
#else
private struct OverseerFaceHost: UIViewRepresentable {
    let spec: OverseerFaceView.Spec
    let pleased: String?
    func makeUIView(context: Context) -> OverseerFaceView { OverseerFaceView() }
    func updateUIView(_ view: OverseerFaceView, context: Context) { view.show(spec, pleased: pleased) }
}
#endif

final class OverseerFaceView: PlatformView {
    struct Spec: Equatable {
        var look: BotLook
        var size: CGFloat
        var pose: OverseerFace.Pose
        var scheme: ColorScheme
        var scale: CGFloat
    }

    private var spec: Spec?
    private var pleased: String?
    private let face = CALayer()

    init() {
        super.init(frame: .zero)
        #if os(macOS)
        wantsLayer = true
        layer?.masksToBounds = false
        layer?.addSublayer(face)
        #else
        isUserInteractionEnabled = false
        layer.masksToBounds = false
        layer.addSublayer(face)
        #endif
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    #if os(macOS)
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        place()
    }
    #else
    override func layoutSubviews() {
        super.layoutSubviews()
        place()
    }
    #endif

    private func place() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        face.position = CGPoint(x: bounds.midX, y: bounds.midY)
        CATransaction.commit()
    }

    func show(_ spec: Spec, pleased: String?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if spec != self.spec {
            // Its pose changed (one of its sessions asks you, say): shown at once.
            if spec.pose != self.spec?.pose { face.removeAnimation(forKey: "pleased") }
            self.spec = spec
            let picture = Self.picture(spec, mood: spec.pose.mood)
            face.contents = picture
            face.contentsScale = spec.scale
            face.bounds = CGRect(origin: .zero, size: picture.map { CGSize(width: CGFloat($0.width) / spec.scale, height: CGFloat($0.height) / spec.scale) } ?? .zero)
            face.opacity = spec.pose == .paused ? 0.6 : 1
            face.position = CGPoint(x: bounds.midX, y: bounds.midY)
        }
        // A new one, while it's looking after them: pleased for a moment, then back as it was.
        // Its face changes, it doesn't move: the bot may be moving in Bots meanwhile.
        if let pleased, pleased != self.pleased, spec.pose == .rest {
            let happy = Self.picture(spec, mood: .news)
            let pleasing = CAKeyframeAnimation(keyPath: "contents")
            pleasing.values = [happy as Any, happy as Any, face.contents as Any]
            pleasing.keyTimes = [0, 0.82, 1]
            pleasing.duration = 1.7
            pleasing.calculationMode = .linear
            face.add(pleasing, forKey: "pleased")
        }
        self.pleased = pleased
        CATransaction.commit()
    }

    private struct PictureKey: Hashable {
        var look: BotLook
        var size: CGFloat
        var mood: BotMood
        var scheme: ColorScheme
        var scale: CGFloat
    }

    /// Each pose drawn once, by the still bot's own view: a sidebar coming back makes all its
    /// faces again.
    @MainActor private static var pictures: [PictureKey: CGImage] = [:]

    @MainActor private static func picture(_ spec: Spec, mood: BotMood) -> CGImage? {
        var look = spec.look
        if spec.pose == .paused { look.color = .graphite }
        let key = PictureKey(look: look, size: spec.size, mood: mood, scheme: spec.scheme, scale: spec.scale)
        if let picture = pictures[key] { return picture }
        let renderer = ImageRenderer(content: BotAvatar(look: look, size: spec.size, mood: mood, animates: false)
            .frame(width: spec.size * 1.5, height: spec.size * 1.5)
            .environment(\.colorScheme, spec.scheme))
        renderer.scale = spec.scale
        let picture = renderer.cgImage
        if pictures.count > 96 { pictures = [:] }
        pictures[key] = picture
        return picture
    }
}

private extension OverseerFace.Pose {
    var mood: BotMood {
        switch self {
        case .rest: .idle
        case .needsYou: .waiting
        case .paused: .sleeping
        }
    }
}

/// A bot's lane down a project's sessions, in the sidebar's own space: from under the project's
/// folder, an elbow into each of its sessions shown, on into Show More when some aren't.
public struct OverseerLane: Hashable, Sendable, Identifiable {
    public var bot: String
    public var look: BotLook
    public var paused: Bool
    /// The lane's line, and where it starts (under the folder) and ends.
    public var x: CGFloat
    public var top: CGFloat
    public var bottom: CGFloat
    /// Each of its sessions' elbows, by session: how far down, into its row.
    public var elbows: [String: CGFloat]
    /// Where the elbows reach, just short of the sessions' titles.
    public var reach: CGFloat
    public var id: String { bot }

    public init(bot: String, look: BotLook, paused: Bool, x: CGFloat, top: CGFloat, bottom: CGFloat, elbows: [String: CGFloat], reach: CGFloat) {
        self.bot = bot
        self.look = look
        self.paused = paused
        self.x = x
        self.top = top
        self.bottom = bottom
        self.elbows = elbows
        self.reach = reach
    }
}

/// Something a bot just did to one of its sessions, to light on its lane: once, by `id`.
public struct OverseerLight: Hashable, Sendable, Identifiable {
    public var id: String
    public var bot: String
    public var session: String

    public init(id: String, bot: String, session: String) {
        self.id = id
        self.bot = bot
        self.session = session
    }
}

/// A project's lanes, over its rows: drawn still, with a light run down one as its bot does
/// something. Nothing here takes a click or the pointer.
public struct OverseerLanes: View {
    let lanes: [OverseerLane]
    let lights: [OverseerLight]
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(lanes: [OverseerLane], lights: [OverseerLight]) {
        self.lanes = lanes
        self.lights = lights
    }

    /// How round a lane turns into a session's row.
    public static let radius: CGFloat = 6

    public var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(lanes) { lane in
                Self.path(lane)
                    .stroke(lane.paused ? Color.secondary.opacity(0.35) : lane.look.color.color.opacity(scheme == .dark ? 0.62 : 0.7),
                            style: StrokeStyle(lineWidth: 1.5, lineCap: .butt, dash: lane.paused ? [2, 3] : []))
            }
            OverseerLightsHost(lanes: lanes.filter { !$0.paused }, lights: lights, still: reduceMotion, scheme: scheme)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// One stroke for the whole lane, so its elbows meet the line without a seam.
    static func path(_ lane: OverseerLane) -> Path {
        Path { path in
            path.move(to: CGPoint(x: lane.x, y: lane.top))
            path.addLine(to: CGPoint(x: lane.x, y: lane.bottom))
            for y in lane.elbows.values {
                path.move(to: CGPoint(x: lane.x, y: y - radius))
                path.addQuadCurve(to: CGPoint(x: lane.x + radius, y: y), control: CGPoint(x: lane.x, y: y))
                path.addLine(to: CGPoint(x: lane.reach, y: y))
            }
        }
    }

    /// An elbow alone, lit.
    static func elbow(_ lane: OverseerLane, at y: CGFloat) -> Path {
        Path { path in
            path.move(to: CGPoint(x: lane.x, y: y - radius - 4))
            path.addLine(to: CGPoint(x: lane.x, y: y - radius))
            path.addQuadCurve(to: CGPoint(x: lane.x + radius, y: y), control: CGPoint(x: lane.x, y: y))
            path.addLine(to: CGPoint(x: lane.reach, y: y))
        }
    }

    /// How long the light takes down a lane, longer the further it goes: a third of a second to
    /// the first row, about a second ten rows down.
    static func travel(_ distance: CGFloat) -> Double { 0.28 + 0.07 * Double(max(distance, 0)) / 33 }
}

#if os(macOS)
private struct OverseerLightsHost: NSViewRepresentable {
    let lanes: [OverseerLane]
    let lights: [OverseerLight]
    let still: Bool
    let scheme: ColorScheme
    func makeNSView(context: Context) -> OverseerLightsView { OverseerLightsView() }
    func updateNSView(_ view: OverseerLightsView, context: Context) { view.play(lights, on: lanes, still: still, scheme: scheme) }
}
#else
private struct OverseerLightsHost: UIViewRepresentable {
    let lanes: [OverseerLane]
    let lights: [OverseerLight]
    let still: Bool
    let scheme: ColorScheme
    func makeUIView(context: Context) -> OverseerLightsView { OverseerLightsView() }
    func updateUIView(_ view: OverseerLightsView, context: Context) { view.play(lights, on: lanes, still: still, scheme: scheme) }
}
#endif

/// The lights on a project's lanes: a layer for each while it plays, then none.
final class OverseerLightsView: PlatformView {
    private let root = CALayer()
    private var played: [String] = []

    init() {
        super.init(frame: .zero)
        #if os(macOS)
        wantsLayer = true
        layer?.masksToBounds = false
        root.isGeometryFlipped = true
        layer?.addSublayer(root)
        #else
        isUserInteractionEnabled = false
        layer.masksToBounds = false
        layer.addSublayer(root)
        #endif
        root.masksToBounds = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    #if os(macOS)
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        place()
    }
    #else
    override func layoutSubviews() {
        super.layoutSubviews()
        place()
    }
    #endif

    private func place() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        root.frame = bounds
        CATransaction.commit()
    }

    private final class Layers {
        var all: [CALayer] = []
    }

    /// Layers playing now: none at rest.
    var playing: Int { root.sublayers?.count ?? 0 }

    func play(_ lights: [OverseerLight], on lanes: [OverseerLane], still: Bool, scheme: ColorScheme) {
        // Only those with a lane to play on: one whose lane isn't laid out yet plays once it is.
        let new = lights.filter { light in !played.contains(light.id) && lanes.contains { $0.bot == light.bot } }
        guard !new.isEmpty else { return }
        played = Array((played + new.map(\.id)).suffix(64))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let now = root.convertTime(CACurrentMediaTime(), from: nil)
        for light in new {
            guard let lane = lanes.first(where: { $0.bot == light.bot }) else { continue }
            // To its row, or into Show More when it's among those not shown.
            let elbow = lane.elbows[light.session]
            let to = elbow ?? lane.bottom
            let travel = still ? 0 : OverseerLanes.travel(to - lane.top)
            let tint = PlatformColor(lane.look.color.color)
            // Gone once played, so nothing's left on the lane: the block waits for the
            // animations added after it.
            let layers = Layers()
            CATransaction.begin()
            CATransaction.setCompletionBlock { [layers] in
                for layer in layers.all { layer.removeFromSuperlayer() }
            }
            if !still {
                layers.all.append(runner(lane, to: to, tint: tint, scheme: scheme, at: now, travel: travel))
            }
            if let elbow {
                layers.all += glow(lane, at: elbow, tint: tint, scheme: scheme, at: now + travel, rise: still ? 0.4 : 0.12)
            }
            for layer in layers.all { root.addSublayer(layer) }
            CATransaction.commit()
        }
        CATransaction.commit()
    }

    /// The light running down the lane.
    private func runner(_ lane: OverseerLane, to y: CGFloat, tint: PlatformColor, scheme: ColorScheme, at start: CFTimeInterval, travel: Double) -> CALayer {
        let runner = CALayer()
        runner.bounds = CGRect(x: 0, y: 0, width: 3, height: 9)
        runner.cornerRadius = 1.5
        runner.backgroundColor = Self.lit(tint, scheme: scheme, by: 0.35).cgColor
        runner.shadowColor = tint.cgColor
        runner.shadowOpacity = 0.9
        runner.shadowRadius = 3
        runner.shadowOffset = .zero
        runner.position = CGPoint(x: lane.x, y: y)
        runner.opacity = 0
        let move = CABasicAnimation(keyPath: "position.y")
        move.fromValue = lane.top
        move.toValue = y
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0, 1, 1, 0]
        fade.keyTimes = [0, 0.12, 0.85, 1]
        let group = CAAnimationGroup()
        group.animations = [move, fade]
        group.beginTime = start
        group.duration = travel
        group.fillMode = .both
        group.isRemovedOnCompletion = false
        move.duration = travel
        fade.duration = travel
        runner.add(group, forKey: "runs")
        return runner
    }

    /// The elbow lit, and a soft light where it meets the title: up quickly, a moment, then gone.
    private func glow(_ lane: OverseerLane, at y: CGFloat, tint: PlatformColor, scheme: ColorScheme, at start: CFTimeInterval, rise: Double) -> [CALayer] {
        let hold = 0.5, fall = 1.1, duration = rise + hold + fall
        func fading(_ layer: CALayer, to peak: Float) {
            layer.opacity = 0
            let fade = CAKeyframeAnimation(keyPath: "opacity")
            fade.values = [0, peak, peak, 0]
            fade.keyTimes = [0, NSNumber(value: rise / duration), NSNumber(value: (rise + hold) / duration), 1]
            fade.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .linear), CAMediaTimingFunction(name: .easeInEaseOut)]
            fade.beginTime = start
            fade.duration = duration
            fade.fillMode = .both
            fade.isRemovedOnCompletion = false
            layer.add(fade, forKey: "lights")
        }
        let elbow = CAShapeLayer()
        elbow.frame = root.bounds
        elbow.path = OverseerLanes.elbow(lane, at: y).cgPath
        elbow.fillColor = nil
        elbow.strokeColor = Self.lit(tint, scheme: scheme, by: scheme == .dark ? 0.25 : 0).cgColor
        elbow.lineWidth = 2
        elbow.lineCap = .round
        fading(elbow, to: 1)
        let spot = CALayer()
        spot.bounds = CGRect(x: 0, y: 0, width: 4, height: 4)
        spot.cornerRadius = 2
        spot.backgroundColor = tint.cgColor
        spot.shadowColor = tint.cgColor
        spot.shadowOpacity = 1
        spot.shadowRadius = 4
        spot.shadowOffset = .zero
        spot.position = CGPoint(x: lane.reach, y: y)
        fading(spot, to: 0.5)
        return [elbow, spot]
    }

    private static func lit(_ tint: PlatformColor, scheme: ColorScheme, by amount: CGFloat) -> PlatformColor {
        guard amount > 0 else { return tint }
        #if os(macOS)
        return tint.blended(withFraction: amount, of: .white) ?? tint
        #else
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        tint.getRed(&r, green: &g, blue: &b, alpha: &a)
        return UIColor(red: r + (1 - r) * amount, green: g + (1 - g) * amount, blue: b + (1 - b) * amount, alpha: a)
        #endif
    }
}
