import SwiftUI

/// How a bot looks: a color, a shape and a face, picked when it's made and changed any time.
nonisolated public struct BotLook: Codable, Hashable, Sendable {
    public var color: Tint
    public var shape: Form
    public var face: Face

    public init(color: Tint, shape: Form, face: Face) {
        self.color = color
        self.shape = shape
        self.face = face
    }

    public enum Tint: String, CaseIterable, Codable, Identifiable, Sendable {
        case mint, sky, indigo, violet, pink, coral, orange, amber, lime, graphite
        public var id: String { rawValue }

        public var color: Color {
            switch self {
            case .mint: Color(red: 0.37, green: 0.78, blue: 0.72)
            case .sky: Color(red: 0.31, green: 0.61, blue: 0.96)
            case .indigo: Color(red: 0.36, green: 0.36, blue: 0.94)
            case .violet: Color(red: 0.54, green: 0.36, blue: 0.96)
            case .pink: Color(red: 0.93, green: 0.44, blue: 0.71)
            case .coral: Color(red: 0.95, green: 0.45, blue: 0.36)
            case .orange: Color(red: 0.96, green: 0.60, blue: 0.24)
            case .amber: Color(red: 0.95, green: 0.76, blue: 0.31)
            case .lime: Color(red: 0.55, green: 0.80, blue: 0.31)
            case .graphite: Color(red: 0.43, green: 0.45, blue: 0.50)
            }
        }

        /// Deep colors get light eyes; the rest dark ones.
        public var isDeep: Bool { [.indigo, .violet, .graphite].contains(self) }

        public var title: String { rawValue.capitalized }

        /// One a newer Kuvo Code added: graphite, as a box shows a look it doesn't know.
        public init(from decoder: Decoder) throws {
            self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .graphite
        }
    }

    public enum Form: String, CaseIterable, Codable, Identifiable, Sendable {
        case round, squircle, pebble, gem, bloom
        public var id: String { rawValue }
        public var title: String { rawValue.capitalized }

        /// One a newer Kuvo Code added: round.
        public init(from decoder: Decoder) throws {
            self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .round
        }
    }

    public enum Face: String, CaseIterable, Codable, Identifiable, Sendable {
        case calm, happy, sleepy, wink, curious, bright
        public var id: String { rawValue }
        public var title: String { rawValue.capitalized }

        /// One a newer Kuvo Code added: calm.
        public init(from decoder: Decoder) throws {
            self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .calm
        }
    }

    public static func random() -> BotLook {
        BotLook(color: Tint.allCases.randomElement()!, shape: Form.allCases.randomElement()!, face: Face.allCases.randomElement()!)
    }
}

/// What a bot is up to, which is how its avatar moves.
public enum BotMood: Hashable, Sendable {
    /// Nothing to do: it breathes, blinks, looks around and fidgets now and then.
    case idle
    /// Running: it hops, its eyes scan, sparks circle it.
    case working
    /// Waiting for you (a permission, a question): it wiggles, wide-eyed, with a soft glow.
    case waiting
    /// Done, with something you haven't seen yet: happy, hopping now and then.
    case news
    /// Idle with a wake-up scheduled: asleep, with z's floating up.
    case sleeping
    /// Idle with something to watch (and no wake-up): awake, looking out one way and the other,
    /// leaning a little into each look.
    case watching
}

/// A bot's face on its shape, at any size: in the sidebar, on its tab, in its header and, large,
/// where it's made. It moves with its mood; everything is worked out from the clock, so each
/// frame is cheap, and it holds still with Reduce Motion on.
public struct BotAvatar: View {
    let look: BotLook
    var size: CGFloat = 26
    var mood: BotMood = .idle
    /// The pointer is on it: an idle bot notices, happy, with a little bounce.
    var noticed = false
    /// False where the bot also shows, moving, somewhere else on screen: it holds a still pose
    /// for its mood, and only moves when it's pointed at. One bot moves in one place at a time.
    var animates = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(look: BotLook, size: CGFloat = 26, mood: BotMood = .idle, noticed: Bool = false, animates: Bool = true) {
        self.look = look
        self.size = size
        self.mood = mood
        self.noticed = noticed
        self.animates = animates
    }

    public var body: some View {
        if reduceMotion || (!animates && !noticed) || Self.stillForTesting {
            figure(BotPose.still(mood, noticed: noticed))
        } else {
            // Played by Core Animation, which moves it without the app drawing each frame (and
            // not at all while no window of it can be seen).
            BotMotion(look: look, size: size, mood: mood, noticed: noticed, seed: seed)
                .frame(width: size, height: size)
        }
    }

    #if DEBUG
    /// KUVO_PERF_STILL_BOTS: every bot holds still, for measuring what their motion costs.
    private static let stillForTesting = ProcessInfo.processInfo.environment["KUVO_PERF_STILL_BOTS"] != nil
    #else
    private static let stillForTesting = false
    #endif

    /// Keeps bots out of step with each other, and the same from one launch to the next.
    private var seed: Double {
        let text = look.color.rawValue + look.shape.rawValue + look.face.rawValue
        let number = text.unicodeScalars.reduce(UInt32(7)) { $0 &* 31 &+ $1.value }
        return Double(number % 10_000) / 10_000 * 13
    }

    private func figure(_ pose: BotPose) -> some View {
        let tint = look.color.color
        let spins = look.shape == .bloom || look.shape == .gem
        return ZStack {
            // A soft pulse behind a bot that's waiting for you.
            if pose.glow > 0 {
                Circle()
                    .fill(Color.orange.opacity(0.4 * (1 - pose.glow)))
                    .frame(width: size, height: size)
                    .scaleEffect(1 + 0.5 * pose.glow)
            }
            ZStack {
                ForEach(Array(pose.sparks.enumerated()), id: \.offset) { _, angle in
                    spark(at: angle, tint: tint)
                }
                Self.body(look, size: size)
                    .rotationEffect(.degrees(spins ? pose.spin : 0))
                    .shadow(color: .black.opacity(size > 40 ? 0.12 : 0.08), radius: size / 24, y: size / 48)
                    .zIndex(0)
                BotFace(face: pose.face ?? look.face, deep: look.color.isDeep, glance: pose.glance, blink: pose.blink)
                    .frame(width: size * 0.5, height: size * 0.3)
                    .offset(x: size * 0.04, y: faceOffset)
                    .zIndex(0.5)
            }
            .frame(width: size, height: size)
            .scaleEffect(x: pose.scaleX, y: pose.scaleY, anchor: .bottom)
            .rotationEffect(.degrees(pose.tilt), anchor: .bottom)
            .offset(y: pose.lift * size)
            // Z's drifting up from a sleeping bot, swaying as they go.
            ForEach(Array(pose.zs.enumerated()), id: \.offset) { _, progress in
                let place = Self.z(at: progress, size: size)
                Self.zLetter(size: size)
                    .scaleEffect(place.scale)
                    .opacity(place.opacity)
                    .offset(place.offset)
            }
            // A sparkle beside a bot with news.
            if pose.twinkle > 0 {
                Self.star(size: size)
                    .scaleEffect(pose.twinkle)
                    .rotationEffect(.degrees(Double(pose.twinkle) * 45))
                    .offset(Self.starOffset(size: size))
            }
        }
        .frame(width: size, height: size)
    }

    /// One spark on a tilted orbit around the bot's middle, with a fading trail, drawn in front
    /// of the bot on the near side of the orbit and behind it on the far side.
    private func spark(at angle: Double, tint: Color) -> some View {
        ZStack {
            ForEach(Array(Self.sparkDots(at: angle, size: size).enumerated()), id: \.offset) { step, dot in
                Self.sparkDot(step: step, tint: tint, size: size)
                    .scaleEffect(dot.scale)
                    .opacity(dot.opacity)
                    .offset(dot.offset)
            }
        }
        .zIndex(Self.sparkInFront(angle) ? 1 : -1)
    }

    private var faceOffset: CGFloat { Self.faceOffset(look.shape, size: size) }

    // What both ways of drawing a bot share (still and moving here, played by Core Animation in
    // BotMotion): its pieces, and where they go for a pose.

    /// Its shape in its color, with a lit top edge like the window's other raised surfaces.
    static func body(_ look: BotLook, size: CGFloat) -> some View {
        let tint = look.color.color
        return BotShape(form: look.shape)
            .fill(LinearGradient(colors: [tint.mix(with: .white, by: 0.14), tint.mix(with: .black, by: 0.06)], startPoint: .top, endPoint: .bottom))
            .overlay {
                BotShape(form: look.shape)
                    .stroke(LinearGradient(colors: [.white.opacity(0.55), .white.opacity(0)], startPoint: .top, endPoint: .center), lineWidth: max(0.5, size / 40))
            }
            .frame(width: size, height: size)
    }

    /// Where a piece sits, from the middle of the avatar, and how big and clear it is.
    struct Placement {
        var offset: CGSize
        var scale: CGFloat
        var opacity: Double
    }

    /// One spark's five dots, its head first and its fading trail after, on a tilted orbit
    /// around the bot's middle.
    static func sparkDots(at angle: Double, size: CGFloat) -> [Placement] {
        let depth = (sin(angle) + 1) / 2
        return (0..<5).map { step in
            let a = angle - Double(step) * 0.2
            let fade = 1 - Double(step) / 5
            return Placement(offset: CGSize(width: cos(a) * size * 0.62, height: sin(a) * size * 0.24 + size * 0.04),
                             scale: (0.55 + 0.45 * depth) * (0.4 + 0.6 * fade), opacity: (0.45 + 0.55 * depth) * fade)
        }
    }

    /// On the near side of its orbit, a spark is drawn in front of the bot; behind it on the far.
    static func sparkInFront(_ angle: Double) -> Bool { (sin(angle) + 1) / 2 > 0.5 }

    static func sparkDot(step: Int, tint: Color, size: CGFloat) -> some View {
        let dot = max(2.5, size * 0.13)
        return Circle()
            .fill(step == 0 ? tint.mix(with: .white, by: 0.45) : tint)
            .frame(width: dot, height: dot)
    }

    /// A z drifting up from a sleeping bot, swaying as it goes, `progress` 0 to 1.
    static func z(at progress: Double, size: CGFloat) -> Placement {
        Placement(offset: CGSize(width: size * (0.3 + 0.28 * progress + 0.06 * sin(progress * 2 * .pi)), height: -size * (0.26 + 0.56 * progress)),
                  scale: 0.45 + 0.8 * progress, opacity: min(1, progress * 5) * (1 - pow(progress, 3)))
    }

    static func zLetter(size: CGFloat) -> some View {
        Text("z")
            .font(.system(size: max(7, size * 0.32), weight: .heavy, design: .rounded))
            .foregroundStyle(.secondary)
    }

    /// The sparkle beside a bot with news.
    static func star(size: CGFloat) -> some View {
        Star()
            .fill(Color(red: 1, green: 0.76, blue: 0.2))
            .frame(width: size * 0.34, height: size * 0.34)
    }

    static func starOffset(size: CGFloat) -> CGSize { CGSize(width: size * 0.46, height: -size * 0.42) }

    /// The pebble's face sits low, where it's widest.
    static func faceOffset(_ shape: BotLook.Form, size: CGFloat) -> CGFloat {
        switch shape {
        case .pebble: size * 0.12
        default: -size * 0.03
        }
    }
}

/// On the corner of a bot's face: it lives on one of your machines, not this Mac.
public struct MachineBadge: View {
    let machine: String
    var size: CGFloat = 14
    @Environment(\.colorScheme) private var scheme

    public init(machine: String, size: CGFloat = 14) {
        self.machine = machine
        self.size = size
    }

    public var body: some View {
        Image(systemName: "server.rack")
            .font(.system(size: size * 0.48, weight: .bold))
            .foregroundStyle(.secondary)
            .frame(width: size, height: size)
            .background(Circle().fill(scheme == .dark ? Color(white: 0.2) : .white))
            .shadow(color: .black.opacity(scheme == .dark ? 0.45 : 0.2), radius: 1, y: 0.5)
            .help("On \(machine)")
            .accessibilityLabel("On \(machine)")
    }
}

/// A group chat's picture: its bots together, like a group photo. Two stand side by side; three
/// stand two at the back and the lead in front; more show as "+N" beside the first three.
public struct GroupAvatar: View {
    public struct Face: Equatable {
        public var look: BotLook
        public var mood: BotMood = .idle

        public init(look: BotLook, mood: BotMood = .idle) {
            self.look = look
            self.mood = mood
        }
    }

    let faces: [Face]
    /// The square they share.
    var size: CGFloat = 28

    public init(faces: [Face], size: CGFloat = 28) {
        self.faces = faces
        self.size = size
    }

    public var body: some View {
        let shown = Array(faces.prefix(3))
        let more = faces.count - shown.count
        ZStack {
            // The lead (first) is drawn last, in front.
            ForEach(Array(shown.enumerated()).reversed(), id: \.offset) { index, face in
                let spot = place(index, of: shown.count)
                // Still: its bots move in their own rows.
                BotAvatar(look: face.look, size: size * spot.scale, mood: face.mood, animates: false)
                    .offset(x: size * spot.x, y: size * spot.y)
            }
            if more > 0 {
                Text("+\(more)")
                    .font(.system(size: max(7, size * 0.2), weight: .bold, design: .rounded))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, size * 0.06)
                    .background(.background, in: Capsule())
                    .offset(x: size * 0.38, y: size * 0.36)
            }
        }
        .frame(width: size, height: size)
    }

    /// Where each stands, as shares of the square, and how large.
    private func place(_ index: Int, of count: Int) -> (x: CGFloat, y: CGFloat, scale: CGFloat) {
        switch count {
        case 2: [(-0.2, 0.04, 0.6), (0.2, -0.04, 0.6)][index]
        case 3: [(0, 0.15, 0.56), (-0.24, -0.12, 0.48), (0.24, -0.12, 0.48)][index]
        default: (0, 0, 1)
        }
    }
}

/// A four-pointed sparkle.
nonisolated struct Star: Shape {
    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY), r = min(rect.width, rect.height) / 2
        let tips = [CGPoint(x: c.x, y: c.y - r), CGPoint(x: c.x + r, y: c.y), CGPoint(x: c.x, y: c.y + r), CGPoint(x: c.x - r, y: c.y)]
        var path = Path()
        path.move(to: tips[0])
        for index in 1...4 {
            path.addQuadCurve(to: tips[index % 4], control: c)
        }
        path.closeSubpath()
        return path
    }
}

/// Where everything about a bot's avatar is at one moment: worked out from the time, so the
/// motion is smooth at any frame rate and two bots never move in step.
struct BotPose {
    /// Up, as a share of the avatar's size (negative is up).
    var lift: CGFloat = 0
    var scaleX: CGFloat = 1
    var scaleY: CGFloat = 1
    /// The whole figure, in degrees, from its base.
    var tilt: Double = 0
    /// The shape alone (bloom and gem turn while they work, and twirl now and then).
    var spin: Double = 0
    /// Eyes left (negative) or right, as a share of the face's width.
    var glance: CGFloat = 0
    /// 0 open, 1 shut.
    var blink: CGFloat = 0
    var face: BotLook.Face?
    /// A soft pulse behind it, 0 to 1, while it waits for you.
    var glow: CGFloat = 0
    /// Angles of the sparks circling it.
    var sparks: [Double] = []
    /// How far each z has drifted, 0 to 1.
    var zs: [Double] = []
    /// A sparkle beside it, 0 (gone) to 1 (fully out).
    var twinkle: CGFloat = 0

    /// A face for each mood, without motion (Reduce Motion).
    static func still(_ mood: BotMood, noticed: Bool) -> BotPose {
        var pose = BotPose()
        switch mood {
        case .waiting: pose.face = .bright
        case .news: pose.face = .happy; pose.twinkle = 0.8
        case .sleeping: pose.face = .sleepy; pose.zs = [0.5]
        case .watching: pose.glance = 0.1
        case .idle, .working: pose.face = noticed ? .happy : nil
        }
        return pose
    }

    init() {}

    init(mood: BotMood, noticed: Bool, time t: Double, seed: Double, small: Bool) {
        switch mood {
        case .idle:
            breathe(t, depth: 0.035, period: 3.8)
            blinks(t, every: 3.4 + seed.truncatingRemainder(dividingBy: 1.6), seed: seed)
            if noticed {
                face = .happy
                hop(t, height: 0.08, period: 0.5)
            } else {
                fidget(t, seed: seed)
            }
        case .working:
            // Busy little bobs, and now and then a big jump with a twist.
            let cycle = 2.8, jump = 0.62
            let c = t.truncatingRemainder(dividingBy: cycle)
            if c < jump {
                hop(c, height: small ? 0.14 : 0.18, period: jump)
                tilt = sin(c / jump * 2 * .pi) * 9
            } else {
                hop(c - jump, height: small ? 0.045 : 0.055, period: (cycle - jump) / 5)
            }
            // Eyes reading along a line, then back to its start.
            let r = t.truncatingRemainder(dividingBy: 1.2) / 1.2
            glance = CGFloat(r < 0.8 ? -0.13 + 0.26 * r / 0.8 : 0.13 - 0.26 * (r - 0.8) / 0.2)
            spin = (t * 60).truncatingRemainder(dividingBy: 360)
            sparks = [t * 2 * .pi / 1.3, t * 2 * .pi / 1.3 + .pi]
            blinks(t, every: 2.9, seed: seed)
        case .waiting:
            // A hop to get your attention, then a wiggle, wide-eyed.
            face = .bright
            let c = t.truncatingRemainder(dividingBy: 2.4)
            if c < 0.4 {
                hop(c, height: 0.12, period: 0.4)
            } else if c < 1.0 {
                let p = (c - 0.4) / 0.6
                tilt = sin(p * .pi * 4) * 11 * (1 - p)
            }
            glow = CGFloat(t.truncatingRemainder(dividingBy: 1.6) / 1.6)
            blinks(t, every: 3.1, seed: seed)
        case .news:
            // Happy, with two hops and a sparkle every few seconds.
            face = .happy
            breathe(t, depth: 0.03, period: 2.6)
            let c = t.truncatingRemainder(dividingBy: 3.6)
            if c < 0.9 { hop(c, height: 0.12, period: 0.45) }
            let w = (c - 0.15) / 1.5
            if w > 0 && w < 1 { twinkle = CGFloat(sin(w * .pi)) }
        case .watching:
            // Slow breaths; every few seconds a long look out to one side, then the other,
            // leaning into each, and back.
            breathe(t, depth: 0.03, period: 4.2)
            blinks(t, every: 3.8 + seed.truncatingRemainder(dividingBy: 1.2), seed: seed)
            if noticed {
                face = .happy
            } else {
                let c = (t + seed * 3).truncatingRemainder(dividingBy: 6.4) / 6.4
                let look = Self.keys(c, [(0, 0), (0.1, 0), (0.2, -1), (0.42, -1), (0.52, 1), (0.78, 1), (0.88, 0), (1, 0)])
                glance = CGFloat(0.21 * look)
                tilt = -7 * look
            }
        case .sleeping:
            // Deep, slow breaths and a slow nod, z's drifting up.
            face = .sleepy
            breathe(t, depth: 0.045, period: 3.6)
            tilt = sin(t * 2 * .pi / 7.2) * 3
            zs = (0..<3).map { index in (t / 4.2 + Double(index) / 3).truncatingRemainder(dividingBy: 1) }
        }
    }

    /// Every few seconds an idle bot does something small, picked at random so it never feels
    /// like a loop: looks around, hops, tilts its head, smiles, yawns, wiggles, twirls or rests.
    private mutating func fidget(_ t: Double, seed: Double) {
        let beat = 4.2
        let index = (t / beat).rounded(.down)
        let c = t - index * beat
        let pick = Self.random(Int(index), seed)
        switch pick {
        case ..<0.18:
            // Looks left, then right, then back.
            if c < 2.4 { glance = CGFloat(0.14 * Self.keys(c / 2.4, [(0, 0), (0.12, -1), (0.42, -1), (0.56, 1), (0.84, 1), (1, 0)])) }
        case ..<0.3:
            // A little hop.
            if c < 0.55 { hop(c, height: 0.13, period: 0.55) }
        case ..<0.44:
            // A curious tilt of the head.
            if c < 1.7 {
                let e = Self.keys(c / 1.7, [(0, 0), (0.22, 1), (0.78, 1), (1, 0)])
                tilt = 11 * e * (Self.random(Int(index) + 7, seed) < 0.5 ? 1 : -1)
                glance = CGFloat(0.06 * e)
                if e > 0.4 { face = .curious }
            }
        case ..<0.56:
            // A happy moment, with a bounce.
            if c < 1.1 {
                face = .happy
                hop(c, height: 0.06, period: 0.55)
            }
        case ..<0.66:
            // A yawn and a stretch, then a little settle.
            if c < 2 {
                let e = Self.keys(c / 2, [(0, 0), (0.3, 1), (0.65, 1), (0.85, -0.35), (1, 0)])
                scaleY *= CGFloat(1 + 0.1 * e)
                scaleX *= CGFloat(1 - 0.05 * e)
                if e > 0.4 { face = .sleepy }
            }
        case ..<0.76:
            // A wiggle.
            if c < 0.8 {
                let p = c / 0.8
                tilt = sin(p * .pi * 4) * 8 * (1 - p)
            }
        case ..<0.86:
            // A twirl (bloom and gem turn; the others hop).
            if c < 0.9 {
                spin = 360 * Self.keys(c / 0.9, [(0, 0), (1, 1)])
                hop(c, height: 0.07, period: 0.9)
            }
        default:
            break
        }
    }

    /// A slow swell, taller and narrower, then back.
    private mutating func breathe(_ t: Double, depth: Double, period: Double) {
        let s = sin(t * 2 * .pi / period)
        scaleY *= 1 + CGFloat(depth * s)
        scaleX *= 1 - CGFloat(depth * 0.5 * s)
    }

    /// A hop: up and down, stretched in the air, squashed where it lands.
    private mutating func hop(_ t: Double, height: Double, period: Double) {
        let up = abs(sin(t * .pi / period))
        lift = -CGFloat(height * up)
        let land = pow(1 - up, 8)
        scaleY *= CGFloat(1 + 0.06 * up - 0.09 * land)
        scaleX *= CGFloat(1 - 0.03 * up + 0.08 * land)
    }

    /// Eyes shut for a moment every few seconds, sometimes twice.
    private mutating func blinks(_ t: Double, every period: Double, seed: Double) {
        let c = t.truncatingRemainder(dividingBy: period)
        let twice = Self.random(Int(t / period), seed + 3) < 0.3
        func shut(_ at: Double) -> CGFloat {
            let d = abs(c - at)
            return d < 0.09 ? CGFloat(1 - d / 0.09) : 0
        }
        blink = max(blink, shut(period - 0.12), twice ? shut(period - 0.42) : 0)
    }

    /// A number from 0 to 1 that looks random but is always the same for the same `n` and `seed`.
    private static func random(_ n: Int, _ seed: Double) -> Double {
        let x = sin(Double(n) * 12.9898 + seed * 78.233) * 43758.5453
        return x - x.rounded(.down)
    }

    /// The value at `p` along keyframes of (time, value), eased between each.
    private static func keys(_ p: Double, _ points: [(Double, Double)]) -> Double {
        guard let last = points.last else { return 0 }
        for (a, b) in zip(points, points.dropFirst()) where p <= b.0 {
            let x = max(0, min(1, (p - a.0) / (b.0 - a.0)))
            let eased = x * x * (3 - 2 * x)
            return a.1 + (b.1 - a.1) * eased
        }
        return last.1
    }
}

/// The bot's outline, filling the square it's given.
nonisolated struct BotShape: Shape {
    let form: BotLook.Form

    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height)
        let box = CGRect(x: rect.midX - s / 2, y: rect.midY - s / 2, width: s, height: s)
        switch form {
        case .round:
            return Path(ellipseIn: box)
        case .squircle:
            return Path(roundedRect: box.insetBy(dx: s * 0.04, dy: s * 0.04), cornerRadius: s * 0.32, style: .continuous)
        case .pebble:
            // A triangle with soft corners, wide at the bottom. Its corners reach past the box,
            // and their rounding brings the outline back inside, as large as the others.
            return rounded([
                CGPoint(x: box.minX + s * 0.5, y: box.minY - s * 0.16),
                CGPoint(x: box.minX + s * 1.1, y: box.minY + s * 0.94),
                CGPoint(x: box.minX - s * 0.1, y: box.minY + s * 0.94),
            ], radius: s * 0.24)
        case .gem:
            return rounded([
                CGPoint(x: box.midX, y: box.minY - s * 0.08),
                CGPoint(x: box.maxX + s * 0.08, y: box.midY),
                CGPoint(x: box.midX, y: box.maxY + s * 0.08),
                CGPoint(x: box.minX - s * 0.08, y: box.midY),
            ], radius: s * 0.22)
        case .bloom:
            // A circle with eight soft scallops.
            var path = Path()
            let center = CGPoint(x: box.midX, y: box.midY)
            let steps = 96
            for step in 0...steps {
                let angle = Double(step) / Double(steps) * 2 * .pi
                let radius = s * (0.455 + 0.035 * cos(8 * angle))
                let point = CGPoint(x: center.x + radius * cos(angle - .pi / 2), y: center.y + radius * sin(angle - .pi / 2))
                if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            path.closeSubpath()
            return path
        }
    }

    /// A polygon through `points` with every corner rounded.
    private func rounded(_ points: [CGPoint], radius: CGFloat) -> Path {
        var path = Path()
        let count = points.count
        func mid(_ a: CGPoint, _ b: CGPoint) -> CGPoint { CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
        path.move(to: mid(points[count - 1], points[0]))
        for index in 0..<count {
            path.addArc(tangent1End: points[index], tangent2End: points[(index + 1) % count], radius: radius)
        }
        path.closeSubpath()
        return path
    }
}

/// Two eyes, drawn in the box they're given (twice as wide as tall), with an expression.
struct BotFace: View {
    let face: BotLook.Face
    /// On a deep color: light eyes.
    let deep: Bool
    /// Eyes moved left or right, as a share of the width.
    var glance: CGFloat = 0
    /// 0 open, 1 shut (open eyes only; closed-looking ones stay as they are).
    var blink: CGFloat = 0

    private var ink: Color { deep ? Color.white.opacity(0.92) : Color(red: 0.09, green: 0.1, blue: 0.13).opacity(0.86) }

    var body: some View {
        let ink = ink
        return Canvas { context, size in
            let w = size.width, h = size.height
            let eye = CGSize(width: w * 0.17, height: h * 0.62)
            let left = CGPoint(x: w * (0.27 + glance), y: h * 0.5), right = CGPoint(x: w * (0.73 + glance), y: h * 0.5)
            let open = 1 - 0.88 * blink
            let line = max(1, w * 0.1)

            func oval(at center: CGPoint, scale: CGFloat = 1) {
                let height = eye.height * scale * open
                let rect = CGRect(x: center.x - eye.width * scale / 2, y: center.y - height / 2, width: eye.width * scale, height: height)
                context.fill(Path(ellipseIn: rect), with: .color(ink))
            }
            func arc(at center: CGPoint, up: Bool) {
                var path = Path()
                let half = eye.width * 1.15
                path.move(to: CGPoint(x: center.x - half, y: center.y + (up ? h * 0.12 : -h * 0.08)))
                path.addQuadCurve(
                    to: CGPoint(x: center.x + half, y: center.y + (up ? h * 0.12 : -h * 0.08)),
                    control: CGPoint(x: center.x, y: center.y + (up ? -h * 0.32 : h * 0.3))
                )
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: line, lineCap: .round))
            }
            func dash(at center: CGPoint) {
                var path = Path()
                path.move(to: CGPoint(x: center.x - eye.width * 1.1, y: center.y + h * 0.06))
                path.addLine(to: CGPoint(x: center.x + eye.width * 1.1, y: center.y + h * 0.14))
                context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: line, lineCap: .round))
            }

            switch face {
            case .calm:
                oval(at: left); oval(at: right)
            case .happy:
                arc(at: left, up: true); arc(at: right, up: true)
            case .sleepy:
                dash(at: left); dash(at: right)
            case .wink:
                oval(at: left); arc(at: right, up: true)
            case .curious:
                // Looking up and aside, one eye a little bigger.
                oval(at: CGPoint(x: left.x + w * 0.05, y: left.y - h * 0.1), scale: 0.9)
                oval(at: CGPoint(x: right.x + w * 0.05, y: right.y - h * 0.1), scale: 1.12)
            case .bright:
                for center in [left, right] {
                    let height = eye.width * 1.6 * open
                    let rect = CGRect(x: center.x - eye.width * 0.8, y: center.y - height / 2, width: eye.width * 1.6, height: height)
                    context.fill(Path(ellipseIn: rect), with: .color(ink))
                    let shine = CGRect(x: center.x - eye.width * 0.05, y: center.y - eye.width * 0.55, width: eye.width * 0.5, height: eye.width * 0.5)
                    if blink < 0.5 { context.fill(Path(ellipseIn: shine), with: .color(deep ? .black.opacity(0.35) : .white.opacity(0.85))) }
                }
            }
        }
    }
}

#Preview {
    VStack(spacing: 16) {
        ForEach(BotLook.Form.allCases) { form in
            HStack(spacing: 14) {
                ForEach(Array(BotLook.Face.allCases.enumerated()), id: \.offset) { index, face in
                    BotAvatar(look: BotLook(color: BotLook.Tint.allCases[(index + form.hashValue) % 10], shape: form, face: face), size: 48)
                }
            }
        }
    }
    .padding(30)
}
