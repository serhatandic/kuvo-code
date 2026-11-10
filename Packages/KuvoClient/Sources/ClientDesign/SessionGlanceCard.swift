import SwiftUI

/// A pull request's mark on a session's row and its card: GitHub's pull request glyph in its
/// state's color (open green, merged purple; a draft, a closed one and one not read yet gray, so
/// red only ever means something failed), and all of it red while a check fails on one still
/// open.
public struct PullMark: View {
    let pull: SessionGlance.Pull
    let size: CGFloat

    public init(_ pull: SessionGlance.Pull, size: CGFloat) {
        self.pull = pull
        self.size = size
    }

    /// GitHub's own: its open green and merged purple.
    public static let open = Color(red: 0.12, green: 0.65, blue: 0.29)
    public static let merged = Color(red: 0.55, green: 0.34, blue: 0.94)
    public static let failing = Color.red

    static func color(_ pull: SessionGlance.Pull) -> Color {
        if pull.isFailing { return failing }
        return switch pull.state {
        case .open?: open
        case .merged?: merged
        case .draft?, .closed?, nil: .secondary
        }
    }

    public var body: some View {
        PullGlyph(merged: pull.state == .merged)
            .stroke(Self.color(pull), style: StrokeStyle(lineWidth: max(1.2, size * 0.1), lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .accessibilityElement()
            .accessibilityLabel(pull.spoken)
    }
}

/// GitHub's pull request mark, drawn in a 16-point square: two commits on the left with the line
/// between them, and on the right the branch coming back to the first with an arrow; merged, the
/// branch's line curves into the left one.
struct PullGlyph: Shape {
    let merged: Bool

    func path(in rect: CGRect) -> Path {
        let k = min(rect.width, rect.height) / 16
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * k, y: rect.minY + y * k) }
        let r = 1.9 * k
        var path = Path()
        func node(_ x: CGFloat, _ y: CGFloat) { path.addEllipse(in: CGRect(x: p(x, y).x - r, y: p(x, y).y - r, width: 2 * r, height: 2 * r)) }
        node(4.3, 3.4)
        node(4.3, 12.6)
        path.move(to: p(4.3, 5.3))
        path.addLine(to: p(4.3, 10.7))
        if merged {
            node(11.7, 9.6)
            path.move(to: p(4.3, 5.3))
            path.addQuadCurve(to: p(9.8, 9.6), control: p(4.3, 9.6))
        } else {
            node(11.7, 12.6)
            path.move(to: p(11.7, 10.7))
            path.addLine(to: p(11.7, 6.4))
            path.addQuadCurve(to: p(8.7, 3.4), control: p(11.7, 3.4))
            path.addLine(to: p(7.4, 3.4))
            path.move(to: p(9.2, 1.6))
            path.addLine(to: p(7.4, 3.4))
            path.addLine(to: p(9.2, 5.2))
        }
        return path
    }
}

/// A share of a circle, from twelve o'clock clockwise.
struct Pie: Shape {
    let fraction: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        path.move(to: center)
        path.addArc(center: center, radius: min(rect.width, rect.height) / 2, startAngle: .degrees(-90),
                    endAngle: .degrees(-90 + 360 * min(1, max(0, fraction))), clockwise: false)
        path.closeSubpath()
        return path
    }
}

/// A pull request's checks on its card: a red ✕ while one fails, a quiet ring filling as they
/// pass, a green ✓ once all have; and how many passed of all.
public struct ChecksMark: View {
    let checks: SessionGlance.Pull.Checks
    let size: CGFloat

    public init(_ checks: SessionGlance.Pull.Checks, size: CGFloat) {
        self.checks = checks
        self.size = size
    }

    public var body: some View {
        HStack(spacing: 4) {
            if checks.failed > 0 {
                Image(systemName: "xmark.circle.fill").foregroundStyle(PullMark.failing)
            } else if checks.pending > 0 {
                // A pie filling as they pass: not a ring alone, which is the working mark's shape.
                ZStack {
                    Circle().strokeBorder(Color.primary.opacity(0.45), lineWidth: 1.2)
                    Pie(fraction: checks.share)
                        .fill(Color.primary.opacity(0.45))
                        .padding(2.4)
                }
                .frame(width: size * 0.9, height: size * 0.9)
            } else {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(PullMark.open)
            }
            Text("\(checks.passed)/\(checks.total)")
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .font(.system(size: size))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(checks.failed > 0 ? "\(checks.failed) of \(checks.total) checks failed" : "\(checks.passed) of \(checks.total) checks passed")
    }
}

/// The computer a session is on, for its card in search results across computers.
public struct GlanceComputer: Equatable, Sendable {
    public let name: String
    public let isMachine: Bool

    public init(name: String, isMachine: Bool) {
        self.name = name
        self.isMachine = isMachine
    }
}

/// The card a session's row opens (hover on the Mac, a long press on a phone): its state and how
/// long ago first, then where it is when the row doesn't say it, its branch, the model, and its
/// pull request with its checks and size. One line each, an icon to a line, the names alone: the
/// layout says what each is.
public struct SessionGlanceCard<ModelMark: View>: View {
    public typealias Computer = GlanceComputer

    let facts: GlanceCardFacts
    let size: CGFloat
    let now: Date
    let fitsWidth: Bool
    let modelMark: ModelMark

    /// `size`: the text's size (13 on a Mac, as its sidebar's text is; a phone's own). `fitsWidth`:
    /// as wide as it's given (a phone's, the row's), rather than its own width. `modelMark`: the
    /// model's maker's mark.
    public init(_ facts: GlanceCardFacts, size: CGFloat = 13, now: Date = .now, fitsWidth: Bool = false, @ViewBuilder modelMark: () -> ModelMark) {
        self.facts = facts
        self.size = size
        self.now = now
        self.fitsWidth = fitsWidth
        self.modelMark = modelMark()
    }

    /// Where its first line's middle is, down from its top: for a card laid beside its row.
    public static func firstLine(size: CGFloat) -> CGFloat { size + size * 0.65 }

    public var body: some View {
        VStack(alignment: .leading, spacing: size * 0.62) {
            HStack(spacing: 7) {
                Group {
                    if let state = facts.state {
                        StatusMark(state, size: size + 1)
                    } else {
                        Circle().strokeBorder(Color.primary.opacity(0.3), lineWidth: 1.4).frame(width: size - 2, height: size - 2)
                    }
                }
                .frame(width: size + 3)
                Text(facts.stateWords).fontWeight(.semibold)
                Spacer(minLength: 12)
                if let since = facts.since {
                    Text(GlanceAge.card(since, now: now)).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            if let folder = facts.folder {
                line { FolderIcon(isOpen: false, size: size + 1) } text: { Text(folder) }
            }
            if let computer = facts.computer {
                line { Image(systemName: computer.isMachine ? "server.rack" : "laptopcomputer") } text: { Text(computer.name) }
            }
            if let branch = facts.branch {
                line { Image(systemName: "arrow.triangle.branch") } text: { Text(branch).truncationMode(.middle) } trailing: {
                    // Without a pull request, the branch carries its size.
                    if facts.glance?.pull == nil, let additions = facts.glance?.additions, let deletions = facts.glance?.deletions { lines(additions, deletions) }
                }
            }
            if facts.model != nil || facts.details != nil {
                line { modelMark } text: {
                    HStack(spacing: 6) {
                        if let model = facts.model { Text(model) }
                        if let details = facts.details { Text(details).foregroundStyle(.secondary) }
                    }
                }
            }
            if let pull = facts.glance?.pull {
                line { PullMark(pull, size: size) } text: { Text("#\(pull.number)").monospacedDigit() } trailing: {
                    HStack(spacing: 10) {
                        if pull.isOpen, let checks = pull.checks { ChecksMark(checks, size: size) }
                        if let additions = pull.additions, let deletions = pull.deletions { lines(additions, deletions) }
                    }
                }
            }
        }
        .font(.system(size: size))
        .lineLimit(1)
        .padding(.horizontal, size + 1)
        .padding(.vertical, size)
        .frame(minWidth: fitsWidth ? nil : size * 21, maxWidth: fitsWidth ? .infinity : size * 30, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private func lines(_ additions: Int, _ deletions: Int) -> some View {
        HStack(spacing: 4) {
            Text("+\(additions)").foregroundStyle(Color.additions)
            Text("−\(deletions)").foregroundStyle(Color.deletions)
        }
        .monospacedDigit()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(additions) lines added, \(deletions) removed")
    }

    private func line<Icon: View, Words: View, Trailing: View>(@ViewBuilder icon: () -> Icon, @ViewBuilder text: () -> Words,
                                                              @ViewBuilder trailing: () -> Trailing = { EmptyView() }) -> some View {
        HStack(spacing: 9) {
            icon()
                .foregroundStyle(.secondary)
                .frame(width: size + 3)
            text()
            Spacer(minLength: 12)
            trailing()
        }
    }
}

/// What a row's card says, for VoiceOver on the row, which can't reach the card: each of its lines
/// as the row's custom content (the same lines every time, so the row isn't made again as one comes).
public struct GlanceSpoken: ViewModifier {
    let facts: GlanceCardFacts

    public init(_ facts: GlanceCardFacts) {
        self.facts = facts
    }

    public func body(content: Content) -> some View {
        let lines = Dictionary(facts.spoken().map { ($0.label, $0.value) }) { first, _ in first }
        content
            .accessibilityCustomContent("State", lines["State"])
            .accessibilityCustomContent("Project", lines["Project"])
            .accessibilityCustomContent("Computer", lines["Computer"])
            .accessibilityCustomContent("Branch", lines["Branch"])
            .accessibilityCustomContent("Model", lines["Model"])
            .accessibilityCustomContent("Pull request", lines["Pull request"])
    }
}

extension View {
    /// The card's surface: raised, as the window's cards are, with their lit edge and a soft
    /// shadow, without an arrow.
    public func glanceCardSurface(_ scheme: ColorScheme) -> some View {
        background(Surface.cardFill(scheme, focused: true), in: .rect(cornerRadius: 14))
            .specularRim(RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(scheme == .dark ? 0.45 : 0.12), radius: 18, y: 8)
    }
}
