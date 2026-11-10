import SwiftUI

/// Tucks the whole card over the composer into its one line (`BarTuck`): a control of the card's
/// own, apart from each bar's chevron, which folds only that bar. The Mac's and the phone's.
public struct BarTuckButton: View {
    private let hide: () -> Void
    public init(hide: @escaping () -> Void) { self.hide = hide }

    #if os(iOS)
    private let size = CGSize(width: 44, height: 28)
    #else
    private let size = CGSize(width: 36, height: 20)
    #endif

    public var body: some View {
        HStack {
            Spacer()
            Button(action: hide) {
                Image(systemName: "chevron.down.2")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: size.width, height: size.height)
                    .background(.secondary.opacity(0.10), in: Capsule())
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Fold all bars")
            .help("Fold all bars into one line")
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
    }
}
