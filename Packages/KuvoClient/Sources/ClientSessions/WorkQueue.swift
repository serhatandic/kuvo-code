import Foundation

// The Work Queue as the box states it (PROTOCOL.md, "The Work Queue"), and what both apps work
// out from it to draw: its sections (In progress, then each category), "Updated 8m ago", an
// item's name ("#243", or "New" while it waits for a number), and whose an item is. Times on the
// wire are milliseconds since 1970.

/// A category: Next, Later, Parked and Done built in, custom ones (`cat_…`) between Later and Parked.
public struct WorkCategory: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var builtIn: Bool

    public init(id: String, name: String, builtIn: Bool) {
        self.id = id
        self.name = name
        self.builtIn = builtIn
    }

    public static let done = "done"
}

/// Who wrote something: you, or a session (by its name then).
public enum WorkWho: Hashable, Sendable, Decodable {
    case user
    case session(String, name: String)

    private enum Keys: String, CodingKey { case user, session, name }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if let session = try container.decodeIfPresent(String.self, forKey: .session) {
            self = .session(session, name: try container.decodeIfPresent(String.self, forKey: .name) ?? "")
        } else {
            self = .user
        }
    }

    /// "you", or the session's name.
    public var words: String {
        switch self {
        case .user: "you"
        case .session(_, let name): name.isEmpty ? "an agent" : name
        }
    }
}

public struct WorkStamp: Hashable, Sendable, Decodable {
    public var at: Double
    public var by: WorkWho
    public var date: Date { Date(timeIntervalSince1970: at / 1000) }

    public init(at: Double, by: WorkWho) {
        self.at = at
        self.by = by
    }
}

public struct WorkNote: Hashable, Sendable, Decodable {
    public var at: Double
    public var by: WorkWho
    public var text: String
    public var date: Date { Date(timeIntervalSince1970: at / 1000) }
}

/// What's being done, and how far along.
public struct WorkProgress: Hashable, Sendable, Decodable {
    public var value: Double?
    public var note: String?

    public init(value: Double? = nil, note: String? = nil) {
        self.value = value
        self.note = note
    }
}

/// A session linked to an item, and whether it's at work now.
public struct WorkItemSession: Hashable, Sendable, Decodable {
    public var session: String
    public var title: String
    public var working: Bool
}

/// An item as a list shows it: everything but its body and notes.
public struct WorkItem: Hashable, Sendable, Decodable, Identifiable {
    public var id: String
    public var number: Int?
    public var wanted: Int?
    public var owner: String
    public var title: String
    public var category: String
    public var order: Double
    public var inProgress: Bool
    public var progress: WorkProgress?
    public var sessions: [WorkItemSession]
    public var noteCount: Int
    public var lastNote: WorkNote?
    public var fileCount: Int
    public var linkCount: Int
    public var handedBy: String?
    public var created: WorkStamp
    public var updated: WorkStamp
    public var doneAt: Double?
    public var removed: WorkStamp?

    public var isDone: Bool { category == WorkCategory.done }
    /// "#243", or "New" while it waits for its number.
    public var name: String { number.map { "#\($0)" } ?? "New" }
}

/// An item whole: its description (Markdown), notes, files, links and who handed it on.
public struct WorkItemDetail: Hashable, Sendable, Decodable {
    public struct File: Hashable, Sendable, Decodable {
        public var name: String
        public var size: Int
        public var type: String
        public var at: Double
        public var isPicture: Bool { type.hasPrefix("image/") }
    }

    public struct Link: Hashable, Sendable, Decodable {
        public var url: String
        public var title: String?
    }

    public struct Handed: Hashable, Sendable, Decodable {
        public var from: String
        public var to: String
        public var at: Double
    }

    public var item: WorkItem
    public var body: String
    public var notes: [WorkNote]
    public var files: [File]
    public var links: [Link]
    public var handed: [Handed]

    private enum Keys: String, CodingKey { case body, notes, files, links, handed }

    public init(from decoder: any Decoder) throws {
        item = try WorkItem(from: decoder)
        let container = try decoder.container(keyedBy: Keys.self)
        body = try container.decodeIfPresent(String.self, forKey: .body) ?? ""
        notes = try container.decodeIfPresent([WorkNote].self, forKey: .notes) ?? []
        files = try container.decodeIfPresent([File].self, forKey: .files) ?? []
        links = try container.decodeIfPresent([Link].self, forKey: .links) ?? []
        handed = try container.decodeIfPresent([Handed].self, forKey: .handed) ?? []
    }
}

/// An owner in a view: a session, a bot's conversation or a group chat.
public struct WorkOwner: Hashable, Sendable, Decodable {
    public struct Bot: Hashable, Sendable, Decodable {
        public var id: String
        public var name: String
    }

    public var owner: String
    public var kind: String
    public var title: String?
    public var bot: Bot?
    public var startedBy: String?

    /// As a list names it: the bot's name, the session's title, or the group chat.
    public var name: String {
        if let bot { return bot.name }
        if let title, !title.isEmpty { return title }
        return kind == "group" ? "Group chat" : "Untitled session"
    }
}

/// An owner's view, or every queue on the box (`owner` "all").
public struct WorkQueueView: Hashable, Sendable, Decodable {
    public var owner: String
    public var categories: [WorkCategory]
    public var items: [WorkItem]
    public var owners: [WorkOwner]
    public var removed: [WorkItem]

    public init(owner: String, categories: [WorkCategory] = [], items: [WorkItem] = [], owners: [WorkOwner] = [], removed: [WorkItem] = []) {
        self.owner = owner
        self.categories = categories
        self.items = items
        self.owners = owners
        self.removed = removed
    }

    public static let all = "all"
}

/// What a `#n` names, for a chip.
public struct WorkRef: Hashable, Sendable, Decodable {
    public var id: String
    public var number: Int?
    public var title: String
    public var category: String
    public var inProgress: Bool
    public var owner: String
    public var removed: Bool?

    public init(id: String, number: Int?, title: String, category: String, inProgress: Bool, owner: String, removed: Bool? = nil) {
        self.id = id
        self.number = number
        self.title = title
        self.category = category
        self.inProgress = inProgress
        self.owner = owner
        self.removed = removed
    }

    public init(_ item: WorkItem) {
        self.init(id: item.id, number: item.number, title: item.title, category: item.category, inProgress: item.inProgress, owner: item.owner, removed: item.removed == nil ? nil : true)
    }
}

/// The `refs` route's answer: null for a number the box doesn't know.
public struct WorkRefs: Decodable, Sendable {
    public var refs: [String: WorkRef?]
}

/// What the panel shows of a view, the same in both apps.
public enum WorkQueue {
    /// A filter over the list: everything, what's in progress, or one category.
    public enum Filter: Hashable, Sendable {
        case all
        case inProgress
        case category(String)
    }

    /// A part of the list: In progress first (whatever its items' categories), then each category
    /// in the box's order, each with its items in their order.
    public struct Section: Hashable, Sendable, Identifiable {
        public var id: String
        public var name: String
        /// The category items here are kept in; nil for In progress, which isn't one.
        public var category: String?
        public var items: [WorkItem]
    }

    public static let inProgressID = "in-progress"

    /// In progress: at work on now. Done isn't, nor anything deleted.
    public static func isInProgress(_ item: WorkItem) -> Bool {
        item.inProgress && !item.isDone && item.removed == nil
    }

    /// The view's sections, In progress first, then every category (empty ones too: the panel says
    /// how many each holds).
    public static func sections(_ view: WorkQueueView) -> [Section] {
        let working = view.items.filter(isInProgress)
        var sections = [Section(id: inProgressID, name: "In progress", category: nil, items: working)]
        let rest = view.items.filter { !isInProgress($0) }
        let known = Set(view.categories.map(\.id))
        for category in view.categories {
            sections.append(Section(id: category.id, name: category.name, category: category.id, items: rest.filter { $0.category == category.id }))
        }
        // An item in a category the list doesn't name (it came from elsewhere): with Next.
        let strays = rest.filter { !known.contains($0.category) }
        if !strays.isEmpty, let next = sections.firstIndex(where: { $0.category == "next" }) { sections[next].items += strays }
        return sections
    }

    /// The items `filter` keeps, in the list's order: In progress first under All.
    public static func items(_ view: WorkQueueView, _ filter: Filter, showsDone: Bool = true) -> [WorkItem] {
        let sections = sections(view)
        switch filter {
        case .all: return sections.filter { showsDone || $0.category != WorkCategory.done }.flatMap(\.items)
        case .inProgress: return sections.first?.items ?? []
        case .category(let id): return sections.first { $0.category == id }?.items ?? []
        }
    }

    /// How many items are open (not Done): the tab's "24 items".
    public static func openCount(_ view: WorkQueueView) -> Int {
        view.items.count { !$0.isDone }
    }

    /// "24 items", "1 item", "No items".
    public static func count(_ number: Int) -> String {
        number == 0 ? "No items" : number == 1 ? "1 item" : "\(number) items"
    }

    /// "Updated just now", "Updated 8m ago", "Updated 3h ago", "Updated 2d ago", then the day.
    public static func updated(_ date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        "Updated " + ago(date, now: now, calendar: calendar, locale: locale)
    }

    /// "just now", "8m ago", "3h ago", "2d ago", then "Oct 25".
    public static func ago(_ date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h ago" }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d ago" }
        return date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day())
    }

    /// Whose an item is, by name, when it isn't the view's own owner's (a session a lead oversees,
    /// or the All view's): nil for the view's own.
    public static func ownerName(of item: WorkItem, in view: WorkQueueView) -> String? {
        guard item.owner != view.owner else { return nil }
        return view.owners.first { $0.owner == item.owner }?.name ?? (item.owner.hasPrefix("grp_") ? "Group chat" : "Untitled session")
    }

    /// What's being done now: the agent's note, else the session at work.
    public static func currentWork(_ item: WorkItem) -> String? {
        if let note = item.progress?.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty { return note }
        if let working = item.sessions.first(where: \.working) { return "\(working.title.isEmpty ? "A session" : working.title) is at work on it" }
        return nil
    }

    /// The category an item is kept in, by name.
    public static func categoryName(_ id: String, in categories: [WorkCategory]) -> String {
        categories.first { $0.id == id }?.name ?? id.capitalized
    }

    /// Where an item may be moved to from a menu: every category but the one it's in. In progress
    /// isn't one (the box works it out from the sessions at work).
    public static func moveTargets(for item: WorkItem, in categories: [WorkCategory]) -> [WorkCategory] {
        categories.filter { $0.id != item.category }
    }
}
