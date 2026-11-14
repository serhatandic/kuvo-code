import QuartzCore
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// A bot moving, played by Core Animation. BotPose works out its motion over one cycle of its
/// mood, which goes to the window server as keyframes; it plays them on the GPU, so a moving bot
/// costs the app nothing from one frame to the next (moving in SwiftUI, a frame at a time, the
/// sidebar's bots at rest took a third of a core). Its pieces are pictures drawn once, by the
/// same views a still bot is drawn with.
struct BotMotion {
    let look: BotLook
    let size: CGFloat
    let mood: BotMood
    let noticed: Bool
    let seed: Double
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var scale


    fileprivate var spec: BotMotionView.Spec {
        BotMotionView.Spec(look: look, size: size, mood: mood, noticed: noticed, seed: seed, scheme: scheme, scale: scale)
    }
}

#if os(macOS)
extension BotMotion: NSViewRepresentable {
    func makeNSView(context: Context) -> BotMotionView { BotMotionView() }
    func updateNSView(_ view: BotMotionView, context: Context) { view.show(spec) }
}
#else
extension BotMotion: UIViewRepresentable {
    func makeUIView(context: Context) -> BotMotionView { BotMotionView() }
    func updateUIView(_ view: BotMotionView, context: Context) { view.show(spec) }
}
#endif

final class BotMotionView: PlatformView {
    struct Spec: Equatable {
        var look: BotLook
        var size: CGFloat
        var mood: BotMood
        var noticed: Bool
        var seed: Double
        var scheme: ColorScheme
        var scale: CGFloat

        /// The same pictures do for both.
        func drawsLike(_ other: Spec) -> Bool {
            look == other.look && size == other.size && scheme == other.scheme && scale == other.scale
        }
    }

    private var spec: Spec?
    /// Laid out from the top left, as SwiftUI lays out the still bot.
    private let root = CALayer()
    private let glow = CALayer()
    /// The bot itself, which hops, leans and squashes from its base.
    private let figure = CALayer()
    private let body = CALayer()
    private let face = CALayer()
    /// Two sparks, five dots each, head first.
    private let dots = (0..<10).map { _ in CALayer() }
    private let zs = (0..<3).map { _ in CALayer() }
    private let star = CALayer()

    init() {
        super.init(frame: .zero)
        #if os(macOS)
        wantsLayer = true
        layer?.masksToBounds = false
        root.isGeometryFlipped = true
        layer?.addSublayer(root)
        #else
        // Touches go to what it's in (a row of the list).
        isUserInteractionEnabled = false
        layer.masksToBounds = false
        layer.addSublayer(root)
        #endif
        root.masksToBounds = false
        for piece in [glow, figure, star] + zs { root.addSublayer(piece) }
        for piece in dots + [body, face] { figure.addSublayer(piece) }
        body.zPosition = 0
        face.zPosition = 0.5
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    #if os(macOS)
    /// Clicks and the pointer go to what it's in (a row in the sidebar).
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

    func show(_ spec: Spec) {
        guard spec != self.spec else { return }
        let redraw = self.spec.map { !$0.drawsLike(spec) } ?? true
        self.spec = spec
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if redraw { draw(spec) }
        animate(spec)
        CATransaction.commit()
    }

    // MARK: Pictures

    /// A bot's pictures, drawn once for its look at its size: the sidebar coming back makes all
    /// of its bots again, and drawing them took most of the slide's first frames.
    private final class Pictures {
        var glow: CGImage?
        var body: CGImage?
        var dots: [CGImage?] = []
        var letter: CGImage?
        var star: CGImage?
        var faces: [BotLook.Face: CGImage] = [:]
    }

    private struct PicturesKey: Hashable {
        var look: BotLook
        var size: CGFloat
        var scheme: ColorScheme
        var scale: CGFloat
    }

    private static var pictureCache: [PicturesKey: Pictures] = [:]
    private var pictures = Pictures()

    private func draw(_ spec: Spec) {
        let size = spec.size
        let center = CGPoint(x: size / 2, y: size / 2)
        let key = PicturesKey(look: spec.look, size: size, scheme: spec.scheme, scale: spec.scale)
        let cached = Self.pictureCache[key]
        let pictures = cached ?? Pictures()
        self.pictures = pictures
        func picture(_ view: some View) -> CGImage? {
            let renderer = ImageRenderer(content: view.environment(\.colorScheme, spec.scheme))
            renderer.scale = spec.scale
            return renderer.cgImage
        }
        if cached == nil {
            pictures.glow = picture(Circle().fill(Color.orange).frame(width: size, height: size))
            pictures.body = picture(BotAvatar.body(spec.look, size: size)
                .shadow(color: .black.opacity(size > 40 ? 0.12 : 0.08), radius: size / 24, y: size / 48)
                .padding(size * 0.25))
            let tint = spec.look.color.color
            pictures.dots = (0..<dots.count).map { index in picture(BotAvatar.sparkDot(step: index % 5, tint: tint, size: size)) }
            pictures.letter = picture(BotAvatar.zLetter(size: size).fixedSize())
            pictures.star = picture(BotAvatar.star(size: size))
            // A few large ones (the editor's) weigh as much as many small ones (a list's).
            if Self.pictureCache.count > (size > 60 ? 8 : 64) { Self.pictureCache = [:] }
            Self.pictureCache[key] = pictures
        }
        func place(_ layer: CALayer, _ image: CGImage?, at position: CGPoint) {
            layer.contents = image
            layer.contentsScale = spec.scale
            let points = image.map { CGSize(width: CGFloat($0.width) / spec.scale, height: CGFloat($0.height) / spec.scale) } ?? .zero
            layer.bounds = CGRect(origin: .zero, size: points)
            layer.position = position
        }

        glow.contents = pictures.glow
        glow.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        glow.position = center

        figure.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        figure.anchorPoint = CGPoint(x: 0.5, y: 1)
        figure.position = CGPoint(x: size / 2, y: size)

        // With room for its shadow.
        place(body, pictures.body, at: center)

        face.bounds = CGRect(x: 0, y: 0, width: size * 0.5, height: size * 0.3)
        face.position = CGPoint(x: center.x + size * 0.04, y: center.y + BotAvatar.faceOffset(spec.look.shape, size: size))
        face.contentsScale = spec.scale

        for (index, dot) in dots.enumerated() {
            place(dot, index < pictures.dots.count ? pictures.dots[index] : nil, at: center)
        }
        for z in zs { place(z, pictures.letter, at: center) }
        place(star, pictures.star, at: center)
    }

    private func faceImage(_ kind: BotLook.Face, _ spec: Spec) -> CGImage? {
        if let image = pictures.faces[kind] { return image }
        let renderer = ImageRenderer(content: BotFace(face: kind, deep: spec.look.color.isDeep).frame(width: spec.size * 0.5, height: spec.size * 0.3))
        renderer.scale = spec.scale
        let image = renderer.cgImage
        pictures.faces[kind] = image
        return image
    }

    // MARK: Motion

    /// How long one round of a mood's motion is, a length its parts' own rhythms fit into (so it
    /// loops without a jump), and how often in it the pose is worked out; Core Animation moves
    /// smoothly between those.
    static func cycle(_ mood: BotMood, noticed: Bool) -> (length: Double, rate: Double) {
        switch mood {
        // Breaths of 3.8 s, a fidget every 4.2 s; noticed, hops of half a second.
        case .idle: noticed ? (19, 30) : (79.8, 20)
        // Hops of 2.8 s, eyes along a line in 1.2 s, a turn in 6 s.
        case .working: (42, 30)
        // A hop and wiggle every 2.4 s, a pulse every 1.6 s.
        case .waiting: (4.8, 30)
        // Breaths of 2.6 s, hops and a sparkle every 3.6 s.
        case .news: (46.8, 30)
        // Breaths of 4.2 s and a look out one way and the other every 6.4 s.
        case .watching: noticed ? (42, 20) : (134.4, 20)
        // Breaths of 3.6 s, a nod in 7.2 s, a z every 4.2 s.
        case .sleeping: (50.4, 20)
        }
    }

    /// One part's motion: its value at the start, and, if it moves, its keyframes over a round.
    private struct Recipe {
        var layer: Int
        var keyPath: String
        var first: Any
        var values: [Any]?
        var duration: Double
        var discrete = false
    }

    private struct MotionKey: Hashable {
        var look: BotLook
        var size: CGFloat
        var mood: BotMood
        var noticed: Bool
        var seed: Double
        var scheme: ColorScheme
        var scale: CGFloat
    }

    /// Bots' motion as last worked out: a bot made again (the sidebar coming back) plays it at
    /// once, rather than working out a round of poses again.
    private static var motionCache: [MotionKey: [Recipe]] = [:]

    private var parts: [CALayer] { [glow, figure, body, face, star] + dots + zs }

    private func apply(_ recipes: [Recipe]) {
        let parts = parts
        let now = CACurrentMediaTime()
        for recipe in recipes {
            let layer = parts[recipe.layer]
            layer.setValue(recipe.first, forKeyPath: recipe.keyPath)
            guard let values = recipe.values else { continue }
            let animation = CAKeyframeAnimation(keyPath: recipe.keyPath)
            animation.values = values
            animation.duration = recipe.duration
            animation.repeatCount = .infinity
            animation.isRemovedOnCompletion = false
            if recipe.discrete { animation.calculationMode = .discrete }
            // Where in the round it is now: bots that came in at different times still move apart.
            animation.beginTime = layer.convertTime(now, from: nil) - now.truncatingRemainder(dividingBy: recipe.duration)
            layer.add(animation, forKey: recipe.keyPath)
        }
    }

    private func animate(_ spec: Spec) {
        for layer in parts { layer.removeAllAnimations() }
        let key = MotionKey(look: spec.look, size: spec.size, mood: spec.mood, noticed: spec.noticed, seed: spec.seed, scheme: spec.scheme, scale: spec.scale)
        if let recipes = Self.motionCache[key] {
            apply(recipes)
            return
        }
        var recipes: [Recipe] = []
        let parts = parts
        let (length, rate) = Self.cycle(spec.mood, noticed: spec.noticed)
        let count = Int((length * rate).rounded())
        let poses = (0..<count).map { index in
            BotPose(mood: spec.mood, noticed: spec.noticed, time: Double(index) / rate + spec.seed, seed: spec.seed, small: spec.size < 24)
        }
        let size = spec.size
        let center = CGPoint(x: size / 2, y: size / 2)

        /// Each pose's value, back to the first at the end, as the round starts again. A part
        /// with a rhythm of its own (the sparks' orbit) goes round in `round`, `over` its poses.
        func play(_ layer: CALayer, _ keyPath: String, discrete: Bool = false, over poses: [BotPose] = poses, round: Double = length, _ value: (BotPose) -> Any) {
            var values = poses.map(value)
            values.append(values[0])
            // The same all round: set, not played.
            let still = if let numbers = values as? [Double] {
                numbers.allSatisfy { abs($0 - numbers[0]) < 0.0001 }
            } else {
                values.allSatisfy { CFEqual($0 as CFTypeRef, values[0] as CFTypeRef) }
            }
            let index = parts.firstIndex { $0 === layer } ?? 0
            recipes.append(Recipe(layer: index, keyPath: keyPath, first: values[0], values: still ? nil : values, duration: round, discrete: discrete))
        }

        let degrees = Double.pi / 180
        play(figure, "transform.translation.y") { Double($0.lift * size) }
        play(figure, "transform.rotation.z") { $0.tilt * degrees }
        play(figure, "transform.scale.x") { Double($0.scaleX) }
        play(figure, "transform.scale.y") { Double($0.scaleY) }

        // A turn goes on round: each pose's angle counts the whole circles before it, and the
        // round ends a whole number of circles on (working's 42 s at 60° a second is seven), so
        // the next one starts where it looks the same, rather than spinning back.
        if spec.look.shape == .bloom || spec.look.shape == .gem {
            func step(_ from: Double, _ to: Double) -> Double {
                let step = (to - from).truncatingRemainder(dividingBy: 360)
                return step > 180 ? step - 360 : step < -180 ? step + 360 : step
            }
            var turned = poses[0].spin
            var values = [turned * degrees]
            for index in 1..<poses.count {
                turned += step(poses[index - 1].spin, poses[index].spin)
                values.append(turned * degrees)
            }
            turned += step(poses[poses.count - 1].spin, poses[0].spin)
            values.append(turned * degrees)
            let moves = values.contains { abs($0) > 0.0001 }
            recipes.append(Recipe(layer: 2, keyPath: "transform.rotation.z", first: poses[0].spin * degrees, values: moves ? values : nil, duration: length))
        } else {
            recipes.append(Recipe(layer: 2, keyPath: "transform.rotation.z", first: 0.0, values: nil, duration: length))
        }

        let faceWidth = Double(size * 0.5)
        play(face, "contents", discrete: true) { pose -> Any in self.faceImage(pose.face ?? spec.look.face, spec) ?? NSNull() }
        play(face, "transform.translation.x") { Double($0.glance) * faceWidth }
        play(face, "transform.scale.y") { pose in
            // Only open eyes shut; closed-looking ones stay as they are.
            switch pose.face ?? spec.look.face {
            case .happy, .sleepy: 1
            default: 1 - 0.88 * Double(pose.blink)
            }
        }

        play(glow, "opacity") { Double(0.4 * (1 - $0.glow)) * ($0.glow > 0 ? 1 : 0) }
        play(glow, "transform.scale") { Double(1 + 0.5 * $0.glow) }

        // The sparks circle in 1.3 s, which no round of the rest fits: a round of their own.
        let orbit = 1.3
        let orbitPoses = spec.mood == .working
            ? (0..<39).map { BotPose(mood: spec.mood, noticed: spec.noticed, time: Double($0) / 30 + spec.seed, seed: spec.seed, small: spec.size < 24) }
            : poses
        let orbitRound = spec.mood == .working ? orbit : length
        for (index, dot) in dots.enumerated() {
            let spark = index / 5, step = index % 5
            func placement(_ pose: BotPose) -> BotAvatar.Placement? {
                guard pose.sparks.indices.contains(spark) else { return nil }
                return BotAvatar.sparkDots(at: pose.sparks[spark], size: size)[step]
            }
            play(dot, "position", over: orbitPoses, round: orbitRound) { pose in
                let offset = placement(pose)?.offset ?? .zero
                return NSValue.point(CGPoint(x: center.x + offset.width, y: center.y + offset.height))
            }
            play(dot, "transform.scale", over: orbitPoses, round: orbitRound) { Double(placement($0)?.scale ?? 1) }
            play(dot, "opacity", over: orbitPoses, round: orbitRound) { placement($0)?.opacity ?? 0 }
            play(dot, "zPosition", discrete: true, over: orbitPoses, round: orbitRound) { pose in
                pose.sparks.indices.contains(spark) && BotAvatar.sparkInFront(pose.sparks[spark]) ? 1.0 : -1.0
            }
        }

        for (index, z) in zs.enumerated() {
            func placement(_ pose: BotPose) -> BotAvatar.Placement? {
                pose.zs.indices.contains(index) ? BotAvatar.z(at: pose.zs[index], size: size) : nil
            }
            play(z, "position") { pose in
                let offset = placement(pose)?.offset ?? .zero
                return NSValue.point(CGPoint(x: center.x + offset.width, y: center.y + offset.height))
            }
            play(z, "transform.scale") { Double(placement($0)?.scale ?? 1) }
            play(z, "opacity") { placement($0)?.opacity ?? 0 }
        }

        let starAt = BotAvatar.starOffset(size: size)
        star.position = CGPoint(x: center.x + starAt.width, y: center.y + starAt.height)
        play(star, "transform.scale") { Double($0.twinkle) }
        play(star, "transform.rotation.z") { Double($0.twinkle) * 45 * degrees }

        apply(recipes)
        if Self.motionCache.count > 64 { Self.motionCache = [:] }
        Self.motionCache[key] = recipes
    }
}

private extension NSValue {
    /// A point as Core Animation takes it.
    static func point(_ point: CGPoint) -> NSValue {
        #if os(macOS)
        NSValue(point: point)
        #else
        NSValue(cgPoint: point)
        #endif
    }
}
