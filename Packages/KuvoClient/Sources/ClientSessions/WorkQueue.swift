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

/// Who wrote something: you, a session (by its name then), or someone else the box kept as it
/// came (an outside tracker's change, `{source, name?}`), by its name, never taken for you.
public enum WorkWho: Hashable, Sendable, Decodable {
    case user
    case session(String, name: String)
    case other(String)

    private enum Keys: String, CodingKey { case user, session, name, source }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if (try? container.decodeIfPresent(Bool.self, forKey: .user)) == true {
            self = .user
        } else if let session = try? container.decodeIfPresent(String.self, forKey: .session) {
            self = .session(session, name: (try? container.decodeIfPresent(String.self, forKey: .name)) ?? "")
        } else {
            let name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? (try? container.decodeIfPresent(String.self, forKey: .source)) ?? nil
            self = .other(name ?? "")
        }
    }

    /// "you", the session's name, or another's.
    public var words: String {
        switch self {
        case .user: "you"
        case .session(_, let name): name.isEmpty ? "an agent" : name
        case .other(let name): name.isEmpty ? "someone else" : name
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

/// Something that happened to an item, as the box kept it for its feed: a session `started` or
/// `stopped` work on it, it `moved` (`from` and `to` its categories' ids, `top` when it went to the
/// top), it was `done`. A newer box may say other kinds, which a client leaves out.
public struct WorkEvent: Hashable, Sendable, Decodable {
    public var at: Double
    public var by: WorkWho
    public var kind: String
    public var from: String?
    public var to: String?
    public var top: Bool
    public var date: Date { Date(timeIntervalSince1970: at / 1000) }

    public init(at: Double, by: WorkWho, kind: String, from: String? = nil, to: String? = nil, top: Bool = false) {
        self.at = at
        self.by = by
        self.kind = kind
        self.from = from
        self.to = to
        self.top = top
    }

    private enum Keys: String, CodingKey { case at, by, kind, from, to, top }

    // (What a newer box adds, or says otherwise, never keeps the rest of the item from being read.)
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        at = try container.decode(Double.self, forKey: .at)
        by = try container.decode(WorkWho.self, forKey: .by)
        kind = try container.decode(String.self, forKey: .kind)
        from = try? container.decodeIfPresent(String.self, forKey: .from)
        to = try? container.decodeIfPresent(String.self, forKey: .to)
        top = ((try? container.decodeIfPresent(Bool.self, forKey: .top)) ?? nil) ?? false
    }
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

/// An outside source's item (an issue or a pull request): named by its ref (`gh:owner/repo#12`),
/// never numbered; `name` what's shown of it (`app#12`), as the box says.
public struct WorkSource: Hashable, Sendable, Decodable {
    public var kind: String
    public var ref: String
    public var url: String?
    public var name: String?

    public init(kind: String, ref: String, url: String? = nil, name: String? = nil) {
        self.kind = kind
        self.ref = ref
        self.url = url
        self.name = name
    }

    /// What's shown of it: the box's name for it ("app#12"), else its ref without its prefix and
    /// owner.
    public var shownName: String {
        if let name, !name.isEmpty { return name }
        return ref.replacing(/^[a-z]+:(?:[^\/#]+\/)?/, with: "")
    }

    /// Whether it's GitHub's (an issue, or a pull request): drawn with GitHub's mark.
    public var isGitHub: Bool { kind == "github" || kind == "github-pr" }

    public var isPullRequest: Bool { kind == "github-pr" }

    /// What it is, for VoiceOver: "GitHub issue", "GitHub pull request".
    public var spokenKind: String { isGitHub ? (isPullRequest ? "GitHub pull request" : "GitHub issue") : "Issue" }
}

/// Where an outside source's item stands there, as the box last read it: `open`, `draft`,
/// `completed`, `not_planned`, `merged` or `closed` (a pull request closed unmerged); a newer box
/// may say more. `gone`: found missing there since (deleted, or no longer visible to the box's
/// sign-in), `state` what it was before.
public struct WorkSeen: Hashable, Sendable, Decodable {
    public var state: String
    public var at: Double
    public var gone: Bool?

    public init(state: String, at: Double, gone: Bool? = nil) {
        self.state = state
        self.at = at
        self.gone = gone
    }
}

/// Another of your computers: the one an item is on, when it isn't the box asked. A client reads
/// and changes the item there: a machine by its `id`, a Mac by its own box.
public struct WorkComputer: Hashable, Sendable, Decodable {
    public var key: String
    public var name: String
    public var kind: String
    public var id: String?

    public init(key: String, name: String, kind: String, id: String? = nil) {
        self.key = key
        self.name = name
        self.kind = kind
        self.id = id
    }
}

/// An item on its way to a conversation on another computer: unchanged until it's there.
public struct WorkHanding: Hashable, Sendable, Decodable {
    public var to: String
    public var name: String
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
    public var source: WorkSource?
    /// What its source says of it (an issue's or a pull request's), as the box last read it.
    public var seen: WorkSeen?
    /// The category it's kept in while its source makes it Done (`category` "done").
    public var keptIn: String?
    /// Its title struck through, as the box says: closed there without being done.
    public var struck: Bool?
    /// Where it's made Done ("github"), as the box says: never by a move here.
    public var closesOn: String?
    /// What's shown in place of its category while its source makes it Done ("Merged on GitHub"),
    /// as the box says.
    public var doneAs: String?
    public var computer: WorkComputer?
    public var handing: WorkHanding?
    public var created: WorkStamp
    public var updated: WorkStamp
    public var doneAt: Double?
    public var removed: WorkStamp?

    public var isDone: Bool { category == WorkCategory.done }
    /// An outside source's name ("app#12"), "#243", or "New" while it waits for its number.
    public var name: String { source?.shownName ?? number.map { "#\($0)" } ?? "New" }

    /// How it's written in a message, so it names it there: `gh:owner/repo#12`, "#243"; nil while
    /// it has no number.
    public var written: String? { source?.ref ?? number.map { "#\($0)" } }
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
        /// What it links: `pr`, `mr`, `issue`, `doc` (outside sources, later), and its ref.
        public var kind: String?
        public var ref: String?
    }

    public struct Handed: Hashable, Sendable, Decodable {
        public var from: String
        public var to: String
        public var at: Double
    }

    public var item: WorkItem
    public var body: String
    public var notes: [WorkNote]
    /// What happened to it, as the box kept it (none from a box from before it kept them).
    public var events: [WorkEvent]
    public var files: [File]
    public var links: [Link]
    public var handed: [Handed]

    private enum Keys: String, CodingKey { case body, notes, events, files, links, handed }

    // (An event this client can't read leaves out only itself, never the item.)
    private struct Lossy<Value: Decodable>: Decodable {
        var value: Value?
        init(from decoder: any Decoder) throws { value = try? Value(from: decoder) }
    }

    public init(from decoder: any Decoder) throws {
        item = try WorkItem(from: decoder)
        let container = try decoder.container(keyedBy: Keys.self)
        body = try container.decodeIfPresent(String.self, forKey: .body) ?? ""
        notes = try container.decodeIfPresent([WorkNote].self, forKey: .notes) ?? []
        events = ((try? container.decodeIfPresent([Lossy<WorkEvent>].self, forKey: .events)) ?? nil)?.compactMap(\.value) ?? []
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

/// An owner's view, or every queue on the box and on your other computers (`owner` "all"). Items
/// another computer told of say which (`computer`); `computers` says when each told them.
public struct WorkQueueView: Hashable, Sendable, Decodable {
    public struct Told: Hashable, Sendable, Decodable {
        public var key: String
        public var name: String
        public var kind: String
        public var id: String?
        public var at: Double
        /// Since when it hasn't answered: its items are as it last told them, none at work.
        public var away: Double?
        public var date: Date { Date(timeIntervalSince1970: at / 1000) }
    }

    public var owner: String
    public var categories: [WorkCategory]
    public var items: [WorkItem]
    public var owners: [WorkOwner]
    public var removed: [WorkItem]
    public var computers: [Told]

    public init(owner: String, categories: [WorkCategory] = [], items: [WorkItem] = [], owners: [WorkOwner] = [], removed: [WorkItem] = [], computers: [Told] = []) {
        self.owner = owner
        self.categories = categories
        self.items = items
        self.owners = owners
        self.removed = removed
        self.computers = computers
    }

    private enum Keys: String, CodingKey { case owner, categories, items, owners, removed, computers }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        owner = try container.decode(String.self, forKey: .owner)
        categories = try container.decode([WorkCategory].self, forKey: .categories)
        items = try container.decode([WorkItem].self, forKey: .items)
        owners = try container.decode([WorkOwner].self, forKey: .owners)
        removed = try container.decodeIfPresent([WorkItem].self, forKey: .removed) ?? []
        // (A box from before piece 3 has none.)
        computers = (try? container.decodeIfPresent([Told].self, forKey: .computers)) ?? []
    }

    public static let all = "all"
}

/// What a ref names, for a chip: a `#n`, or (later) an outside source's. `owner` and `computer`
/// only when the box says (an outside ref may have no owner).
public struct WorkRef: Hashable, Sendable, Decodable {
    public var id: String
    public var number: Int?
    public var source: WorkSource?
    public var seen: WorkSeen?
    public var struck: Bool?
    public var title: String
    public var category: String
    public var inProgress: Bool
    public var owner: String?
    public var removed: Bool?
    public var computer: WorkComputer?

    public init(id: String, number: Int?, source: WorkSource? = nil, seen: WorkSeen? = nil, struck: Bool? = nil, title: String, category: String, inProgress: Bool, owner: String?, removed: Bool? = nil, computer: WorkComputer? = nil) {
        self.id = id
        self.number = number
        self.source = source
        self.seen = seen
        self.struck = struck
        self.title = title
        self.category = category
        self.inProgress = inProgress
        self.owner = owner
        self.removed = removed
        self.computer = computer
    }

    public init(_ item: WorkItem) {
        self.init(id: item.id, number: item.number, source: item.source, seen: item.seen, struck: item.struck, title: item.title, category: item.category, inProgress: item.inProgress, owner: item.owner, removed: item.removed == nil ? nil : true, computer: item.computer)
    }

    /// What a chip shows of it: its source's name ("app#12"), else "#243".
    public var name: String { source?.shownName ?? number.map { "#\($0)" } ?? "New" }
}

/// The `refs` route's answer, by the ref as it was asked: null for one the box doesn't know. Each is
/// read on its own, so one this client can't read (a newer box's) stays plain text and the rest
/// still show.
public struct WorkRefs: Decodable, Sendable {
    public var refs: [String: WorkRef?]

    private struct Each: Decodable {
        var ref: WorkRef?
        init(from decoder: any Decoder) throws { ref = try? decoder.singleValueContainer().decode(WorkRef.self) }
    }

    private enum Keys: String, CodingKey { case refs }

    public init(refs: [String: WorkRef?]) { self.refs = refs }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        refs = try container.decode([String: Each].self, forKey: .refs).mapValues(\.ref)
    }
}

/// What the panel shows of a view, the same in both apps.
public enum WorkQueue {
    /// A filter over the list: everything, what's in progress, or one category.
    public enum Filter: Hashable, Sendable {
        case all
        /// What this session works on that's someone else's (a session's view only).
        case workingOn
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

        public init(id: String, name: String, category: String?, items: [WorkItem]) {
            self.id = id
            self.name = name
            self.category = category
            self.items = items
        }
    }

    public static let inProgressID = "in-progress"
    public static let workingOnID = "working-on"

    /// In progress, as the box says (it never says so of one that's Done or deleted).
    public static func isInProgress(_ item: WorkItem) -> Bool { item.inProgress }

    /// Whether `item` is one the view's owner is working on that's someone else's: a lead's item
    /// linked to the session whose view it is, not Done. The box shows those in its view, to see
    /// only; they go first, under Working on (one that's Done goes with the Done ones).
    public static func isWorkingOn(_ item: WorkItem, in view: WorkQueueView) -> Bool {
        view.owner != WorkQueueView.all && item.owner != view.owner && !item.isDone && item.sessions.contains { $0.session == view.owner }
    }

    /// The view's sections: Working on first when the view has any (what this session works on
    /// that's someone else's), then In progress (whatever its items' categories), then every
    /// category (empty ones too: the panel says how many each holds). Each item shows once.
    public static func sections(_ view: WorkQueueView) -> [Section] {
        let workingOn = view.items.filter { isWorkingOn($0, in: view) }
        let rest = view.items.filter { !isWorkingOn($0, in: view) }
        var sections = workingOn.isEmpty ? [] : [Section(id: workingOnID, name: "Working on", category: nil, items: workingOn)]
        sections.append(Section(id: inProgressID, name: "In progress", category: nil, items: rest.filter(isInProgress)))
        let kept = rest.filter { !isInProgress($0) }
        for category in view.categories {
            sections.append(Section(id: category.id, name: category.name, category: category.id, items: kept.filter { $0.category == category.id }))
        }
        return sections
    }

    /// The items `filter` keeps, in the list's order: Working on and In progress first under All.
    /// Each item is under one filter but All, so the others' counts add up to All's.
    public static func items(_ view: WorkQueueView, _ filter: Filter, showsDone: Bool = true) -> [WorkItem] {
        switch filter {
        case .all: return sections(view).filter { showsDone || $0.category != WorkCategory.done }.flatMap(\.items)
        default: return section(for: filter, in: view)?.items ?? []
        }
    }

    /// The section a filter shows (nil for All, and for Working on in a view without it): In
    /// progress, Working on, or a category.
    public static func section(for filter: Filter, in view: WorkQueueView) -> Section? {
        let sections = sections(view)
        switch filter {
        case .all: return nil
        case .workingOn: return sections.first { $0.id == workingOnID }
        case .inProgress: return sections.first { $0.id == inProgressID }
        case .category(let id): return sections.first { $0.category == id }
        }
    }

    /// How many items All has: every one, Done too. Each counts once, so this is In progress plus
    /// every category's count (In progress is a state over the categories: an item there isn't
    /// counted in its category too).
    public static func allCount(_ view: WorkQueueView) -> Int {
        view.items.count
    }

    /// How many items are open (not Done): the tab's "24 open".
    public static func openCount(_ view: WorkQueueView) -> Int {
        view.items.count { !$0.isDone }
    }

    /// "24 items", "1 item", "No items".
    public static func count(_ number: Int) -> String {
        number == 0 ? "No items" : number == 1 ? "1 item" : "\(number) items"
    }

    /// "24 open", "Nothing open": how many are left to do, beside All's count of everything.
    public static func openWords(_ number: Int) -> String {
        number == 0 ? "Nothing open" : "\(number) open"
    }

    // MARK: Moving by hand

    /// Where you put an item, as the box's move takes it (`kuvo/work-queue/items/:item/move`, the
    /// same `before`/`after`/`top` agents give `queue_update`): before or after another item (in that
    /// one's category), at the top of a category, or at its end.
    public enum Place: Hashable, Sendable {
        case top(String)
        case before(WorkItem)
        case after(WorkItem)
        case category(String)

        /// The category it goes to.
        public var category: String {
            switch self {
            case .top(let id), .category(let id): id
            case .before(let other), .after(let other): other.category
            }
        }
    }

    /// Where `item` lands dropped at `index` among `section`'s items (0 is before the first, the
    /// count after the last, counted as the list shows them with the item still in its old place,
    /// as a list's move gives it): beside the nearest item on the same computer (each keeps its own
    /// order), else the top of the category. Nil where it can't go (In progress isn't a category:
    /// an item is there while a session works on it; one its source makes Done stays as it says) or
    /// where it wouldn't move.
    public static func place(of item: WorkItem, at index: Int, in section: Section) -> Place? {
        // (An issue's Done is its source's: it's never moved there, nor one its source made Done.)
        guard let category = section.category, canMove(item), item.closesOn == nil || category != WorkCategory.done else { return nil }
        let index = min(max(index, 0), section.items.count)
        // Where it is now, in this list: dropped just above or below itself, it stays.
        if let from = section.items.firstIndex(where: { $0.id == item.id }), index == from || index == from + 1 { return nil }
        let mates = { (other: WorkItem) in other.id != item.id && other.computer?.key == item.computer?.key && canMove(other) }
        if let below = section.items[index...].first(where: mates) { return .before(below) }
        if let above = section.items[..<index].last(where: mates) { return .after(above) }
        return .top(category)
    }

    /// Where an item's menu moves it: the top of its category, a place up and a place down, among
    /// the items there on its computer that can move (nil where it's there already). One in
    /// progress moves only to its category's top: its place among the others there can't be seen.
    public struct MenuPlaces: Hashable, Sendable {
        public var top: Place?
        public var up: Place?
        public var down: Place?

        public init(top: Place? = nil, up: Place? = nil, down: Place? = nil) {
            self.top = top
            self.up = up
            self.down = down
        }
    }

    public static func menuPlaces(of item: WorkItem, in view: WorkQueueView) -> MenuPlaces {
        guard canMove(item) else { return MenuPlaces() }
        let mates = view.items.filter { $0.category == item.category && !isInProgress($0) && $0.computer?.key == item.computer?.key && canMove($0) }
        guard !isInProgress(item), let index = mates.firstIndex(where: { $0.id == item.id }) else {
            return MenuPlaces(top: mates.isEmpty ? nil : .top(item.category))
        }
        return MenuPlaces(top: index > 0 ? .top(item.category) : nil,
                          up: index > 0 ? .before(mates[index - 1]) : nil,
                          down: index + 1 < mates.count ? .after(mates[index + 1]) : nil)
    }

    /// `view` as it will be once `item` is moved to `place`: shown at once, until the box's next
    /// word (which it then is).
    public static func moving(_ item: WorkItem, to place: Place, in view: WorkQueueView) -> WorkQueueView {
        guard view.items.contains(where: { $0.id == item.id }) else { return view }
        var view = view
        var moved = view.items.first { $0.id == item.id } ?? item
        view.items.removeAll { $0.id == item.id }
        moved.category = place.category
        // (Sections take each category's items in the list's order: where among the others it's put
        // is all that counts.)
        switch place {
        case .top: view.items.insert(moved, at: 0)
        case .category: view.items.append(moved)
        case .before(let other): view.items.insert(moved, at: view.items.firstIndex { $0.id == other.id } ?? view.items.endIndex)
        case .after(let other): view.items.insert(moved, at: view.items.firstIndex { $0.id == other.id }.map { $0 + 1 } ?? view.items.endIndex)
        }
        return view
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

    /// What's said over the list when items in it are on a computer that isn't answering: "lab isn't
    /// answering: its items are as it last told them, 2h ago." Nil while every one answers.
    public static func awayNote(_ view: WorkQueueView, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String? {
        let shown = Set(view.items.compactMap(\.computer?.key))
        let away = view.computers.filter { $0.away != nil && shown.contains($0.key) }
        guard let first = away.first else { return nil }
        if away.count == 1 { return "\(first.name) isn’t answering: its items are as it last told them, \(ago(first.date, now: now, calendar: calendar, locale: locale))." }
        let names = away.map(\.name)
        return "\(names.dropLast().joined(separator: ", ")) and \(names.last!) aren’t answering: their items are as they last told them."
    }

    /// The computer an item is on, by name, when it isn't the box the view is from: "lab".
    public static func computerName(of item: WorkItem) -> String? { item.computer?.name }

    /// Whose an item is, by name, when it isn't the view's own owner's (a session a lead oversees,
    /// or the All view's): nil for the view's own.
    public static func ownerName(of item: WorkItem, in view: WorkQueueView) -> String? {
        guard item.owner != view.owner else { return nil }
        return view.owners.first { $0.owner == item.owner }?.name ?? (item.owner.hasPrefix("grp_") ? "Group chat" : "Untitled session")
    }

    /// What the agent said it's doing, when it said something: nil otherwise (the working mark
    /// says a session is at work; the session's title would repeat the item's).
    public static func progressNote(_ item: WorkItem) -> String? {
        guard let note = item.progress?.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty else { return nil }
        return note
    }

    /// The category an item is kept in, by name.
    public static func categoryName(_ id: String, in categories: [WorkCategory]) -> String {
        categories.first { $0.id == id }?.name ?? id.capitalized
    }

    /// Where an item may be moved to from a menu: every category but the one it's in. In progress
    /// isn't one (the box works it out from the sessions at work); nor is Done for an issue or a
    /// pull request, which is Done when it's closed there, and stays so until it's reopened.
    public static func moveTargets(for item: WorkItem, in categories: [WorkCategory]) -> [WorkCategory] {
        guard canMove(item) else { return [] }
        return categories.filter { $0.id != item.category && (item.closesOn == nil || $0.id != WorkCategory.done) }
    }

    /// Whether you can move it at all: not one its source makes Done (an issue closed on GitHub),
    /// which the box says by the category it keeps it in (`keptIn`).
    public static func canMove(_ item: WorkItem) -> Bool { item.keptIn == nil }
}

/// What both apps draw an item's name with, in a list or a chip: the mark of the service its source
/// is (a `BrandMark` id, "github"), and what VoiceOver says for its name.
public extension WorkSource {
    var brand: String? { isGitHub ? "github" : nil }
}

public extension WorkItem {
    var brand: String? { source?.brand }
    /// "GitHub issue app#12", "Work item 243", "New work item".
    var spokenName: String { source.map { "\($0.spokenKind) \($0.shownName)" } ?? number.map { "Work item \($0)" } ?? "New work item" }
    /// Its title struck through: closed without being done there (not planned, or unmerged).
    var isStruck: Bool { struck == true }
    /// Gone from its source (deleted there, or no longer visible): its mark drawn dimmed.
    var isGone: Bool { seen?.gone == true }
}

public extension WorkRef {
    var brand: String? { source?.brand }
    var spokenName: String { source.map { "\($0.spokenKind) \($0.shownName)" } ?? number.map { "Work item \($0)" } ?? "New work item" }
    var isStruck: Bool { struck == true }
    var isGone: Bool { seen?.gone == true }
}
