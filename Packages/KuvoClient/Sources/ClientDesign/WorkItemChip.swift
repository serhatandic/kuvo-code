import SwiftUI

/// A Work Queue item's look, the same in both apps: the dot of its category's color, a ring while
/// it's in progress, a check once it's done, a hollow dot once it's deleted.
public enum WorkItemMark: Hashable, Sendable {
    case category(String)
    case inProgress
    case done
    case removed

    public init(category: String, inProgress: Bool, removed: Bool) {
        if removed { self = .removed } else if category == "done" { self = .done } else if inProgress { self = .inProgress } else { self = .category(category) }
    }

    /// A category's color: Next teal, Later purple, Parked gray, Done green, and a custom one's
    /// own, kept for its id. Work in progress is blue, as its ring is.
    public static func color(of category: String) -> Color {
        switch category {
        case "next": return .teal
        case "later": return .purple
        case "parked": return .gray
        case "done": return .green
        default:
            let palette: [Color] = [.orange, .pink, .indigo, .mint, .brown, .yellow]
            return palette[category.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF } % palette.count]
        }
    }

    public var color: Color {
        switch self {
        case .category(let id): Self.color(of: id)
        case .inProgress: .blue
        case .done: .green
        case .removed: .gray
        }
    }

    /// As VoiceOver says it.
    public var words: String {
        switch self {
        case .category: ""
        case .inProgress: "in progress"
        case .done: "done"
        case .removed: "deleted"
        }
    }
}

/// The mark itself, at `size` points: drawn still (a chip in a message is a picture), so the ring
/// of work in progress is an open arc rather than a turning one.
public struct WorkItemDot: View {
    let mark: WorkItemMark
    let size: CGFloat

    public init(_ mark: WorkItemMark, size: CGFloat = 8) {
        self.mark = mark
        self.size = size
    }

    public var body: some View {
        Group {
            switch mark {
            case .category:
                Circle().fill(mark.color).padding(size * 0.12)
            case .inProgress:
                Circle()
                    .trim(from: 0, to: 0.72)
                    .stroke(mark.color, style: StrokeStyle(lineWidth: max(1.3, size * 0.2), lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(max(0.65, size * 0.1))
            case .done:
                Image(systemName: "checkmark.circle.fill")
                    .resizable()
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, mark.color)
            case .removed:
                Circle().strokeBorder(mark.color, lineWidth: max(1, size * 0.15)).padding(size * 0.12)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// A `#243` reference in a message, drawn as a chip: a small capsule with the item's mark, its
/// number and its title cut to one line. Its words for VoiceOver are "Work item 243, <title>".
public struct WorkItemChip: View {
    let number: Int
    let title: String
    let mark: WorkItemMark
    let size: CGFloat
    let dark: Bool

    /// The longest title a chip shows before it's cut with "…".
    public static let titleLimit = 36

    public init(number: Int, title: String, mark: WorkItemMark, size: CGFloat, dark: Bool) {
        self.number = number
        self.title = title
        self.mark = mark
        self.size = size
        self.dark = dark
    }

    /// The title as the chip shows it: one line, cut past `titleLimit` characters.
    public static func shownTitle(_ title: String) -> String {
        let line = title.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count > titleLimit else { return trimmed }
        return String(trimmed.prefix(titleLimit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    public var body: some View {
        let ink = dark ? Color.white : Color.black
        let font = size * 0.86
        HStack(spacing: size * 0.3) {
            WorkItemDot(mark, size: (size * 0.62).rounded())
            Text("#\(number)")
                .font(.system(size: font, weight: .semibold).monospacedDigit())
                .foregroundStyle(ink.opacity(mark == .removed ? 0.5 : 0.85))
            Text(Self.shownTitle(title))
                .font(.system(size: font))
                .foregroundStyle(ink.opacity(mark == .removed ? 0.45 : 0.68))
                .strikethrough(mark == .removed)
                .lineLimit(1)
                .fixedSize()
        }
        .padding(.leading, size * 0.36)
        .padding(.trailing, size * 0.5)
        .frame(height: (size * 1.4).rounded())
        .background(Capsule().fill(mark.color.opacity(dark ? 0.2 : 0.11)))
        .overlay(Capsule().strokeBorder(mark.color.opacity(dark ? 0.38 : 0.28), lineWidth: 1))
        .fixedSize()
        .environment(\.colorScheme, dark ? .dark : .light)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.spoken(number: number, title: title, mark: mark))
    }

    /// "Work item 243, Fix the sign-in, in progress".
    public static func spoken(number: Int, title: String, mark: WorkItemMark) -> String {
        ["Work item \(number)", title, mark.words].filter { !$0.isEmpty }.joined(separator: ", ")
    }
}
