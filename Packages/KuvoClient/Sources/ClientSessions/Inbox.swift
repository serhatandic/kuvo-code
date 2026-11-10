import Foundation

/// What waits for you across your computers, as an inbox lists it: every conversation whose mark in
/// the sidebar calls you back to it. One that waits on you (a permission, a question, a sign-in…)
/// comes first; then what finished or failed since you were last there; each the latest first.
/// Opening it (or marking it read) is what takes it off: the same `viewed` the sidebar's marks go
/// by, so the two never disagree.
public enum Inbox {
    public enum Reason: Hashable, Sendable {
        /// It waits on you.
        case needsYou
        /// Its last run failed, since you were last there.
        case failed
        /// It finished since you were last there.
        case finished

        /// What waits on you, apart from what's only news.
        public var needsYou: Bool { self == .needsYou }
    }

    /// Why a conversation is in the inbox, if it is: from the facts its sidebar mark goes by.
    public static func reason(needsYou: Bool, failed: Bool, isNew: Bool) -> Reason? {
        if needsYou { return .needsYou }
        guard isNew else { return nil }
        return failed ? .failed : .finished
    }

    /// `entries` in the inbox's order: what waits on you first, then the rest; each the latest
    /// first. `at` is when each last changed (ms or s, alike for all).
    public static func ordered<Entry>(_ entries: [Entry], reason: (Entry) -> Reason, at: (Entry) -> Double) -> [Entry] {
        let waiting = entries.filter { reason($0).needsYou }.sorted { at($0) > at($1) }
        let news = entries.filter { !reason($0).needsYou }.sorted { at($0) > at($1) }
        return waiting + news
    }
}

extension WorkQueue {
    /// Whether `item` is one a search for `words` finds: by its title, or its number ("243" or "#243").
    public static func matches(_ item: WorkItem, _ words: String) -> Bool {
        let words = words.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else { return false }
        if let number = Int(words.trimmingCharacters(in: CharacterSet(charactersIn: "#"))), item.number == number { return true }
        return item.title.localizedStandardContains(words)
    }
}
