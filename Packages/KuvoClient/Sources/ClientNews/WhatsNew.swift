import Foundation
import Observation

// What's new in each app: a release's highlights, shown once in a sheet after an update to it,
// and "New" marks on what came with it (a keyword, a Settings page) until you've used it. Both come
// from the app's CHANGELOG.md, which `scripts/whats-new.py` reads into the `whats-new.json` each
// app carries. Shared so the Mac and the phone show and remember them the same way.

/// What each release brought, as `whats-new.json` has it: newest first, only those with
/// highlights or marks.
public struct WhatsNew: Decodable, Equatable, Sendable {
    public var releases: [Release]

    public init(releases: [Release]) {
        self.releases = releases
    }

    /// One release: its version as the changelog names it ("0.8.0", or "Unreleased" until it's
    /// named), what it's worth telling people about, and what carries a "New" mark.
    public struct Release: Decodable, Equatable, Sendable, Identifiable {
        public var version: String
        public var highlights: [Highlight]
        public var marks: [String]
        public var id: String { version }

        public init(version: String, highlights: [Highlight] = [], marks: [String] = []) {
            self.version = version
            self.highlights = highlights
            self.marks = marks
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            version = try container.decode(String.self, forKey: .version)
            highlights = try container.decodeIfPresent([Highlight].self, forKey: .highlights) ?? []
            marks = try container.decodeIfPresent([String].self, forKey: .marks) ?? []
        }

        private enum CodingKeys: String, CodingKey { case version, highlights, marks }
    }

    /// Something a release is worth telling people about: a few words, a line on what it does,
    /// its symbol, a picture where there's one, and where Try It goes (`settings/<page>`, or a
    /// web address).
    public struct Highlight: Decodable, Equatable, Sendable, Identifiable {
        public var title: String
        public var line: String
        public var symbol: String
        public var picture: String?
        public var open: String?
        public var id: String { title }

        public init(title: String, line: String, symbol: String, picture: String? = nil, open: String? = nil) {
            self.title = title
            self.line = line
            self.symbol = symbol
            self.picture = picture
            self.open = open
        }
    }

    /// What an app carries in `bundle`; none when it has none, or it can't be read.
    public static func bundled(in bundle: Bundle = .main) -> WhatsNew? {
        guard let url = bundle.url(forResource: "whats-new", withExtension: "json"), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(WhatsNew.self, from: data)
    }

    /// The release this copy is: its own version's, or what's Unreleased for a beta (named once
    /// it's released) and a build made before it's named.
    public func release(of version: String) -> Release? {
        releases.first { $0.version == version } ?? releases.first { $0.version == "Unreleased" }
    }

    /// The newest release that has highlights, for Help › What's New after its own has none.
    public var latestHighlights: Release? {
        releases.first { !$0.highlights.isEmpty }
    }

    /// Every mark, in any release.
    public var marks: Set<String> {
        Set(releases.flatMap(\.marks))
    }
}

/// What this app remembers of What's New: the highlights it's shown and the marks you've seen,
/// in its own defaults (each app keeps its own).
public final class NewsMemory: @unchecked Sendable {
    /// How long a mark stays after it first shows, used or not.
    public static let markLasts: TimeInterval = 21 * 24 * 60 * 60

    private let defaults: UserDefaults
    private let lock = NSLock()

    private enum Key {
        static let shown = "whatsNew.shown"
        static let started = "whatsNew.started"
        static let used = "whatsNew.used"
        static let firstSeen = "whatsNew.firstSeen"
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// As the app opens, the highlights to show this once: the release it is now, when it has
    /// some you haven't seen (after an update, not the first time it ever opens, when everything
    /// is new and the marks are taken as seen). `ranBefore`: the app had opened before it kept
    /// any of this (an update to the first copy with What's New). Nil otherwise.
    public func afterLaunch(_ news: WhatsNew?, version: String, ranBefore: Bool) -> WhatsNew.Release? {
        lock.lock()
        defer { lock.unlock() }
        let isFirstLaunch = !defaults.bool(forKey: Key.started) && !ranBefore
        defaults.set(true, forKey: Key.started)
        guard let news else { return nil }
        if isFirstLaunch {
            var used = Set(defaults.stringArray(forKey: Key.used) ?? [])
            used.formUnion(news.marks)
            defaults.set(used.sorted(), forKey: Key.used)
        }
        guard let release = news.release(of: version), !release.highlights.isEmpty else { return nil }
        // The same highlights (a beta's, then its release's) are shown once.
        let signature = release.highlights.map(\.title).joined(separator: "\n")
        guard defaults.string(forKey: Key.shown) != signature else { return nil }
        defaults.set(signature, forKey: Key.shown)
        return isFirstLaunch ? nil : release
    }

    /// Whether `mark` shows "New" now: one a release brought that you haven't used, for a few
    /// weeks from when it first showed. Showing it starts that time.
    public func isNew(_ mark: String, in news: WhatsNew?, now: Date = Date()) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard let news, news.marks.contains(mark), !(defaults.stringArray(forKey: Key.used) ?? []).contains(mark) else { return false }
        var firstSeen = defaults.dictionary(forKey: Key.firstSeen) as? [String: Double] ?? [:]
        guard let first = firstSeen[mark] else {
            firstSeen[mark] = now.timeIntervalSince1970
            defaults.set(firstSeen, forKey: Key.firstSeen)
            return true
        }
        return now.timeIntervalSince1970 - first < Self.markLasts
    }

    /// The marks used so far.
    public var usedMarks: Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return Set(defaults.stringArray(forKey: Key.used) ?? [])
    }

    /// `mark` was used (the keyword sent, the page opened): it isn't new any more.
    public func used(_ mark: String) {
        lock.lock()
        defer { lock.unlock() }
        var used = Set(defaults.stringArray(forKey: Key.used) ?? [])
        guard used.insert(mark).inserted else { return }
        defaults.set(used.sorted(), forKey: Key.used)
    }
}

/// The "New" marks as views read them: each is new until it's used (which shows at once), or for a
/// few weeks from when it first showed.
@MainActor @Observable
public final class NewMarks {
    public let news: WhatsNew?
    @ObservationIgnored private let memory: NewsMemory
    /// What's been used, kept here too so a view showing a mark hears when it goes.
    private var used: Set<String>

    public init(news: WhatsNew?, memory: NewsMemory) {
        self.news = news
        self.memory = memory
        used = memory.usedMarks
    }

    /// Whether `mark` shows "New".
    public func isNew(_ mark: String) -> Bool {
        !used.contains(mark) && memory.isNew(mark, in: news)
    }

    /// `mark` was used: its "New" goes.
    public func use(_ mark: String) {
        guard news?.marks.contains(mark) == true, !used.contains(mark) else { return }
        used.insert(mark)
        memory.used(mark)
    }
}
