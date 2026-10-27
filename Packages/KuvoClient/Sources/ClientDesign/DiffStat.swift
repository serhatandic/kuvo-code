import SwiftUI

extension Color {
    /// Lines a change adds and removes, wherever they're counted or shown: the system's green and red.
    #if os(macOS)
    public static let additions = Color(nsColor: .systemGreen)
    public static let deletions = Color(nsColor: .systemRed)
    #else
    public static let additions = Color(uiColor: .systemGreen)
    public static let deletions = Color(uiColor: .systemRed)
    #endif
}

/// `+12 −3`, in diff colors.
public struct DiffStat: View {
    let additions: Int
    let deletions: Int

    public init(additions: Int, deletions: Int) {
        self.additions = additions
        self.deletions = deletions
    }

    public var body: some View {
        HStack(spacing: 4) {
            if additions > 0 { Text("+\(additions)").foregroundStyle(Color.additions) }
            if deletions > 0 { Text("−\(deletions)").foregroundStyle(Color.deletions) }
        }
        .font(.caption.monospacedDigit().weight(.medium))
    }
}
