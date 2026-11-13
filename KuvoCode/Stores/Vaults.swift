import ClientVault
import Foundation
import Security

/// Each computer's vault, as the Mac app shows and changes it (KuvoLink's PROTOCOL.md, "Vault"):
/// what its box says, by box (`BoxClient.thisMac`, or a machine's id). A machine's is reached with its
/// unlock key, which this Mac keeps in the Keychain (`VaultKeys`) and gets, the first time, by
/// proving to the machine it's the Mac that set it up.
@MainActor
@Observable
final class Vaults {
    static let shared = Vaults()

    /// One computer's vault, as last read.
    struct Shown: Equatable {
        var vault: Vault?
        var asks: [VaultAsk] = []
        var activity: [VaultActivity] = []
        /// Why it couldn't be read just now.
        var failure: String?
        /// A machine's vault, locked since it started again, until you unlock it (`unlock`).
        var locked = false
        /// A machine's vault files were put back to older copies (its grants, its sites, Pause):
        /// every agent's use there was paused for you to look.
        var rolledBack = false
    }

    private(set) var shown: [String: Shown] = [:]
    /// Reaches a box (`AppModel.box`), set as the app starts.
    @ObservationIgnored var client: (String) -> BoxClient? = { _ in nil }
    /// The Mac's proof for a machine it set up, to be given its vault's key (`PhoneLink.vaultProof`).
    @ObservationIgnored var proof: (String) -> [String: Any]? = { _ in nil }
    /// The Mac's proof for one request to a machine's vault (`PhoneLink.vaultRequestProof`).
    @ObservationIgnored var requestProof: (_ machine: String, _ method: String, _ path: String, _ body: Data) -> String? = { _, _, _, _ in nil }
    /// Goes up with each read of a box, and as it's forgotten.
    @ObservationIgnored private var reads: [String: Int] = [:]
    /// The latest read whose answer shows, and the read the box was forgotten at: a read that
    /// comes back after a later one's answer, or from before the box was forgotten, is dropped. One
    /// that only a later read began over (another reader's) still shows when it comes, until the
    /// later one's replaces it: its caller finds the vault it read, not nothing.
    @ObservationIgnored private var shownRead: [String: Int] = [:]
    @ObservationIgnored private var forgottenAt: [String: Int] = [:]

    subscript(box: String) -> Shown { shown[box] ?? Shown() }

    // MARK: Asking a box

    /// The machine's unlock key, which it gives (making its vault, the first time) to the Mac that
    /// set it up; kept once it's given. Asked for only to unlock it: what runs as you on the machine
    /// could take it on its way, so it never goes with an ordinary request.
    private func keyFromMachine(_ box: String) async throws -> String {
        guard let proof = proof(box), let client = client(box) else { throw BoxRefusal(status: 503, message: "This Mac can't reach that machine's vault now. Try again in a moment.") }
        let (status, data) = try await client.send("POST", VaultRoutes.key, body: try JSONSerialization.data(withJSONObject: proof))
        guard status == 200, let key = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["key"] as? String else { throw BoxRefusal(status: status, data: data) }
        VaultKeys.keep(key, for: box)
        return key
    }

    /// `method path` on `box`'s vault, its answer's JSON as `T`: to a machine with this Mac's
    /// proof for that request alone, never its unlock key.
    func ask<T: Decodable>(_ type: T.Type = T.self, _ method: String, _ path: String, body: [String: Any]? = nil, on box: String) async throws -> T {
        guard let client = client(box) else { throw BoxRefusal(status: 503, message: "Kuvo Code isn't ready yet.") }
        let sent = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        var headers: [String: String] = [:]
        if BoxClient.needsVaultProof(box) {
            guard let proof = requestProof(box, method, path, sent ?? Data()) else { throw BoxRefusal(status: 503, message: "This Mac can't reach that machine's vault now. Try again in a moment.") }
            headers["x-kuvo-vault-proof"] = proof
        }
        let (status, data) = try await client.send(method, path, body: sent, headers: headers)
        guard (200..<300).contains(status) else { throw BoxRefusal(status: status, data: data) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private struct Nothing: Decodable {}
    private struct Asks: Decodable { var asks: [VaultAsk] }
    private struct Entries: Decodable { var entries: [VaultActivity] }
    private struct Made: Decodable { var item: VaultItem; var key: String? }
    private struct Values: Decodable { var values: [String: String] }

    // MARK: Reading

    private func nextRead(_ box: String) -> Int {
        let read = (reads[box] ?? 0) + 1
        reads[box] = read
        return read
    }

    /// Reads `box`'s vault, its asks and its latest activity again.
    func refresh(_ box: String) async {
        let read = nextRead(box)
        var now = self[box]
        do {
            now.vault = try await ask(Vault.self, "GET", VaultRoutes.vault, on: box)
            now.asks = try await ask(Asks.self, "GET", VaultRoutes.asks, on: box).asks
            now.activity = try await ask(Entries.self, "GET", VaultRoutes.activity(limit: 50), on: box).entries
            now.failure = nil
            now.locked = false
            // (A vault the app's own box keeps checks itself.)
            if BoxClient.needsVaultProof(box), let generations = now.vault?.state.generations {
                if Self.wentBack(box, to: generations) {
                    now.rolledBack = true
                    // What it says now is taken from now on only once its agents are paused: if
                    // that didn't go, it's seen again next time.
                    if (try? await ask(Nothing.self, "POST", VaultRoutes.pause, body: ["paused": true], on: box)) != nil {
                        now.vault?.state.paused = true
                        Self.remember(box, generations, replacing: true)
                    }
                } else {
                    Self.remember(box, generations)
                }
            }
        } catch {
            now.failure = error.localizedDescription
            now.locked = (error as? BoxRefusal)?.status == 423
        }
        guard read > (forgottenAt[box] ?? 0), read > (shownRead[box] ?? 0) else { return }
        shownRead[box] = read
        shown[box] = now
    }

    /// Follows `box` while the caller's task runs (a view's): what its agents ask, read again
    /// every second on this Mac (with its vault every few, which the browser and agents' sign-ins
    /// read) and every ten on a machine, whose box answers once over SSH, each with this Mac's
    /// proof (never its key, and never making a vault). A box from before the vault stops it.
    func follow(_ box: String) async {
        var round = 0
        while !Task.isCancelled {
            if BoxClient.streams(box), round % 5 == 0 {
                await refresh(box)
            } else {
                // Dropped if a whole read began meanwhile, which has the asks too.
                let read = reads[box]
                do {
                    let asks = try await ask(Asks.self, "GET", VaultRoutes.asks, on: box).asks
                    if reads[box] == read, asks != self[box].asks {
                        var now = self[box]
                        now.asks = asks
                        shown[box] = now
                    }
                    // Answering again after it didn't: read whole, which says so.
                    if self[box].failure != nil { await refresh(box) }
                } catch let refusal as BoxRefusal where [404, 405].contains(refusal.status) {
                    return
                } catch {}
            }
            round += 1
            // (Every second from the app's own box, answered here; any other, the one attached in
            // place too, answers each read in a process of its own.)
            try? await Task.sleep(for: .seconds(BoxClient.streams(box) ? 1 : 10))
        }
    }

    /// Forgets what's shown of `box`'s vault (a read still on its way is dropped); a machine's
    /// unlock key too (the machine removed from this Mac).
    func forget(_ box: String) {
        forgottenAt[box] = nextRead(box)
        shown[box] = nil
        if BoxClient.needsVaultProof(box) { VaultKeys.forget(box) }
    }

    func activity(on box: String, item: String? = nil, bot: String? = nil, limit: Int = 100) async throws -> [VaultActivity] {
        try await ask(Entries.self, "GET", VaultRoutes.activity(item: item, bot: bot, limit: limit), on: box).entries
    }

    // MARK: Changing

    @discardableResult
    func add(_ given: VaultDraft, on box: String) async throws -> VaultItem {
        let made = try await ask(Made.self, "POST", VaultRoutes.items, body: given.json, on: box)
        if let key = made.key, BoxClient.needsVaultProof(box) { VaultKeys.keep(key, for: box) }
        await refresh(box)
        return made.item
    }

    @discardableResult
    func change(_ item: VaultItem, to given: VaultDraft, on box: String) async throws -> VaultItem {
        let changed = try await ask(Made.self, "PATCH", VaultRoutes.item(item.id), body: given.json, on: box)
        await refresh(box)
        return changed.item
    }

    func remove(_ item: VaultItem, on box: String) async throws {
        _ = try await ask(Nothing.self, "DELETE", VaultRoutes.item(item.id), on: box)
        await refresh(box)
    }

    /// Its values, for you to see or copy (after Touch ID, which the page asks).
    func values(of item: VaultItem, on box: String) async throws -> [String: String] {
        try await ask(Values.self, "GET", VaultRoutes.values(item.id), on: box).values
    }

    /// Sets how `who` may use `item` (`nil` takes it away).
    func grant(_ item: VaultItem, to who: VaultGrant.Who, how: VaultGrant.How?, on box: String) async throws {
        var whom: [String: Any] = [:]
        if let bot = who.bot { whom["bot"] = bot }
        if let project = who.project { whom["project"] = project }
        if who.everyone == true { whom["everyone"] = true }
        _ = try await ask(Nothing.self, "POST", VaultRoutes.grants, body: ["item": item.id, "who": whom, "how": how?.rawValue ?? NSNull()], on: box)
        await refresh(box)
    }

    /// Whether a machine's vault files are older than this Mac saw them last (each newest one is
    /// remembered here, where nothing on the machine reaches): a copy put back while its box was
    /// stopped.
    static func wentBack(_ box: String, to generations: [String: Int]) -> Bool {
        let seen = UserDefaults.standard.dictionary(forKey: "vault.generations.\(box)") as? [String: Int] ?? [:]
        return seen.contains { file, generation in (generations[file] ?? 0) < generation }
    }

    /// Remembers a machine's generations: the newest of these and those seen, or (once its agents
    /// were paused for a copy put back) these from now on.
    static func remember(_ box: String, _ generations: [String: Int], replacing: Bool = false) {
        let key = "vault.generations.\(box)"
        let seen = UserDefaults.standard.dictionary(forKey: key) as? [String: Int] ?? [:]
        UserDefaults.standard.set(replacing ? generations : seen.merging(generations) { max($0, $1) }, forKey: key)
    }

    /// Unlocks a machine's vault, locked since it started again, with the key this Mac keeps: sent
    /// only now, when you ask, since what answers for it then can't prove it's the vault.
    func unlock(_ box: String) async throws {
        // (A locked vault doesn't give its key: then only a client that kept it can, your iPhone say.)
        var key = VaultKeys.key(for: box)
        if key == nil { key = try? await keyFromMachine(box) }
        guard let key else { throw BoxRefusal(status: 423, message: "This Mac doesn't keep that machine's vault key. Unlock it from your iPhone.") }
        _ = try await ask(Nothing.self, "POST", VaultRoutes.unlock, body: ["key": key], on: box)
        await refresh(box)
    }

    /// Pauses (or lets go again) every agent's use, or one bot's.
    func pause(_ paused: Bool, bot: String? = nil, on box: String) async throws {
        // Letting every agent go on is looking over what was put back.
        if !paused, bot == nil { shown[box]?.rolledBack = false }
        var body: [String: Any] = ["paused": paused]
        if let bot { body["bot"] = bot }
        _ = try await ask(Nothing.self, "POST", VaultRoutes.pause, body: body, on: box)
        await refresh(box)
    }

    /// Your answer to what an agent asks.
    func answer(_ asked: VaultAsk, _ answer: String, item: VaultItem? = nil, on box: String) async throws {
        var body: [String: Any] = ["answer": answer]
        if let item { body["item"] = item.id }
        _ = try await ask(Nothing.self, "POST", VaultRoutes.ask(asked.id), body: body, on: box)
        var now = self[box]
        now.asks.removeAll { $0.id == asked.id }
        shown[box] = now
        Task { await refresh(box) }
    }
}

/// The unlock keys of your machines' vaults, which only your clients keep: in the Keychain, by
/// machine. A demo or test copy keeps its own.
nonisolated enum VaultKeys {
    private static var service: String { (Bundle.main.bundleIdentifier ?? "run.kuvo.code") + ".vault-keys" }

    private static func query(_ machine: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: machine]
    }

    static func key(for machine: String) -> String? {
        var item = query(machine)
        item[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard Keychain.copyMatching(item, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func keep(_ key: String, for machine: String) {
        let data = Data(key.utf8)
        if Keychain.update(query(machine), [kSecValueData as String: data]) == errSecSuccess { return }
        var item = query(machine)
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Kuvo Code vault key"
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        Keychain.add(item)
    }

    static func forget(_ machine: String) {
        Keychain.delete(query(machine))
    }
}
