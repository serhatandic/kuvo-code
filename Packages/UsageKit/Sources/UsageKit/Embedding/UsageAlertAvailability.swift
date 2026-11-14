import Foundation
import Observation

/// Alert capabilities and explanations come from the box; the client only filters to active cards.
@MainActor
@Observable
public final class UsageAlertAvailability {
    public static let shared = UsageAlertAvailability()
    private struct Entry: Decodable {
        var provider: String
        var available: Bool
        var message: String
    }
    private var entries: [Entry] = []

    public init() {}

    public func apply(_ data: Data) {
        entries = (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    func messages(for providers: [String]) -> [String] {
        let families = Set(providers.map { $0.split(separator: "@").first.map(String.init) ?? $0 })
        return entries.filter { !$0.available && families.contains($0.provider) }.map(\.message)
    }
}
