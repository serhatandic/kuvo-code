import Foundation
import OpenCodeKit

extension AppModel {
    /// Each computer signs in to integrations (Notion, Linear…) on its own, in its own tab in
    /// Settings. A new machine starts with this Mac's accounts (API keys, GitHub Copilot's
    /// sign-in), once (`MachineEngine.seededNow`), and with its integrations' sign-ins that don't
    /// renew themselves; never one that does, as two computers renewing it end it on the other.
    /// After that, only a copy of the same account on both (made before) stays one sign-in, the
    /// newer one winning (a service may hand out a new refresh token each time it's used, and the
    /// other copy then stops working), and the older copy goes, so they don't pile up. A machine's
    /// sign-in to another account, or none, is its own. Sign-outs it hasn't taken yet (from before
    /// computers kept their own) go first.
    ///
    /// Once after another with each machine (two at once would each copy the same sign-in), and
    /// each to its end: what it changes is a change that asks for it again, and cut off halfway it
    /// would leave the older copy behind.
    func syncSignIns(with engine: MachineEngine) async {
        let previous = engine.signInTurn
        let turn = Task { [weak self, weak engine] in
            await previous?.value
            guard let self, let engine else { return }
            await self.copySignIns(with: engine)
        }
        engine.signInTurn = turn
        await turn.value
    }

    private func copySignIns(with engine: MachineEngine) async {
        // Another Mac's engine there is used as it is, with that Mac's accounts: this Mac's don't
        // go in (they'd stay when you remove the machine, which leaves that engine running).
        guard let mac = api, let remote = engine.api, !engine.isAnotherMacsEngine else { return }
        // A machine that started with this Mac's settings just now gets its accounts too, once.
        let accounts = engine.seededNow
        engine.seededNow = false
        await copySignIns(mac: mac, remote: remote, machine: engine.machine.id, accounts: accounts)
    }

    /// One sync between this Mac's engine (`mac`) and `machine`'s (`remote`): integrations'
    /// sign-ins, and, for a machine that's new, `accounts` too.
    func copySignIns(mac: OpenCodeAPI, remote: OpenCodeAPI, machine: String, accounts copyingAccounts: Bool = false) async {
        await signOutWhileAway(machine, mac: mac, api: remote)
        async let macServers = mac.mcpServers()
        async let remoteServers = remote.mcpServers()
        async let macEntries = mac.credentialEntries()
        async let remoteEntries = remote.credentialEntries()
        guard let here = try? await macServers, let there = try? await remoteServers,
              let ours = try? await macEntries, let theirs = try? await remoteEntries else { return }
        for server in here {
            guard let local = server.integrationID, let match = there.first(where: { $0.name == server.name }), let far = match.integrationID,
                  let mine = ours.first(where: { $0.integrationID == local && $0.active && $0.isOAuth }) else { continue }
            let yours = theirs.first { $0.integrationID == far && $0.active && $0.isOAuth }
            // The machine's own (another account, or none: it signs in there); a new one starts
            // with one that doesn't renew itself.
            guard yours.map({ Self.isSameAccount(mine, $0, copy: Self.copy(on: machine, of: far), byLabel: true) }) == true
                || (copyingAccounts && !Self.renewsItself(mine)) else { continue }
            switch await exchange(mine, yours, here: local, there: far, mac: mac, remote: remote, machine: machine, ours: ours) {
            case true?: await reconnect(match.name, api: remote, machine: machine)
            case false?: await reconnect(server.name, api: mac, machine: nil)
            case nil: break
            }
        }
        // Accounts, each the one in use here: keys, and sign-ins that stay the same. (Integrations
        // the catalog names as an account's, not a server's.)
        let integrations = catalog.integrations.isEmpty ? ((try? await mac.integrations()) ?? []) : catalog.integrations
        let accounts = Set(integrations.filter { !$0.isMCP }.map(\.id))
        await removeRenewingCopies(ours: ours, theirs: theirs, accounts: accounts, mac: mac, remote: remote, machine: machine)
        guard copyingAccounts else { return }
        for mine in ours where mine.active && accounts.contains(mine.integrationID) && !Self.renewsItself(mine) {
            let yours = theirs.first { $0.integrationID == mine.integrationID && $0.active }
            // The machine signed in on its own (a ChatGPT sign-in where this Mac has a key): its own
            // stays, neither replaced by this Mac's nor shared back.
            if let yours, Self.renewsItself(yours) { continue }
            // Two of your accounts with one label here (two GitLab accounts on one host): the label
            // can't say which the machine's copy is of.
            let byLabel = ours.filter { $0.integrationID == mine.integrationID && $0.label == mine.label }.count == 1
            await exchange(mine, yours, here: mine.integrationID, there: mine.integrationID, mac: mac, remote: remote, machine: machine, ours: ours, byLabel: byLabel)
        }
    }

    /// Puts this Mac's sign-in or key on the machine, in place of the one there, unless that's the
    /// same, or the machine's is the newer of the two (it renewed it), which comes back here
    /// instead: true if the machine's changed, false if this Mac's did. For another account than
    /// the machine's (one you switched to here), or another key, this Mac's.
    @discardableResult
    private func exchange(_ mine: CredentialEntry, _ yours: CredentialEntry?, here local: String, there far: String,
                          mac: OpenCodeAPI, remote: OpenCodeAPI, machine: String, ours: [CredentialEntry], byLabel: Bool = true) async -> Bool? {
        let copy = Self.copy(on: machine, of: far)
        if let yours, Self.isSameAccount(mine, yours, copy: copy, byLabel: byLabel) {
            // Each side renews its own sign-in with the same refresh token: only a new one (from a
            // service that hands out a new one each time) has to go to the other.
            if Self.lasting(mine) == Self.lasting(yours) {
                if copy != Copy(mac: mine.id, machine: yours.id) { Self.noteCopy(Copy(mac: mine.id, machine: yours.id), on: machine, of: far) }
                return nil
            }
            // Back to this Mac only when it's known to be this account's (its ID, or the copy made
            // of it): a label shared by two accounts could bring back the other one.
            let known: Bool
            if let a = Self.accountID(mine), let b = Self.accountID(yours) {
                known = a == b
            } else if let copy {
                known = copy == Copy(mac: mine.id, machine: yours.id)
            } else {
                // No copy noted yet (made before it was): the label, when it names one account here.
                known = byLabel && mine.label == yours.label
            }
            if known, yours.expires > mine.expires {
                // Back to this Mac, and from it to the other machines.
                guard (try? await mac.storeCredential(yours, for: local)) != nil else { return nil }
                try? await mac.removeCredential(mine.id)
                let stored = await Self.entry(like: yours, for: local, in: mac)
                Self.noteCopy(stored.map { Copy(mac: $0.id, machine: yours.id) }, on: machine, of: far)
                return false
            }
        }
        // Another account of yours is in use here now: what the machine renewed of the one before
        // goes back to that one here (not in use), so switching back finds it signed in.
        if let yours, let copy, copy.machine == yours.id, copy.mac != mine.id, let before = ours.first(where: { $0.id == copy.mac }),
           Self.lasting(before) != Self.lasting(yours), yours.expires > before.expires {
            if (try? await mac.storeCredential(yours, for: local, activate: false)) != nil { try? await mac.removeCredential(before.id) }
        }
        guard (try? await remote.storeCredential(mine, for: far)) != nil else { return nil }
        if let yours { try? await remote.removeCredential(yours.id) }
        let stored = await Self.entry(like: mine, for: far, in: remote)
        Self.noteCopy(stored.map { Copy(mac: mine.id, machine: $0.id) }, on: machine, of: far)
        return true
    }

    /// A sign-in that gets a new refresh token each time it's renewed (ChatGPT's, GitLab's…), the
    /// old one then refused. Two engines can't share one: whichever renews second (a machine whose
    /// bots ran while it was apart from this Mac) is refused, and the service may end the sign-in
    /// everywhere. Each machine signs in to these on its own. GitHub Copilot's keeps its token.
    static func renewsItself(_ entry: CredentialEntry) -> Bool {
        guard entry.value["refresh"]?.string?.isEmpty == false else { return false }
        return !["github-copilot"].contains(entry.integrationID)
    }

    /// Takes off a machine the copies this Mac made there of its sign-ins that renew themselves
    /// (before they were kept apart): the copy noted, or one with this Mac's very refresh token.
    /// One the machine renewed while apart comes back here first, as this Mac's is refused now.
    /// One the machine signed in to on its own stays.
    private func removeRenewingCopies(ours: [CredentialEntry], theirs: [CredentialEntry], accounts: Set<String>, mac: OpenCodeAPI, remote: OpenCodeAPI, machine: String) async {
        for integration in accounts {
            let mine = ours.filter { $0.integrationID == integration && Self.renewsItself($0) }
            let copy = Self.copy(on: machine, of: integration)
            guard !mine.isEmpty || copy != nil else { continue }
            let copies = theirs.filter { yours in
                yours.integrationID == integration && Self.renewsItself(yours)
                    && (yours.id == copy?.machine || mine.contains { Self.lasting($0) == Self.lasting(yours) })
            }
            var removed = true
            // At most one comes back: this Mac's is gone once it has.
            var broughtBack = false
            for yours in copies {
                if !broughtBack, let here = mine.first(where: \.active) ?? mine.first, Self.lasting(here) != Self.lasting(yours), yours.expires > here.expires,
                   Self.accountID(here).map({ $0 == Self.accountID(yours) }) ?? (copy == Copy(mac: here.id, machine: yours.id)) {
                    guard (try? await mac.storeCredential(yours, for: integration, activate: here.active)) != nil else { removed = false; continue }
                    try? await mac.removeCredential(here.id)
                    broughtBack = true
                }
                if (try? await remote.removeCredential(yours.id)) == nil { removed = false }
            }
            // Noted while there was a copy to note: a key copied since keeps its note.
            if removed, copy != nil, !ours.contains(where: { $0.integrationID == integration && $0.active && !Self.renewsItself($0) }) {
                Self.noteCopy(nil, on: machine, of: integration)
            }
        }
    }

    /// The sign-in `api` keeps for `integration` that is `entry` (or a copy of it), as stored.
    private static func entry(like entry: CredentialEntry, for integration: String, in api: OpenCodeAPI) async -> CredentialEntry? {
        (try? await api.credentialEntries())?.first { $0.integrationID == integration && lasting($0) == lasting(entry) }
    }

    /// What stays the same while a sign-in renews itself: its refresh token, or a key (or the
    /// whole of something else).
    private static func lasting(_ entry: CredentialEntry) -> JSONValue? {
        entry.value["refresh"] ?? entry.value["key"] ?? entry.value
    }

    /// Copies of one sign-in: the same account, as the service names it; the very same sign-in;
    /// the copy made of this one, still there (renewed, maybe); or else the same label (a copy
    /// keeps it), when the label names one account here and no copy of either is known.
    private static func isSameAccount(_ mine: CredentialEntry, _ yours: CredentialEntry, copy: Copy?, byLabel: Bool) -> Bool {
        if let a = accountID(mine), let b = accountID(yours) { return a == b }
        if lasting(mine) == lasting(yours) { return true }
        if let copy { return copy == Copy(mac: mine.id, machine: yours.id) }
        return byLabel && mine.label == yours.label
    }

    /// A machine's copy of one of this Mac's sign-ins: which sign-in here, and which there (an
    /// engine renews a sign-in in place, so it keeps its ID; a copy another Mac put there doesn't).
    struct Copy: Equatable {
        var mac: String
        var machine: String
    }

    /// The copy each machine has, by machine and integration, as "<mac>|<machine>".
    private static var copies: [String: [String: String]] {
        get { UserDefaults.standard.dictionary(forKey: "machineCopies") as? [String: [String: String]] ?? [:] }
        set { UserDefaults.standard.set(newValue.isEmpty ? nil : newValue, forKey: "machineCopies") }
    }

    private static func copy(on machine: String, of integration: String) -> Copy? {
        let parts = copies[machine]?[integration]?.split(separator: "|", maxSplits: 1).map(String.init) ?? []
        return parts.count == 2 ? Copy(mac: parts[0], machine: parts[1]) : nil
    }

    private static func noteCopy(_ copy: Copy?, on machine: String, of integration: String) {
        var all = copies
        all[machine, default: [:]][integration] = copy.map { "\($0.mac)|\($0.machine)" }
        if all[machine]?.isEmpty == true { all[machine] = nil }
        copies = all
    }

    /// The account a sign-in is for, as its service names it (the engine keeps it in its metadata).
    private static func accountID(_ entry: CredentialEntry) -> String? {
        entry.value["metadata"]?["accountID"]?.string ?? entry.value["accountId"]?.string
    }

    /// Connects an integration's server again after a sign-in (or a Try Again), in every folder
    /// its engine has open, as each runs its own: `machine`'s engine, or this Mac's for nil.
    func reconnect(_ server: String, api: OpenCodeAPI, machine: String?) async {
        try? await api.connectMCP(server)
        for folder in workspace.openFolders(on: machine) { try? await api.connectMCP(server, directory: folder) }
    }

    /// Signs out of `integration` (a server's or an account's, which engines name alike) on one
    /// computer: this Mac, or a machine, in its tab in Settings. Each keeps its own.
    func forgetSignIn(_ integration: String, on box: SidebarBox = .mac) {
        guard let api = api(for: box) else { return }
        Task {
            guard let entries = try? await api.credentialEntries() else { return }
            for entry in entries where entry.integrationID == integration { try? await api.removeCredential(entry.id) }
        }
    }

    /// A sign-out of an account's copies only (its keys, GitHub Copilot's sign-in), in `pendingSignOuts`.
    private static let keysOnly = "keys:"

    /// The sign-outs each machine still has to take, by machine.
    private static var pendingSignOuts: [String: [String]] {
        get { UserDefaults.standard.dictionary(forKey: "machineSignOuts") as? [String: [String]] ?? [:] }
        set { UserDefaults.standard.set(newValue.isEmpty ? nil : newValue, forKey: "machineSignOuts") }
    }

    /// Signs `engine`'s machine out of what you signed out of here, unless you've signed in to it
    /// again since. One it couldn't is left for the next time.
    private func signOutWhileAway(_ id: String, mac: OpenCodeAPI, api remote: OpenCodeAPI) async {
        guard let missed = Self.pendingSignOuts[id],
              let ours = try? await mac.credentialEntries(), let theirs = try? await remote.credentialEntries() else { return }
        var done: Set<String> = []
        for item in Set(missed) {
            let keysOnly = item.hasPrefix(Self.keysOnly)
            let integration = keysOnly ? String(item.dropFirst(Self.keysOnly.count)) : item
            let copy = Self.copy(on: id, of: integration)
            var removed = true
            // Signed in to here again: the sync copies that one over instead.
            if !ours.contains(where: { $0.integrationID == integration }) {
                for entry in theirs where entry.integrationID == integration && (!keysOnly || !Self.renewsItself(entry) || entry.id == copy?.machine) {
                    if (try? await remote.removeCredential(entry.id)) == nil { removed = false }
                }
            }
            if removed { done.insert(item) }
        }
        // As the list is now: a sign-out made meanwhile stays on it.
        var pending = Self.pendingSignOuts
        let left = (pending[id] ?? []).filter { !done.contains($0) }
        pending[id] = left.isEmpty ? nil : left
        Self.pendingSignOuts = pending
    }

    /// Every connected machine, after a sign-in here (or one renewed by itself).
    func syncSignIns() {
        for engine in machines.engines.values where engine.isReady { nudgeSignIns(engine) }
    }

    /// Soon, once: a sign-in comes with a few changes in a row (stored, made active, the old one
    /// removed), each of them an event, and copying one is one more.
    func nudgeSignIns(_ engine: MachineEngine) {
        engine.signInNudge?.cancel()
        engine.signInNudge = Task { [weak self, weak engine] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let engine, engine.isReady else { return }
            await self?.syncSignIns(with: engine)
        }
    }
}
