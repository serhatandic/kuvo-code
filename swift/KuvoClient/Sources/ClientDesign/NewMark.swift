import SwiftUI

/// "New", beside something a recent release brought (a keyword, a Settings page), until it's used:
/// small, in the accent, so it's noticed without asking for anything.
public struct NewMark: View {
    public init() {}

    public var body: some View {
        Text("New")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.tint)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color.accentColor.opacity(0.14), in: .capsule)
            .fixedSize()
            .accessibilityLabel("New")
    }
}
