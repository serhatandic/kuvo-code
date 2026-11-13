#if os(macOS)
import Foundation
import Security

/// A Mac's box's Keychain items, as they go from the app to the box's helper when the box moves to
/// a home of its own, and back (#333 piece 4; KuvoLink's PROTOCOL.md, "This Mac's box: its
/// helper"). The values never change, only who reads them, so the box stays the same box to every
/// phone, machine and peer.
///
/// - The app's keeper (the app's own program, in each original's list) copies each item under the
///   helper's names (`<helper ID>.phone-link`, …), made trusting only the helper (`copy`). The copies
///   are journaled first (`updates/rehome/keychain.json`, in the folder the move keeps and never
///   moves), so whatever stops part way can take them away again.
/// - Only a program an item names may delete it, so taking the copies away again (the move went
///   back, `uncopy`) is the helper's, in a short run of its own.
/// - The originals go only once the move can't go back (`deleteOriginals`, the step the move owes
///   the app's program after it cleared the old place), each once its copy is there.
/// - Moving back, the helper makes the originals again, trusting the app, then takes its own away
///   (`back`): every item it has, those made since the move too.
public struct KeychainMove: Sendable {
    /// The services a box's items are in, after the bundle ID: its link's keys, its integrations'
    /// keys, and its vault.
    public static let services = ["phone-link", "integrations", "vault"]

    /// What's copied, and how far it got.
    public struct Journal: Codable, Equatable, Sendable {
        public enum State: String, Codable, Sendable {
            /// The copies are being made: each listed may be there.
            case copying
            /// All made: the originals stay until the move can't go back.
            case copied
            /// The originals are being taken away (the move can't go back): the copies stay, whatever
            /// asks.
            case settling
            /// The originals are gone: the helper's copies are the box's items.
            case settled
            /// Moving back: the originals are being made again from the helper's.
            case returning
        }

        public var v = 1
        public var state: State
        /// The originals' prefix (the app's bundle ID) and the copies' (the helper's).
        public var app: String
        public var helper: String
        public var items: [Entry]
    }

    /// One item: its service (after the prefix) and account.
    public struct Entry: Codable, Hashable, Sendable {
        public var service: String
        public var account: String
        public var label: String?

        public init(service: String, account: String, label: String? = nil) {
            self.service = service
            self.account = account
            self.label = label
        }

        /// How it's named in `box/keychain.json` and the journal's words: `phone-link/key`.
        public var name: String { "\(service)/\(account)" }
    }

    public enum Failure: LocalizedError, Equatable {
        /// The Keychain wouldn't list or give out an item without asking.
        case refused(String, OSStatus)
        /// An item couldn't be made, or taken away.
        case unchanged(String, OSStatus)
        /// A copy the originals can't go without isn't there.
        case copyMissing(String)
        /// Moving back while the app's own items are still there (their deletion is owed first).
        case originalsRemain(String)
        /// The journal says otherwise (`state`), or there's none.
        case journal(String)
        /// Items under the helper's names that no move of this one's made (left by a box removed or
        /// set aside): never taken for copies of what the app has now.
        case leftovers(String)

        public var errorDescription: String? {
            switch self {
            case .refused(let item, let status): "Your Keychain didn’t give out \(item) (\(status)): unlock your Mac, then try again."
            case .unchanged(let item, let status): "Your Keychain didn’t take the change to \(item) (\(status))."
            case .copyMissing(let item): "The box’s copy of \(item) isn’t in your Keychain, so the app’s stays."
            case .originalsRemain(let item): "Kuvo Code’s own \(item) is still in your Keychain: it goes before the box moves back."
            case .journal(let why): why
            case .leftovers(let item): "Your Keychain already has \(item) for this Mac’s box, from an earlier box: the app’s keys aren’t copied over it."
            }
        }
    }

    let keychain: HostKeychain
    /// The box's home (`~/.kuvo-code`, a test's own).
    let home: URL
    /// The originals' prefix (the app's bundle ID), and the copies' (the helper's).
    let app: String
    let helper: String

    public init(keychain: HostKeychain = HostKeychain(), home: URL, app: String, helper: String) {
        precondition(app != helper, "the copies are named apart from the originals")
        self.keychain = keychain
        self.home = home
        self.app = app
        self.helper = helper
    }

    /// The journal, in the folder the move keeps (`updates/rehome`), made first and never moved.
    public var journalFile: URL { home.appending(path: "updates/rehome/keychain.json") }

    public func journal() throws -> Journal? {
        guard let data = try? Data(contentsOf: journalFile) else { return nil }
        do {
            return try JSONDecoder().decode(Journal.self, from: data)
        } catch {
            throw Failure.journal("The box’s Keychain journal can’t be read: \(error.localizedDescription)")
        }
    }

    /// Written whole and to the disk before anything it says is done.
    func write(_ journal: Journal) throws {
        try PrivateFile.write(try JSONEncoder().encode(journal), to: journalFile)
    }

    private func forgetJournal() throws {
        do {
            try FileManager.default.removeItem(at: journalFile)
        } catch CocoaError.fileNoSuchFile {}
    }

    /// The app's keeper's: every original copied under the helper's names, trusting only the helper
    /// (`trusting`: the helper's bundle the app carries; the copy installed in the box's `bin` has
    /// the same signature, which is what the list goes by). Journaled before any is made. It never
    /// takes an item already under the helper's names for a copy of what the app has now (it can't
    /// read one to tell): one left by an earlier box refuses it, and so does any journal left by an
    /// earlier try, however far it got (`copying` or `copied`: the helper's `uncopy` first, then
    /// copy afresh). Says how many there are.
    @discardableResult
    public func copy(trusting helperBundle: URL) throws -> Int {
        let earlier = try journal()
        switch earlier?.state {
        case .settled?, .settling?: return earlier?.items.count ?? 0
        case .copying?, .copied?: throw Failure.journal("An earlier try’s copies of the app’s keys are still there: they’re taken away first.")
        case .returning?: throw Failure.journal("The box is moving back: its keys aren’t copied again until that’s done.")
        case nil: break
        }
        // (Locked, it would ask you to unlock it: the move waits instead.)
        guard !keychain.isLocked else { throw Failure.refused(app, errSecInteractionNotAllowed) }
        var entries: [Entry] = []
        for service in Self.services {
            guard let items = keychain.items("\(app).\(service)") else { throw Failure.refused("\(app).\(service)", errSecInteractionNotAllowed) }
            entries += items.map { Entry(service: service, account: $0.account, label: $0.label) }
            guard let there = keychain.items("\(helper).\(service)") else { throw Failure.refused("\(helper).\(service)", errSecInteractionNotAllowed) }
            if let stray = there.first { throw Failure.leftovers("\(service)/\(stray.account)") }
        }
        // Each one it will make, listed before any is: whatever stops part way takes them all away.
        try write(Journal(state: .copying, app: app, helper: helper, items: entries))
        for entry in entries {
            let data: Data
            switch keychain.read("\(app).\(entry.service)", entry.account) {
            case .found(let found): data = found
            // (Gone meanwhile: nothing to copy.)
            case .missing: continue
            case .refused(let status): throw Failure.refused(entry.name, status)
            }
            let status = keychain.add("\(helper).\(entry.service)", entry.account, data, label: entry.label, trusting: [helperBundle])
            guard status == errSecSuccess else { throw status == errSecDuplicateItem ? Failure.leftovers(entry.name) : Failure.unchanged(entry.name, status) }
        }
        try write(Journal(state: .copied, app: app, helper: helper, items: entries))
        return entries.count
    }

    /// The helper's (the copies trust it alone, and only a program an item trusts may delete it):
    /// each journaled copy taken away, then the journal, after a move that went back before it
    /// cleared the old place. The originals are never touched, and a copy goes only while its
    /// original is there: one whose original is gone is the box's only one, and stays.
    public func uncopy() throws {
        guard let journal = try journal() else { return }
        guard journal.state == .copying || journal.state == .copied else {
            throw Failure.journal("The box’s keys were moved already: its copies stay.")
        }
        for entry in journal.items {
            guard keychain.exists("\(helper).\(entry.service)", entry.account) == true else { continue }
            switch keychain.exists("\(app).\(entry.service)", entry.account) {
            case true?: break
            case false?: throw Failure.journal("Kuvo Code’s own \(entry.name) is gone from your Keychain, so the box’s copy, now its only one, stays.")
            case nil: throw Failure.refused(entry.name, errSecInteractionNotAllowed)
            }
            let status = keychain.delete("\(helper).\(entry.service)", entry.account)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.unchanged(entry.name, status) }
        }
        try forgetJournal()
    }

    /// The helper's, as the move checks it: the journaled copies it can't read (none: all well).
    public func unreadable() throws -> [String] {
        guard let journal = try journal(), [.copied, .settling, .settled].contains(journal.state) else {
            throw Failure.journal("There are no copies of the box’s keys to check.")
        }
        return journal.items.filter { keychain.read("\(helper).\($0.service)", $0.account).data == nil }.map(\.name)
    }

    /// The app's keeper's, owed once the move cleared the old place: each original taken away,
    /// once its copy is there, so an older Kuvo Code can't find them and run a second box as this
    /// one. Said in the journal before the first goes (`settling`, which nothing undoes); gone
    /// already, it's done.
    public func deleteOriginals() throws {
        guard var journal = try journal() else { throw Failure.journal("There are no copies of the box’s keys, so the app’s stay.") }
        if journal.state == .settled { return }
        guard journal.state == .copied || journal.state == .settling else { throw Failure.journal("The box’s keys weren’t all copied, so the app’s stay.") }
        guard !keychain.isLocked else { throw Failure.refused(app, errSecInteractionNotAllowed) }
        for entry in journal.items {
            // (One gone since it was copied, with its original, is gone.)
            let original = keychain.exists("\(app).\(entry.service)", entry.account)
            guard original != false else { continue }
            guard keychain.exists("\(helper).\(entry.service)", entry.account) == true else { throw Failure.copyMissing(entry.name) }
        }
        journal.state = .settling
        try write(journal)
        for entry in journal.items {
            let status = keychain.delete("\(app).\(entry.service)", entry.account)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.unchanged(entry.name, status) }
        }
        journal.state = .settled
        try write(journal)
    }

    /// The helper's, before it goes as the box moves back: every item it has (made since the move
    /// too) made again under the app's names, trusting the app at `appBundle`, then its own taken
    /// away, and the journal with them. The app's own still there (their deletion still owed) stop
    /// it: it changes nothing then.
    public func back(trusting appBundle: URL) throws {
        var entries: [Entry] = []
        for service in Self.services {
            guard let items = keychain.items("\(helper).\(service)") else { throw Failure.refused("\(helper).\(service)", errSecInteractionNotAllowed) }
            entries += items.map { Entry(service: service, account: $0.account, label: $0.label) }
        }
        let journaled = (try journal())?.items ?? []
        if (try journal())?.state != .returning {
            for entry in entries where keychain.exists("\(app).\(entry.service)", entry.account) != false {
                throw Failure.originalsRemain(entry.name)
            }
        }
        // Listed before any is made, with those the move copied: a stop part way finishes forward.
        let listed = journaled + entries.filter { !journaled.contains($0) }
        try write(Journal(state: .returning, app: app, helper: helper, items: listed))
        for entry in entries {
            let data: Data
            switch keychain.read("\(helper).\(entry.service)", entry.account) {
            case .found(let found): data = found
            case .missing: continue
            case .refused(let status): throw Failure.refused(entry.name, status)
            }
            let status = keychain.add("\(app).\(entry.service)", entry.account, data, label: entry.label, trusting: [appBundle])
            // (Made before it stopped part way.)
            guard status == errSecSuccess || status == errSecDuplicateItem else { throw Failure.unchanged(entry.name, status) }
        }
        for entry in entries {
            let status = keychain.delete("\(helper).\(entry.service)", entry.account)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.unchanged(entry.name, status) }
        }
        try forgetJournal()
    }
}
#endif
