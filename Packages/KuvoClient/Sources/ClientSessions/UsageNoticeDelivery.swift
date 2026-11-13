import Foundation

/// Each box decides usage notices; an app only remembers which ids it successfully showed.
/// Shared across every connection, so hearing the same notice from two computers still shows once.
@MainActor
public final class UsageNoticeDelivery {
    private let defaults: UserDefaults
    private let key: String
    private var shown: Set<String>
    private var pending: Set<String> = []

    public init(defaults: UserDefaults = .standard, key: String = "usage.notices.shown") {
        self.defaults = defaults
        self.key = key
        self.shown = Set(defaults.stringArray(forKey: key) ?? [])
    }

    /// Failed OS delivery remains eligible on the next read. In-flight delivery is reserved before
    /// awaiting the OS, so concurrent reads from different boxes cannot schedule it twice.
    public func deliver(id: String, post: () async -> Bool) async {
        guard !id.isEmpty, !shown.contains(id), pending.insert(id).inserted else { return }
        defer { pending.remove(id) }
        guard await post() else { return }
        shown.insert(id)
        defaults.set(shown.sorted(), forKey: key)
    }
}
