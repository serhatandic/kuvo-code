import Foundation

// What both apps show of one item, worked out the same way: its status (said once: In progress
// while a session is at work on it, never with the category it's kept in), its properties line, the
// card of the sessions on it, its activity (notes and what the box keeps of its history, oldest
// first), and a row's eyebrow. Clients only draw these.

public extension WorkQueue {
    /// Where an item stands, when that's a state rather than its category: shown as the page's
    /// pill. Nil while it's simply kept in a category, which its properties say.
    enum Status: Hashable, Sendable {
        case inProgress
        case deleted

        public var words: String {
            switch self {
            case .inProgress: "In progress"
            case .deleted: "Deleted"
            }
        }

        /// The pill's tip.
        public var help: String {
            switch self {
            case .inProgress: "A session is at work on it."
            case .deleted: "Kept for 30 days: Restore brings it back."
            }
        }
    }

    /// In progress while a session is at work on it, Deleted once it's deleted; else nil.
    static func status(of item: WorkItem) -> Status? {
        if item.removed != nil { return .deleted }
        if isInProgress(item) { return .inProgress }
        return nil
    }

    /// One fact on an item's properties line.
    struct Property: Hashable, Sendable, Identifiable {
        public enum Kind: Hashable, Sendable {
            /// The category it's kept in (its id), only while no session is at work on it.
            case category(String)
            /// Whose queue it's in (the owner's address, for its face).
            case owner(String)
            /// The other computer it's on.
            case computer
            /// On its way to a conversation on another computer.
            case handing
            /// When it was added.
            case added
        }

        public var kind: Kind
        public var words: String
        /// More, for its tip.
        public var help: String?
        public var id: Kind { kind }
    }

    /// An item's properties, on one line under its title: the category it's kept in ("In Next",
    /// "Done", "Merged on GitHub"), only when no session is at work on it and it isn't deleted (its
    /// status says those, once); whose queue it's in; the computer it's on, when that's another;
    /// where it's being handed; and when it was added. Whose queue only where the view names its
    /// owner (a page opened from a chip may have no list read yet).
    static func properties(of item: WorkItem, in view: WorkQueueView, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> [Property] {
        var properties: [Property] = []
        if status(of: item) == nil {
            if let kept = item.keptIn {
                let merged = item.seen?.state == "merged"
                properties.append(Property(kind: .category(item.category), words: merged ? "Merged on GitHub" : "Closed on GitHub",
                                           help: "If it’s reopened there, it’s back in \(categoryName(kept, in: view.categories))."))
            } else if item.isDone {
                properties.append(Property(kind: .category(item.category), words: "Done", help: item.doneAt.map { "Done \(ago(Date(timeIntervalSince1970: $0 / 1000), now: now, calendar: calendar, locale: locale))" }))
            } else {
                properties.append(Property(kind: .category(item.category), words: "In \(categoryName(item.category, in: view.categories))", help: nil))
            }
        }
        if let owner = ownerWords(item.owner, in: view) {
            properties.append(Property(kind: .owner(item.owner), words: "\(owner)’s queue", help: nil))
        }
        if let computer = computerName(of: item) {
            properties.append(Property(kind: .computer, words: "On \(computer)", help: "Kept on \(computer): changes to it are made there."))
        }
        if let handing = item.handing {
            properties.append(Property(kind: .handing, words: "Handing to \(handing.name.isEmpty ? "another computer" : handing.name)", help: "It stays as it is until it’s there."))
        }
        let added = ago(item.created.date, now: now, calendar: calendar, locale: locale)
        properties.append(Property(kind: .added, words: "Added \(added)",
                                   help: "Added \(added) by \(item.created.by.words). \(updated(item.updated.date, now: now, calendar: calendar, locale: locale)) by \(item.updated.by.words)."))
        return properties
    }

    /// Of the views a client has read, the one to name an item's owner and history by (an item's
    /// page opened from a chip has no list of its own): All, when it has the item, else the first
    /// that names its owner, else any that has it.
    static func view(naming item: WorkItem, among views: [WorkQueueView]) -> WorkQueueView? {
        let having = views.filter { $0.items.contains { $0.id == item.id } || $0.removed.contains { $0.id == item.id } }
        return having.first { $0.owner == WorkQueueView.all } ?? having.first { view in view.owners.contains { $0.owner == item.owner } } ?? having.first
    }

    /// An owner by name, whoever's view it is: the bot's name, the session's title, or the group
    /// chat; nil for a session the view doesn't name.
    static func ownerWords(_ owner: String, in view: WorkQueueView) -> String? {
        view.owners.first { $0.owner == owner }?.name ?? (owner.hasPrefix("grp_") ? "Group chat" : nil)
    }

    // MARK: The sessions on it

    /// The card of the sessions on an item: whether one is at work, its heading, the sessions (at
    /// work first), and what the agent said it's doing and how far.
    struct SessionCard: Hashable, Sendable {
        public var working: Bool
        /// "Session at work", "2 sessions at work", "No session at work".
        public var heading: String
        public var sessions: [WorkItemSession]
        /// The one its Open Session is the page's filled button for: the session at work (the
        /// first, of several); none while none works.
        public var main: String?
        public var note: String?
        public var progress: Double?
    }

    /// The card, for an item with a session linked or progress said; nil for one with neither, or
    /// deleted.
    static func sessionCard(for item: WorkItem) -> SessionCard? {
        guard item.removed == nil, !item.sessions.isEmpty || item.progress != nil else { return nil }
        let atWork = item.sessions.filter(\.working).count
        let heading = atWork == 0 ? "No session at work" : atWork == 1 ? "Session at work" : "\(atWork) sessions at work"
        let sessions = item.sessions.filter(\.working) + item.sessions.filter { !$0.working }
        return SessionCard(working: atWork > 0, heading: heading, sessions: sessions, main: sessions.first(where: \.working)?.session, note: progressNote(item), progress: item.progress?.value)
    }

    /// A session's name in the card: its title, as its starter gave it.
    static func sessionName(_ session: WorkItemSession) -> String {
        session.title.isEmpty ? "Untitled session" : session.title
    }

    /// The session a row's Open Session opens: the one at work, else the first linked; nil for an
    /// item no session is linked to, or one that's deleted.
    static func sessionToOpen(_ item: WorkItem) -> WorkItemSession? {
        guard item.removed == nil else { return nil }
        return item.sessions.first(where: \.working) ?? item.sessions.first
    }

    // MARK: Activity

    /// One line of an item's activity: who did what, when, and a note's words.
    struct Activity: Hashable, Sendable, Identifiable {
        public enum Kind: Hashable, Sendable {
            case added
            /// A session started work on it.
            case started
            case note
            case handed
            /// A session stopped work on it.
            case stopped
            /// Moved to another category, or within its own.
            case moved
            case done
            case deleted

            // Which goes first of lines at one moment: work started, then what was said, then the
            // rest (a change that starts work and leaves a note, or leaves one and marks it done,
            // reads in that order).
            var rank: Int {
                switch self {
                case .added: 0
                case .started: 1
                case .note: 2
                case .handed: 3
                case .stopped, .moved, .done: 4
                case .deleted: 5
                }
            }
        }

        public var id: String
        public var kind: Kind
        /// Who did it, when the box kept that.
        public var who: WorkWho?
        /// "You", "Kuvo Foreman", "Sign-in": who, as the line starts.
        public var whoWords: String
        /// "added the item", "started work", "left a note", "handed it to Sign-in", "moved it to the
        /// top of Next", "stopped work", "marked it done", "deleted it".
        public var what: String
        public var text: String?
        public var at: Double
        public var date: Date { Date(timeIntervalSince1970: at / 1000) }
    }

    /// An item's activity, oldest first: who added it, its notes and what the box kept of what
    /// happened to it (work started and stopped, moves, done), its hand-offs, and when it was
    /// deleted. Of lines at one moment, work started goes first, then notes, then the rest.
    static func activity(of detail: WorkItemDetail, in view: WorkQueueView) -> [Activity] {
        let item = detail.item
        var lines: [Activity] = []
        lines.append(Activity(id: "added", kind: .added, who: item.created.by, whoWords: capitalized(item.created.by.words), what: "added the item", at: item.created.at))
        for (index, note) in detail.notes.enumerated() {
            lines.append(Activity(id: "note-\(index)", kind: .note, who: note.by, whoWords: capitalized(note.by.words), what: "left a note", text: note.text, at: note.at))
        }
        for (index, handed) in detail.handed.enumerated() {
            lines.append(Activity(id: "handed-\(index)", kind: .handed, who: nil, whoWords: ownerWords(handed.from, in: view) ?? "A conversation", what: "handed it to \(ownerWords(handed.to, in: view) ?? "another conversation")", at: handed.at))
        }
        for (index, event) in detail.events.enumerated() {
            guard let (kind, what) = eventWords(event, in: view) else { continue }
            lines.append(Activity(id: "event-\(index)", kind: kind, who: event.by, whoWords: capitalized(event.by.words), what: what, at: event.at))
        }
        // (Done, from an item whose box kept no word of it: from when it was done.)
        if item.isDone, item.keptIn == nil, !detail.events.contains(where: { $0.kind == "done" }), let doneAt = item.doneAt {
            // (Who marked it done is kept only as its last change, when that's the same moment.)
            let by = abs(item.updated.at - doneAt) < 1000 ? item.updated.by : nil
            lines.append(Activity(id: "done", kind: .done, who: by, whoWords: by.map { capitalized($0.words) } ?? "", what: by == nil ? "Marked done" : "marked it done", at: doneAt))
        }
        if let removed = item.removed {
            lines.append(Activity(id: "deleted", kind: .deleted, who: removed.by, whoWords: capitalized(removed.by.words), what: "deleted it", at: removed.at))
        }
        // (Oldest first; at one moment, by kind, then in the order above.)
        return lines.enumerated().sorted { a, b in
            if a.element.at != b.element.at { return a.element.at < b.element.at }
            if a.element.kind.rank != b.element.kind.rank { return a.element.kind.rank < b.element.kind.rank }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// What an event says it did ("started work", "moved it to the top of Next"), and its kind; nil
    /// for a kind this client doesn't know (a newer box's).
    private static func eventWords(_ event: WorkEvent, in view: WorkQueueView) -> (Activity.Kind, String)? {
        switch event.kind {
        case "started": return (.started, "started work")
        case "stopped": return (.stopped, "stopped work")
        case "done": return (.done, "marked it done")
        case "moved":
            guard let to = event.to else { return nil }
            let name = categoryName(to, in: view.categories)
            if event.top { return (.moved, "moved it to the top of \(name)") }
            return (.moved, event.from == to ? "moved it within \(name)" : "moved it to \(name)")
        default: return nil
        }
    }

    private static func capitalized(_ words: String) -> String {
        words.prefix(1).uppercased() + words.dropFirst()
    }

    // MARK: A row

    /// What follows a row's name on its eyebrow, when it isn't the view's own: whose it is, the
    /// computer it's on, and where it's being handed ("Kuvo Foreman", "on lab", "handing to Wren").
    static func eyebrow(of item: WorkItem, in view: WorkQueueView) -> [String] {
        var parts: [String] = []
        if let owner = ownerName(of: item, in: view) { parts.append(owner) }
        if let computer = computerName(of: item) { parts.append("on \(computer)") }
        if let handing = item.handing { parts.append("handing to \(handing.name.isEmpty ? "another computer" : handing.name)") }
        return parts
    }

    /// What VoiceOver reads for a row, its title first, as a list's rows say theirs: "Fix the
    /// sign-in, Work item 551, in progress, Writing the tests, Kuvo Foreman, on lab, updated 12m ago".
    static func spokenRow(_ item: WorkItem, in view: WorkQueueView, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        var parts = [item.title, item.spokenName]
        if item.isDone { parts.append("done") } else if isInProgress(item) { parts.append("in progress") }
        if isInProgress(item), let note = progressNote(item) { parts.append(note) }
        parts += eyebrow(of: item, in: view)
        parts.append(updated(item.updated.date, now: now, calendar: calendar, locale: locale).lowercased())
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// A row's time, short: "now", "8m", "3h", "2d", then "Oct 25".
    static func shortAgo(_ date: Date, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d" }
        return date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).month(.abbreviated).day())
    }
}
