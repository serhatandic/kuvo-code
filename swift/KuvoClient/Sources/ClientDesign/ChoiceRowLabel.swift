import SwiftUI

/// A numbered choice, as both apps draw a question's choices and a permission's answers: its
/// number in a small square (filled once picked, a tick among several), its words, and what it
/// means under them. Each app puts it in its own button (the phone's for touch, the Mac's for the
/// pointer).
public struct ChoiceRowLabel: View {
    let number: Int
    let label: Text
    let detail: String?
    let isSelected: Bool
    let isMultiple: Bool
    /// The number's size: a step under the row's text.
    let numberSize: CGFloat
    @Environment(\.accent) private var accent

    public init(number: Int, label: Text, detail: String? = nil, isSelected: Bool = false, isMultiple: Bool = false, numberSize: CGFloat) {
        self.number = number
        self.label = label
        self.detail = detail
        self.isSelected = isSelected
        self.isMultiple = isMultiple
        self.numberSize = numberSize
    }

    public var body: some View {
        // The number sits in the middle of the whole choice, however many lines it takes.
        HStack(alignment: .center, spacing: 10) {
            badge
            VStack(alignment: .leading, spacing: 2) {
                label.foregroundStyle(.primary)
                if let detail {
                    Text(detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
        }
    }

    private var badge: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(isSelected ? accent : Color.primary.opacity(0.06))
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(isSelected ? .clear : Color.primary.opacity(0.12))
            if isMultiple, isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: numberSize - 1, weight: .bold))
                    .foregroundStyle(.white)
            } else if number <= 9 {
                Text("\(number)")
                    .font(.system(size: numberSize, weight: .medium).monospacedDigit())
                    .foregroundStyle(isSelected ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
            }
        }
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}
