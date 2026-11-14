import SwiftUI

/// A service's mark beside its name ("Stripe", "Add a Cloudflare API token", "Open Stripe"): its own
/// site's icon, as each app loads it from the site itself (never a logo of Kuvo Code's), else the
/// first letter of its name in a quiet rounded square. Sized to the text beside it, with no color of
/// its own, so it never competes with what's around it. VoiceOver passes over it: the name says it.
public struct ServiceMark: View {
    let icon: Image?
    let name: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 14

    /// `icon`: the site's icon, once loaded; `name`: the service's, for the letter when there's none.
    public init(icon: Image?, name: String) {
        self.icon = icon
        self.name = name
    }

    public var body: some View {
        Group {
            if let icon {
                icon
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
            } else {
                RoundedRectangle(cornerRadius: size * 0.25, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.18), lineWidth: 1)
                    .overlay {
                        Text(name.trimmingCharacters(in: .whitespaces).prefix(1).uppercased())
                            .font(.system(size: size * 0.62, weight: .semibold, design: .rounded))
                            .foregroundStyle(.secondary)
                    }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        .accessibilityHidden(true)
    }
}
