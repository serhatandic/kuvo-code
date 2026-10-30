import Observation
import SwiftUI

/// A card of the host's at the foot of the dashboard, above the footer's own row (fork addition:
/// Kuvo Code's "Working in the background", while its window is closed). Nil shows none.
@MainActor @Observable
public final class HostCard {
    public static let shared = HostCard()
    public var content: AnyView?

    private init() {}
}
