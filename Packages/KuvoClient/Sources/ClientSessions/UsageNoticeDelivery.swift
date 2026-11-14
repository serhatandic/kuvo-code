import Foundation

/// Each box decides usage notices; an app only remembers which ids it successfully showed.
/// Shared across every connection, bounded to a day and 4096 ids so old receipts do not grow forever.
@MainActor
public final class UsageNoticeDelivery {
    private struct Receipt {
        var at: TimeInterval
        var shown: Bool
    }
    private let defaults: UserDefaults
    private let key: String
    private let now: () -> Date
    private var receipts: [String: Receipt] = [:]
    private var pending: Set<String> = []

    public init(defaults: UserDefaults = .standard, key: String = "usage.notices.shown", now: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.key = key
        self.now = now
        if let stored = defaults.dictionary(forKey: key) {
            for (id, value) in stored {
                if let record = value as? [String: Any], let at = record["at"] as? Double, let shown = record["shown"] as? Bool {
                    receipts[id] = Receipt(at: at, shown: shown)
                } else if let at = value as? Double {
                    receipts[id] = Receipt(at: at, shown: true)
                }
            }
        } else {
            // Migrate the former unbounded id-only list once; its unknown ages expire in a day.
            for id in (defaults.stringArray(forKey: key) ?? []).suffix(4096) {
                receipts[id] = Receipt(at: now().timeIntervalSince1970, shown: true)
            }
        }
        prune()
    }

    private func prune() {
        let stamp = now().timeIntervalSince1970
        receipts = receipts.mapValues { Receipt(at: min($0.at, stamp), shown: $0.shown) }
        receipts = Dictionary(uniqueKeysWithValues: receipts.filter { $0.value.at.isFinite && stamp - $0.value.at < 86_400 }
            .sorted { $0.value.at > $1.value.at }.prefix(4096).map { ($0.key, $0.value) })
        let stored = receipts.mapValues { ["at": $0.at, "shown": $0.shown] as [String: Any] }
        if !(defaults.dictionary(forKey: key).map { NSDictionary(dictionary: $0).isEqual(to: stored) } ?? false) {
            defaults.set(stored, forKey: key)
        }
    }

    /// True for an id shown here, including one shown before reconnect/relaunch, so the caller can
    /// acknowledge it to the box again. Silently consumed ids never suppress the phone's notice.
    @discardableResult
    public func deliver(id: String, enabled: Bool = true, visible: () async -> Bool = { true }, post: () async -> Bool) async -> Bool {
        prune()
        guard !id.isEmpty else { return false }
        if let receipt = receipts[id] { return receipt.shown }
        guard pending.insert(id).inserted else { return false }
        defer { pending.remove(id) }
        if enabled { guard await post() else { return false } }
        let shown = enabled ? await visible() : false
        receipts[id] = Receipt(at: now().timeIntervalSince1970, shown: shown)
        prune()
        return shown
    }
}
