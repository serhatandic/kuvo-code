import Foundation

/// A repository's branch backups, which its box takes as each agent turn starts and ends, and
/// taking one back, which never moves a branch you have (KuvoLink's PROTOCOL.md, "Branch
/// backups"). Read and taken back through the box the folder is on, as a phone does.
@Observable final class BranchBackups {
    /// The backups of the repository a folder is in (or was in, once its `.git` is gone).
    struct Listing: Decodable, Equatable {
        /// Its top folder; nil where none was ever backed up.
        var repository: String?
        /// False once its `.git` is gone: taking one back makes it again.
        var exists: Bool
        /// Newest first.
        var backups: [Backup]
    }

    struct Backup: Decodable, Equatable, Identifiable {
        var id: String
        /// Milliseconds since 1970.
        var at: Double
        /// The branch checked out then; "" for none.
        var head: String
        var branches: Int
        var stashes: Int
        /// Its branches deleted since, which come back under their names.
        var gone: [String]
        /// Its branches somewhere else now, which come back beside them.
        var moved: [String]
        /// Its stashes no longer on the list.
        var stashesGone: Int

        var date: Date { Date(timeIntervalSince1970: at / 1000) }
    }

    /// What taking one back did.
    struct Restored: Decodable, Equatable {
        struct Branch: Decodable, Equatable {
            /// "" for a checkout on no branch.
            var name: String
            /// The name it came back under.
            var `as`: String
        }
        /// The repository was made again (its `.git` was gone).
        var remade: Bool
        var branches: [Branch]
        var stashes: Int
        /// What didn't come back, in words.
        var missed: [String]?
    }

    enum Shown: Equatable {
        case loading
        case failed(String)
        case listed(Listing)
    }

    enum Outcome: Equatable {
        /// What came back, in words, and what didn't.
        case restored(String, missed: [String])
        case failed(String)
    }

    let box: BoxClient
    /// The folder as its box names it (on a machine, the path there).
    let folder: String
    private(set) var shown: Shown = .loading
    /// The backup being taken back.
    private(set) var restoring: String?
    /// What the last Take Back did.
    private(set) var outcome: Outcome?

    init(box: BoxClient, folder: String) {
        self.box = box
        self.folder = folder
    }

    /// Reads the list again; one already shown stays while it's read.
    func load() async {
        if case .listed = shown {} else { shown = .loading }
        do {
            shown = .listed(try await box.value(Listing.self, "GET", "kuvo/git/backups?folder=\(Workspace.queryValue(folder))"))
        } catch let refusal as BoxRefusal where refusal.status == 404 {
            // A box from before backups.
            shown = .failed("This computer’s Kuvo Code doesn’t keep branch backups yet. Update it, then try again.")
        } catch let refusal as BoxRefusal where refusal.status == 400 {
            shown = .failed("The folder isn’t there any more.")
        } catch {
            shown = .failed(error.localizedDescription)
        }
    }

    /// Takes `backup` back, then reads the list again (what each would bring back has changed).
    func takeBack(_ backup: Backup) async {
        guard restoring == nil else { return }
        restoring = backup.id
        outcome = nil
        struct Asked: Encodable { let folder, id: String }
        do {
            let restored = try await box.value(Restored.self, "POST", "kuvo/git/backups/restore", body: Asked(folder: folder, id: backup.id))
            outcome = .restored(Self.sentence(for: restored), missed: restored.missed ?? [])
        } catch {
            outcome = .failed(error.localizedDescription)
        }
        restoring = nil
        await load()
    }

    // MARK: Words

    /// Whether taking it back would bring anything back now.
    static func bringsBack(_ backup: Backup, exists: Bool) -> Bool {
        !exists || !backup.gone.isEmpty || !backup.moved.isEmpty || backup.stashesGone > 0
    }

    /// When it was taken: "Today, 14:32", "Yesterday, 09:05", "Monday, 18:10", "28 Oct, 11:00".
    static func when(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        let locale = calendar.locale ?? .autoupdatingCurrent
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone))
        let day: String
        if calendar.isDate(date, inSameDayAs: now) {
            day = "Today"
        } else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            day = "Yesterday"
        } else if let weekAgo = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now)), date >= weekAgo, date < now {
            day = date.formatted(Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).weekday(.wide))
        } else {
            var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).day().month(.abbreviated)
            if calendar.component(.year, from: date) != calendar.component(.year, from: now) { style = style.year() }
            day = date.formatted(style)
        }
        return "\(day), \(time)"
    }

    /// What taking it back would bring back now, in parts; `warns` for branches deleted since.
    /// `shortened`: long branch names cut in the middle, so the rest of the line still shows.
    static func detail(_ backup: Backup, exists: Bool, shortened: Bool = false) -> [(text: String, warns: Bool)] {
        // Its `.git` gone: all of it comes back, which the sheet says above the list.
        guard exists else { return [(counts(backup), false)] }
        let shown: ([String]) -> [String] = { shortened ? $0.map(Self.shortened) : $0 }
        var parts: [(text: String, warns: Bool)] = []
        if !backup.gone.isEmpty { parts.append(("\(names(shown(backup.gone))) deleted since", true)) }
        if !backup.moved.isEmpty { parts.append(("\(names(shown(backup.moved))) moved", false)) }
        if backup.stashesGone > 0 { parts.append(("\(backup.stashesGone) \(backup.stashesGone == 1 ? "stash" : "stashes") gone", false)) }
        if parts.isEmpty { parts = [(counts(backup), false), ("nothing to bring back", false)] }
        return parts
    }

    /// The detail as one line.
    static func detailLine(_ backup: Backup, exists: Bool) -> String {
        detail(backup, exists: exists).map(\.text).joined(separator: " · ")
    }

    /// "6 branches, 2 stashes".
    private static func counts(_ backup: Backup) -> String {
        let branches = "\(backup.branches) \(backup.branches == 1 ? "branch" : "branches")"
        guard backup.stashes > 0 else { return branches }
        return "\(branches), \(backup.stashes) \(backup.stashes == 1 ? "stash" : "stashes")"
    }

    /// A branch's name, cut in the middle past 30 characters: "feature/search-r…-longer-name".
    static func shortened(_ name: String) -> String {
        guard name.count > 30 else { return name }
        return String(name.prefix(16)) + "…" + String(name.suffix(12))
    }

    /// "a", "a and b", "a, b and 3 more".
    private static func names(_ list: [String]) -> String {
        switch list.count {
        case 0: ""
        case 1: list[0]
        case 2: "\(list[0]) and \(list[1])"
        default: "\(list[0]), \(list[1]) and \(list.count - 2) more"
        }
    }

    /// What came back, in plain words.
    static func sentence(for restored: Restored) -> String {
        var said: [String] = []
        if restored.remade { said.append("The repository is back, around your files as they are.") }
        let back = restored.branches.filter { !$0.name.isEmpty && $0.name == $0.as }.map(\.name)
        if !back.isEmpty { said.append("\(names(back)) \(back.count == 1 ? "is" : "are") back.") }
        let beside = restored.branches.filter { !$0.name.isEmpty && $0.name != $0.as }
        if beside.count == 1, let branch = beside.first {
            said.append("\(branch.name)’s earlier place is on \(branch.as), so you can reset to it.")
        } else if beside.count > 1 {
            said.append("\(names(beside.map(\.name))) are elsewhere now; their earlier places are on \(names(beside.map(\.as))), so you can reset to them.")
        }
        for detached in restored.branches where detached.name.isEmpty {
            said.append("The checkout on no branch is on \(detached.as).")
        }
        if restored.stashes == 1 {
            said.append("1 stash is back on the list.")
        } else if restored.stashes > 1 {
            said.append("\(restored.stashes) stashes are back on the list.")
        }
        return said.isEmpty ? "Nothing needed bringing back." : said.joined(separator: " ")
    }
}
