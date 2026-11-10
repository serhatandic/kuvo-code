import SwiftUI

/// A separate, wordless control for the whole card; each bar keeps its own chevron.
public struct BarTuckButton: View {
    private let hide: () -> Void
    public init(hide: @escaping () -> Void) { self.hide = hide }

    public var body: some View {
        HStack {
            Spacer()
            Button(action: hide) {
                Image(systemName: "chevron.down.2")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 28)
                    .background(.secondary.opacity(0.10), in: Capsule())
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fold all bars")
            .help("Fold all bars into one line")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }
}
