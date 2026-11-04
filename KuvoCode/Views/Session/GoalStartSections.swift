import ClientDesign
import ClientSessions
import SwiftUI

// The pieces of a goal's start card: its sections, each a quiet panel with a mark and a title (a
// caption on the right where it says what the section is for), and the rows in them: what needs
// you, a setting with its control on the right, and the checks that passed, folded into one line.

/// One of the card's sections: its mark, its title and a caption on the right, then what's in it.
struct GoalCardSection<Content: View, Trailing: View>: View {
    let symbol: String
    var tint: Color?
    let title: String
    var caption: String?
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(tint.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
                    .frame(width: GoalCardMetrics.markWidth)
                    .accessibilityHidden(true)
                Text(title)
                    .font(.body.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                if let caption {
                    Text(caption)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                trailing()
            }
            .padding(.vertical, 10)
            content()
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 4)
        .background(GoalCardPanel())
    }
}

enum GoalCardMetrics {
    /// The column a section's mark sits in, and its rows' marks.
    static let markWidth: CGFloat = 20
}

extension GoalCardSection where Trailing == EmptyView {
    init(symbol: String, tint: Color? = nil, title: String, caption: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.init(symbol: symbol, tint: tint, title: title, caption: caption, trailing: { EmptyView() }, content: content)
    }
}

/// A section's quiet panel.
struct GoalCardPanel: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color.primary.opacity(scheme == .dark ? 0.06 : 0.04))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(scheme == .dark ? 0.08 : 0.06)))
    }
}

/// A setting in Execution settings: its mark, what it is, a line on what it does, and its control
/// on the right, whole, its words wrapping beside it in a narrow card (so every row in a section
/// keeps one shape).
struct GoalSettingRow<Control: View>: View {
    let symbol: String
    let title: String
    var subtitle: String?
    @ViewBuilder var control: () -> Control

    var body: some View {
        HStack(spacing: 12) {
            words
                .frame(maxWidth: .infinity, alignment: .leading)
            choices
        }
        .padding(.vertical, 9)
        .frame(minHeight: 44)
    }

    private var words: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(width: GoalCardMetrics.markWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let subtitle {
                    Text(subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var choices: some View {
        HStack(spacing: 8) { control() }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
    }
}

/// The checks that passed, folded into one line under the sections: how many, what they are in a
/// line, and a chevron that opens each.
struct GoalReadyFold: View {
    let checks: [GoalPlan.Check]
    let box: String
    @State private var isOpen = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.ui) { isOpen.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(.white, .green)
                        .frame(width: GoalCardMetrics.markWidth)
                    Text(checks.count == 1 ? "1 check passed" : "\(checks.count) checks passed")
                        .font(.body.weight(.semibold))
                        .fixedSize()
                    if !isOpen {
                        Text(checks.map(\.text).joined(separator: " • "))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                .padding(.vertical, 12)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .clickablePointer()
            .accessibilityLabel(checks.count == 1 ? "1 check passed" : "\(checks.count) checks passed")
            .accessibilityValue(checks.map(\.text).joined(separator: ", "))
            .accessibilityHint(isOpen ? "Folds them" : "Shows each")
            if isOpen {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(checks) { check in
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.green)
                                .frame(width: GoalCardMetrics.markWidth)
                                .accessibilityHidden(true)
                            Text("\(ServiceText.text(check.text, mark: check.site.map { .site($0) }, on: box, scheme: scheme))\(check.detail.map { Text("  \($0)").foregroundStyle(.secondary) } ?? Text(""))")
                                .font(.callout)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .padding(.bottom, 12)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 14)
        .background(GoalCardPanel())
    }
}

/// Something that needs you before the goal starts, in Needs attention: an orange dot (a warning
/// where it failed, a spinner while it's checked), its service's or app's mark or a symbol of its
/// own, what it is and a word on why, and its button on the right.
struct GoalAttentionRow: View {
    let text: String
    var detail: String?
    var mark: GoalPlanWords.StepMark?
    /// A symbol of its own where it names no service (the Mac on battery, the sandbox).
    var symbol: String?
    var failed = false
    var busy = false
    var button: (String, () -> Void)?
    var help: String?
    /// Less common actions, in a menu after the button.
    var more: [(String, () -> Void)] = []

    var body: some View {
        // Its button whole on the right, its words wrapping beside it in a narrow card.
        HStack(alignment: .center, spacing: 12) {
            lead
            words
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 2) { controls }
        }
        .padding(.vertical, 8)
        .frame(minHeight: 40)
    }

    private var lead: some View {
        HStack(spacing: 12) {
            Group {
                if busy {
                    Spinner(size: 9)
                } else if failed {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(.orange)
                } else {
                    Circle().fill(.orange).frame(width: 7, height: 7)
                }
            }
            .frame(width: 8)
            Group {
                if let mark {
                    GoalServiceMark(mark: mark)
                } else {
                    Image(systemName: symbol ?? "circle.dotted")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: GoalCardMetrics.markWidth)
        }
        .accessibilityHidden(true)
    }

    private var words: some View {
        Text("\(Text(text).fontWeight(.medium))\(detail.map { Text("  \($0)").foregroundStyle(.secondary) } ?? Text(""))")
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Needs attention: \(text)\(detail.map { ", \($0)" } ?? "")")
    }

    @ViewBuilder private var controls: some View {
        if let (label, action) = button {
            Button(label, action: action)
                .buttonStyle(GoalPillButtonStyle())
                .fixedSize()
                .help(help ?? "")
                .accessibilityHint(help ?? "")
        }
        if !more.isEmpty {
            Menu {
                ForEach(more.indices, id: \.self) { index in
                    Button(more[index].0, action: more[index].1)
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 11, weight: .semibold))
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(IconButtonStyle(width: 22, height: 22))
            .foregroundStyle(.secondary)
            .help("More")
            .accessibilityLabel("More for \(text)")
        }
    }
}
