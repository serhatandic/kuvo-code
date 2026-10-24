import AppKit
import Foundation

/// What's typed in a composer but not sent yet, by session (or by a project's new session),
/// kept across launches. Attachments that have since been deleted are dropped.
@Observable
final class Drafts {
    static let shared = Drafts()

    struct Draft: Codable, Hashable {
        var text = ""
        var files: [URL] = []
        /// What you were replying to, before you could reply to several (read once, into `quotes`).
        var quote: String?
        /// What you're replying to, each with your answer to it: sent in order, then the text.
        var quotes: [Quote] = []
        /// Your comments on lines of the changes, sent with the next message.
        var comments: [ReviewComment] = []

        var isEmpty: Bool { text.isEmpty && files.isEmpty && quote == nil && quotes.isEmpty && comments.isEmpty }

        init(text: String = "", files: [URL] = [], quote: String? = nil, quotes: [Quote] = []) {
            self.text = text
            self.files = files
            self.quote = quote
            self.quotes = quotes
        }

        /// Drafts saved before a field was added still read.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
            files = try c.decodeIfPresent([URL].self, forKey: .files) ?? []
            quote = try c.decodeIfPresent(String.self, forKey: .quote)
            quotes = try c.decodeIfPresent([Quote].self, forKey: .quotes) ?? []
            comments = try c.decodeIfPresent([ReviewComment].self, forKey: .comments) ?? []
        }
    }

    /// A part of a message you're replying to, and what you say to it.
    struct Quote: Codable, Hashable, Identifiable {
        var id = UUID()
        var text: String
        var response = ""
    }

    /// A draft on its way, taken out of its composer while its session is made.
    private struct Sending: Codable {
        /// The composer it came from.
        let key: String
        let draft: Draft
        let at: Date
    }

    private var drafts: [String: Draft]
    /// The drafts on their way, by an ID of their own: kept on disk until their session has them,
    /// so a quit or crash meanwhile doesn't lose them.
    @ObservationIgnored private var sending: [String: Sending] = [:]
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    private static let key = "composerDrafts"
    private static let sendingKey = "composerDraftsSending"
    /// Where they're kept: the app's settings (a test's own).
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([String: Draft].self, from: $0) } ?? [:]
        drafts = Dictionary(uniqueKeysWithValues: stored.map { key, draft in
            var draft = draft
            draft.files = draft.files.filter { FileManager.default.fileExists(atPath: $0.path) }
            // A draft from before it could reply to several quotes.
            if let quote = draft.quote, draft.quotes.isEmpty {
                draft.quotes = [Quote(text: quote)]
                draft.quote = nil
            }
            return (key, draft)
        })
        // What was on its way when the app last quit, or crashed: back in its composer.
        let unsent = defaults.data(forKey: Self.sendingKey).flatMap { try? JSONDecoder().decode([String: Sending].self, from: $0) } ?? [:]
        if !unsent.isEmpty {
            // The latest first, so the earliest ends up first.
            for message in unsent.values.sorted(by: { $0.at > $1.at }) {
                var draft = message.draft
                draft.files = draft.files.filter { FileManager.default.fileExists(atPath: $0.path) }
                putBack(draft, in: message.key)
            }
            save()
        }
        // Typing saves after a pause; quitting right after shouldn't lose the last words.
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.save() }
        }
    }

    /// Takes `key`'s draft out of its composer, to send: it stays on disk, under the ID given,
    /// until it's `sent`; if the app quits first, it's back in the composer the next time.
    func takeOut(_ key: String) -> (id: String, draft: Draft) {
        let id = UUID().uuidString
        let draft = self[key]
        sending[id] = Sending(key: key, draft: draft, at: .now)
        drafts[key] = nil
        saveNow()
        return (id, draft)
    }

    /// `text`, sent to `key` from elsewhere (a notification's Reply), kept on disk as on its way
    /// under the ID given until it's `sent`: if the app quits first (it waited for a move), it's
    /// in `key`'s composer the next time.
    func onItsWay(_ text: String, to key: String) -> String {
        let id = UUID().uuidString
        sending[id] = Sending(key: key, draft: Draft(text: text), at: .now)
        saveNow()
        return id
    }

    /// The draft taken out as `id` has gone: nothing of it is kept.
    func sent(_ id: String) {
        guard sending.removeValue(forKey: id) != nil else { return }
        saveNow()
    }

    /// The draft taken out as `id` didn't go: it's back in its composer, before what's been
    /// written there since.
    func putBack(_ id: String) {
        guard let message = sending.removeValue(forKey: id) else { return }
        putBack(message.draft, in: message.key)
        saveNow()
    }

    private func putBack(_ sent: Draft, in key: String) {
        let since = drafts[key] ?? Draft()
        var draft = Draft(
            text: [sent.text, since.text].filter { !$0.isEmpty }.joined(separator: "\n\n"),
            files: sent.files + since.files.filter { !sent.files.contains($0) },
            quotes: sent.quotes + since.quotes
        )
        // Its comments on the changes too, which go with it.
        draft.comments = sent.comments + since.comments.filter { comment in !sent.comments.contains { $0.id == comment.id } }
        drafts[key] = draft.isEmpty ? nil : draft
    }

    /// Adds a quote to answer to `key`'s draft, after those there are; one already there isn't
    /// added again. Its ID, for its answer to take the keyboard; nil for nothing to quote.
    @discardableResult
    func addQuote(_ text: String, to key: String) -> UUID? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let same = self[key].quotes.first(where: { $0.text == text }) { return same.id }
        let quote = Quote(text: text)
        self[key].quotes.append(quote)
        self[key].quote = nil
        return quote.id
    }

    subscript(key: String) -> Draft {
        get { drafts[key] ?? Draft() }
        set {
            drafts[key] = newValue.isEmpty ? nil : newValue
            scheduleSave()
        }
    }

    func remove(_ key: String) {
        guard drafts[key] != nil else { return }
        drafts[key] = nil
        scheduleSave()
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            save()
        }
    }

    /// Saves at once (typing saves after a pause).
    func saveNow() {
        saveTask?.cancel()
        save()
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(drafts), forKey: Self.key)
        if sending.isEmpty {
            defaults.removeObject(forKey: Self.sendingKey)
        } else {
            defaults.set(try? JSONEncoder().encode(sending), forKey: Self.sendingKey)
        }
    }
}
